// Grounded Ask ★ — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. The retrieval gate below is real (it is
// plain local keyword matching over saved notes, no AI), so the honest
// "no notes yet" path still works and citations are still built from real notes.
// Generating the answer itself requires an AI provider, which this build has none
// of — those calls raise BtlError('not-configured') and the Ask screen renders its
// friendly not-set-up state.
//
// To wire this up later: replace the throw sites with a real completion call.

import type { Citation } from '@/types/chat';

import { BtlError } from './btl';
import { retrieveTopK } from './retrieval';

/** The decline sentence — used identically as prompt instruction, fallback, and detector. */
export const NOT_IN_NOTES = "I don't have that in your notes yet.";

/** Shown when the student hasn't saved a single note yet (nudge to add one). */
export const NO_NOTES_YET =
  "You haven't saved any notes yet. Add your first note and I'll answer straight from it.";

/** How many note chunks would feed the answer. */
const RETRIEVE_K = 8;

export type AskResult = {
  /** True only when a real answer was drawn from retrieved notes. */
  grounded: boolean;
  content: string;
  citations: Citation[];
  /** Hit the length cap mid-answer — UI offers "Generate more". */
  truncated: boolean;
};

/** Retrieval gate: real, local, AI-free. Returns null when nothing is saved. */
async function gate(question: string): Promise<AskResult | null> {
  const hits = await retrieveTopK(question, RETRIEVE_K);
  if (hits.length === 0) {
    return { grounded: false, content: NO_NOTES_YET, citations: [], truncated: false };
  }
  return null;
}

/** Not implemented — retrieval runs, answer generation needs an AI provider. */
export async function askFromNotes(
  question: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<AskResult> {
  const empty = await gate(question);
  if (empty) return empty;
  throw new BtlError('not-configured');
}

export type ContinueResult = AskResult & {
  /** Model signalled there is nothing further to add — UI retires "Generate more". */
  exhausted: boolean;
};

/** Not implemented in the UI-only build. */
export async function continueAnswer(
  _question: string,
  _priorAnswer: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<ContinueResult> {
  throw new BtlError('not-configured');
}

export type BeyondResult = { content: string; truncated: boolean };

/** Not implemented in the UI-only build. */
export async function answerBeyondNotes(
  _question: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  throw new BtlError('not-configured');
}

export type ImageAskResult = AskResult & { fromImage: true };

/** Not implemented in the UI-only build. */
export async function answerImageGrounded(
  _question: string,
  _imageText: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<ImageAskResult | null> {
  throw new BtlError('not-configured');
}

/** Not implemented in the UI-only build. */
export async function answerImageOpen(
  _question: string,
  _imageText: string,
  _opts: { onToken?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<BeyondResult> {
  throw new BtlError('not-configured');
}
