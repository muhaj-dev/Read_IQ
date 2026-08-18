// Root-cause analysis for Weak Topics — the graph-native half of the feature.
//
// A flat list of missed topics tells a student what they failed. It cannot tell
// them WHY. This walks the concept graph backwards from each missed topic and
// finds what they share upstream, which is often a topic the quiz never covered
// and sometimes sits in a different subject entirely.
//
// Two rules make the traversal honest:
//
// 1. Only *learning prerequisites* compose. "Krebs cycle produces ATP" and
//    "Calvin cycle requires ATP" are both true, but chaining them would claim
//    you must study Krebs to understand Calvin — material flow is not a
//    prerequisite, so those predicates are deliberately excluded.
//
// 2. Every cause carries the sentence that justifies it. A root cause the
//    student cannot verify against their own notes is not worth showing.

import { hydraQuery, isHydraConfigured, type HydraTriple } from './hydra';

/** Predicates where the TARGET is the prerequisite ("A depends on B" → B first). */
const UPSTREAM_IS_TARGET = /^(depends on|requires|needs|based on|built on)/i;
/** Predicates where the SOURCE is the prerequisite ("A is a prerequisite for B"). */
const UPSTREAM_IS_SOURCE = /^(is a prerequisite (for|of)|prerequisite)/i;

/** How far upstream to walk before giving up. */
const MAX_DEPTH = 4;
/** Rounds of frontier expansion. graph_context is scoped to the question asked,
 *  so one round only sees prerequisites named in the topics' own notes. */
const EXPANSION_ROUNDS = 2;

export type RootCause = {
  /** The upstream concept, e.g. "redox reactions". */
  concept: string;
  /** Which of the missed topics this concept sits underneath. */
  explains: string[];
  /** Hops from the nearest missed topic — bigger means more foundational. */
  depth: number;
  /** The sentence from the student's notes that justifies the link. */
  evidence: string;
};

type Edge = { from: string; to: string; context: string };

function directedEdge(t: HydraTriple): Edge | null {
  const pred = t.relation.predicate;
  const a = t.source.name;
  const b = t.target.name;
  if (!a || !b) return null;

  if (UPSTREAM_IS_TARGET.test(pred)) return { from: b, to: a, context: t.relation.context };
  if (UPSTREAM_IS_SOURCE.test(pred)) return { from: a, to: b, context: t.relation.context };
  return null;
}

/** Ancestors of `name` with their hop distance, walking prerequisite edges backwards. */
function ancestorsOf(name: string, parents: Map<string, Set<string>>): Map<string, number> {
  const out = new Map<string, number>();
  let frontier = [name.toLowerCase()];

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const parent of parents.get(node) ?? []) {
        if (out.has(parent)) continue;
        out.set(parent, depth);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return out;
}

/** What the missed topics have in common, most-explanatory first. Returns `[]`
 *  when HydraDB is unavailable — the caller keeps showing the plain topic list. */
export async function findRootCauses(
  missedTopics: string[],
  signal?: AbortSignal,
): Promise<RootCause[]> {
  if (!isHydraConfigured() || missedTopics.length === 0) return [];

  const edges = new Map<string, Edge>();
  const asked = new Set<string>();
  let frontier = [...missedTopics];

  for (let round = 0; round < EXPANSION_ROUNDS; round += 1) {
    const discovered: string[] = [];

    for (const term of frontier) {
      const key = term.toLowerCase();
      if (asked.has(key)) continue;
      asked.add(key);

      let triples: HydraTriple[];
      try {
        const result = await hydraQuery(
          `What does ${term} depend on and what is required to understand it?`,
          { signal },
        );
        triples = [...result.paths, ...result.relations];
      } catch {
        continue; // one failed hop shouldn't lose the whole analysis
      }

      for (const triple of triples) {
        const edge = directedEdge(triple);
        if (!edge) continue;
        discovered.push(edge.from);
        const id = `${edge.from}>${edge.to}`;
        if (!edges.has(id)) edges.set(id, edge);
      }
    }

    frontier = [...new Set(discovered)].filter((f) => !asked.has(f.toLowerCase()));
  }

  // downstream -> its prerequisites, for walking backwards.
  const parents = new Map<string, Set<string>>();
  for (const edge of edges.values()) {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set());
    parents.get(edge.to)!.add(edge.from);
  }

  const missedSet = new Set(missedTopics.map((t) => t.toLowerCase()));
  const tally = new Map<string, { explains: Set<string>; depth: number }>();

  for (const topic of missedTopics) {
    for (const [concept, depth] of ancestorsOf(topic, parents)) {
      if (missedSet.has(concept)) continue; // a symptom, not a cause
      const entry = tally.get(concept) ?? { explains: new Set<string>(), depth };
      entry.explains.add(topic);
      entry.depth = Math.min(entry.depth, depth);
      tally.set(concept, entry);
    }
  }

  return [...tally.entries()]
    .map(([concept, info]) => ({
      concept,
      explains: [...info.explains],
      depth: info.depth,
      evidence: [...edges.values()].find((e) => e.from === concept)?.context ?? '',
    }))
    // Explaining more failures wins; ties break toward the more foundational cause.
    .sort((a, b) => b.explains.length - a.explains.length || b.depth - a.depth)
    .filter((cause) => cause.explains.length > 1 || cause.depth > 1);
}
