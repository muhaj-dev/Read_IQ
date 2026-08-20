// Groq client — the ONLY module in the app that holds a Groq key or base URL.
//
// Scope is deliberate and narrow. Groq does two jobs: it writes quiz questions,
// and it turns a recording into text. Ask, Weak Topics, Root Cause and Memory
// are HydraDB's work and stay LLM-free — retrieval is graph traversal and
// answers are extractive, so nothing on that path may import this file.
//
// Both jobs are *generation from the student's own material*, never retrieval:
// MCQs from their notes, words from their audio. Neither has an opinion the
// graph could have supplied instead.
//
// OpenAI-compatible endpoints: chat completions (JSON mode) and transcriptions.

import { File as FsFile } from 'expo-file-system';

import { BtlError } from './btl';

const BASE_URL = process.env.EXPO_PUBLIC_GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';
const API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY ?? '';

/** The model used when the student hasn't picked one (or picked a retired id). */
export const DEFAULT_QUIZ_MODEL = 'openai/gpt-oss-120b';

/** Speech-to-text. Not student-selectable — the picker is about quiz style. */
export const TRANSCRIBE_MODEL = 'whisper-large-v3';

/** False when no key is configured — callers surface the friendly not-set-up state. */
export function isGroqConfigured(): boolean {
  return API_KEY.length > 0;
}

export type GroqChatOptions = {
  /** Model slug. Falls back to DEFAULT_QUIZ_MODEL if the id is unknown to Groq. */
  model?: string;
  /** Low by default — quiz questions should be faithful, not creative. */
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

type ChatMessage = { role: 'system' | 'user'; content: string };

/** Map an HTTP failure onto the app's friendly error vocabulary. */
function toBtlError(status: number, body: string): BtlError {
  if (status === 401 || status === 403) return new BtlError('auth', body, status);
  if (status === 429) return new BtlError('credits', body, status);
  if (status >= 500) return new BtlError('server', body, status);
  return new BtlError('unknown', body, status);
}

/** True when the failure is "that model doesn't exist here" — worth one retry
 *  on the default model rather than failing the student's quiz over a slug. */
function isUnknownModel(status: number, body: string): boolean {
  return status === 404 && /model_not_found|does not exist/i.test(body);
}

async function post(messages: ChatMessage[], model: string, opts: GroqChatOptions) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
      response_format: { type: 'json_object' },
    }),
    signal: opts.signal,
  });
}

/** One JSON-mode completion. Returns the parsed object, or throws BtlError.
 *
 *  JSON mode is not a guarantee of *shape*, only of syntax — every caller must
 *  still validate what it gets back. */
export async function groqChatJson<T = unknown>(
  messages: ChatMessage[],
  opts: GroqChatOptions = {},
): Promise<T> {
  if (!isGroqConfigured()) throw new BtlError('not-configured');

  const wanted = opts.model?.trim() || DEFAULT_QUIZ_MODEL;

  let res: Response;
  try {
    res = await post(messages, wanted, opts);
    if (!res.ok && wanted !== DEFAULT_QUIZ_MODEL) {
      const body = await res.text();
      if (!isUnknownModel(res.status, body)) throw toBtlError(res.status, body);
      res = await post(messages, DEFAULT_QUIZ_MODEL, opts);
    }
  } catch (err) {
    if (err instanceof BtlError) throw err;
    // AbortError is the student leaving the screen — not a failure to report.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new BtlError('network', err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) throw toBtlError(res.status, await res.text());

  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new BtlError('server', 'Groq returned an empty completion');
  }

  try {
    return JSON.parse(stripFence(content)) as T;
  } catch {
    throw new BtlError('server', 'Groq returned malformed JSON');
  }
}

/** Some models still wrap JSON in a ```json fence despite JSON mode. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

// --- Transcription -----------------------------------------------------------

/** Groq's upload ceiling for audio. A long lecture can genuinely exceed it, so
 *  it is checked before the upload rather than after a slow failed one. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** MIME type from the file extension — Groq rejects an upload with no type. */
function audioMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    m4a: 'audio/m4a',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
  };
  return types[ext] ?? 'audio/m4a';
}

/** Filename for the upload, from the recording's URI. */
function audioName(uri: string): string {
  const last = uri.split(/[?#]/)[0].split('/').pop() ?? '';
  return /\.[a-z0-9]{2,5}$/i.test(last) ? last : 'recording.m4a';
}

/** Attach the recording to the form. React Native uploads by URI; web (and any
 *  blob:/data: URI) has to be fetched into a real Blob first. */
async function appendAudio(form: FormData, uri: string): Promise<void> {
  const name = audioName(uri);
  const type = audioMime(name);

  if (/^(blob:|data:)/.test(uri)) {
    const blob = await (await fetch(uri)).blob();
    form.append('file', blob, name);
    return;
  }

  // Size is a cheap local check; a URI the file API can't stat just skips it.
  try {
    const size = new FsFile(uri).size ?? 0;
    if (size > MAX_AUDIO_BYTES) {
      throw new BtlError(
        'too-large',
        `audio is ${Math.round(size / 1024 / 1024)}MB, limit ${MAX_AUDIO_BYTES / 1024 / 1024}MB`,
      );
    }
  } catch (err) {
    if (err instanceof BtlError) throw err;
    // Not stat-able (web, an odd provider URI) — let the upload decide.
  }

  // RN's FormData takes {uri, name, type}; the DOM typings don't describe it.
  form.append('file', { uri, name, type } as unknown as Blob);
}

export type GroqTranscribeOptions = {
  /** ISO-639-1 hint, e.g. "en". Omitted means auto-detect. */
  language?: string;
  signal?: AbortSignal;
};

/** Transcribe a local recording. Returns the text, or '' when the audio is silent.
 *
 *  Throws BtlError for real failures (no key, network, auth, credits, oversized
 *  file) — every caller already treats a throw as "let the student type it in". */
export async function groqTranscribe(
  uri: string,
  opts: GroqTranscribeOptions = {},
): Promise<string> {
  if (!isGroqConfigured()) throw new BtlError('not-configured');

  const form = new FormData();
  await appendAudio(form, uri);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  // Deterministic: a lecture transcript should not be embellished.
  form.append('temperature', '0');
  if (opts.language) form.append('language', opts.language);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      // No Content-Type — the runtime sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new BtlError('network', err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 413) throw new BtlError('too-large', body, res.status);
    throw toBtlError(res.status, body);
  }

  const json = (await res.json()) as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

export type GroqStatus = { ok: boolean; message: string };

/** Settings shows this as an honest status row. */
export async function checkGroqConnection(signal?: AbortSignal): Promise<GroqStatus> {
  if (!isGroqConfigured()) {
    return { ok: false, message: 'No Groq API key — quiz generation is off.' };
  }
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal,
    });
    if (res.ok) return { ok: true, message: 'Connected to Groq.' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Your Groq API key was rejected.' };
    }
    return { ok: false, message: `Groq responded with ${res.status}.` };
  } catch {
    return { ok: false, message: 'Cannot reach Groq. Check your connection.' };
  }
}
