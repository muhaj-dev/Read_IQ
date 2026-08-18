// One-off probe: run a HydraDB query and dump the raw response shape.
//   node scripts/hydra-probe.mjs "your question here"
// Reads credentials from .env (not committed).

import { readFileSync } from 'node:fs';

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
// Accept either name — both spellings have been used in .env.example.
const key = env.EXPO_PUBLIC_HYDRA_API_KEY || env.EXPO_PUBLIC_HYDRA_KEY;
if (!key) {
  console.error('Set EXPO_PUBLIC_HYDRA_API_KEY (or EXPO_PUBLIC_HYDRA_KEY) in .env');
  process.exit(1);
}

const question =
  process.argv.slice(2).join(' ') ||
  'What do I need to understand before the Calvin cycle?';

const body = {
  database: env.EXPO_PUBLIC_HYDRA_DATABASE || 'default-tenant',
  collection: env.EXPO_PUBLIC_HYDRA_COLLECTION || 'default-tenant',
  query: question,
  type: 'all',
  mode: 'auto',
  graph_context: true,
  max_results: 10,
};

console.error(`> ${question}\n`);

const res = await fetch(`${env.EXPO_PUBLIC_HYDRA_BASE_URL || 'https://api.hydradb.com'}/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'API-Version': '2',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.error(`HTTP ${res.status}\n`);
try {
  // Pretty-print so the response shape is readable.
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
