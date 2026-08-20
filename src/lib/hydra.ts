// HydraDB Cloud client — the graph/context layer behind Ask, Memory and Quiz.
//
// One endpoint does everything: POST /query returns the matching note chunks
// AND the graph triples that connect them. Retrieval and graph traversal are
// the same call, so there is no separate "build the graph" step — ingestion
// derives entities, predicates and edges from the note text itself.
//
// This is the only module that should hold the base URL or the API key.

/** A node in the derived graph. `entityId` is stable across documents. */
export type HydraEntity = {
  entityId: string;
  name: string;
  /** Grouping HydraDB inferred, e.g. "concepts", "locations". */
  namespace: string;
  /** Entity class it inferred, e.g. "CONCEPT", "LOCATION". */
  type: string;
};

/** One edge, with the sentence that justifies it. */
export type HydraRelation = {
  /** Normalised predicate ("depends on"), used for traversal. */
  predicate: string;
  /** Predicate exactly as it appeared in the note. */
  rawPredicate: string;
  /** The sentence the edge was drawn from — shown as edge evidence in the UI. */
  context: string;
  /** Chunk the edge came from, so an edge can cite its note. */
  chunkId: string;
  timestamp: number | null;
};

/** source —predicate→ target, the unit of graph reasoning. */
export type HydraTriple = {
  source: HydraEntity;
  relation: HydraRelation;
  target: HydraEntity;
};

/** Which lane a chunk came out of. The wire calls saved material "document" and
 *  observations "memory"; carrying the distinction on the chunk is what stops a
 *  quiz failure being quoted back as if the student had written it down. */
export type HydraSourceType = 'document' | 'memory';

/** A retrieved slice of a note, before it becomes a RetrievalHit. */
export type HydraChunk = {
  chunkId: string;
  /** Source document id — maps to a ReadIQ note. */
  sourceId: string;
  title: string;
  text: string;
  score: number;
  /** Lane it came from — never assume, `type: "all"` mixes both freely. */
  sourceType: HydraSourceType;
  /** ISO time the source was last written. Two claims that disagree are ordered
   *  by this, so a memory can supersede the note it contradicts. */
  updatedAt: string;
};

export type HydraResult = {
  chunks: HydraChunk[];
  /** Multi-hop paths the query traversed. */
  paths: HydraTriple[];
  /** Edges linking retrieved chunks to each other. */
  relations: HydraTriple[];
};

export type HydraQueryOptions = {
  /** "all" searches knowledge + memory; narrow it when you know which you want. */
  type?: 'all' | 'knowledge' | 'memory';
  /** "fast" trades depth for latency — worth it on interactive screens. */
  mode?: 'fast' | 'thinking' | 'auto';
  maxResults?: number;
  signal?: AbortSignal;
};

const BASE_URL = process.env.EXPO_PUBLIC_HYDRA_BASE_URL ?? 'https://api.hydradb.com';
const API_KEY =
  process.env.EXPO_PUBLIC_HYDRA_API_KEY ?? process.env.EXPO_PUBLIC_HYDRA_KEY ?? '';
const DATABASE = process.env.EXPO_PUBLIC_HYDRA_DATABASE ?? 'default-tenant';
const COLLECTION = process.env.EXPO_PUBLIC_HYDRA_COLLECTION ?? 'default-tenant';

/** False when no key is configured — callers fall back to local retrieval. */
export function isHydraConfigured(): boolean {
  return API_KEY.length > 0;
}

// The wire shape is snake_case and deeply nested; everything below narrows it
// to the flat types above so no caller has to know the payload format.

type WireEntity = { entity_id: string; name: string; namespace: string; type: string };
type WireTriplet = {
  source: WireEntity;
  target: WireEntity;
  relation: {
    canonical_predicate?: string;
    raw_predicate?: string;
    context?: string;
    chunk_id?: string;
    timestamp?: number | null;
  };
};

function toEntity(w: WireEntity): HydraEntity {
  return { entityId: w.entity_id, name: w.name, namespace: w.namespace, type: w.type };
}

