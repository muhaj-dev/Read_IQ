// Note summarisation — one calm line describing what a saved note is about.
//
// This runs once, on the Add screen, after a scan/recording/upload has produced
// text and before the note is saved, so saving itself stays instant. It is
// generation, not retrieval: the summary is a sentence about the student's own
// material, never a claim added to it, and HydraDB never sees it — the note text
// is what gets ingested.
//
// Every caller treats a throw as "no summary" and saves the note anyway, so a
// missing key or a bad hop costs the student nothing.

import { groqChatJson } from './groq';

/** How much of the note the model reads. A summary of the first few pages is
 *  right far more often than a truncated request is worth retrying. */
const MAX_INPUT_CHARS = 12000;

/** Below this there is nothing to summarise — the title already says it. */
const MIN_INPUT_CHARS = 200;

/** One sentence, and short enough for the card it sits on. Anything longer is
 *  the model ignoring the brief, so it is dropped rather than trimmed mid-word. */
const MAX_SUMMARY_CHARS = 200;

/** Generous for a one-sentence answer, and deliberately so: the default model
 *  reasons before it writes, and those tokens count against the same ceiling.
 *  Set it to the size of the *answer* and Groq rejects the call outright —
 *  "max completion tokens reached before generating a valid document", a 400,
 *  not a short summary — so every note would silently save without one. The
 *  25-word brief is what keeps the output short; this is only headroom. */
const SUMMARY_MAX_TOKENS = 2048;

/** Deterministic — a gist should not be inventive. */
const SUMMARY_TEMPERATURE = 0.2;

const SYSTEM_PROMPT = [
  'You summarise a student’s study notes in one sentence, so they can tell at a',
  'glance what a saved note is about.',
  '',
  'Rules:',
  '- Exactly one sentence, at most 25 words.',
  '- Say what the notes cover, using their own vocabulary. Never add a fact the',
  '  notes do not contain, and never evaluate or advise.',
  '- Do not open with "This note", "These notes", "The document" or similar —',
  '  start with the subject matter itself.',
  '- No markdown, no quotes, no trailing commentary.',
  '',
  'Reply with JSON only, in exactly this shape:',
  '{"summary":"..."}',
].join('\n');

/** Collapse the model's sentence to one clean line. Returns '' when what came
 *  back is not usable, which the caller reads as "no summary". */
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/\s+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (!text || text.length > MAX_SUMMARY_CHARS) return '';
  return text;
}

/** A one-sentence gist of a note's text.
 *
 *  Returns '' when the note is too thin to summarise or the model returned
 *  something unusable. Throws BtlError when Groq itself failed (no key, network,
 *  rejected key) — callers catch both and simply save without a summary. */
export async function summarizeNoteText(
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = content.trim();
  if (text.length < MIN_INPUT_CHARS) return '';

  const json = await groqChatJson<{ summary?: unknown }>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
    ],
    { temperature: SUMMARY_TEMPERATURE, maxTokens: SUMMARY_MAX_TOKENS, signal },
  );

  return clean(json?.summary);
}

