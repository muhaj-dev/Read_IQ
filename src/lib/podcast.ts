// "From Your Notes" study podcast — the two-host script.
//
// Everything around this was already real and needs no provider: playback is
// on-device TTS via expo-speech ([`hooks/use-episode-player.ts`]), the voices
// are the phone's own ([`podcast-voices.ts`]), and episodes cache in SQLite by
// note id + content hash. The only missing piece was the *script*, and writing a
// conversation out of a paragraph is generation — the same job as the quiz
// generator, and equally not something the graph could supply.
//
// So this is a Groq call and nothing else is. HydraDB is untouched: an episode
// is one note's content turned into dialogue, not a retrieval.
//
// Everything the model returns is untrusted. Speaker tags, turn count, title
// length and coverage are all re-checked here, and a malformed turn is dropped
// rather than patched.

import type { PodcastCoverage, PodcastTurn } from '@/types/podcast';

import { BtlError } from './btl';
import { DEFAULT_QUIZ_MODEL, groqChatJson, isGroqConfigured } from './groq';
import { hashContent } from './hash';

// Re-exported so existing importers keep working now that hashContent moved to lib/hash.
export { hashContent };

/** What the scriptwriter returns (before we stamp noteId + hash + createdAt). */
export type EpisodeScript = {
  title: string;
  coverage: PodcastCoverage;
  turns: PodcastTurn[];
};

/** Below this a note cannot carry a conversation — the Listen screen says so
 *  rather than letting two hosts pad three sentences into five minutes. */
const MIN_CONTENT_CHARS = 200;

/** How much of the note the script is written from. */
const MAX_CONTENT_CHARS = 12000;

/** Turn ceiling. Past this an "episode" is a lecture, and on-device TTS reading
 *  it back is a long time to hold a phone. */
const MAX_TURNS = 24;

/** A turn shorter than this is an interjection the player would flash past. */
const MIN_TURN_CHARS = 15;

/** One turn is one spoken breath, not a paragraph — the transcript view shows
 *  turns as tappable rows and a wall of text breaks that. */
const MAX_TURN_CHARS = 600;

/** Title budget, matching the ≤6-word brief with room for a long word. */
const MAX_TITLE_CHARS = 60;
const MAX_TITLE_WORDS = 6;

/** Sized against the free tier's rate limit, not the model's context window.
 *  Groq bills prompt + max_tokens against a per-minute token budget (8000 on
 *  on-demand), so a ceiling that looks harmless is rejected outright — 8192 here
 *  returned a 413 rate_limit_exceeded before the model ran at all. This leaves
 *  room for the prompt and still far exceeds what 24 turns of dialogue need,
 *  reasoning included. */
const MAX_TOKENS = 6000;

/** Slightly loose: this is a conversation, and two hosts reading in a monotone
 *  is the failure mode. Still well below anything that would invent facts. */
const TEMPERATURE = 0.5;

const SYSTEM_PROMPT = [
  'You write a short two-host study podcast from ONE set of a student’s notes.',
  'The hosts are Maya (speaker "A") and Leo (speaker "B").',
  '',
  'Maya (A) hosts: she opens, asks the questions a student would actually ask,',
  'and pulls Leo back when he goes too fast. Leo (B) explains.',
  '',
  'Rules:',
  '- Use ONLY the notes provided. Never add a fact, a number, an example or a',
  '  definition that is not in them. If the notes do not say why, Maya can say',
  '  the notes do not cover it — do not invent the reason.',
  '- This is speech. Short sentences, contractions, no bullet points, no',
  '  markdown, no stage directions, no "[laughs]", no sound effects.',
  '- Never say the words "the notes" as if reading a document aloud; the hosts',
  '  are talking about the topic, not about a file.',
  '- Speakers alternate. Open with Maya, and close with Maya summing up in one',
  '  or two sentences.',
  '- Cover the whole set of notes, not just the first idea in them.',
  '- "title" is at most 6 words, naming the topic. No "Episode 1", no colon.',
  '- "coverage" is "full" if the episode genuinely covers the notes, "partial"',
  '  if the notes were too thin to do more than touch on them.',
  '',
  'Reply with JSON only, in exactly this shape:',
  '{"title":"...","coverage":"full","turns":[{"speaker":"A","text":"..."},',
  '{"speaker":"B","text":"..."}]}',
].join('\n');

