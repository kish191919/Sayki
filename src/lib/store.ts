import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { LessonError } from "./errors";
import type { Lesson, LessonSummary, LibraryState } from "./types";

/**
 * Lesson storage.
 * - Upstash Redis when UPSTASH_REDIS_REST_* or KV_REST_API_* env vars are set
 *   (what the Vercel Marketplace integration injects) — used in production.
 * - Otherwise one JSON file per lesson under `.data/lessons/` — local dev only;
 *   serverless filesystems are read-only / not persistent.
 */
interface LessonStore {
  get(id: string): Promise<Lesson | null>;
  save(lesson: Lesson): Promise<void>;
  recent(limit: number): Promise<LessonSummary[]>;
  /** Every lesson, newest first. */
  all(): Promise<LessonSummary[]>;
  remove(ids: string[]): Promise<void>;
  /** The learner's folders (one document; null until first saved). */
  getLibrary(): Promise<LibraryState | null>;
  saveLibrary(library: LibraryState): Promise<void>;
  /** Bookmarked sentences: `${lessonId}:${index}` → when it was bookmarked (ms). */
  getBookmarks(): Promise<Record<string, number>>;
  addBookmark(field: string, at: number): Promise<void>;
  removeBookmarks(fields: string[]): Promise<void>;
  /** Sentences the learner deleted from a lesson (kept apart from the lesson, which translation rewrites). */
  getHidden(lessonId: string): Promise<number[]>;
  setHidden(lessonId: string, indexes: number[], hidden: boolean): Promise<void>;
  /** Increments a counter that expires after `ttlSeconds`; returns the new value. */
  bump(key: string, ttlSeconds: number): Promise<number>;
}

const ID_RE = /^(yt|md|up)_[A-Za-z0-9_-]{6,40}$/;

export const isLessonId = (id: string) => ID_RE.test(id);
export const youtubeLessonId = (videoId: string) => `yt_${videoId}`;
export const mediaLessonId = (url: string) =>
  `md_${createHash("sha256").update(url).digest("base64url").slice(0, 16)}`;
export const uploadLessonId = () => `up_${randomBytes(9).toString("base64url")}`;

export function summarize(lesson: Lesson): LessonSummary {
  const { sentences, ...rest } = lesson;
  return { ...rest, sentenceCount: sentences.length };
}

const newestFirst = (a: LessonSummary, b: LessonSummary) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/* --------------------------------- Redis ---------------------------------- */

/** Every lesson id, scored by creation time. Not trimmed: it is the library index. */
const RECENT_KEY = "lessons:recent";
const LIBRARY_KEY = "library";
/** A hash, so adding and removing one bookmark never races with another. */
const BOOKMARKS_KEY = "bookmarks";
const MGET_CHUNK = 100;
const lessonKey = (id: string) => `lesson:${id}`;
const summaryKey = (id: string) => `lesson-summary:${id}`;
/** A set of sentence indexes, so deleting and restoring sentences never race. */
const hiddenKey = (id: string) => `lesson-hidden:${id}`;

/** Sentence indexes as stored, cleaned up (sorted, no junk). */
const indexList = (raw: unknown[]) =>
  [...new Set(raw.map(Number).filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b);

function redisStore(redis: Redis): LessonStore {
  const summaries = async (ids: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MGET_CHUNK) chunks.push(ids.slice(i, i + MGET_CHUNK));
    const rows = await Promise.all(
      chunks.map((chunk) => redis.mget<(LessonSummary | null)[]>(...chunk.map(summaryKey))),
    );
    return rows.flat().filter((s): s is LessonSummary => s !== null);
  };

  return {
    async get(id) {
      return (await redis.get<Lesson>(lessonKey(id))) ?? null;
    },
    async save(lesson) {
      await redis
        .pipeline()
        .set(lessonKey(lesson.id), lesson)
        .set(summaryKey(lesson.id), summarize(lesson))
        .zadd(RECENT_KEY, { score: Date.parse(lesson.createdAt), member: lesson.id })
        .exec();
    },
    async recent(limit) {
      return summaries(await redis.zrange<string[]>(RECENT_KEY, 0, limit - 1, { rev: true }));
    },
    async all() {
      return summaries(await redis.zrange<string[]>(RECENT_KEY, 0, -1, { rev: true }));
    },
    async remove(ids) {
      if (ids.length === 0) return;
      await redis
        .pipeline()
        .del(...ids.flatMap((id) => [lessonKey(id), summaryKey(id), hiddenKey(id)]))
        .zrem(RECENT_KEY, ...ids)
        .exec();
    },
    async getLibrary() {
      return (await redis.get<LibraryState>(LIBRARY_KEY)) ?? null;
    },
    async saveLibrary(library) {
      await redis.set(LIBRARY_KEY, library);
    },
    async getBookmarks() {
      return (await redis.hgetall<Record<string, number>>(BOOKMARKS_KEY)) ?? {};
    },
    async addBookmark(field, at) {
      await redis.hset(BOOKMARKS_KEY, { [field]: at });
    },
    async removeBookmarks(fields) {
      if (fields.length === 0) return;
      await redis.hdel(BOOKMARKS_KEY, ...fields);
    },
    async getHidden(lessonId) {
      return indexList((await redis.smembers<unknown[]>(hiddenKey(lessonId))) ?? []);
    },
    async setHidden(lessonId, indexes, hidden) {
      const [first, ...rest] = indexes;
      if (first === undefined) return;
      if (hidden) await redis.sadd(hiddenKey(lessonId), first, ...rest);
      else await redis.srem(hiddenKey(lessonId), ...indexes);
    },
    async bump(key, ttlSeconds) {
      const [count] = await redis.pipeline().incr(`counter:${key}`).expire(`counter:${key}`, ttlSeconds).exec<[number, number]>();
      return count;
    },
  };
}

