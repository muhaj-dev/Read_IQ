// The quiz generator — NOT IMPLEMENTED IN THIS BUILD.
//
// This repository is the UI layer only. `shuffleQuestionOptions` is pure local
// logic and is kept intact so the quiz runner UI works on any questions it is
// given. Generating questions from a note requires an AI provider, which this
// build has none of.
//
// To wire this up later: implement `generateQuiz` to return grounded MCQs.

import type { QuizOption, QuizQuestion } from '@/types/quiz';

import { BtlError } from './btl';

/** Fallback question target when a caller doesn't ask for a specific count. */
const DEFAULT_TARGET = 10;

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

/** Fisher–Yates shuffle (in place, returns the same array). */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Re-letter a question's options into a random A–D order, moving `answerKey`
 *  with the correct option's text. Index-based (not text-based) so duplicate
 *  option texts can't misplace the answer. Pure and side-effect free. */
export function shuffleQuestionOptions(q: QuizQuestion): QuizQuestion {
  const correctIndex = q.options.findIndex((o) => o.key === q.answerKey);
  if (correctIndex === -1) return q; // malformed — leave untouched
  const order = shuffle(q.options.map((_, i) => i));
  const options: QuizOption[] = order.map((from, i) => ({
    key: OPTION_KEYS[i] ?? q.options[from].key,
    text: q.options[from].text,
  }));
  const answerKey = OPTION_KEYS[order.indexOf(correctIndex)] ?? q.answerKey;
  return { ...q, options, answerKey };
}

/** Options for one generation pass. */
export type GenerateQuizOptions = {
  /** How many questions to aim for. Defaults to DEFAULT_TARGET. */
  count?: number;
  /** Prompts already put to the student, so a re-attempt never repeats questions. */
  avoid?: string[];
};

/** Not implemented — quiz generation needs an AI provider. */
export async function generateQuiz(
  _note: {
    id: string;
    title: string;
    subject: string | null;
    content: string;
  },
  _opts: GenerateQuizOptions = { count: DEFAULT_TARGET },
): Promise<QuizQuestion[]> {
  throw new BtlError('not-configured');
}
