// Scan OCR — reading a photo of a page back as text.
//
// This is the one job in readIQ that genuinely needs a model the graph could
// never replace: the words exist only as pixels, so something has to look at
// them. Groq serves one multimodal model, and it does this well.
//
// It is transcription, not interpretation. The prompt asks for the text and
// nothing else — no summarising, no tidying, no filling in a word that is hard
// to read. A student's notes are theirs, including the abbreviations and the
// half-finished sentence at the bottom of the page; a model that "helpfully"
// completes them has changed what they wrote.
//
// A failure here is never fatal: the Scan screen falls back to typing.

import { BtlError } from './btl';
import { fileUriToDataUri } from './files';
import { groqVisionText, VISION_MODEL } from './groq';

/** Ceiling on one page of transcription. A dense A4 page of handwriting is well
 *  under this; past it the photo is a screenshot of a book, not a note. */
const MAX_CHARS = 8000;

/** Zero, because a transcription that varies between runs is a transcription
 *  that is guessing. */
const TEMPERATURE = 0;

/** What the model says when the photo has no readable text. A sentinel rather
 *  than an empty completion, because an empty completion is also what a server
 *  error looks like, and the two need telling apart. */
const NO_TEXT = 'NO_TEXT_FOUND';

const SYSTEM_PROMPT = [
  'You transcribe photographs of study notes — handwritten or printed — into',
  'plain text. You are a transcriber, not an editor.',
  '',
  'Rules:',
  '- Reproduce the text exactly as written, including abbreviations, symbols,',
  '  equations and the student’s own shorthand.',
  '- Never correct spelling, expand an abbreviation, finish an unfinished',
  '  sentence, or add a word that is not visibly on the page.',
  '- Keep the reading order and the line breaks. Keep headings on their own',
  '  line. Render a bullet or dash as "- ".',
  '- If a word is genuinely illegible, write [?] in its place rather than',
  '  guessing what it probably said.',
  '- Do not describe the image, the paper, the handwriting or the layout. Do not',
  '  add a preamble, a heading of your own, or any closing remark.',
  `- If the image contains no readable text at all, reply with exactly ${NO_TEXT}.`,
  '',
  'Reply with the transcribed text only.',
].join('\n');

/** Read the text out of a photographed page.
 *
 *  Returns '' when the image holds no readable text — the Scan screen already
 *  treats that as "we couldn't read this" and offers manual entry, which is the
 *  honest outcome for a blurry shot.
 *
 *  Throws BtlError for real failures (no key, network, auth, credits), which the
 *  same screen surfaces as its friendly error state. */
export async function extractImageText(uri: string, signal?: AbortSignal): Promise<string> {
  // RN cached camera files often report octet-stream, which the vision endpoint
  // rejects — stamp a real image type onto the data URI.
  const dataUri = await fileUriToDataUri(uri, 'image/jpeg');

  const text = await groqVisionText(SYSTEM_PROMPT, dataUri, {
    model: VISION_MODEL,
    temperature: TEMPERATURE,
    signal,
  });

  if (!text || text.trim() === NO_TEXT) return '';
  // A model that ignored the sentinel and narrated its failure instead.
  if (/^(?:i (?:can|could)(?:'|’)?t|sorry|there (?:is|are) no)\b/i.test(text)) return '';

  const trimmed = text.slice(0, MAX_CHARS).trim();
  if (!trimmed) throw new BtlError('server', 'the transcription came back empty');
  return trimmed;
}
