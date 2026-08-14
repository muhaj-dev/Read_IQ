// PDF text extraction — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. The upload picker, the attachment cards
// and the in-app PDF reader are all real (the reader renders the file itself and
// needs no AI). Pulling selectable text out of a PDF used a vision model, which
// this build has none of. Uploaded .docx files still extract locally — see
// `lib/docx-extract.ts`.

import type { NoteAttachment } from '@/types/note';

import { BtlError } from './btl';

/** Not implemented — PDF text extraction needs a document/vision provider. */
export async function extractPdfText(_attachment: NoteAttachment): Promise<string> {
  throw new BtlError('not-configured');
}

/** Not implemented — see {@link extractPdfText}. */
export async function extractPdfsText(_attachments: NoteAttachment[]): Promise<string> {
  throw new BtlError('not-configured');
}
