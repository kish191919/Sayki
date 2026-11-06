import type { Lesson } from "./types";

/** How many times a lesson's untranslated lines are sent to the model. */
export const AI_MAX_ATTEMPTS = 3;

/**
 * Sentence indexes that still need an AI translation ([] = nothing to do).
 * Shared by the server (what to translate) and the practice room (whether
 * to ask for it).
 */
export function pendingAiLines(lesson: Lesson): number[] {
  if (lesson.koreanOrigin !== "ai") return lesson.sentences.map((s) => s.index);
  if ((lesson.aiAttempts ?? 1) >= AI_MAX_ATTEMPTS) return [];
  // Lessons translated before `aiPending` existed: blank lines are pending.
  return lesson.aiPending ?? lesson.sentences.filter((s) => !s.ko).map((s) => s.index);
}
