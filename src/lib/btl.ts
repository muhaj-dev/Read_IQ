// AI runtime client — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. Every function below keeps its real
// signature so the screens, stores and hooks that call it compile and run
// unchanged, but no request is ever made and no credentials are read.
//
// To wire a real provider later, implement the bodies in this one file:
// it is the only module that should ever hold a base URL or an API key.

/** Always false here — no credentials exist in the UI-only build. */
export function isBtlConfigured(): boolean {
  return false;
}

// --- Models -----------------------------------------------------------------
// Plain identifier strings used by the Settings model picker UI.

export const DEFAULT_CHAT_MODEL = 'btl-2';
export const DEFAULT_DOC_MODEL = 'gemini-2.5-flash';
export const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

// --- Friendly errors --------------------------------------------------------
// Every failure maps to a calm, student-facing sentence — never a raw trace.

export type BtlErrorKind = 'not-configured' | 'network' | 'auth' | 'credits' | 'server' | 'unknown';

const FRIENDLY: Record<BtlErrorKind, string> = {
  'not-configured': 'AI is not set up in this build yet.',
  network: 'Cannot reach your study assistant. Check your connection and try again.',
  auth: 'Your API key was rejected. Check your credentials.',
  credits: 'The study assistant is out of credits for now. Please try again later.',
  server: 'The study assistant is having a moment. Please try again shortly.',
  unknown: 'Something went wrong reaching the study assistant. Please try again.',
};

/** Every AI failure surfaces as this — render `.friendly`, log `.message`. */
export class BtlError extends Error {
  readonly kind: BtlErrorKind;
  readonly friendly: string;
  readonly status?: number;

  constructor(kind: BtlErrorKind, detail?: string, status?: number) {
    super(detail || kind);
    this.name = 'BtlError';
    this.kind = kind;
    this.friendly = FRIENDLY[kind];
    this.status = status;
  }
}

// --- Request surface (stubs) -------------------------------------------------

type JsonBody = Record<string, unknown>;

/** Not implemented — always throws so callers show their friendly not-configured state. */
export async function btlPost<T = unknown>(
  _path: string,
  _body: JsonBody,
  _signal?: AbortSignal,
): Promise<T> {
  throw new BtlError('not-configured');
}

/** Not implemented — no vectors in the UI-only build. */
export async function btlEmbed(_inputs: string[], _signal?: AbortSignal): Promise<number[][]> {
  throw new BtlError('not-configured');
}

type ChatContentPart = { text?: unknown };
type ChatLike = {
  choices?: { message?: { content?: unknown } }[];
  output_text?: unknown;
  output?: { content?: unknown }[];
};

/** Pure response parser — kept because it is provider-agnostic and has no side effects. */
export function readChatText(res: unknown): string {
  const r = (res ?? {}) as ChatLike;
  const join = (parts: ChatContentPart[]) =>
    parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
  const message = r.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) return join(message);
  if (typeof r.output_text === 'string') return r.output_text.trim();
  const output = r.output?.[0]?.content;
  if (Array.isArray(output)) return join(output);
  return '';
}

// --- Streaming chat ---------------------------------------------------------

/** Streamed completion outcome. */
export type StreamResult = { text: string; finishReason: string | null; tokens: number };

/** Not implemented — always throws so the Ask screen shows its not-configured state. */
export async function btlChatStream(
  _body: JsonBody,
  _onToken?: (delta: string) => void,
  _signal?: AbortSignal,
): Promise<StreamResult> {
  throw new BtlError('not-configured');
}

// --- Connection check -------------------------------------------------------

export type BtlStatus = { ok: boolean; message: string };

/** Reports "not set up" so Settings renders an honest status row. */
export async function checkBtlConnection(_signal?: AbortSignal): Promise<BtlStatus> {
  return { ok: false, message: 'AI is not set up in this build yet.' };
}
