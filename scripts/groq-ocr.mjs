// Verify Scan OCR against the live vision model, without booting a simulator.
//
//   node scripts/groq-ocr.mjs              # renders a known page, checks it round-trips
//   node scripts/groq-ocr.mjs photo.jpg    # transcribe a real photo and print it
//
// Same prompt and same post-processing as src/lib/ocr.ts, so a failure here is a
// failure in the app. Reads EXPO_PUBLIC_GROQ_API_KEY from .env.
//
// With no argument it draws its own test page from a built-in bitmap font. That
// is the point: the expected text is known EXACTLY, so "did it transcribe or did
// it paraphrase" is a real assertion rather than a judgement call.

import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

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

// --- Kept in step with src/lib/ocr.ts ----------------------------------------

const VISION_MODEL = 'qwen/qwen3.6-27b';
const MAX_CHARS = 8000;
const TEMPERATURE = 0;
const NO_TEXT = 'NO_TEXT_FOUND';

const SYSTEM_PROMPT = [
  'You transcribe photographs of study notes — handwritten or printed — into',
  'plain text. You are a transcriber, not an editor.',
  '',
  'Rules:',
  '- Reproduce the text exactly as written, including abbreviations, symbols,',
  '  equations and the student’s own shorthand.',
  '- Never correct spelling, expand an abbreviation, finish an unfinished',
  '  sentence, or add a word that is not visibly on the page.',
  '- Keep the reading order and the line breaks. Keep headings on their own',
  '  line. Render a bullet or dash as "- ".',
  '- If a word is genuinely illegible, write [?] in its place rather than',
  '  guessing what it probably said.',
  '- Do not describe the image, the paper, the handwriting or the layout. Do not',
  '  add a preamble, a heading of your own, or any closing remark.',
  `- If the image contains no readable text at all, reply with exactly ${NO_TEXT}.`,
  '',
  'Reply with the transcribed text only.',
].join('\n');

/** The <think> block the vision model emits ahead of every answer. */
function stripThinking(text) {
  if (!text.includes('<think>')) return text.trim();
  const closed = text.lastIndexOf('</think>');
  return closed === -1 ? '' : text.slice(closed + '</think>'.length).trim();
}

// --- A test page, drawn from a 5x7 font so its text is known exactly ----------

const FONT = {
  A: '01110,10001,10001,11111,10001,10001,10001',
  B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111',
  F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01110',
  H: '10001,10001,10001,11111,10001,10001,10001',
  I: '11111,00100,00100,00100,00100,00100,11111',
  J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001',
  L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001',
  N: '10001,11001,10101,10011,10001,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101',
  R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110',
  T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001',
  X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100',
  Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110',
  1: '00100,01100,00100,00100,00100,00100,01110',
  2: '01110,10001,00001,00110,01000,10000,11111',
  3: '11110,00001,00001,01110,00001,00001,11110',
  4: '00010,00110,01010,10010,11111,00010,00010',
  5: '11111,10000,11110,00001,00001,10001,01110',
  6: '01110,10001,10000,11110,10001,10001,01110',
  7: '11111,00001,00010,00100,01000,01000,01000',
  8: '01110,10001,10001,01110,10001,10001,01110',
  9: '01110,10001,10001,01111,00001,10001,01110',
  '.': '00000,00000,00000,00000,00000,01100,01100',
  ',': '00000,00000,00000,00000,01100,01100,11000',
  '-': '00000,00000,00000,11111,00000,00000,00000',
  ':': '00000,01100,01100,00000,01100,01100,00000',
  ' ': '00000,00000,00000,00000,00000,00000,00000',
};

const SCALE = 5;
const PAD = 24;
const GAP = 1;

function renderPng(lines) {
  const cols = Math.max(...lines.map((l) => l.length));
  const W = PAD * 2 + cols * (5 + GAP) * SCALE;
  const H = PAD * 2 + lines.length * (7 + 4) * SCALE;
  const px = Buffer.alloc(W * H * 3, 0xff);

  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 3;
    px[o] = px[o + 1] = px[o + 2] = 0;
  };

  lines.forEach((line, li) => {
    [...line.toUpperCase()].forEach((ch, ci) => {
      const glyph = (FONT[ch] ?? FONT[' ']).split(',');
      glyph.forEach((row, ry) => {
        [...row].forEach((bit, rx) => {
          if (bit !== '1') return;
          const bx = PAD + ci * (5 + GAP) * SCALE + rx * SCALE;
          const by = PAD + li * (7 + 4) * SCALE + ry * SCALE;
          for (let dy = 0; dy < SCALE; dy += 1)
            for (let dx = 0; dx < SCALE; dx += 1) set(bx + dx, by + dy);
        });
      });
    });
  });

  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y += 1) {
    raw[y * (1 + W * 3)] = 0;
    px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }

  const table = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Run ----------------------------------------------------------------------

const FIXTURE = [
  'GLYCOLYSIS',
  'SPLITS GLUCOSE INTO 2 PYRUVATE',
  'NET YIELD 2 ATP AND 2 NADH',
  'HAPPENS IN THE CYTOPLASM',
];

const target = process.argv[2];
let bytes;
let mime = 'image/png';

if (target) {
  bytes = readFileSync(target);
  if (/\.jpe?g$/i.test(target)) mime = 'image/jpeg';
} else {
  bytes = renderPng(FIXTURE);
  writeFileSync('.ocr-fixture.png', bytes);
  console.log(`rendered a ${FIXTURE.length}-line test page → .ocr-fixture.png\n`);
}

const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: VISION_MODEL,
    temperature: TEMPERATURE,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SYSTEM_PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` },
          },
        ],
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`Groq ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const body = await res.json();
const rawContent = body.choices?.[0]?.message?.content ?? '';
const thought = rawContent.includes('<think>');
const text = stripThinking(rawContent).slice(0, MAX_CHARS).trim();

console.log(`model emitted a <think> block? ${thought ? 'yes — stripped' : 'no'}`);
console.log('\n--- transcribed ---');
console.log(text === NO_TEXT ? '(NO_TEXT_FOUND → app returns empty, Scan offers manual entry)' : text);
console.log('--- end ---\n');

if (target) process.exit(0);

// The assertion that matters: every line must come back verbatim. A model that
// "helpfully" tidies a student's shorthand has changed what they wrote, and that
// is worse than not reading it at all.
const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
const exact = lines.length === FIXTURE.length && lines.every((l, i) => l.toUpperCase() === FIXTURE[i]);
console.log(`lines: ${lines.length} of ${FIXTURE.length} expected`);
console.log(exact ? 'PASS — transcribed verbatim, nothing added or corrected' : `FAIL — ${JSON.stringify(lines)}`);
process.exitCode = exact ? 0 : 1;
