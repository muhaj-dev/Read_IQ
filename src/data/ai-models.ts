// The models the student can pick in Settings → AI Model.
//
// These run on Groq, and they write quiz questions — that is the only job in
// readIQ a model does. Ask, Weak Topics and Root Cause are HydraDB's graph work
// and are unaffected by this choice; the questions stay grounded in the
// student's own notes whichever model writes them.
//
// The id is sent verbatim as `model` in the Groq request. An id Groq no longer
// serves falls back to the default rather than failing the quiz — see
// `lib/groq.ts`.

import { DEFAULT_QUIZ_MODEL } from '@/lib/groq';

export type AiModel = {
  /** The Groq model slug sent in the request body. */
  id: string;
  /** Friendly name shown in the picker + the Settings row. */
  label: string;
  /** Who trained the model, behind Groq. */
  provider: string;
  /** One calm line on what it's good for. */
  description: string;
  /** The tested default. */
  recommended?: boolean;
};

export const AI_MODELS: AiModel[] = [
  {
    id: DEFAULT_QUIZ_MODEL, // 'openai/gpt-oss-120b'
    label: 'readIQ Default',
    provider: 'OpenAI · GPT-OSS 120B',
    description: 'Careful questions that stick to your notes. The tested default.',
    recommended: true,
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'Instant',
    provider: 'OpenAI · GPT-OSS 20B',
    description: 'The quickest quiz. Best for short, straightforward notes.',
  },
];

/** The friendly label for a model id — falls back to the id, then the default. */
export function modelLabelFor(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id ?? 'readIQ Default';
}

/** Is this id one we offer? Guards a stale persisted value after the list changes. */
export function isKnownModel(id: string): boolean {
  return AI_MODELS.some((m) => m.id === id);
}
