// Generation from outside the notes — the one answer in Ask a model writes.
//
// This is deliberately its own module. `chat.ts` is extractive and must stay
// that way, so it never imports Groq; everything that needs a model to *write*
// an answer lives here instead, and the boundary is the import graph rather than
// a comment asking nicely.
//
// The student opts in per answer. Grounded Ask runs first, and only once it has
// said its piece does the "Answer from outside your notes" button appear — so
// nothing here ever runs uninvited, and what it produces is rendered in its own
// bubble that is visibly not a quote from a note.
//
// It also holds the two answers about a photographed page. By the time they run
// the photo is already text (ocr.ts did the looking), so they are generation
// over supplied material like everything else here.

import { getChatModel } from '@/store/use-settings-store';
import type { Citation } from '@/types/chat';
import type { RetrievalHit } from '@/types/retrieval';

import { BtlError } from './btl';
import type { AskResult } from './chat';
import { groqChatText } from './groq';
import { retrieveTopK } from './retrieval';
import { reveal } from './reveal';

export type BeyondResult = { content: string; truncated: boolean };

/** Headroom, not a length target. The default model reasons before it writes and
 *  that spend comes out of the same ceiling, so sizing this to the answer would
 *  leave hard questions cut off mid-sentence with the thinking, not the answer,
 *  having eaten the budget. The three-paragraph brief is what keeps it short. */
const BEYOND_MAX_TOKENS = 1600;

/** Warmer than quiz generation (0.3), which has to stay faithful to a source.
 *  This is an explanation with no source to be faithful to. */
const BEYOND_TEMPERATURE = 0.4;

/** Appended when Groq stopped on the token ceiling instead of finishing. Saying
 *  so is better than a paragraph that just stops mid-sentence. */
const CUT_SHORT = '\n\n(That answer ran long and was cut short.)';

const BEYOND_SYSTEM = [
  'You are a study assistant answering a student directly, from general',
  'knowledge. Their own notes have already been searched and did not cover',
  'this — that is exactly why you were asked.',
  '',
  'Rules:',
  '- Answer the question. Do not open by restating it or by explaining what you',
  '  are about to do.',
  '- Be accurate before being complete. If something is genuinely disputed or',
  '  you are unsure, say so in the sentence that needs it rather than hedging',
  '  the whole answer.',
  '- Never claim or imply the answer came from the student’s notes, and never',
  '  cite a note, a page or a source you were not given.',
  '- Aim for three short paragraphs at most. Use "- " bullets only for a real',
  '  list. No headings, no bold lines, no tables, no code fences, no links.',
  '- Plain, calm prose. No praise for the question, no sign-off.',
].join('\n');

/** Answer from general knowledge, outside the saved notes.
 *
 *  Throws BtlError — no key, no network, a rejected key — and the Ask store
 *  turns that into a calm error bubble rather than a dead end. */
export async function answerBeyondNotes(
  question: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  const asked = question.trim();
  if (!asked) throw new BtlError('unknown', 'empty question');

  const { text, truncated } = await groqChatText(
    [
      { role: 'system', content: BEYOND_SYSTEM },
      { role: 'user', content: asked },
    ],
    {
      model: getChatModel(),
      temperature: BEYOND_TEMPERATURE,
      maxTokens: BEYOND_MAX_TOKENS,
      signal: opts.signal,
    },
  );

  // A model that returns whitespace is a server problem, not an answer.
  if (!text) throw new BtlError('server', 'Groq returned an empty answer');

  const content = truncated ? `${text}${CUT_SHORT}` : text;
  await reveal(content, opts.onToken, opts.signal);

  return { content, truncated };
}

// --- Questions about an attached photo ---------------------------------------
//
// The photo has already been read by `ocr.ts` — what arrives here is text. So
// these are ordinary generation over supplied material, and the only reason they
// live beside the beyond-notes answer is that both write prose a model composed.

export type ImageAskResult = AskResult & { fromImage: true };

/** How many note chunks are offered alongside the photo. Fewer than grounded Ask
 *  uses: the photo is the subject, and the notes are context around it. */
const IMAGE_RETRIEVE_K = 4;

/** A note chunk below this score is not really about the question — offering it
 *  would invite the model to answer from a note that merely shares a word. */
const IMAGE_MIN_SCORE = 0.2;

const IMAGE_MAX_TOKENS = 1600;

