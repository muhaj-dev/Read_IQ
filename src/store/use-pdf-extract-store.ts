// The bridge between `extractPdfText()` — a plain async function — and the
// WebView that actually runs pdf.js.
//
// pdf.js needs a DOM, and the only DOM in a React Native app is inside a
// WebView, which is a mounted component rather than something a library function
// can call. So the call side puts a job here and awaits a promise; the host
// component ([`components/pdf-extract-host.tsx`]) watches `active`, runs the
// page, and settles it. One job at a time — the Upload flow extracts documents
// sequentially anyway, and a second hidden WebView would double peak memory on
// exactly the large files that need it least.

import { create } from 'zustand';

/** What the extractor page sends back. */
export type PdfExtraction = {
  text: string;
  /** Pages actually read. */
  pages: number;
  totalPages: number;
  /** Hit the page or character cap — the note holds part of the PDF. */
  truncated: boolean;
};

export type PdfExtractJob = { id: string; base64: string };

/** A PDF that never settles must not hang the Upload screen behind a spinner.
 *  Generous, because this is a real parse of a real file on a real phone. */
const JOB_TIMEOUT_MS = 45_000;

type Waiter = {
  resolve: (result: PdfExtraction) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Promise callbacks live outside the store: they are not state, nothing renders
// from them, and putting functions in a zustand store invites a re-render on
// every enqueue.
const waiters = new Map<string, Waiter>();
const queued: PdfExtractJob[] = [];

let counter = 0;
function nextId(): string {
  counter += 1;
  return `pdf-${counter}`;
}

type PdfExtractState = {
  /** The job the host should be running, or null when idle. */
  active: PdfExtractJob | null;
  /** Queue a PDF for extraction and await its text. */
  enqueue: (base64: string) => Promise<PdfExtraction>;
  /** Called by the host when the page reports text. */
  resolve: (id: string, result: PdfExtraction) => void;
  /** Called by the host when the page reports a failure. */
  fail: (id: string, message: string) => void;
};

export const usePdfExtractStore = create<PdfExtractState>((set, get) => {
  /** Settle one job and hand the host the next, if any. */
  const finish = (id: string, settle: (waiter: Waiter) => void) => {
    const waiter = waiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(id);
    settle(waiter);
    // Only advance if the job that finished is the one on screen — a timed-out
    // job settles late and must not steal the slot from its successor.
    if (get().active?.id === id) set({ active: queued.shift() ?? null });
  };

  return {
    active: null,

    enqueue: (base64) =>
      new Promise<PdfExtraction>((resolve, reject) => {
        const job: PdfExtractJob = { id: nextId(), base64 };
        const timer = setTimeout(() => {
          finish(job.id, (w) => w.reject(new Error('timeout')));
        }, JOB_TIMEOUT_MS);
        waiters.set(job.id, { resolve, reject, timer });

        if (get().active) queued.push(job);
        else set({ active: job });
      }),

    resolve: (id, result) => finish(id, (w) => w.resolve(result)),
    fail: (id, message) => finish(id, (w) => w.reject(new Error(message))),
  };
});
