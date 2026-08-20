// Generate a quiz from seed notes without booting a simulator.
//   node scripts/groq-quiz.mjs                       # all Biology seed notes, 5 questions
//   node scripts/groq-quiz.mjs 10 chem-              # 10 questions from seed/chem-*.md
// Mirrors src/lib/quizgen.ts — same prompt, same validation — so a failure here
// is a failure in the app. Reads EXPO_PUBLIC_GROQ_API_KEY from .env.

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

const count = Number(process.argv[2]) || 5;
const prefix = process.argv[3] || 'bio';

const files = readdirSync('seed').filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
if (files.length === 0) {
  console.error(`No seed notes matching "${prefix}*".`);
  process.exit(1);
}

// Same shape combineContent() builds in the app: "# Title" per note.
const content = files
  .map((f) => {
    const body = readFileSync(join('seed', f), 'utf8').trim();
    return body.startsWith('#') ? body : `# ${f.replace(/\.md$/, '')}\n${body}`;
  })
  .join('\n\n');

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

const t0 = Date.now();
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    temperature: 0.3,
    max_tokens: Math.min(8192, 700 + count * 320),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Subject: seed corpus',
          `Write ${count} multiple-choice questions from the notes below.`,
          '--- NOTES ---',
          content.slice(0, 24000),
        ].join('\n\n'),
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`Groq ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const json = await res.json();
const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '{}');
const raw = Array.isArray(parsed.questions) ? parsed.questions : [];

// The app's validation, verbatim in spirit: anything malformed is dropped, not patched.
const LETTERS = ['A', 'B', 'C', 'D'];
const kept = [];
const dropped = [];
for (const q of raw) {
  const options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? '').trim()) : [];
  const index =
    Number.isInteger(q.answer_index) ? q.answer_index : LETTERS.indexOf(String(q.answer).toUpperCase());
  const ok =
    String(q.prompt ?? '').trim() &&
    String(q.topic ?? '').trim() &&
    options.length === 4 &&
    options.every(Boolean) &&
    new Set(options.map((o) => o.toLowerCase())).size === 4 &&
    index >= 0 &&
    index <= 3;
  (ok ? kept : dropped).push(q);
}

console.log(`${MODEL} · ${files.length} notes · ${Date.now() - t0}ms`);
console.log(`${kept.length}/${raw.length} questions passed validation` + (dropped.length ? ` (${dropped.length} dropped)` : ''));
console.log(`tokens: ${json.usage?.total_tokens ?? '?'}\n`);

kept.forEach((q, i) => {
  const index = Number.isInteger(q.answer_index)
    ? q.answer_index
    : LETTERS.indexOf(String(q.answer).toUpperCase());
  console.log(`${i + 1}. [${q.topic}] ${q.prompt}`);
  q.options.forEach((o, j) => console.log(`   ${LETTERS[j]}${j === index ? ' ✓' : ' '} ${o}`));
  if (q.explanation) console.log(`   → ${q.explanation}`);
  console.log(`   source: ${q.source_title ?? '(none)'}\n`);
});