function userPrompt(note: { title: string; subject: string | null; content: string }): string {
  return [
    `Subject: ${note.subject ?? 'General'}`,
    `Note title: ${note.title}`,
    '',
    'Write the episode from the notes below.',
    '',
    note.content.trim().slice(0, MAX_CONTENT_CHARS),
  ].join('\n');
}

// --- Validation ---------------------------------------------------------------

/** The wire shape, before anything is trusted. */
type WireTurn = { speaker?: unknown; text?: unknown };
type WireScript = { title?: unknown; coverage?: unknown; turns?: unknown };

/** Strip the things a model adds when it forgets this is speech: stage
 *  directions, speaker labels it repeated inside the text, stray markdown. */
function cleanTurnText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\[[^\]]*\]/g, ' ') // [laughs], [music]
    .replace(/^\s*(?:maya|leo)\s*:\s*/i, '') // "Maya: ..." duplicated into the text
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One validated turn, or null. */
function toTurn(raw: WireTurn): PodcastTurn | null {
  const speaker = typeof raw?.speaker === 'string' ? raw.speaker.trim().toUpperCase() : '';
  if (speaker !== 'A' && speaker !== 'B') return null;

  const text = cleanTurnText(raw?.text);
  if (text.length < MIN_TURN_CHARS || text.length > MAX_TURN_CHARS) return null;

  return { speaker, text };
}

/** Fold consecutive same-speaker turns into one.
 *
 *  Dropping them would lose what was said, and re-tagging the second one to the
 *  other host would put an explanation in the asker's mouth. Merging keeps every
 *  word with the host who said it — and the player treats a turn as one spoken
 *  run, so two adjacent A-turns would have read as one anyway. */
function mergeAdjacent(turns: PodcastTurn[]): PodcastTurn[] {
  const merged: PodcastTurn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker) last.text = `${last.text} ${turn.text}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/** Trim the title to the brief. A long one is the model ignoring the word cap,
 *  and the Listen screen has one line for it. */
function cleanTitle(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const text = raw
    .replace(/[*_`#"]/g, '')
    .replace(/^\s*episode\s*\d*\s*[:.-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  const words = text.split(' ').slice(0, MAX_TITLE_WORDS).join(' ');
  return words.slice(0, MAX_TITLE_CHARS).replace(/[\s:,-]+$/, '') || fallback;
}

// --- Generation ---------------------------------------------------------------

/** Write a two-host episode from one note.
 *
 *  Throws BtlError for real failures — no key, network, auth, credits — and for
 *  a note too thin to script, which the Listen screen reports as its own state.
 *  Never returns a script with no turns: an empty episode is a failure, not an
 *  episode, and the player would show a dead transcript. */
export async function generateEpisodeScript(note: {
  title: string;
  subject: string | null;
  content: string;
}): Promise<EpisodeScript> {
  if (!isGroqConfigured()) throw new BtlError('not-configured');
  if (note.content.trim().length < MIN_CONTENT_CHARS) {
    throw new BtlError('unknown', 'note is too thin for an episode');
  }

  const json = await groqChatJson<WireScript>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(note) },
    ],
    { model: DEFAULT_QUIZ_MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS },
  );

  const wire = Array.isArray(json?.turns) ? (json.turns as WireTurn[]) : [];
  const valid = wire.map(toTurn).filter((t): t is PodcastTurn => t !== null);
  const merged = mergeAdjacent(valid);
  const turns = merged.slice(0, MAX_TURNS);

  if (turns.length === 0) {
    throw new BtlError('server', 'the episode came back with no usable turns');
  }

  // Coverage is the model's own read of whether it did the notes justice, but a
  // script that lost turns to validation, or got cut at the ceiling, is partial
  // whatever it claimed. Merging adjacent turns is not a loss — the same words
  // survive under one speaker — so it does not count against completeness.
  const claimed = json?.coverage === 'full' ? 'full' : 'partial';
  const complete = valid.length === wire.length && merged.length <= MAX_TURNS;
  const coverage: PodcastCoverage = claimed === 'full' && complete ? 'full' : 'partial';

  return { title: cleanTitle(json?.title, note.title), coverage, turns };
}
