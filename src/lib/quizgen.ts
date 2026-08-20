// The quiz generator — grounded MCQs written from the student's own notes.
//
// This is the one place in readIQ that calls a language model. Groq writes the
// questions; HydraDB is untouched here. The split is deliberate: retrieval and
// root-cause analysis are graph work and must stay extractive, but turning a
// paragraph of notes into four plausible options is generation, and no graph
// can do it.
//
// Everything the model returns is treated as untrusted: shape, option count,
// answer key and grounding are all re-checked locally before a question is ever
// put to a student, and anything that fails validation is dropped rather than
// patched.

import type { QuizOption, QuizQuestion } from '@/types/quiz';

import { BtlError } from './btl';
import { DEFAULT_QUIZ_MODEL, groqChatJson, isGroqConfigured } from './groq';

/** Fallback question target when a caller doesn't ask for a specific count. */
const DEFAULT_TARGET = 10;

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

/** Below this much text a note cannot support real questions — the caller shows
 *  "this note is too thin" rather than letting the model invent. */
const MIN_CONTENT_CHARS = 200;

/** How much note text one request carries. Generous for a subject's notes while
 *  staying well inside the context window with room for the answer. */
const MAX_CONTENT_CHARS = 24000;

/** Extra passes allowed when the first one returns fewer questions than asked. */
const MAX_TOPUP_PASSES = 2;

/** Fisher–Yates shuffle (in place, returns the same array). */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Re-letter a question's options into a random A–D order, moving `answerKey`
 *  with the correct option's text. Index-based (not text-based) so duplicate
 *  option texts can't misplace the answer. Pure and side-effect free. */
export function shuffleQuestionOptions(q: QuizQuestion): QuizQuestion {
  const correctIndex = q.options.findIndex((o) => o.key === q.answerKey);
  if (correctIndex === -1) return q; // malformed — leave untouched
  const order = shuffle(q.options.map((_, i) => i));
  const options: QuizOption[] = order.map((from, i) => ({
    key: OPTION_KEYS[i] ?? q.options[from].key,
    text: q.options[from].text,
  }));
  const answerKey = OPTION_KEYS[order.indexOf(correctIndex)] ?? q.answerKey;
  return { ...q, options, answerKey };
}

/** Options for one generation pass. */
export type GenerateQuizOptions = {
  /** How many questions to aim for. Defaults to DEFAULT_TARGET. */
  count?: number;
  /** Prompts already put to the student, so a re-attempt never repeats questions. */
  avoid?: string[];
  /** Model slug; falls back to Groq's default when unset or retired. */
  model?: string;
  signal?: AbortSignal;
};

/** The subject a quiz is built from. `notes` is optional and only improves
 *  attribution — without it every question cites the subject as its source. */
export type QuizGenSource = {
  id: string;
  title: string;
  subject: string | null;
  content: string;
  /** The individual notes behind `content`, so a question can cite the right one. */
  notes?: { id: string; title: string }[];
};

// --- Prompting ---------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You write multiple-choice exam questions for a student, using ONLY the study',
  'notes you are given. You never use outside knowledge and never invent facts.',
  '',
  'Rules:',
  '- Every question must be answerable from the notes alone, and the correct',
  '  answer must be stated or directly implied by them.',
  '- Exactly four options. Exactly one is correct.',
  '- Distractors must be plausible and on-topic — never joke answers, never',
  '  "none of the above", never options of obviously different length or detail.',
  '- Test understanding (why, how, what follows), not trivia about wording.',
  '- "topic" is a short concept label of 1-4 words taken from the notes, e.g.',
  '  "Calvin cycle". It is used to track what the student is weak on, so keep it',
  '  specific and consistent between questions about the same thing.',
  '- "explanation" is one sentence saying why the answer is right, grounded in',
  '  the notes.',
  '- "source_title" must be copied verbatim from the "#" heading of the note the',
  '  question came from.',
  '- If the notes do not support the number of questions asked for, return fewer.',
  '  Fewer good questions is always better than padding.',
  '',
  'Reply with JSON only, in exactly this shape:',
  '{"questions":[{"topic":"...","prompt":"...","options":["a","b","c","d"],',
  '"answer_index":0,"explanation":"...","source_title":"..."}]}',
].join('\n');

function userPrompt(source: QuizGenSource, count: number, avoid: string[]): string {
  const parts = [
    `Subject: ${source.subject ?? source.title}`,
    `Write ${count} multiple-choice questions from the notes below.`,
  ];
  if (avoid.length > 0) {
    parts.push(
      [
        'The student has already been asked the questions below. Cover different',
        'material — do not rephrase any of them:',
        avoid
          .slice(0, 40)
          .map((p) => `- ${p}`)
          .join('\n'),
      ].join('\n'),
    );
  }
  parts.push('--- NOTES ---', source.content.slice(0, MAX_CONTENT_CHARS));
  return parts.join('\n\n');
}

