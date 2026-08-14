// Lecture audio transcription — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. Recording, the waveform, the timer and
// the editable-transcript screen are all real; turning the audio into text needs
// a speech-to-text provider, which this build has none of. The Record flow
// already falls back to a manual, editable transcript when this is unavailable.

import { BtlError } from './btl';

/** Always false here — no speech-to-text credentials exist in the UI-only build. */
export function isTranscriptionConfigured(): boolean {
  return false;
}

/** Not implemented — Record falls back to a manual, editable transcript. */
export async function transcribeAudio(_uri: string): Promise<string> {
  throw new BtlError('not-configured');
}
