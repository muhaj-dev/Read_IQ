// Lecture audio transcription — Whisper on Groq.
//
// Two screens use this: the Record add-note flow (a whole lecture) and the Ask
// composer's tap-to-dictate. Both already treat a throw as "let the student
// type it in", so a failure here never blocks a note or a question.
//
// Like quiz generation, this is generation from the student's own material and
// stays off HydraDB's path entirely — the transcript becomes a note, and only
// then does the graph see it, on ingest, like any other note.

import { groqTranscribe, isGroqConfigured } from './groq';

/** False when no Groq key is configured — the Record flow goes straight to the
 *  manual, editable transcript instead of failing at it. */
export function isTranscriptionConfigured(): boolean {
  return isGroqConfigured();
}

/** Transcribe a local recording. Returns '' for silence — callers show their
 *  "couldn't catch that" state rather than saving an empty note. */
export async function transcribeAudio(uri: string, signal?: AbortSignal): Promise<string> {
  return groqTranscribe(uri, { signal });
}
