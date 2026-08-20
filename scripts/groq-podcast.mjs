// Write a "From Your Notes" episode from a seed note, without booting a simulator.
//
//   node scripts/groq-podcast.mjs           # first Biology seed note
//   node scripts/groq-podcast.mjs chem      # first seed/chem-*.md
//
// Same prompt and same validation as src/lib/podcast.ts, so a failure here is a
// failure in the app. Reads EXPO_PUBLIC_GROQ_API_KEY from .env.
//
// Only the SCRIPT is a model call. Playback is on-device TTS (expo-speech) and
// needs no provider at all — see src/hooks/use-episode-player.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnv(path = '.env') {
  const out = {};
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`No ${path} found — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const key = env.EXPO_PUBLIC_GROQ_API_KEY;
if (!key) {
  console.error('Set EXPO_PUBLIC_GROQ_API_KEY in .env — get one at https://console.groq.com/keys');
  process.exit(1);
}

const BASE_URL = env.EXPO_PUBLIC_GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = env.EXPO_PUBLIC_GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b';

// --- Kept in step with src/lib/podcast.ts ------------------------------------

const MIN_CONTENT_CHARS = 200;
const MAX_CONTENT_CHARS = 12000;
const MAX_TURNS = 24;
const MIN_TURN_CHARS = 15;
const MAX_TURN_CHARS = 600;
const MAX_TITLE_CHARS = 60;
const MAX_TITLE_WORDS = 6;
const MAX_TOKENS = 6000;
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

function cleanTurnText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^\s*(?:maya|leo)\s*:\s*/i, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTurn(raw) {
  const speaker = typeof raw?.speaker === 'string' ? raw.speaker.trim().toUpperCase() : '';
  if (speaker !== 'A' && speaker !== 'B') return null;
  const text = cleanTurnText(raw?.text);
  if (text.length < MIN_TURN_CHARS || text.length > MAX_TURN_CHARS) return null;
  return { speaker, text };
}

function mergeAdjacent(turns) {
  const merged = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker) last.text = `${last.text} ${turn.text}`;
    else merged.push({ ...turn });
  }
  return merged;
}

function cleanTitle(value, fallback) {
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

// --- Run ----------------------------------------------------------------------

const prefix = process.argv[2] || 'bio';
const file = readdirSync('seed').find((f) => f.startsWith(prefix) && f.endsWith('.md'));
if (!file) {
  console.error(`No seed note matching "${prefix}*".`);
  process.exit(1);
}

const body = readFileSync(join('seed', file), 'utf8').trim();
const title = (body.match(/^#\s*(.+)$/m)?.[1] ?? file.replace(/\.md$/, '')).trim();
const content = body.replace(/^#\s*.+$/m, '').trim();

console.log(`note: ${file} — "${title}" (${content.length} chars)\n`);
if (content.length < MIN_CONTENT_CHARS) {
  console.error(`Below MIN_CONTENT_CHARS (${MIN_CONTENT_CHARS}) — the app throws "too thin" here.`);
  process.exit(1);
}

const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `Subject: Biology`,
          `Note title: ${title}`,
          '',
          'Write the episode from the notes below.',
          '',
          content.slice(0, MAX_CONTENT_CHARS),
        ].join('\n'),
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`Groq ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const json = JSON.parse((await res.json()).choices[0].message.content);
const wire = Array.isArray(json?.turns) ? json.turns : [];
const valid = wire.map(toTurn).filter(Boolean);
const merged = mergeAdjacent(valid);
const turns = merged.slice(0, MAX_TURNS);

const claimed = json?.coverage === 'full' ? 'full' : 'partial';
const complete = valid.length === wire.length && merged.length <= MAX_TURNS;
const coverage = claimed === 'full' && complete ? 'full' : 'partial';

console.log(`title:    "${cleanTitle(json?.title, title)}"`);
console.log(`coverage: ${coverage} (model claimed "${claimed}")`);
console.log(`turns:    ${turns.length} kept of ${wire.length} returned` +
  `${valid.length < wire.length ? ` — ${wire.length - valid.length} DROPPED by validation` : ''}` +
  `${merged.length < valid.length ? ` — ${valid.length - merged.length} merged (same speaker in a row)` : ''}`);

const HOSTS = { A: 'Maya', B: 'Leo' };
console.log('');
for (const turn of turns) console.log(`  ${HOSTS[turn.speaker]}: ${turn.text}`);

// The checks worth watching: the hosts must alternate for the two-voice player
// to make sense, and stage directions / markdown must not survive into speech.
const alternates = turns.every((t, i) => i === 0 || t.speaker !== turns[i - 1].speaker);
const clean = turns.every((t) => !/[[*_`#\]]/.test(t.text));
const opensWithMaya = turns[0]?.speaker === 'A';
console.log('');
console.log(`alternating speakers? ${alternates ? 'yes' : 'NO — the two voices would collide'}`);
console.log(`free of markup?       ${clean ? 'yes' : 'NO — TTS would read the symbols aloud'}`);
console.log(`opens with Maya?      ${opensWithMaya ? 'yes' : 'no (brief says she opens)'}`);
process.exitCode = turns.length > 0 && alternates && clean ? 0 : 1;
