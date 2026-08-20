// The pinned pdf.js build, shared by the two places that run it: the PDF Reader
// ([`pdf-reader-doc.ts`]) and the headless text extractor ([`pdf-extract-doc.ts`]).
//
// One pin, one file. The reader renders pages and the extractor reads their text
// layer, but they are the same library and drifting between two versions would
// mean a PDF that displays correctly and extracts wrongly.

/** pdf.js UMD build, pinned (exposes window.pdfjsLib + renderTextLayer). The PDF
 *  itself never leaves the device — only this viewer library loads from the CDN. */
export const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
export const PDFJS_WORKER_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/** Pages read from one PDF. A lecture deck or a chapter scan sits far below this;
 *  a whole textbook is not a note, and reading 600 pages to make one would cost
 *  the student a long freeze for something they cannot use. */
export const PDFJS_MAX_PAGES = 120;

/** Character ceiling, checked per page. Roughly a long chapter — comfortably more
 *  than the 24k a quiz reads and the 12k a summary reads, so the cap bites the
 *  textbook case and nothing else. */
export const PDFJS_MAX_CHARS = 150_000;
