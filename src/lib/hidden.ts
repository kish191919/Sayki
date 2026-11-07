import "server-only";
import { LessonError } from "./errors";
import { isLessonId, setHiddenSentences } from "./store";

/** No real lesson comes near these; they only keep junk out of storage. */
const MAX_INDEX = 100_000;
const MAX_PER_REQUEST = 1000;

/**
 * Deletes sentences from a lesson's practice, or brings them back.
 * Body: { indexes: number[], hidden: boolean }. Idempotent.
 */
export async function setHidden(lessonId: string, body: unknown): Promise<void> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { indexes, hidden } = input;
  if (
    !isLessonId(lessonId) ||
    typeof hidden !== "boolean" ||
    !Array.isArray(indexes) ||
    indexes.length === 0 ||
    indexes.length > MAX_PER_REQUEST ||
    !indexes.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= MAX_INDEX)
  ) {
    throw new LessonError("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }
  await setHiddenSentences(lessonId, [...new Set(indexes as number[])], hidden);
}
