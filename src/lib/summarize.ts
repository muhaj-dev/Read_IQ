// Note summarisation — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. Callers treat a failure here as
// "no summary", so saving a note still works without an AI provider.

import { BtlError } from './btl';

/** Not implemented — callers fall back to saving the note with no AI summary. */
export async function summarizeNoteText(_content: string): Promise<string> {
  throw new BtlError('not-configured');
}
