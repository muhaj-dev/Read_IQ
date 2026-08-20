// Grounded Ask ★ — extractive, and deliberately so.
//
// An answer here is made of the student's own sentences. Retrieval picks the note
// chunks that clear the grounding gate (HydraDB's concept graph when it is
// configured, local keyword matching when it is not), and this module selects the
// sentences inside them that actually address the question, then shows them
// verbatim under the note they came from.
//
// No model writes anything. That is not a limitation dressed up as a principle: a
// generated paraphrase can drift from the note it cites, and the whole promise of
// Ask is that a claim can be checked rather than trusted. Quoting removes the gap
// entirely — every line on screen exists in a note the student saved, and the
// citation tag opens it.
//
// What still needs a model is generation from outside the notes: answering beyond
// them, and reading an attached photo. Those stay unimplemented here.

import { useNotesStore } from '@/store/use-notes-store';
import type { Citation } from '@/types/chat';
import type { RetrievalHit } from '@/types/retrieval';

import { BtlError } from './btl';
import { retrieveTopK, tokenize } from './retrieval';

/** The decline sentence — used identically as prompt instruction, fallback, and detector. */
export const NOT_IN_NOTES = "I don't have that in your notes yet.";

/** Shown when the student hasn't saved a single note yet (nudge to add one). */
export const NO_NOTES_YET =
  "You haven't saved any notes yet. Add your first note and I'll answer straight from it.";

/** How many note chunks feed the answer. */
const RETRIEVE_K = 8;
/** A continuation looks wider, since the first pass already spent the best hits. */
const CONTINUE_K = 16;
/** Passages quoted in one reply — enough to be useful, few enough to read. */
const MAX_PASSAGES = 3;
/** Roughly a screenful. Passing it is what makes an answer "truncated". */
const ANSWER_CHARS = 900;
/** A quote shorter than this is a fragment, not an answer. */
const MIN_PASSAGE_CHARS = 40;
/** Below this a "sentence" is almost always a chunk boundary's leftover. */
const MIN_SENTENCE_WORDS = 5;

export type AskResult = {
  /** True only when a real answer was drawn from retrieved notes. */
  grounded: boolean;
  content: string;
  citations: Citation[];
  /** Hit the length cap mid-answer — UI offers "Generate more". */
  truncated: boolean;
};

// --- Sentence selection ------------------------------------------------------

