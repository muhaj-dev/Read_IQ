// PDF text extraction — entirely on-device, and deliberately not an AI call.
//
// A PDF written by Word, LaTeX or Google Docs already carries its own text
// layer; pdf.js reads it back with `getTextContent()`. Sending those pages to a
// vision model would be paying to re-read pixels of text that is already in the
// file, slower and with more room to be wrong. So this costs nothing per note,
// works offline once pdf.js is cached, and returns the document's real words.
//
// The one PDF this cannot read is a *scanned* one — pages that are photographs
// with no text layer. That is genuinely an OCR problem, and it is reported as
// such (empty text) rather than dressed up as a failure.
//
// The work happens in a hidden WebView; see `store/use-pdf-extract-store.ts` for
// why, and `components/pdf-extract-host.tsx` for the host that runs it.

import { usePdfExtractStore } from '@/store/use-pdf-extract-store';
import type { NoteAttachment } from '@/types/note';

import { BtlError } from './btl';
import { isPdf } from './files';
import { readPdfBase64 } from './pdf-file';

/** Map an extractor failure onto the app's friendly error vocabulary.
 *
 *  `pdfjs-unavailable` is the interesting one: the library loads from a CDN, so
 *  a first-ever PDF opened with no connection fails here. That is a network
 *  problem and says so, rather than blaming the student's file. */
function toBtlError(message: string): BtlError {
  if (message === 'pdfjs-unavailable' || message === 'webview-failed') {
    return new BtlError('network', `pdf.js could not load (${message})`);
  }
  if (message === 'timeout') {
    return new BtlError('server', 'the PDF took too long to read');
  }
  if (/password|encrypt/i.test(message)) {
    return new BtlError('unknown', 'that PDF is password-protected');
  }
  return new BtlError('unknown', message);
}

/** Pull the text out of one PDF attachment.
 *
 *  Returns '' when the PDF has no text layer at all — a scan. Every caller
 *  already treats empty text as "we couldn't read this", which is the honest
 *  outcome and the one the Upload screen has a message for. */
export async function extractPdfText(attachment: NoteAttachment): Promise<string> {
  if (!isPdf(attachment)) return '';

  const base64 = await readPdfBase64(attachment);
  if (!base64) throw new BtlError('unknown', 'could not read the PDF file');

  let result;
  try {
    result = await usePdfExtractStore.getState().enqueue(base64);
  } catch (err) {
    throw toBtlError(err instanceof Error ? err.message : String(err));
  }

  if (result.truncated) {
    console.warn(
      `[pdf] read ${result.pages} of ${result.totalPages} pages — note holds part of the document`,
    );
  }
  return result.text.trim();
}

/** Extract every PDF in pick order, joined. Sequential on purpose: two hidden
 *  WebViews each holding a decoded PDF is the one way this becomes a memory
 *  problem, and a student picking several files is not in a hurry to the
 *  millisecond. */
export async function extractPdfsText(attachments: NoteAttachment[]): Promise<string> {
  const parts: string[] = [];
  for (const attachment of attachments.filter(isPdf)) {
    const text = await extractPdfText(attachment);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}
