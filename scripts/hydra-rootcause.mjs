// Prototype of the root-cause traversal behind Weak Topics.
//   node scripts/hydra-rootcause.mjs "calvin cycle" "krebs cycle" "atp synthesis"
//
// Given the concepts a student got wrong, query HydraDB for the graph around
// each, then walk dependency edges upstream to find what they have in common.

import { readFileSync } from 'node:fs';

const env = {};
for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const KEY = env.EXPO_PUBLIC_HYDRA_API_KEY || env.EXPO_PUBLIC_HYDRA_KEY;
const BASE = env.EXPO_PUBLIC_HYDRA_BASE_URL || 'https://api.hydradb.com';
const DB = env.EXPO_PUBLIC_HYDRA_DATABASE || 'default-tenant';
const COLL = env.EXPO_PUBLIC_HYDRA_COLLECTION || 'default-tenant';

// Predicates are derived from the notes' prose, so there is no single
// PREREQUISITE_OF edge. These two sets say which end of an edge is upstream.
const UPSTREAM_IS_TARGET = /^(depends on|requires|needs|based on|built on)/i;
const UPSTREAM_IS_SOURCE = /^(is a prerequisite (for|of)|prerequisite)/i;

const weak = process.argv.slice(2);
if (!weak.length) { console.error('Pass the missed concepts as arguments.'); process.exit(1); }

async function query(q) {
  const r = await fetch(`${BASE}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'API-Version': '2', 'Content-Type': 'application/json' },
    body: JSON.stringify({ database: DB, collection: COLL, query: q, type: 'all', mode: 'auto', graph_context: true, max_results: 10 }),
  });
  const j = await r.json();
  const g = j?.data?.graph_context ?? {};
  return [...(g.query_paths ?? []), ...(g.chunk_relations ?? [])].flatMap((p) => p.triplets ?? []);
}

// upstream name -> Set(downstream name), plus the sentence justifying each edge.
const up = new Map();
const evidence = new Map();
const seen = new Set();

// graph_context is scoped to the question asked, so querying only the failed
// concepts misses prerequisites stated in notes we never asked about. Expand
// the frontier one round: ask about each newly discovered ancestor too.
const asked = new Set();
let frontier = [...weak];

for (let round = 0; round < 2; round++) {
  const discovered = [];

  for (const term of frontier) {
    if (asked.has(term.toLowerCase())) continue;
    asked.add(term.toLowerCase());

    const triples = await query(
      `What does ${term} depend on and what is required to understand it?`,
    );

    for (const t of triples) {
      const pred = t.relation?.canonical_predicate ?? '';
      const a = t.source?.name, b = t.target?.name;
      if (!a || !b) continue;

      let from = null, to = null;
      if (UPSTREAM_IS_TARGET.test(pred)) { from = b; to = a; }
      else if (UPSTREAM_IS_SOURCE.test(pred)) { from = a; to = b; }
      else continue;

      discovered.push(from);
      const k = `${from}>${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!up.has(from)) up.set(from, new Set());
      up.get(from).add(to);
      evidence.set(k, { pred, context: t.relation?.context ?? '' });
    }
  }

  frontier = [...new Set(discovered)].filter((f) => !asked.has(f.toLowerCase()));
}

// Reverse index: downstream -> upstream, for walking backwards.
const parents = new Map();
for (const [from, tos] of up) for (const to of tos) {
  if (!parents.has(to)) parents.set(to, new Set());
  parents.get(to).add(from);
}

function ancestors(name, depth = 4) {
  const out = new Map();
  let frontier = [name.toLowerCase()], d = 0;
  while (frontier.length && d < depth) {
    d++;
    const next = [];
    for (const n of frontier) for (const p of parents.get(n) ?? []) {
      if (!out.has(p)) { out.set(p, d); next.push(p); }
    }
    frontier = next;
  }
  return out;
}

console.log(`dependency edges discovered: ${seen.size}\n`);
[...up].forEach(([f, ts]) => ts.forEach((t) => console.log(`  ${f}  →  ${t}`)));

const tally = new Map();
for (const w of weak) {
  for (const [anc, depth] of ancestors(w)) {
    if (weak.some((x) => x.toLowerCase() === anc)) continue; // a symptom, not a cause
    if (!tally.has(anc)) tally.set(anc, { explains: new Set(), depth });
    tally.get(anc).explains.add(w);
    tally.get(anc).depth = Math.min(tally.get(anc).depth, depth);
  }
}

console.log('\n=== ROOT CAUSES (ranked) ===');
const ranked = [...tally].sort((a, b) =>
  b[1].explains.size - a[1].explains.size || b[1].depth - a[1].depth);
if (!ranked.length) console.log('none found');
for (const [name, info] of ranked.slice(0, 6)) {
  console.log(`\n${name}  — explains ${info.explains.size}/${weak.length} (${[...info.explains].join(', ')}), ${info.depth} hop(s) upstream`);
  for (const [k, v] of evidence) {
    if (k.startsWith(`${name}>`)) { console.log(`    ↳ ${v.context.slice(0, 110)}`); break; }
  }
}
