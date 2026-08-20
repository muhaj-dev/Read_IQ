// Memory-lane probe: shows the two lanes separately and the superseding rule
// applied, without needing a simulator.
//
//   node scripts/hydra-memory.mjs                    # the README's exam-date case
//   node scripts/hydra-memory.mjs "krebs cycle"
//
// Mirrors the gates in src/lib/memory.ts, so a disagreement here is a
// disagreement in the app. Reads credentials from .env (not committed).

import { readFileSync } from 'node:fs';

// Kept in step with src/lib/memory.ts.
const MIN_SCORE = 0.45;
const REL_RATIO = 0.65;
const MAX_MEMORIES = 2;

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
const key = env.EXPO_PUBLIC_HYDRA_API_KEY || env.EXPO_PUBLIC_HYDRA_KEY;
if (!key) {
  console.error('Set EXPO_PUBLIC_HYDRA_API_KEY (or EXPO_PUBLIC_HYDRA_KEY) in .env');
  process.exit(1);
}

const question = process.argv.slice(2).join(' ') || 'When is my Week 4 quiz?';

async function query(type, maxResults) {
  const res = await fetch(`${env.EXPO_PUBLIC_HYDRA_BASE_URL || 'https://api.hydradb.com'}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'API-Version': '2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      database: env.EXPO_PUBLIC_HYDRA_DATABASE || 'default-tenant',
      collection: env.EXPO_PUBLIC_HYDRA_COLLECTION || 'default-tenant',
      query: question,
      type,
      mode: 'auto',
      graph_context: false,
      max_results: maxResults,
    }),
  });
  if (!res.ok) {
    console.error(`HydraDB ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const json = await res.json();
  return (json?.data?.chunks ?? []).map((c) => ({
    id: String(c.id ?? ''),
    title: String(c.source_title ?? ''),
    text: String(c.chunk_content ?? ''),
    score: Number(c.relevancy_score ?? 0),
    sourceType: c.source_type === 'memory' ? 'memory' : 'document',
    updatedAt: String(c.source_last_updated_time ?? c.source_upload_time ?? ''),
  }));
}

const clean = (text) => text.split(/\n+Extra context:/)[0].trim();
const oneLine = (text) => clean(text).replace(/\s+/g, ' ').slice(0, 150);

console.log(`> ${question}\n`);

// 1. What Ask retrieves — knowledge only. A memory appearing here is the bug.
const notes = await query('knowledge', 8);
console.log('NOTES (what Ask quotes)');
for (const n of notes.slice(0, 4)) {
  console.log(`  ${n.score.toFixed(3)}  ${n.title}  [${n.sourceType}]  ${n.updatedAt.slice(0, 19)}`);
}
const leaked = notes.filter((n) => n.sourceType === 'memory');
console.log(leaked.length ? `  !! ${leaked.length} memory chunk(s) leaked into notes` : '  ok — no memory in the note lane');

// 2. The memory lane, gated exactly as the app gates it.
const all = await query('memory', 6);
console.log('\nMEMORY (all, with gates applied)');
const ranked = all.filter((m) => m.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
const cutoff = ranked.length ? ranked[0].score * REL_RATIO : 0;
for (const m of all) {
  const why =
    m.score < MIN_SCORE
      ? `dropped: below floor ${MIN_SCORE}`
      : m.score < cutoff
        ? `dropped: below ${REL_RATIO} of best`
        : 'kept';
  console.log(`  ${m.score.toFixed(3)}  ${m.title}  — ${why}`);
}

// 3. Superseding: only memories newer than every note quoted.
const kept = ranked.filter((m) => m.score >= cutoff).slice(0, MAX_MEMORIES);
const newestNote = notes
  .map((n) => n.updatedAt)
  .filter(Boolean)
  .sort()
  .pop();
const superseding = newestNote ? kept.filter((m) => m.updatedAt > newestNote) : kept;

console.log(`\nSUPERSEDING (newer than the newest note, ${newestNote?.slice(0, 19) ?? 'n/a'})`);
if (superseding.length === 0) {
  console.log('  none — the answer shows notes alone');
} else {
  for (const m of superseding) console.log(`  ${m.title}: ${oneLine(m.text)}`);
}

// 4. The answer the student would see.
console.log('\n--- rendered answer ---');
if (notes[0]) console.log(`**${notes[0].title}**\n${oneLine(notes[0].text)}`);
if (superseding.length) {
  console.log('\n**Since you saved that:**\n');
  for (const m of superseding) console.log(`**${m.title}**\n${clean(m.text)}`);
}