const IMAGE_GROUNDED_SYSTEM = [
  'A student photographed a page and asked a question about it. You are given',
  'the text read off that photo, and passages from notes they saved earlier.',
  '',
  'Rules:',
  '- Answer using ONLY the photo text and the passages given. Never add outside',
  '  knowledge. If the answer is not in either, say plainly that the page and',
  '  their notes do not cover it.',
  '- The photo is the subject; their notes are context. Where the two connect,',
  '  say so — that link is the useful part.',
  '- Refer to the photo as "this page", never as "the OCR text" or "the image',
  '  text". Do not mention that anything was transcribed.',
  '- Two or three short paragraphs at most. "- " bullets only for a real list.',
  '  No headings, no bold lines, no tables, no code fences.',
].join('\n');

const IMAGE_OPEN_SYSTEM = [
  'A student photographed a page and asked a question about it. You are given the',
  'text read off that photo. Their own notes do not cover this topic.',
  '',
  'Rules:',
  '- Answer the question about the page, using the page plus general knowledge.',
  '- Refer to the photo as "this page", never as "the OCR text" or "the image',
  '  text". Do not mention that anything was transcribed.',
  '- Be accurate before being complete; say so where you are unsure.',
  '- Two or three short paragraphs at most. "- " bullets only for a real list.',
  '  No headings, no bold lines, no tables, no code fences.',
  '- Plain, calm prose. No praise for the question, no sign-off.',
].join('\n');

/** Build the user turn: the page first, because it is what was asked about. */
function imagePrompt(question: string, imageText: string, passages: RetrievalHit[]): string {
  const parts = [`Question: ${question}`, '', 'Text from this page:', imageText.trim()];
  if (passages.length > 0) {
    parts.push(
      '',
      'Passages from their saved notes:',
      ...passages.map((hit) => `[${hit.noteTitle}] ${hit.text.trim()}`),
    );
  }
  return parts.join('\n');
}

/** Answer a question about a photographed page, using the student's notes too.
 *
 *  Returns null when nothing in their notes is about this — the Ask screen reads
 *  that as "new topic" and offers to save the page instead of answering over it.
 *  That null is the whole reason this is separate from {@link answerImageOpen}. */
export async function answerImageGrounded(
  question: string,
  imageText: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<ImageAskResult | null> {
  const asked = question.trim();
  if (!asked || !imageText.trim()) return null;

  const hits = (await retrieveTopK(asked, IMAGE_RETRIEVE_K)).filter(
    (hit) => hit.score >= IMAGE_MIN_SCORE,
  );
  // Nothing saved on this topic — not a failure, a different branch.
  if (hits.length === 0) return null;

  const { text } = await groqChatText(
    [
      { role: 'system', content: IMAGE_GROUNDED_SYSTEM },
      { role: 'user', content: imagePrompt(asked, imageText, hits) },
    ],
    {
      model: getChatModel(),
      temperature: BEYOND_TEMPERATURE,
      maxTokens: IMAGE_MAX_TOKENS,
      signal: opts.signal,
    },
  );
  if (!text) throw new BtlError('server', 'Groq returned an empty answer');

  await reveal(text, opts.onToken, opts.signal);

  // One citation per note actually handed to the model — the student can open
  // each and check the claim against what they wrote.
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const hit of hits) {
    if (seen.has(hit.noteId)) continue;
    seen.add(hit.noteId);
    citations.push({
      noteId: hit.noteId,
      noteTitle: hit.noteTitle,
      snippet: hit.text.slice(0, 160).trim(),
    });
  }

  return { grounded: true, content: text, citations, truncated: false, fromImage: true };
}

/** Answer about the page alone, once the student has said the topic is new.
 *  General knowledge is allowed here — they asked for it by saying "don't save,
 *  just answer" — so this is the beyond-notes answer with a page attached. */
export async function answerImageOpen(
  question: string,
  imageText: string,
  opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  const asked = question.trim();
  if (!asked) throw new BtlError('unknown', 'empty question');

  const { text, truncated } = await groqChatText(
    [
      { role: 'system', content: IMAGE_OPEN_SYSTEM },
      { role: 'user', content: imagePrompt(asked, imageText, []) },
    ],
    {
      model: getChatModel(),
      temperature: BEYOND_TEMPERATURE,
      maxTokens: IMAGE_MAX_TOKENS,
      signal: opts.signal,
    },
  );
  if (!text) throw new BtlError('server', 'Groq returned an empty answer');

  const content = truncated ? `${text}${CUT_SHORT}` : text;
  await reveal(content, opts.onToken, opts.signal);
  return { content, truncated };
}