// --- Validation --------------------------------------------------------------

type WireQuestion = {
  topic?: unknown;
  prompt?: unknown;
  options?: unknown;
  answer_index?: unknown;
  answer?: unknown;
  explanation?: unknown;
  source_title?: unknown;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalise a prompt so trivial wording differences still count as a duplicate. */
function promptKey(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Accept either `answer_index` (0-3) or `answer` ("A"-"D"); anything else fails. */
function answerIndexOf(raw: WireQuestion): number {
  if (typeof raw.answer_index === 'number' && Number.isInteger(raw.answer_index)) {
    return raw.answer_index;
  }
  const letter = text(raw.answer).toUpperCase();
  return (OPTION_KEYS as readonly string[]).indexOf(letter);
}

/** Turn one wire question into a QuizQuestion, or null if it fails any check. */
function toQuestion(raw: WireQuestion, index: number, source: QuizGenSource): QuizQuestion | null {
  const prompt = text(raw.prompt);
  const topic = text(raw.topic);
  if (!prompt || !topic) return null;

  const options = Array.isArray(raw.options) ? raw.options.map(text) : [];
  if (options.length !== 4 || options.some((o) => o === '')) return null;
  // Duplicate option texts would make more than one answer defensible.
  if (new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;

  const answerIndex = answerIndexOf(raw);
  if (answerIndex < 0 || answerIndex > 3) return null;

  const cited = text(raw.source_title).toLowerCase();
  const note = source.notes?.find((n) => n.title.trim().toLowerCase() === cited) ?? null;

  return {
    id: `${source.id}-${Date.now().toString(36)}-${index}`,
    topic,
    prompt,
    options: options.map((o, i) => ({ key: OPTION_KEYS[i], text: o })),
    answerKey: OPTION_KEYS[answerIndex],
    explanation: text(raw.explanation),
    // No matching heading ⇒ cite the subject, which is still honest grounding.
    sourceNoteId: note?.id ?? source.id,
    sourceNoteTitle: note?.title ?? source.title,
  };
}

// --- Generation --------------------------------------------------------------

/** Generate grounded MCQs for a subject.
 *
 *  Returns fewer than `count` (including zero) when the notes cannot support
 *  more — the store reads an empty result as "too thin" on a first attempt and
 *  "questions used up" on a re-attempt, so under-returning must stay possible.
 *
 *  Throws BtlError only for real failures: no key, network, auth, credits. */
export async function generateQuiz(
  source: QuizGenSource,
  opts: GenerateQuizOptions = {},
): Promise<QuizQuestion[]> {
  const count = opts.count ?? DEFAULT_TARGET;
  if (!isGroqConfigured()) throw new BtlError('not-configured');
  if (source.content.trim().length < MIN_CONTENT_CHARS) return [];

  const seen = new Set((opts.avoid ?? []).map(promptKey));
  const kept: QuizQuestion[] = [];

  for (let pass = 0; pass <= MAX_TOPUP_PASSES && kept.length < count; pass++) {
    const missing = count - kept.length;

    let json: { questions?: WireQuestion[] };
    try {
      json = await groqChatJson<{ questions?: WireQuestion[] }>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          // Ask for a couple extra: validation always drops a few, and a short
          // batch would otherwise cost another whole round trip.
          { role: 'user', content: userPrompt(source, missing + 2, [...seen]) },
        ],
        {
          model: opts.model ?? DEFAULT_QUIZ_MODEL,
          // Nudged up on a top-up so the second pass doesn't retrace the first.
          temperature: pass === 0 ? 0.3 : 0.6,
          maxTokens: Math.min(8192, 700 + missing * 320),
          signal: opts.signal,
        },
      );
    } catch (err) {
      // A failed top-up is not a failed quiz — hand back the questions already
      // validated rather than losing them. Only a failed first pass is fatal.
      if (pass > 0 && kept.length > 0) break;
      throw err;
    }

    const batch = Array.isArray(json?.questions) ? json.questions : [];
    let added = 0;
    for (const raw of batch) {
      if (kept.length >= count) break;
      const question = toQuestion(raw, kept.length, source);
      if (!question) continue;
      const key = promptKey(question.prompt);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(shuffleQuestionOptions(question));
      added++;
    }

    // A pass that added nothing new means the notes are spent — another round
    // would burn a request to return the same questions again.
    if (added === 0) break;
  }

  return kept;
}
