// Keeping HydraDB's knowledge lane in step with the saved notes.
//
// Ask's graph path can only reach a note that has been ingested. Until this
// existed, nothing in the app ever wrote a note to HydraDB — only the seed
// corpus, pushed once by `scripts/hydra-ingest.mjs` — so every question about a
// note the student wrote on-device fell through to local keyword matching at
// best, and to "I don't have that in your notes yet" at worst.
//
// Ingestion is fire-and-forget on purpose: a save must never wait on the
// network, and a note that fails to reach the graph is still fully answerable
// through `lexicalTopK`. The ledger below is what makes retrying free.

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Note } from '@/types/note';

import { noteSearchableText } from './chunk';
import { hydraIngestDocuments, isHydraConfigured, type HydraDocument } from './hydra';

/** noteId → hash of the searchable text last accepted by HydraDB. */
const LEDGER_KEY = 'readiq.graph-sync.v1';

/** One ingest call carries at most this many notes, so a first-launch backfill
 *  of a large library doesn't become one enormous multipart upload. */
const BATCH = 10;

/** djb2 over the searchable text — enough to answer "did this note change since
 *  we last sent it", which is all the ledger is for. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function readLedger(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(LEDGER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    // A corrupt ledger just means everything looks unsynced — safe, since
    // ingest upserts by note id and a re-send replaces rather than duplicates.
    return {};
  }
}

async function writeLedger(ledger: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Losing the ledger costs a redundant upload next launch, nothing more.
  }
}

function toDocument(note: Note): HydraDocument {
  // The same projection retrieval chunks from, so the graph indexes exactly the
  // text a local citation would quote — title and subject included.
  return { id: note.id, title: note.title, text: noteSearchableText(note) };
}

/** Push the notes HydraDB hasn't seen (or has seen an older version of).
 *  Silent and non-blocking — callers `void` this. */
export async function syncNotesToGraph(notes: Note[]): Promise<void> {
  if (!isHydraConfigured() || notes.length === 0) return;

  const ledger = await readLedger();
  const stale = notes.filter((n) => {
    const text = noteSearchableText(n).trim();
    return text.length > 0 && ledger[n.id] !== hashText(text);
  });
  if (stale.length === 0) return;

  // A failed batch stops the run but keeps the batches before it — they really
  // did land, and the ledger is written either way so they aren't re-uploaded.
  // Only the unrecorded notes stay queued for the next save or launch.
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    try {
      const ok = await hydraIngestDocuments(batch.map(toDocument));
      if (!ok) break; // Rejected — leave these unrecorded so the next attempt retries.
      for (const note of batch) ledger[note.id] = hashText(noteSearchableText(note).trim());
    } catch (err) {
      // Offline or unreachable. The note is saved locally and still answerable
      // lexically, so this is a quiet retry rather than a user-facing failure.
      console.warn('[note-graph] ingest failed, will retry', String(err));
      break;
    }
  }

  await writeLedger(ledger);
}

/** Push a single note after a save or an edit. */
export async function syncNoteToGraph(note: Note): Promise<void> {
  return syncNotesToGraph([note]);
}

/** Forget a deleted note so a later note reusing its id can't be skipped as
 *  already-synced. (HydraDB exposes no delete, so the copy there goes stale —
 *  retrieval resolves chunks against the local store, so it stops being cited.) */
export async function forgetNoteInGraph(noteId: string): Promise<void> {
  const ledger = await readLedger();
  if (!(noteId in ledger)) return;
  delete ledger[noteId];
  await writeLedger(ledger);
}
