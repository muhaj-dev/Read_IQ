// The HTML document for the headless PDF text extractor.
//
// The same pdf.js the PDF Reader already runs ([`pdf-reader-doc.ts`]), minus the
// rendering: no canvas, no annotation layer, no visible page. It walks the pages
// calling `getTextContent()` — the API that returns the PDF's *own* text layer —
// and posts the joined result back over postMessage.
//
// This is why extraction needs no AI. A text PDF already contains its words; a
// vision model would be re-reading pixels of text that is sitting right there,
// slower and less accurately. Vision is only the answer for a scanned PDF, and
// that case is detected here (no text layer) and handed onward.
//
// A pure string builder (no React).

export type PdfExtractDocOptions = {
  /** Raw base64 of the PDF (no data-URI prefix). */
  pdfBase64: string;
  /** pdf.js library + worker (CDN, pinned — same build as the reader). */
  pdfjsUrl: string;
  pdfjsWorkerUrl: string;
  /** Stop after this many pages. */
  maxPages: number;
  /** Stop once the text passes this length. */
  maxChars: number;
};

/** Build the full self-contained extractor page. */
export function buildPdfExtractDocument(opts: PdfExtractDocOptions): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<script>
  var MAX_PAGES = ${JSON.stringify(opts.maxPages)};
  var MAX_CHARS = ${JSON.stringify(opts.maxChars)};

  function post(msg) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }

  function fail(message) {
    post({ type: 'error', message: String(message || 'extraction failed') });
  }

  // base64 → Uint8Array. atob is available in the WebView; the PDF bytes never
  // leave the device (only the pdf.js library itself comes off the CDN).
  function toBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // One page's text, with pdf.js's line geometry turned back into line breaks.
  //
  // getTextContent() returns positioned items, not prose: a heading and the
  // paragraph under it arrive as separate items with no separator, so naive
  // joining glues "Glycolysis" onto "Glucose is split..." as one word. Items
  // carry hasEOL on this build; where they don't, a change in the transform's
  // y-offset is the fallback signal that the line moved.
  function pageText(content) {
    var out = '';
    var lastY = null;
    for (var i = 0; i < content.items.length; i++) {
      var item = content.items[i];
      if (typeof item.str !== 'string') continue;
      var y = item.transform ? item.transform[5] : null;
      var broke = item.hasEOL === true || (lastY !== null && y !== null && Math.abs(y - lastY) > 1);
      if (broke && out && !/\\s$/.test(out)) out += '\\n';
      out += item.str;
      if (item.hasEOL === true && !/\\n$/.test(out)) out += '\\n';
      lastY = y;
    }
    return out;
  }

  async function run() {
    try {
      if (window.__pdfjsFailed || !window.pdfjsLib) {
        fail('pdfjs-unavailable');
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(opts.pdfjsWorkerUrl)};

      var doc = await window.pdfjsLib.getDocument({ data: toBytes(PDF_BASE64) }).promise;
      var pages = Math.min(doc.numPages, MAX_PAGES);
      var parts = [];
      var chars = 0;

      for (var p = 1; p <= pages; p++) {
        var page = await doc.getPage(p);
        var content = await page.getTextContent();
        var text = pageText(content).replace(/[ \\t]+/g, ' ').trim();
        if (text) {
          parts.push(text);
          chars += text.length;
        }
        // Free the page before the next one — a long PDF otherwise holds every
        // page's operator list in memory at once.
        page.cleanup();
        if (chars >= MAX_CHARS) break;
      }

      post({
        type: 'text',
        // Blank line between pages, so the paragraph grouping survives into the note.
        text: parts.join('\\n\\n'),
        pages: pages,
        totalPages: doc.numPages,
        truncated: pages < doc.numPages || chars >= MAX_CHARS,
      });
    } catch (err) {
      fail(err && err.message ? err.message : err);
    }
  }

  window.__onPdfjs = run;
  // pdf.js may already have loaded by the time this script runs.
  if (window.pdfjsLib) run();
  else if (window.__pdfjsFailed) fail('pdfjs-unavailable');
</script>
<script>var PDF_BASE64 = ${JSON.stringify(opts.pdfBase64)};</script>
<script src="${opts.pdfjsUrl}" onload="window.__onPdfjs && window.__onPdfjs()" onerror="window.__pdfjsFailed=true; window.__onPdfjsError && window.__onPdfjsError()"></script>
<script>
  window.__onPdfjsError = function () { fail('pdfjs-unavailable'); };
  if (window.__pdfjsFailed) fail('pdfjs-unavailable');
</script>
</body>
</html>`;
}
