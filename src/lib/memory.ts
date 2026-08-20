// The memory lane — what the app observed, kept apart from what the student saved.
//
// Two lanes live in HydraDB under one collection: notes are knowledge, and quiz
// misses, moved deadlines and stated preferences are memory. `type: "all"` mixes
// them, which is why Ask asks for "knowledge" only (see retrieval.ts) and why
// memory is read here, on its own terms, with its own rules.
//
// The rules exist because the two lanes mean different things. A note is a claim
// the student wrote down; a memory is a claim the app made about them, and it is
// usually *later*. So a memory never joins the quoted answer — it appears beneath
// it, attributed, and only when it is both on-topic and newer than the notes that
// were quoted. That is the whole superseding rule: the note still shows, because
// the student wrote it and deserves to see it, and the memory shows after it,
// because it is what is true now.

import { hydraQuery, isHydraConfigured } from './hydra';
import type { RetrievalHit } from '@/types/retrieval';

// --- Gates -------------------------------------------------------------------
// Calibrated against the live collection. An off-topic question ("who won the
// 1998 world cup") scores every memory below 0.20; a near-miss ("what is the
// calvin cycle", when no memory concerns it) peaks at 0.32; a genuine hit starts
// at 0.46. Scores are normalised per result set, so these only hold for a
// memory-only query — a memory's score in a `type: "all"` response is not
// comparable to the same chunk's score here, and must not be gated against.

/** Absolute floor: below this the memory is not about the question. */
const MIN_SCORE = 0.45;
/** Relative gate — stricter than retrieval's, because a memory is an aside and a
 *  weak one reads as the app changing the subject. */
const REL_RATIO = 0.65;
/** Two is already a lot to append to an answer. */
const MAX_MEMORIES = 2;

/** One thing the app observed, ready to show. */
export type MemoryHit = {
  id: string;
  title: string;
  text: string;
  score: number;
  /** ISO time it was written — the basis for "newer wins". */
  updatedAt: string;
};

/** Strip the trailing restatement HydraDB appends on ingest. It is the same claim
 *  said twice, which reads as a stutter when the memory is shown verbatim. */
function clean(text: string): string {
  return text.split(/\n+Extra context:/)[0].trim();
}

/** On-topic memories for a question, best first. `[]` when HydraDB is unconfigured,
 *  unreachable, or simply has nothing to say — all three mean "show no aside". */
export async function recallMemories(
  question: string,
  signal?: AbortSignal,
): Promise<MemoryHit[]> {
  const q = question.trim();
  if (!q || !isHydraConfigured()) return [];

  let chunks;
  try {
    ({ chunks } = await hydraQuery(q, { type: 'memory', maxResults: 6, signal }));
  } catch {
    // An aside is not worth failing an answer over.
    return [];
  }

  const ranked = chunks
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];

  const cutoff = ranked[0].score * REL_RATIO;
  const seen = new Set<string>();

  return ranked
    .filter((c) => c.score >= cutoff)
    .filter((c) => (seen.has(c.sourceId) ? false : seen.add(c.sourceId) && true))
    .slice(0, MAX_MEMORIES)
    .map((c) => ({
      id: c.sourceId,
      title: c.title,
      text: clean(c.text),
      score: c.score,
      updatedAt: c.updatedAt,
    }));
}

/** Keep only the memories that are newer than every note the answer quoted.
 *
 *  A memory older than the notes has already been accounted for — the student
 *  wrote the note afterwards, so the note is the newer word and appending the
 *  memory would contradict them with stale information. Undated hits count as
 *  older than nothing: a lexical (offline) hit carries no timestamp, and in that
 *  case no memory was retrievable anyway. */
export function supersedingMemories(memories: MemoryHit[], hits: RetrievalHit[]): MemoryHit[] {
  const newest = hits
    .map((h) => h.updatedAt)
    .filter((t): t is string => Boolean(t))
    .sort()
    .pop();
  if (!newest) return memories;
  return memories.filter((m) => m.updatedAt > newest);
}
