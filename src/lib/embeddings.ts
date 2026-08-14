// Note embeddings — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. Semantic retrieval needs an embedding
// provider, which this build has none of, so these are no-ops: notes save
// normally and Ask falls back to the local, AI-free keyword retrieval in
// `lib/retrieval.ts`.

import type { Note } from '@/types/note';

export { cosineSimilarity } from './chunk';

/** No-op — returns false meaning "not embedded"; callers carry on regardless. */
export async function embedAndStoreNote(_note: Note): Promise<boolean> {
  return false;
}

/** No-op — nothing to sync without an embedding provider. */
export async function syncNoteEmbeddings(_notes: Note[]): Promise<void> {
  // intentionally empty
}
