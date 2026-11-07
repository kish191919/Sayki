import "server-only";
import { LessonError } from "./errors";
import { addBookmark, getBookmarkMap, getLesson, isLessonId, removeBookmarks } from "./store";
import type { Bookmark, BookmarkGroup } from "./types";

/** No real lesson comes near this; it only keeps junk out of the hash. */
const MAX_INDEX = 100_000;

const fieldOf = (lessonId: string, index: number) => `${lessonId}:${index}`;

function parseField(field: string, at: unknown): Bookmark | null {
  const cut = field.lastIndexOf(":");
  if (cut < 0) return null;
  const lessonId = field.slice(0, cut);
  const index = Number(field.slice(cut + 1));
  if (!isLessonId(lessonId) || !Number.isInteger(index) || index < 0) return null;
  const time = Number(at);
  return { lessonId, index, at: Number.isFinite(time) ? time : 0 };
}

/** Every bookmark, newest first. */
export async function listBookmarks(): Promise<Bookmark[]> {
  const map = await getBookmarkMap();
  return Object.entries(map)
    .map(([field, at]) => parseField(field, at))
    .filter((b): b is Bookmark => b !== null)
    .sort((a, b) => b.at - a.at);
}

/** Lessons that have bookmarks, most recently bookmarked first — the "북마크" page order. */
export function bookmarkLessonOrder(bookmarks: Bookmark[]): string[] {
  const latest = new Map<string, number>();
  for (const b of bookmarks) latest.set(b.lessonId, Math.max(latest.get(b.lessonId) ?? 0, b.at));
  return [...latest].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Adds or removes one bookmark. Body: { lessonId, index, bookmarked }. Idempotent. */
export async function setBookmark(body: unknown): Promise<void> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { lessonId, index, bookmarked } = input;
  if (
    typeof lessonId !== "string" ||
    !isLessonId(lessonId) ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > MAX_INDEX ||
    typeof bookmarked !== "boolean"
  ) {
    throw new LessonError("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }
  if (bookmarked) await addBookmark(fieldOf(lessonId, index), Date.now());
  else await removeBookmarks([fieldOf(lessonId, index)]);
}

/** Drops the bookmarks of deleted lessons. */
export async function forgetBookmarks(lessonIds: string[]): Promise<void> {
  const gone = new Set(lessonIds);
  const bookmarks = await listBookmarks();
  await removeBookmarks(bookmarks.filter((b) => gone.has(b.lessonId)).map((b) => fieldOf(b.lessonId, b.index)));
}

/** Bookmarked sentences with their text, grouped by lesson (most recently bookmarked lesson first). */
export async function loadBookmarkGroups(): Promise<BookmarkGroup[]> {
  const bookmarks = await listBookmarks();
  const order = bookmarkLessonOrder(bookmarks);
  const lessons = await Promise.all(order.map((id) => getLesson(id)));
  const byLesson = new Map<string, Bookmark[]>();
  for (const b of bookmarks) byLesson.set(b.lessonId, [...(byLesson.get(b.lessonId) ?? []), b]);

  const groups: BookmarkGroup[] = [];
  for (const lesson of lessons) {
    // A lesson deleted elsewhere, or a sentence index the lesson no longer has, is skipped.
    if (!lesson) continue;
    const sentences = (byLesson.get(lesson.id) ?? [])
      .filter((b) => b.index < lesson.sentences.length)
      .sort((a, b) => a.index - b.index)
      .map((b) => {
        const s = lesson.sentences[b.index];
        return { index: b.index, start: s.start, text: s.text, ko: s.ko || null, at: b.at };
      });
    if (sentences.length === 0) continue;
    groups.push({
      lesson: {
        id: lesson.id,
        title: lesson.title,
        thumbnail: lesson.thumbnail,
        sentenceCount: lesson.sentences.length,
      },
      sentences,
      latest: Math.max(...sentences.map((s) => s.at)),
    });
  }
  return groups;
}