/* ---------------------------------- Files --------------------------------- */

function fileStore(dir: string): LessonStore {
  const lessonDir = path.join(dir, "lessons");
  const libraryFile = path.join(dir, "library.json");
  const bookmarksFile = path.join(dir, "bookmarks.json");
  const fileFor = (id: string) => path.join(lessonDir, `${id}.json`);
  const hiddenFileFor = (id: string) => path.join(dir, "hidden", `${id}.json`);

  const readJson = async <T,>(file: string): Promise<T | null> => {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };

  const writeJson = async (file: string, value: unknown) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file);
  };

  const get = (id: string) => readJson<Lesson>(fileFor(id));

  const all = async (): Promise<LessonSummary[]> => {
    let names: string[];
    try {
      names = (await fs.readdir(lessonDir)).filter((n) => n.endsWith(".json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const lessons = await Promise.all(names.map((n) => get(n.replace(/\.json$/, ""))));
    return lessons
      .filter((l): l is Lesson => l !== null)
      .map(summarize)
      .sort(newestFirst);
  };

  return {
    get,
    async save(lesson) {
      await writeJson(fileFor(lesson.id), lesson);
    },
    async recent(limit) {
      // Local development only: reading every file is fine at this scale.
      return (await all()).slice(0, limit);
    },
    all,
    async remove(ids) {
      await Promise.all(
        ids.flatMap((id) => [fs.rm(fileFor(id), { force: true }), fs.rm(hiddenFileFor(id), { force: true })]),
      );
    },
    getLibrary() {
      return readJson<LibraryState>(libraryFile);
    },
    async saveLibrary(library) {
      await writeJson(libraryFile, library);
    },
    async getBookmarks() {
      return (await readJson<Record<string, number>>(bookmarksFile)) ?? {};
    },
    // Local development only: read-modify-write is fine for one person.
    async addBookmark(field, at) {
      const all = (await readJson<Record<string, number>>(bookmarksFile)) ?? {};
      await writeJson(bookmarksFile, { ...all, [field]: at });
    },
    async removeBookmarks(fields) {
      const all = (await readJson<Record<string, number>>(bookmarksFile)) ?? {};
      for (const f of fields) delete all[f];
      await writeJson(bookmarksFile, all);
    },
    async getHidden(lessonId) {
      const raw = await readJson<unknown>(hiddenFileFor(lessonId));
      return Array.isArray(raw) ? indexList(raw) : [];
    },
    // Local development only: read-modify-write is fine for one person.
    async setHidden(lessonId, indexes, hidden) {
      const raw = await readJson<unknown>(hiddenFileFor(lessonId));
      const set = new Set(Array.isArray(raw) ? indexList(raw) : []);
      for (const i of indexes) {
        if (hidden) set.add(i);
        else set.delete(i);
      }
      await writeJson(hiddenFileFor(lessonId), [...set].sort((a, b) => a - b));
    },
    async bump(key) {
      // Local development only: an in-memory counter is enough.
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return count;
    },
  };
}

const counters = new Map<string, number>();

/* --------------------------------- Select --------------------------------- */

let cached: LessonStore | null = null;

function store(): LessonStore {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    cached = redisStore(new Redis({ url, token }));
  } else if (process.env.VERCEL) {
    console.error("No lesson storage: connect Upstash Redis to this Vercel project.");
    throw new LessonError(
      "NO_STORAGE",
      "서버 저장소가 아직 연결되지 않았어요. (관리자: Vercel 프로젝트에 Upstash Redis를 연결해 주세요.)",
      503,
    );
  } else {
    cached = fileStore(process.env.SAYKI_DATA_DIR || path.join(process.cwd(), ".data"));
  }
  return cached;
}

export async function getLesson(id: string): Promise<Lesson | null> {
  if (!ID_RE.test(id)) return null;
  return store().get(id);
}

export async function saveLesson(lesson: Lesson): Promise<void> {
  if (!ID_RE.test(lesson.id)) throw new Error(`invalid lesson id: ${lesson.id}`);
  await store().save(lesson);
}

export async function listRecentLessons(limit = 12): Promise<LessonSummary[]> {
  return store().recent(limit);
}

export async function listAllLessons(): Promise<LessonSummary[]> {
  return store().all();
}

export async function deleteLessons(ids: string[]): Promise<void> {
  await store().remove(ids.filter(isLessonId));
}

/** The learner's folders, tolerating a missing or malformed document. */
export async function loadLibrary(): Promise<LibraryState> {
  const raw = await store().getLibrary();
  const folders = Array.isArray(raw?.folders)
    ? raw.folders.filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
    : [];
  const placement = raw?.placement && typeof raw.placement === "object" ? raw.placement : {};
  return { folders, placement };
}

export async function saveLibrary(library: LibraryState): Promise<void> {
  await store().saveLibrary(library);
}

export async function getBookmarkMap(): Promise<Record<string, number>> {
  return store().getBookmarks();
}

export async function addBookmark(field: string, at: number): Promise<void> {
  await store().addBookmark(field, at);
}

export async function removeBookmarks(fields: string[]): Promise<void> {
  await store().removeBookmarks(fields);
}

export async function getHiddenSentences(lessonId: string): Promise<number[]> {
  if (!isLessonId(lessonId)) return [];
  return store().getHidden(lessonId);
}

export async function setHiddenSentences(lessonId: string, indexes: number[], hidden: boolean): Promise<void> {
  if (!isLessonId(lessonId)) throw new Error(`invalid lesson id: ${lessonId}`);
  await store().setHidden(lessonId, indexes, hidden);
}

export async function bumpCounter(key: string, ttlSeconds: number): Promise<number> {
  return store().bump(key, ttlSeconds);
}
