// Ingest seed notes into HydraDB as knowledge, then poll until searchable.
//   node scripts/hydra-ingest.mjs                 # every .md in seed/
//   node scripts/hydra-ingest.mjs seed/one.md     # specific files
// `upsert` defaults true server-side, so re-running replaces rather than duplicates.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

function loadEnv(path = '.env') {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const KEY = env.EXPO_PUBLIC_HYDRA_API_KEY || env.EXPO_PUBLIC_HYDRA_KEY;
const BASE = env.EXPO_PUBLIC_HYDRA_BASE_URL || 'https://api.hydradb.com';
const DB = env.EXPO_PUBLIC_HYDRA_DATABASE || 'default-tenant';
const COLLECTION = env.EXPO_PUBLIC_HYDRA_COLLECTION || 'default-tenant';
if (!KEY) { console.error('No API key in .env'); process.exit(1); }

const auth = { Authorization: `Bearer ${KEY}`, 'API-Version': '2' };

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync('seed').filter((f) => f.endsWith('.md')).map((f) => join('seed', f));

const form = new FormData();
form.append('type', 'knowledge');
form.append('database', DB);
form.append('collection', COLLECTION);
// Stable id per file: re-running replaces the source instead of duplicating it,
// and gives the app a predictable handle to cite a note by.
const docIds = files.map((f) => basename(f).replace(/\.md$/, ''));
for (const f of files) {
  form.append('documents', new Blob([readFileSync(f)], { type: 'text/markdown' }), basename(f));
}
form.append('document_metadata', JSON.stringify(docIds.map((id) => ({ id }))));

console.log(`Ingesting ${files.length} file(s) into ${DB}/${COLLECTION}:`);
files.forEach((f) => console.log('  -', f));

const res = await fetch(`${BASE}/context/ingest`, { method: 'POST', headers: auth, body: form });
const json = await res.json().catch(() => null);
console.log(`\nHTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2).slice(0, 1500));
if (!res.ok) process.exit(1);

// Collect whatever ids the response exposes so we can poll them.
const ids = JSON.stringify(json?.data ?? {}).match(/[0-9a-f]{32}/g) ?? [];
const unique = [...new Set(ids)];
if (!unique.length) { console.log('\nNo source ids in response — check status in the dashboard.'); process.exit(0); }

console.log(`\nPolling ${unique.length} source id(s)...`);
// `graph_creation` means chunks are searchable but edges are still forming —
// wait for `completed` or the graph_context comes back thin.
const DONE = ['completed', 'errored', 'failed'];
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const url = `${BASE}/context/status?database=${DB}&collection=${COLLECTION}&ids=${unique.join(',')}`;
  const s = await fetch(url, { headers: auth });
  const body = await s.json().catch(() => null);
  const statuses = JSON.stringify(body?.data ?? body).match(/"indexing_status"\s*:\s*"([a-z_]+)"/g) ?? [];
  console.log(`  [${i}] ${statuses.join(' ') || JSON.stringify(body?.data ?? body).slice(0, 200)}`);
  if (statuses.length && statuses.every((x) => DONE.some((d) => x.includes(d)))) break;
}
console.log('\nDone.');
