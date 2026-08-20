// Verify PDF text extraction without booting a simulator.
//
//   node scripts/pdf-extract.mjs              # hand-authored PDF, checks each line
//   node scripts/pdf-extract.mjs some.pdf     # extract a real PDF and print it
//
// The app runs pdf.js inside a WebView, which a Node script has no way to mount.
// So this lifts the page's own `pageText()` straight out of
// src/lib/pdf-extract-doc.ts and runs it against the same pinned pdf.js version
// the WebView loads — testing the code that ships, not a paraphrase of it.
//
// Needs the dev-only pdfjs-dist: npm install

import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pdfjs;
try {
  pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
} catch {
  console.error('pdfjs-dist is not installed — run `npm install` (it is a devDependency).');
  process.exit(1);
}

const SOURCE = 'src/lib/pdf-extract-doc.ts';

/** Lift pageText() out of the shipped builder. It lives inside a TS template
 *  literal, so its escapes are one level deep — undo that to get the real
 *  browser source the WebView evaluates. */
function liftPageText() {
  const src = readFileSync(SOURCE, 'utf8');
  const match = src.match(/function pageText\(content\) \{[\s\S]*?\n {2}\}/);
  if (!match) {
    console.error(`Could not find pageText() in ${SOURCE} — did it get renamed?`);
    process.exit(1);
  }
  return new Function(`${match[0].replace(/\\\\/g, '\\')}; return pageText;`)();
}

// --- A minimal, valid PDF with a real text layer, built here so the expected
// --- output is known exactly rather than assumed.

const FIXTURE = [
  'Glycolysis',
  'Glucose is split into two pyruvate molecules.',
  'The pathway yields 2 ATP and 2 NADH.',
  'It happens in the cytoplasm and needs no oxygen.',
];

function buildFixturePdf(lines) {
  let content = 'BT\n';
  let y = 700;
  lines.forEach((text, i) => {
    const size = i === 0 ? 24 : 14;
    content += `/F1 ${size} Tf\n1 0 0 1 72 ${y} Tm\n(${text}) Tj\n`;
    y -= size * 2;
  });
  content += 'ET\n';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

// --- Run ----------------------------------------------------------------------

const pageText = liftPageText();
const target = process.argv[2];

let bytes;
if (target) {
  bytes = readFileSync(target);
} else {
  bytes = buildFixturePdf(FIXTURE);
  writeFileSync('.pdf-extract-fixture.pdf', bytes);
}

const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
console.log(`pages: ${doc.numPages}`);

const parts = [];
for (let p = 1; p <= doc.numPages; p += 1) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  if (p === 1) {
    const eol = content.items.filter((i) => i.hasEOL === true).length;
    // hasEOL is the primary line-break signal; if a pdf.js bump ever drops it,
    // extraction silently falls back to the y-offset heuristic alone.
    console.log(`items: ${content.items.length}, carrying hasEOL: ${eol}`);
  }
  const text = pageText(content).replace(/[ \t]+/g, ' ').trim();
  if (text) parts.push(text);
  page.cleanup();
}

const text = parts.join('\n\n');
console.log('\n--- extracted ---');
console.log(text);
console.log('--- end ---\n');

if (target) process.exit(0);

// The fixture's expected output is known exactly, so this is a real assertion:
// every line must survive whole AND stay on its own line. The failure this
// guards is the heading gluing onto the paragraph under it — getTextContent()
// returns positioned items with no separators, so naive joining produces
// "GlycolysisGlucose is split...".
const lines = text.split('\n').filter(Boolean);
const exact = lines.length === FIXTURE.length && lines.every((l, i) => l === FIXTURE[i]);
console.log(`lines: ${lines.length} of ${FIXTURE.length} expected`);
console.log(exact ? 'PASS — every line exact and separately broken' : 'FAIL — ' + JSON.stringify(lines));
process.exit(exact ? 0 : 1);