// Split without lookbehind (Hermes-safe), the same way chunk.ts sees a note, so a
// quote lines up with the text the student would find if they opened it. Markdown
// heading marks are dropped: they are structure in the note, noise in a quote.
function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((s) => s.replace(/#+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Whole sentences only. Retrieved chunks are cut to a size, not to a full stop,
 *  so the first and last sentence of a chunk are often halves — quoting a half
 *  sentence looks like the app garbled the note. Nothing detects every tail
 *  reliably, but capitalised-start, terminated-end and a few words of body
 *  catches the ones that read as damage ("RuBP.", "Calvin cycle."). */
function isWhole(sentence: string): boolean {
  if (!/^[A-Z0-9"'(]/.test(sentence) || !/[.!?]$/.test(sentence)) return false;
  return sentence.split(/\s+/).length >= MIN_SENTENCE_WORDS;
}

/** Collapse to comparable form, so "already said this" survives whitespace and case. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The passage inside a chunk that speaks to the question: the best *run* of
 *  consecutive sentences that fits the budget.
 *
 *  Consecutive is the point. Picking the highest-scoring sentences individually
 *  scores better and reads worse — the quote jumps between unrelated lines and
 *  the explanation in between goes missing. A chunk is only a few sentences long,
 *  so the best window is worth finding exhaustively. */
function pickSentences(question: string, chunk: string, budget: number): string {
  const terms = new Set(tokenize(question));
  const sentences = splitSentences(chunk).filter(isWhole);
  if (sentences.length === 0) return '';

  const matched = sentences.map(
    (text) => new Set(tokenize(text).filter((t) => terms.has(t))).size,
  );

  // Widening a window never lowers its total, so score alone would always pick
  // the whole chunk — including the line about when the exam is. Ties go to the
  // shorter window, and the edges are trimmed back to sentences that matched, so
  // what survives is the passage about the question plus the prose between.
  let best = { start: 0, end: 0, score: -1 };
  for (let start = 0; start < sentences.length; start += 1) {
    let length = 0;
    let score = 0;
    for (let end = start; end < sentences.length; end += 1) {
      length += sentences[end].length + 1;
      if (length > budget && end > start) break;
      score += matched[end];
      if (score > best.score) best = { start, end, score };
    }
  }

  // Nothing in this chunk speaks to the question. The graph path returns chunks
  // for any query, gate or no gate, so this is the check that keeps "who won the
  // 1998 world cup" from being answered with three paragraphs about ATP.
  if (best.score <= 0) return '';

  let { start, end } = best;
  while (start < end && matched[start] === 0) start += 1;
  while (end > start && matched[end] === 0) end -= 1;

  // Trimmed to matches alone a quote is accurate and useless — "The Calvin cycle
  // takes place in the stroma." is the sentence that matched, and the one after it
  // is the one that explains anything. So carry the next sentence, but only when it
  // continues the same subject: a note ends on "It is scheduled for the 22nd", and
  // that sentence shares nothing with the passage but adjacency.
  const next = sentences[end + 1];
  const width = sentences.slice(start, end + 1).join(' ').length;
  if (next && width + next.length <= budget) {
    const body = new Set(tokenize(sentences.slice(start, end + 1).join(' ')));
    if (tokenize(next).some((t) => body.has(t))) end += 1;
  }

  return sentences.slice(start, end + 1).join(' ');
}

// --- Composing the reply -----------------------------------------------------

type Passage = { noteId: string; noteTitle: string; text: string };

/** Turn ranked hits into quoted passages within a length budget. Consecutive hits
 *  from one note merge, so a long answer doesn't repeat the same heading. */
function buildPassages(
  question: string,
  hits: RetrievalHit[],
  opts: { max: number; budget: number; skip?: string },
): { passages: Passage[]; more: boolean } {
  const skip = opts.skip ? normalize(opts.skip) : '';
  const passages: Passage[] = [];
  let spent = 0;
  let more = false;

  for (const hit of hits) {
    if (passages.length >= opts.max || spent >= opts.budget) {
      more = true;
      break;
    }

    const text = pickSentences(question, hit.text, opts.budget - spent);
    // Drop what the student has already read, sentence by sentence.
    const fresh = skip
      ? splitSentences(text)
          .filter((s) => !skip.includes(normalize(s)))
          .join(' ')
      : text;
    if (fresh.length < MIN_PASSAGE_CHARS) continue;

    const last = passages[passages.length - 1];
    if (last && last.noteId === hit.noteId) {
      last.text = `${last.text} ${fresh}`;
    } else {
      passages.push({ noteId: hit.noteId, noteTitle: hit.noteTitle, text: fresh });
    }
    spent += fresh.length;
  }

  return { passages, more };
}

/** "**Note title**" + the quote beneath renders as a definition card (answer-blocks.ts). */
function render(passages: Passage[]): string {
  return passages.map((p) => `**${p.noteTitle}**\n${p.text}`).join('\n\n');
}

/** One tag per source note, in the order they were quoted. */
function toCitations(passages: Passage[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const p of passages) {
    if (seen.has(p.noteId)) continue;
    seen.add(p.noteId);
    citations.push({
      noteId: p.noteId,
      noteTitle: p.noteTitle,
      snippet: p.text.slice(0, 160).trim(),
    });
  }
  return citations;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reveal the answer a few words at a time. Nothing is being waited on — the text
 *  is already in hand — but an answer that lands whole reads as a canned string,
 *  and the bubble's typing state is driven by deltas. Aborting stops the reveal;
 *  the caller still receives the finished text. */
async function reveal(
  text: string,
  onToken?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!onToken) return;
  const parts = text.match(/\S+\s*/g) ?? [];
  for (let i = 0; i < parts.length; i += 4) {
    if (signal?.aborted) return;
    onToken(parts.slice(i, i + 4).join(''));
    await sleep(16);
  }
}

// --- The public surface ------------------------------------------------------

/** Answer strictly from the saved notes, quoting them. Empty retrieval is the
 *  honest decline — and an empty library says so differently from a real miss. */
export async function askFromNotes(
  question: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<AskResult> {
  const hits = await retrieveTopK(question, RETRIEVE_K);

  if (hits.length === 0) {
    const empty = useNotesStore.getState().notes.length === 0;
    return {
      grounded: false,
      content: empty ? NO_NOTES_YET : NOT_IN_NOTES,
      citations: [],
      truncated: false,
    };
  }

  const { passages, more } = buildPassages(question, hits, {
    max: MAX_PASSAGES,
    budget: ANSWER_CHARS,
  });

  // Hits that survive retrieval but hold nothing quotable are a miss, not an answer.
  if (passages.length === 0) {
    return { grounded: false, content: NOT_IN_NOTES, citations: [], truncated: false };
  }

  const content = render(passages);
  await reveal(content, opts.onToken, opts.signal);

  return {
    grounded: true,
    content,
    citations: toCitations(passages),
    truncated: more || hits.length > passages.length,
  };
}

export type ContinueResult = AskResult & {
  /** Nothing further in the notes — UI retires "Generate more". */
  exhausted: boolean;
};

/** "Generate more": the next passages down the ranking, minus anything the prior
 *  answer already quoted. `priorAnswer` is the whole record of what was said, so
 *  no continuation state has to be threaded through the store. */
export async function continueAnswer(
  question: string,
  priorAnswer: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<ContinueResult> {
  const hits = await retrieveTopK(question, CONTINUE_K);
  const { passages, more } = buildPassages(question, hits, {
    max: MAX_PASSAGES,
    budget: ANSWER_CHARS,
    skip: priorAnswer,
  });

  if (passages.length === 0) {
    return { grounded: true, content: '', citations: [], truncated: false, exhausted: true };
  }

  const content = render(passages);
  await reveal(content, opts.onToken, opts.signal);

  return {
    grounded: true,
    content,
    citations: toCitations(passages),
    truncated: more,
    exhausted: false,
  };
}

// --- Still unimplemented: generation from outside the notes ------------------
// These are not retrieval, so nothing here can supply them. Each throws, and the
// Ask screen renders its calm not-set-up state rather than a dead end.

export type BeyondResult = { content: string; truncated: boolean };

/** Not implemented — a general-knowledge answer needs a model. */
export async function answerBeyondNotes(
  _question: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  throw new BtlError('not-configured');
}

export type ImageAskResult = AskResult & { fromImage: true };

/** Not implemented — reading an attached photo needs a vision provider (see lib/ocr.ts). */
export async function answerImageGrounded(
  _question: string,
  _imageText: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<ImageAskResult | null> {
  throw new BtlError('not-configured');
}

/** Not implemented — see {@link answerImageGrounded}. */
export async function answerImageOpen(
  _question: string,
  _imageText: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  throw new BtlError('not-configured');
}
