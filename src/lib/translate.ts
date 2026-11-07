import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, canUseClaude, fallbackParams, tokenTotals } from "./claude";
import { LessonError } from "./errors";
import { bumpCounter, getLesson, saveLesson } from "./store";
import { pendingAiLines } from "./translation-state";
import type { Lesson } from "./types";

/**
 * Sentence-by-sentence Korean translation with Claude, so every lesson gets
 * a Korean line aligned 1:1 with its English sentences (needed for the
 * "Korean → speak English" mode; YouTube's Korean tracks are timed chunks).
 */

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || "claude-opus-5-5";

const CHUNK_SIZE = 40;
/** Chunk size for the second pass over lines that came back missing. */
const RESCUE_CHUNK_SIZE = 8;
const CONCURRENCY = 4;
const CONTEXT_LINES = 3;
const MAX_SENTENCES = 1500;
const DAILY_LIMIT = Number(process.env.TRANSLATE_DAILY_LIMIT) || 100;

export const canTranslate = canUseClaude;

const SYSTEM = `You translate English video subtitles into Korean for Korean learners of English.

Learners will read your Korean line and try to say the original English sentence from it, so:
- Translate every line 1:1. Return exactly one translation per input id; never merge, split, skip, or reorder lines.
- Keep all of the information in the line and stay close to its meaning and structure, while still sounding like natural spoken Korean.
- Match the speaker's register: casual speech stays casual, formal speech stays formal.
- A line may be a fragment of a longer sentence; translate it as a fragment rather than completing it.
- Keep names as they are commonly written in Korean; keep numbers as digits.
- Output only the translations. No notes, romanization, or explanations.`;

const SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ko: { type: "string" },
        },
        required: ["id", "ko"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

type Item = { id: number; text: string };

/** Token totals and problems for one translation run (for logs/response). */
type Run = { input: number; output: number; issues: string[] };

/**
 * Translates one chunk. Returns whatever lines came back; a declined chunk
 * returns none (recorded in `run.issues`). Throws on API/network errors.
 */
async function translateChunk(title: string, items: Item[], context: string[], run: Run): Promise<Map<number, string>> {
  const prompt = [
    `Video title: ${title}`,
    context.length ? `Earlier lines, for context only (do not translate):\n${context.join("\n")}` : "",
    `Translate these subtitle lines:\n${JSON.stringify(items)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
    ...fallbackParams(MODEL),
  });

  const tokens = tokenTotals(response.usage);
  run.input += tokens.input;
  run.output += tokens.output;
  const span = `lines ${items[0].id}–${items[items.length - 1].id}`;

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "none";
    run.issues.push(`declined(${category}) ${span}`);
    console.warn(`Translation declined (${category}) for ${span} of "${title}" by ${response.model}`);
    return new Map();
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("translation hit max_tokens");
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as { translations?: { id: number; ko: string }[] };
  const wanted = new Set(items.map((i) => i.id));
  const result = new Map<number, string>();
  for (const t of parsed.translations ?? []) {
    if (wanted.has(t.id) && typeof t.ko === "string" && t.ko.trim()) result.set(t.id, t.ko.trim());
  }
  if (result.size < items.length) {
    run.issues.push(`omitted ${items.length - result.size}/${items.length} ${span}`);
    console.warn(`Translation omitted ${items.length - result.size} of ${items.length} for ${span} (${response.model})`);
  }
  return result;
}

/** Translates the given sentences in chunks of `size`, a few chunks at a time. */
async function translateBatch(lesson: Lesson, targets: number[], size: number, out: Map<number, string>, run: Run) {
  const { sentences } = lesson;
  const chunks: number[][] = [];
  for (let s = 0; s < targets.length; s += size) chunks.push(targets.slice(s, s + size));

  const runChunk = async (ids: number[]) => {
    const items = ids.map((i) => ({ id: i, text: sentences[i].text }));
    const context = sentences.slice(Math.max(0, ids[0] - CONTEXT_LINES), ids[0]).map((s) => s.text);
    for (const [id, ko] of await translateChunk(lesson.title, items, context, run)) out.set(id, ko);
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length) await runChunk(chunks[next++]);
  });
  await Promise.all(workers);
}

/**
 * Translates `targets`. Lines that come back missing (left out, or in a
 * declined chunk) get a second pass in small chunks, so one sensitive line
 * doesn't cost its whole chunk.
 */
async function translateLines(lesson: Lesson, targets: number[]) {
  const out = new Map<number, string>();
  const run: Run = { input: 0, output: 0, issues: [] };

  await translateBatch(lesson, targets, CHUNK_SIZE, out, run);
  const missing = targets.filter((i) => !out.has(i));
  // Small target lists were already sent in one small chunk.
  if (missing.length && targets.length > RESCUE_CHUNK_SIZE) {
    await translateBatch(lesson, missing, RESCUE_CHUNK_SIZE, out, run);
  }

  console.log(
    `Translated ${lesson.id}: ${out.size}/${targets.length} lines with ${MODEL}, ` +
      `${run.input} input / ${run.output} output tokens` +
      (run.issues.length ? `; issues: ${run.issues.join(", ")}` : ""),
  );
  return { out, issues: run.issues };
}

export type AiTranslation = {
  /** Korean line per sentence ("" where there is none). */
  ko: string[];
  /** Sentences still without an AI translation. */
  pending: number;
  /** What went wrong this run, e.g. "declined(general_harms) lines 0–7". */
  issues: string[];
};

const inFlight = new Map<string, Promise<AiTranslation>>();

const resultOf = (lesson: Lesson, issues: string[] = []): AiTranslation => ({
  ko: lesson.sentences.map((s) => s.ko ?? ""),
  pending: lesson.koreanOrigin === "ai" ? (lesson.aiPending?.length ?? 0) : lesson.sentences.length,
  issues,
});

/**
 * Makes sure the lesson has AI translations: translates it the first time,
 * and on later visits retries only the lines that are still missing (up to
 * AI_MAX_ATTEMPTS passes in total).
 */
export async function ensureAiTranslation(lessonId: string): Promise<AiTranslation> {
  const running = inFlight.get(lessonId);
  if (running) return running;

  const job = (async () => {
    const lesson = await getLesson(lessonId);
    if (!lesson) throw new LessonError("NOT_FOUND", "레슨을 찾을 수 없어요.", 404);
    const targets = pendingAiLines(lesson);
    if (!targets.length) return resultOf(lesson);

    const firstRun = lesson.koreanOrigin !== "ai";
    if (firstRun) {
      if (lesson.sentences.length > MAX_SENTENCES) {
        throw new LessonError("TOO_LONG", "영상이 너무 길어서 번역할 수 없어요.", 422);
      }
      // Retries of missing lines are bounded by AI_MAX_ATTEMPTS, so only
      // whole-lesson translations count toward the daily cap.
      const today = new Date().toISOString().slice(0, 10);
      if ((await bumpCounter(`translate:${today}`, 2 * 24 * 3600)) > DAILY_LIMIT) {
        throw new LessonError("DAILY_LIMIT", "오늘 번역 한도를 다 썼어요. 내일 다시 시도해 주세요.", 429);
      }
    }

    let result: Awaited<ReturnType<typeof translateLines>>;
    try {
      result = await translateLines(lesson, targets);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("Anthropic API key was rejected");
      } else if (e instanceof Anthropic.RateLimitError) {
        console.error("Anthropic rate limit reached while translating");
      } else {
        console.error("Translation failed", e);
      }
      throw new LessonError("TRANSLATE_FAILED", "번역 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 502);
    }
    const { out, issues } = result;
    if (firstRun && out.size === 0) {
      throw new LessonError("TRANSLATE_FAILED", "이 영상은 번역하지 못했어요.", 502);
    }

    const stillPending = targets.filter((i) => !out.has(i));
    const translated: Lesson = {
      ...lesson,
      koreanOrigin: "ai",
      // Where the model gave nothing, keep any existing (YouTube) line.
      sentences: lesson.sentences.map((s) => (out.has(s.index) ? { ...s, ko: out.get(s.index) } : s)),
      aiPending: stillPending.length ? stillPending : undefined,
      aiAttempts: (firstRun ? 0 : (lesson.aiAttempts ?? 1)) + 1,
    };
    await saveLesson(translated);
    return resultOf(translated, issues);
  })();

  inFlight.set(lessonId, job);
  try {
    return await job;
  } finally {
    inFlight.delete(lessonId);
  }
}
