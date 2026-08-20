// The generation lane, end to end, without booting a simulator.
//
//   node scripts/groq-generate.mjs                        # status + both jobs
//   node scripts/groq-generate.mjs "why is the sky blue"  # beyond-notes only
//
// Covers the three things a model does outside the quiz generator:
//   1. the Settings status rows  (src/lib/groq.ts, src/lib/hydra.ts)
//   2. answerBeyondNotes         (src/lib/beyond.ts)
//   3. summarizeNoteText         (src/lib/summarize.ts)
//
// Prompts, gates and validation are kept in step with those files, so a failure
// here is a failure in the app. Reads credentials from .env (not committed).

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
const groqKey = env.EXPO_PUBLIC_GROQ_API_KEY;
if (!groqKey) {
  console.error('Set EXPO_PUBLIC_GROQ_API_KEY in .env — get one at https://console.groq.com/keys');
  process.exit(1);
}

const GROQ_URL = env.EXPO_PUBLIC_GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = env.EXPO_PUBLIC_GROQ_QUIZ_MODEL || 'openai/gpt-oss-120b';

const HYDRA_URL = env.EXPO_PUBLIC_HYDRA_BASE_URL || 'https://api.hydradb.com';
const hydraKey = env.EXPO_PUBLIC_HYDRA_API_KEY || env.EXPO_PUBLIC_HYDRA_KEY;
const DATABASE = env.EXPO_PUBLIC_HYDRA_DATABASE || 'default-tenant';
const COLLECTION = env.EXPO_PUBLIC_HYDRA_COLLECTION || 'default-tenant';

// --- Kept in step with src/lib/beyond.ts -------------------------------------

const BEYOND_MAX_TOKENS = 1600;
const BEYOND_TEMPERATURE = 0.4;

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

// --- Kept in step with src/lib/summarize.ts ----------------------------------

const MAX_INPUT_CHARS = 12000;
const MIN_INPUT_CHARS = 200;
const MAX_SUMMARY_CHARS = 200;
const SUMMARY_MAX_TOKENS = 2048;
const SUMMARY_TEMPERATURE = 0.2;

const SUMMARY_SYSTEM = [
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

// --- Groq ---------------------------------------------------------------------

async function complete(messages, { json, temperature, maxTokens }) {
  const res = await fetch(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const choice = body.choices?.[0];
  return {
    content: String(choice?.message?.content ?? ''),
    finishReason: choice?.finish_reason ?? null,
  };
}

// --- 1. Status rows -----------------------------------------------------------

async function checkGroq() {
  const res = await fetch(`${GROQ_URL}/models`, { headers: { Authorization: `Bearer ${groqKey}` } });
  if (res.ok) return { ok: true, message: 'Connected to Groq.' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: 'Your Groq API key was rejected.' };
  }
  return { ok: false, message: `Groq responded with ${res.status}.` };
}

async function checkHydra() {
  if (!hydraKey) {
    return { ok: false, message: 'No HydraDB key — Ask falls back to local search.' };
  }
  const res = await fetch(`${HYDRA_URL}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${hydraKey}`,
      'API-Version': '2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      database: DATABASE,
      collection: COLLECTION,
      query: 'readiq connection check',
      type: 'all',
      mode: 'fast',
      graph_context: true,
      max_results: 1,
    }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Your HydraDB key was rejected.' };
    }
    return { ok: false, message: `HydraDB responded with ${res.status}.` };
  }
  const chunks = (await res.json())?.data?.chunks ?? [];
  if (chunks.length === 0) {
    return { ok: false, message: `Connected, but "${COLLECTION}" has no notes ingested yet.` };
  }
  return { ok: true, message: `Connected to HydraDB · ${COLLECTION}.` };
}

// --- 2. answerBeyondNotes -----------------------------------------------------

async function beyond(question) {
  const { content, finishReason } = await complete(
    [
      { role: 'system', content: BEYOND_SYSTEM },
      { role: 'user', content: question },
    ],
    { json: false, temperature: BEYOND_TEMPERATURE, maxTokens: BEYOND_MAX_TOKENS },
  );
  return { text: content.trim(), truncated: finishReason === 'length' };
}

/** The rendering contract from answer-blocks.ts: a whole line of "**Bold**" is a
 *  heading, and a heading followed by prose renders as a note-quote card. A
 *  beyond-notes answer must never produce one — that is the shape the grounded
 *  answer uses for the student's own notes. */
function checkShape(text) {
  const problems = [];
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.some((l) => /^\*\*(.+?)\*\*:?$/.test(l))) problems.push('bold heading line');
  if (lines.some((l) => /^#{1,6}\s/.test(l))) problems.push('markdown heading');
  if (text.includes('```')) problems.push('code fence');
  if (/\|.*\|/.test(text)) problems.push('table');
  if (/\byour notes?\b/i.test(text)) problems.push('claims to read the notes');
  return problems;
}

// --- 3. summarizeNoteText -----------------------------------------------------

function clean(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!text || text.length > MAX_SUMMARY_CHARS) return '';
  return text;
}

async function summarize(content) {
  const text = content.trim();
  if (text.length < MIN_INPUT_CHARS) return '';
  const { content: raw } = await complete(
    [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
    ],
    { json: true, temperature: SUMMARY_TEMPERATURE, maxTokens: SUMMARY_MAX_TOKENS },
  );
  let parsed = {};
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, ''));
  } catch {
    return '';
  }
  return clean(parsed?.summary);
}

// --- Run ----------------------------------------------------------------------

const asked = process.argv.slice(2).join(' ');

const [groqStatus, hydraStatus] = await Promise.all([checkGroq(), checkHydra()]);
console.log('STATUS');
console.log(`  ${groqStatus.ok ? '✓' : '✗'} Quizzes & Transcripts  ${groqStatus.message}`);
console.log(`  ${hydraStatus.ok ? '✓' : '✗'} Notes & Memory         ${hydraStatus.message}`);

const questions = asked
  ? [asked]
  : ['Why is the sky blue?', 'What is the capital of Nigeria?'];

for (const question of questions) {
  console.log(`\nBEYOND  > ${question}`);
  const { text, truncated } = await beyond(question);
  const problems = checkShape(text);
  console.log(
    `        ${problems.length === 0 ? 'shape ok' : `shape PROBLEM: ${problems.join(', ')}`}` +
      `${truncated ? ' · truncated (cut-short note appended)' : ''}`,
  );
  console.log(text.split('\n').map((l) => `        ${l}`).join('\n'));
}

if (asked) process.exit(0);

// Summaries over the seed corpus — real notes, the same text the app extracts.
const seeds = readdirSync('seed').filter((f) => f.endsWith('.md')).slice(0, 3);
console.log('\nSUMMARY');
for (const file of seeds) {
  const body = readFileSync(join('seed', file), 'utf8');
  const summary = await summarize(body);
  const words = summary ? summary.split(/\s+/).length : 0;
  console.log(`  ${file}`);
  console.log(`    ${summary || '(dropped — unusable, note saves with no summary)'}`);
  if (summary) console.log(`    ${words} words${words > 25 ? ' — OVER the 25-word brief' : ''}`);
}

// A note too thin to summarise must never reach Groq at all.
const thin = await summarize('Read chapter 4.');
console.log(`\n  thin note → ${thin === '' ? "'' (skipped, no request made)" : `PROBLEM: "${thin}"`}`);
