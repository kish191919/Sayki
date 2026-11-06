import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { LessonError } from "./errors";
import { bumpCounter, getLesson, saveLesson } from "./store";
import type { Lesson } from "./types";

/**
 * Sentence-by-sentence Korean translation with Claude, so every lesson gets
 * a Korean line aligned 1:1 with its English sentences (needed for the
 * "Korean → speak English" mode; YouTube's Korean tracks are timed chunks).
 */

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || "claude-opus-5-5";
/** Models that accept server-side `fallbacks: "default"` (not Haiku). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

const CHUNK_SIZE = 40;
const CONCURRENCY = 4;
const CONTEXT_LINES = 3;
const MAX_SENTENCES = 1500;
const DAILY_LIMIT = Number(process.env.TRANSLATE_DAILY_LIMIT) || 100;

export function canTranslate(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

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

type Usage = { input: number; output: number };

/**
 * Translates one chunk. Returns null when the model (and its fallback)
 * declined the content; throws on API/network errors.
 */
async function translateChunk(
  title: string,
  items: { id: number; text: string }[],
  context: string[],
  usage: Usage,
): Promise<Map<number, string> | null> {
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
    ...(FALLBACK_MODELS.has(MODEL)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  });

  usage.input += response.usage.input_tokens;
  usage.output += response.usage.output_tokens;

  if (response.stop_reason === "refusal") {
    console.warn(`Translation declined (${response.stop_details?.category ?? "unknown"}) for "${title}"`);
    return null;
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("translation hit max_tokens");
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as { translations?: { id: number; ko: string }[] };
  const result = new Map<number, string>();
  for (const t of parsed.translations ?? []) {
    if (Number.isInteger(t.id) && typeof t.ko === "string" && t.ko.trim()) result.set(t.id, t.ko.trim());
  }
  return result;
}

async function translateSentences(lesson: Lesson): Promise<string[]> {
  const { sentences } = lesson;
  const out: string[] = sentences.map(() => "");
  const usage: Usage = { input: 0, output: 0 };

  const chunks: { start: number; end: number }[] = [];
  for (let s = 0; s < sentences.length; s += CHUNK_SIZE) {
    chunks.push({ start: s, end: Math.min(sentences.length, s + CHUNK_SIZE) });
  }

  const runChunk = async ({ start, end }: { start: number; end: number }) => {
    const items = sentences.slice(start, end).map((s) => ({ id: s.index, text: s.text }));
    const context = sentences.slice(Math.max(0, start - CONTEXT_LINES), start).map((s) => s.text);
    let missing = items;
    // One retry for lines the model left out.
    for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
      const got = await translateChunk(lesson.title, missing, context, usage);
      if (!got) return; // declined: leave these lines untranslated
      for (const [id, ko] of got) if (id >= start && id < end) out[id] = ko;
      missing = missing.filter((m) => !out[m.id]);
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length) await runChunk(chunks[next++]);
  });
  await Promise.all(workers);

  console.log(
    `Translated ${lesson.id} (${sentences.length} sentences) with ${MODEL}: ` +
      `${usage.input} input / ${usage.output} output tokens`,
  );
  return out;
}

const inFlight = new Map<string, Promise<string[]>>();

/**
 * Makes sure the lesson has AI translations, translating and saving them
 * the first time. Returns the Korean line for every sentence.
 */
export async function ensureAiTranslation(lessonId: string): Promise<string[]> {
  const running = inFlight.get(lessonId);
  if (running) return running;

  const job = (async () => {
    const lesson = await getLesson(lessonId);
    if (!lesson) throw new LessonError("NOT_FOUND", "레슨을 찾을 수 없어요.", 404);
    if (lesson.koreanOrigin === "ai") return lesson.sentences.map((s) => s.ko ?? "");

    if (lesson.sentences.length > MAX_SENTENCES) {
      throw new LessonError("TOO_LONG", "영상이 너무 길어서 번역할 수 없어요.", 422);
    }
    const today = new Date().toISOString().slice(0, 10);
    if ((await bumpCounter(`translate:${today}`, 2 * 24 * 3600)) > DAILY_LIMIT) {
      throw new LessonError("DAILY_LIMIT", "오늘 번역 한도를 다 썼어요. 내일 다시 시도해 주세요.", 429);
    }

    let ko: string[];
    try {
      ko = await translateSentences(lesson);
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

    const translated: Lesson = {
      ...lesson,
      koreanOrigin: "ai",
      // Keep an existing (YouTube) line where the model declined a chunk.
      sentences: lesson.sentences.map((s, i) => ({ ...s, ko: ko[i] || s.ko })),
    };
    await saveLesson(translated);
    return translated.sentences.map((s) => s.ko ?? "");
  })();

  inFlight.set(lessonId, job);
  try {
    return await job;
  } finally {
    inFlight.delete(lessonId);
  }
}
