import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";
import { LessonError } from "./errors";
import type { Lesson, LessonSummary } from "./types";

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
}

const ID_RE = /^(yt|md|up)_[A-Za-z0-9_-]{6,40}$/;

export const youtubeLessonId = (videoId: string) => `yt_${videoId}`;
export const mediaLessonId = (url: string) =>
  `md_${createHash("sha256").update(url).digest("base64url").slice(0, 16)}`;
export const uploadLessonId = () => `up_${randomBytes(9).toString("base64url")}`;

export function summarize(lesson: Lesson): LessonSummary {
  const { sentences, ...rest } = lesson;
  return { ...rest, sentenceCount: sentences.length };
}

/* --------------------------------- Redis ---------------------------------- */

const RECENT_KEY = "lessons:recent";
const RECENT_KEEP = 200;
const lessonKey = (id: string) => `lesson:${id}`;
const summaryKey = (id: string) => `lesson-summary:${id}`;

function redisStore(redis: Redis): LessonStore {
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
        .zremrangebyrank(RECENT_KEY, 0, -(RECENT_KEEP + 1))
        .exec();
    },
    async recent(limit) {
      const ids = await redis.zrange<string[]>(RECENT_KEY, 0, limit - 1, { rev: true });
      if (ids.length === 0) return [];
      const summaries = await redis.mget<(LessonSummary | null)[]>(...ids.map(summaryKey));
      return summaries.filter((s): s is LessonSummary => s !== null);
    },
  };
}

/* ---------------------------------- Files --------------------------------- */

function fileStore(dir: string): LessonStore {
  const lessonDir = path.join(dir, "lessons");
  const fileFor = (id: string) => path.join(lessonDir, `${id}.json`);

  const get = async (id: string): Promise<Lesson | null> => {
    try {
      return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as Lesson;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };

  return {
    get,
    async save(lesson) {
      await fs.mkdir(lessonDir, { recursive: true });
      const target = fileFor(lesson.id);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(lesson));
      await fs.rename(tmp, target);
    },
    async recent(limit) {
      let names: string[];
      try {
        names = (await fs.readdir(lessonDir)).filter((n) => n.endsWith(".json"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const stats = await Promise.all(
        names.map(async (n) => ({ n, mtime: (await fs.stat(path.join(lessonDir, n))).mtimeMs })),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      const lessons = await Promise.all(stats.slice(0, limit).map((s) => get(s.n.replace(/\.json$/, ""))));
      return lessons.filter((l): l is Lesson => l !== null).map(summarize);
    },
  };
}

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