function toTriples(groups: { triplets?: WireTriplet[] }[] | undefined): HydraTriple[] {
  return (groups ?? []).flatMap((group) =>
    (group.triplets ?? []).map((t) => ({
      source: toEntity(t.source),
      target: toEntity(t.target),
      relation: {
        predicate: t.relation?.canonical_predicate ?? t.relation?.raw_predicate ?? '',
        rawPredicate: t.relation?.raw_predicate ?? '',
        context: t.relation?.context ?? '',
        chunkId: t.relation?.chunk_id ?? '',
        timestamp: t.relation?.timestamp ?? null,
      },
    })),
  );
}

/** One thing the app learned about this student — a quiz result, a changed
 *  deadline, a stated preference. Memories are timestamped, so a later memory
 *  can supersede an earlier one rather than contradict it silently. */
export type HydraMemory = {
  /** Stable id; re-sending the same id updates rather than duplicates. */
  id: string;
  title: string;
  text: string;
};

/** Write memories to the student's Memory lane. Knowledge is what they saved;
 *  memory is what the app observed about them. Kept apart deliberately — a
 *  quiz failure is not a fact about photosynthesis. */
export async function hydraRemember(
  memories: HydraMemory[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isHydraConfigured() || memories.length === 0) return false;

  const form = new FormData();
  form.append('type', 'memory');
  form.append('database', DATABASE);
  form.append('collection', COLLECTION);
  form.append(
    'memories',
    JSON.stringify(memories.map((m) => ({ ...m, infer: true }))),
  );

  const res = await fetch(`${BASE_URL}/context/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'API-Version': '2' },
    body: form,
    signal,
  });
  return res.ok;
}

/** Ask HydraDB a question; get back matching note chunks plus the graph around them. */
export async function hydraQuery(
  query: string,
  opts: HydraQueryOptions = {},
): Promise<HydraResult> {
  const res = await fetch(`${BASE_URL}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'API-Version': '2',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      database: DATABASE,
      collection: COLLECTION,
      query,
      type: opts.type ?? 'all',
      mode: opts.mode ?? 'auto',
      graph_context: true,
      max_results: opts.maxResults ?? 10,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`HydraDB ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const data = json?.data ?? {};

  return {
    chunks: (data.chunks ?? []).map((c: Record<string, unknown>) => ({
      chunkId: String(c.chunk_uuid ?? ''),
      sourceId: String(c.id ?? ''),
      title: String(c.source_title ?? ''),
      text: String(c.chunk_content ?? ''),
      score: Number(c.relevancy_score ?? 0),
      // Anything not explicitly a memory is treated as saved material — the safe
      // default, since the memory lane is the one carrying the quoting rules.
      sourceType: c.source_type === 'memory' ? 'memory' : 'document',
      updatedAt: String(c.source_last_updated_time ?? c.source_upload_time ?? ''),
    })),
    paths: toTriples(data.graph_context?.query_paths),
    relations: toTriples(data.graph_context?.chunk_relations),
  };
}

export type HydraStatus = { ok: boolean; message: string };

/** Settings shows this as an honest status row.
 *
 *  There is no cheap health endpoint, so this *is* a query — a trivial one,
 *  capped to a single result. That makes it a real answer to "can this app read
 *  my notes right now", which a ping to the host would not be: a reachable API
 *  with the wrong collection name looks identical from the outside and returns
 *  nothing for every question the student asks. */
export async function checkHydraConnection(signal?: AbortSignal): Promise<HydraStatus> {
  if (!isHydraConfigured()) {
    return { ok: false, message: 'No HydraDB key — Ask falls back to local search.' };
  }
  try {
    const res = await hydraQuery('readiq connection check', {
      mode: 'fast',
      maxResults: 1,
      signal,
    });
    if (res.chunks.length === 0) {
      // Reachable and authorised, but the collection has nothing in it — the
      // ingest step has not been run against this database yet.
      return { ok: false, message: `Connected, but "${COLLECTION}" has no notes ingested yet.` };
    }
    return { ok: true, message: `Connected to HydraDB · ${COLLECTION}.` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/\b(401|403)\b/.test(detail)) return { ok: false, message: 'Your HydraDB key was rejected.' };
    const status = detail.match(/HydraDB (\d{3})/)?.[1];
    if (status) return { ok: false, message: `HydraDB responded with ${status}.` };
    return { ok: false, message: 'Cannot reach HydraDB. Check your connection.' };
  }
}
