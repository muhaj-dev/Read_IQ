// Retrieval — the gate behind "answers only from your notes".
//
// Two paths behind one signature. The primary path is GRAPH retrieval: HydraDB
// holds a concept graph built from the notes, so a question pulls in chunks that
// are *connected* to it, not only ones that repeat its words — that is what lets
// Ask reach a prerequisite the question never named.
//
// The fallback is LEXICAL retrieval (IDF-weighted keyword overlap), fully local
// and offline. It runs when HydraDB is unconfigured or unreachable, so the app
// degrades instead of failing.
//
// Either way an empty result is the honest "not in your notes", which is what
// stops Ask from answering ungrounded.

import { useNotesStore } from '@/store/use-notes-store';
import type { Note } from '@/types/note';
import type { NoteChunk, RetrievalHit } from '@/types/retrieval';

import { chunkNote } from './chunk';
import { hydraQuery, isHydraConfigured, type HydraChunk } from './hydra';

// --- Grounding gates ---------------------------------------------------------
/** Minimum weighted-overlap score to count as a real match. */
const MIN_SCORE = 0.2;
/** Relative gate: drop chunks below this fraction of the best score. */
const REL_RATIO = 0.55;

// --- Tokenizing + IDF-weighted overlap scoring -------------------------------

// Stopwords carry no topic signal. Includes instructional filler ("explain",
// "define", …) common to exam questions, which would otherwise match anything.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'is',
  'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'by', 'with', 'from', 'into', 'about', 'what', 'which', 'who', 'how', 'why',
  'when', 'where', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'i', 'you',
  'me', 'my', 'we', 'they', 'them', 'their', 'so', 'if', 'then', 'than', 'there',
  // instructional / filler words
  'explain', 'define', 'describe', 'discuss', 'list', 'outline', 'summarize',
  'summarise', 'identify', 'state', 'give', 'tell', 'mention', 'provide', 'show',
  'main', 'also', 'using', 'use', 'used', 'some', 'any', 'many', 'much', 'more',
  'most', 'such', 'each', 'between', 'within', 'during', 'need', 'want', 'get',
]);

/** Light suffix folding so singular/plural & simple inflections match during
 *  retrieval ("communication" ↔ "communications", "studies" ↔ "study"). Only
 *  widens matching — it never invents overlap, so the grounding gate stays honest. */
function foldSuffix(token: string): string {
  if (token.length <= 4) return token; // too short to fold safely
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`; // studies → study
  if (token.endsWith('ss')) return token; // class, process — the 's' isn't a plural
  if (token.endsWith('s')) return token.slice(0, -1); // communications → communication
  return token;
}

/** Lowercase alphanumeric tokens, minus stopwords and single characters, each
 *  suffix-folded so a query matches a note that only differs by plural form. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(foldSuffix);
}

type Idf = { weight: Map<string, number>; fallback: number };

/** IDF across chunks: distinctive terms weigh high, filler low. `fallback` weights
 *  a query term absent from every note (correctly makes matching harder). */
function buildIdf(corpus: string[][]): Idf {
  const df = new Map<string, number>();
  for (const terms of corpus) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = corpus.length;
  const weight = new Map<string, number>();
  for (const [t, d] of df) weight.set(t, Math.log(1 + n / d));
  return { weight, fallback: Math.log(1 + n) };
}

// Weighted-overlap score in [0, 1]: question weight the chunk covers, plus a small
// density nudge. Matching the rare topic word beats matching several filler words.
function scoreChunk(queryTerms: Set<string>, chunkTerms: string[], idf: Idf): number {
  if (queryTerms.size === 0 || chunkTerms.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const t of chunkTerms) counts.set(t, (counts.get(t) ?? 0) + 1);

  let totalWeight = 0;
  let matchedWeight = 0;
  let matchedHits = 0;
  for (const term of queryTerms) {
    const w = idf.weight.get(term) ?? idf.fallback;
    totalWeight += w;
    const c = counts.get(term) ?? 0;
    if (c > 0) {
      matchedWeight += w;
      matchedHits += c;
    }
  }
  if (totalWeight === 0) return 0;

  const coverage = matchedWeight / totalWeight;
  const density = Math.min(matchedHits / chunkTerms.length, 1);
  return coverage * 0.85 + density * 0.15;
}

/** Rank chunks against a question by lexical overlap, keeping only those past the gate. */
export function rankChunks(query: string, chunks: NoteChunk[]): RetrievalHit[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];

  const corpus = chunks.map((chunk) => tokenize(chunk.text));
  const idf = buildIdf(corpus);

  return chunks
    .map((chunk, i) => ({ ...chunk, score: scoreChunk(queryTerms, corpus[i], idf) }))
    .filter((hit) => hit.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/** Lexical top-K over a set of notes: chunk, keyword-rank, apply the absolute +
 *  relative gates. Synchronous — used as the fallback and for not-yet-embedded notes. */
export function lexicalTopK(query: string, notes: Note[], k = 4): RetrievalHit[] {
  const chunks = notes.flatMap(chunkNote);
  const ranked = rankChunks(query, chunks);
  if (ranked.length === 0) return [];
  const cutoff = ranked[0].score * REL_RATIO;
  return ranked.filter((hit) => hit.score >= cutoff).slice(0, k);
}

/** Top-K note chunks for a question, best-first. Returns `[]` when nothing clears the
 *  grounding gate — the caller shows the honest fallback.
 *
 *  Tries the HydraDB graph first and falls back to local keyword matching. Callers
 *  see one signature and never need to know which path answered. */
export async function retrieveTopK(query: string, k = 4): Promise<RetrievalHit[]> {
  const q = query.trim();
  if (!q) return [];

  const { notes } = useNotesStore.getState();

  // Graph-native path: HydraDB walks the concept graph and returns the chunks
  // around the question, not just the ones that share its words. Falls through
  // to the local lexical scorer when unconfigured or unreachable, so the app
  // still answers offline.
  if (isHydraConfigured()) {
    try {
      const { chunks } = await hydraQuery(q, { maxResults: k });
      const hits = chunks.map((c) => toHit(c, notes));
      if (hits.length > 0) return hits.slice(0, k);
    } catch {
      // Fall back rather than surface a network error as "not in your notes".
    }
  }

  if (notes.length === 0) return [];
  return lexicalTopK(q, notes, k);
}

/** Resolve a HydraDB chunk back to a local note so citations stay tappable.
 *  Notes ingested by the app carry their ReadIQ id, but seeded documents only
 *  match on title — those cite by HydraDB's source id and simply don't deep-link. */
function toHit(chunk: HydraChunk, notes: Note[]): RetrievalHit {
  const local =
    notes.find((n) => n.id === chunk.sourceId) ??
    notes.find((n) => n.title.trim().toLowerCase() === chunk.title.trim().toLowerCase());

  return {
    noteId: local?.id ?? chunk.sourceId,
    noteTitle: local?.title ?? chunk.title,
    text: chunk.text,
    score: chunk.score,
  };
}
