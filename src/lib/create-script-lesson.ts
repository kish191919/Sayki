import "server-only";
import { LessonError } from "./errors";
import { assertAudioStorage, buildScriptAudio, saveScriptAudio } from "./script-audio";
import { bumpCounter, saveLesson, scriptLessonId } from "./store";
import type { Lesson, ScriptLine } from "./types";

/** A reviewed script, as the learner confirmed it. */
export type ScriptLessonInput = { title: string; lines: ScriptLine[] };

const MAX_TITLE = 120;
const MAX_LINES = 80;
const MAX_LINE = 400;
/** About eight minutes of speech — a cost guard well above a 2–3 minute script. */
const MAX_ENGLISH_CHARS = 6000;
const DAILY_LIMIT = Number(process.env.SCRIPT_DAILY_LIMIT) || 30;

const bad = (message: string) => new LessonError("BAD_SCRIPT", message, 400);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Validates a confirmed script from the request body. */
export function parseScriptLessonInput(body: unknown): ScriptLessonInput {
  const b = body as { title?: unknown; lines?: unknown } | null;
  const title = typeof b?.title === "string" ? oneLine(b.title) : "";
  if (!title) throw bad("제목을 입력해 주세요.");
  if (title.length > MAX_TITLE) throw bad(`제목은 ${MAX_TITLE}자까지 쓸 수 있어요.`);
  if (!Array.isArray(b?.lines)) throw bad("요청 형식이 올바르지 않아요.");

  const lines: ScriptLine[] = [];
  for (const raw of b.lines as { en?: unknown; ko?: unknown }[]) {
    const en = typeof raw?.en === "string" ? oneLine(raw.en) : "";
    const ko = typeof raw?.ko === "string" ? oneLine(raw.ko) : "";
    if (!en) continue; // a line left empty in the editor
    if (en.length > MAX_LINE || ko.length > MAX_LINE) throw bad(`한 문장은 ${MAX_LINE}자까지 쓸 수 있어요.`);
    lines.push({ en, ko });
  }
  if (lines.length === 0) throw bad("연습할 문장이 없어요.");
  if (lines.length > MAX_LINES) throw bad(`문장은 ${MAX_LINES}개까지 만들 수 있어요.`);
  if (lines.reduce((n, l) => n + l.en.length, 0) > MAX_ENGLISH_CHARS) {
    throw bad("스크립트가 너무 길어요. 2–3분 분량으로 줄여 주세요.");
  }
  return { title, lines };
}

/** Reads the script aloud, stores the audio, and saves it as a lesson. */
export async function createScriptLesson({ title, lines }: ScriptLessonInput): Promise<Lesson> {
  assertAudioStorage();
  const today = new Date().toISOString().slice(0, 10);
  if ((await bumpCounter(`script-audio:${today}`, 2 * 24 * 3600)) > DAILY_LIMIT) {
    throw new LessonError("DAILY_LIMIT", "오늘 음성 만들기 한도를 다 썼어요. 내일 다시 시도해 주세요.", 429);
  }

  const id = scriptLessonId();
  const startedAt = Date.now();
  const audio = await buildScriptAudio(lines.map((l) => l.en));
  const stored = await saveScriptAudio(id, audio.mp3);
  console.log(
    `Script lesson ${id}: ${lines.length} sentences, ${audio.durationSec.toFixed(1)}s, ` +
      `${(audio.mp3.length / 1024).toFixed(0)} KB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );

  // Lines left without Korean are filled in by the regular AI translation when the room opens.
  const missingKo = lines.flatMap((l, i) => (l.ko ? [] : [i]));
  const lesson: Lesson = {
    id,
    title,
    source: { kind: "script", audio: stored },
    captionOrigin: "script",
    koreanOrigin: "ai",
    durationSec: Math.round(audio.durationSec),
    thumbnail: SCRIPT_THUMBNAIL,
    sentences: lines.map((l, index) => ({
      index,
      start: audio.timings[index].start,
      end: audio.timings[index].end,
      text: l.en,
      ...(l.ko ? { ko: l.ko } : {}),
    })),
    createdAt: new Date().toISOString(),
    aiPending: missingKo.length ? missingKo : undefined,
    aiAttempts: 1,
  };
  await saveLesson(lesson);
  return lesson;
}

/** Card image for script lessons (public/icons is served without the site lock, like the app icons). */
export const SCRIPT_THUMBNAIL = "/icons/script-cover.svg";
