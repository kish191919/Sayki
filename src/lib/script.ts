import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, canUseClaude, fallbackParams, tokenTotals } from "./claude";
import { LessonError } from "./errors";
import { bumpCounter } from "./store";
import type { ScriptDraft, ScriptLine } from "./types";

/**
 * Writes a spoken English teaching script from the teacher's material (photos
 * of a textbook page and/or typed notes), one practice sentence per line,
 * each with a Korean line to practise "Korean → English" from.
 */

const MODEL = process.env.ANTHROPIC_SCRIPT_MODEL || "claude-opus-5-5";
const DAILY_LIMIT = Number(process.env.SCRIPT_DAILY_LIMIT) || 30;

export const MAX_SCRIPT_IMAGES = 5;
export const MAX_SCRIPT_TEXT = 8000;
export const MAX_SCRIPT_REQUEST = 500;
/** Lines kept from the model's answer (a 2–3 minute script is about 25–40). */
const MAX_LINES = 80;

export const canWriteScript = canUseClaude;

const SYSTEM = `You write spoken English teaching scripts for a Korean teacher who teaches elementary school students in grades 4 to 6 (about 10 to 12 years old) in English. The teacher gives you material — photos of a textbook or worksheet page, typed notes, or both. The teacher will practise your script aloud sentence by sentence (listening, shadowing, and saying the English from the Korean) and then use it to teach the lesson in class. The subject is usually elementary math, but it can be anything.

What to write
- A clear, focused explanation of the key content of the material, the way a good teacher explains it out loud to these students.
- Length: about 280 to 380 English words in total — two to three minutes at a calm teaching pace.
- A typical flow is: introduce the idea, explain it step by step, work through one or two concrete examples (use the material's own examples and numbers when it has them), check understanding with a question or point out a common mistake, and finish with a short recap. Follow the material rather than forcing this shape.

Leave out
- Greetings, small talk, attendance, and closing pleasantries ("Good morning, everyone!", "How was your weekend?", "See you next time!").
- Classroom management ("Open your books to page 32.", "Take out your pencils.", "Be quiet, please.").
- References to the layout of the page or photo ("Look at the picture on the left.", "In box number three ...").

Keep
- The teacher language that carries an explanation: introducing a topic ("Today, we're going to learn how to ..."), signposting ("First, ...", "Here's the key idea.", "Let's try one together."), rephrasing ("In other words, ..."), and questions to the students ("What do you think comes next?"). The teacher most needs to say these fluently, so use them naturally — but every sentence has to move the explanation forward.

Language
- Natural spoken classroom English that 10- to 12-year-old learners of English can follow: short, clear sentences and common words. Use the correct subject terms (numerator, denominator, ...) and explain each one simply the first time it appears.
- Each line is exactly one sentence (a question counts as one), with one idea, usually 5 to 18 words. Split longer sentences.
- Write math the way it is said aloud, with no symbols: "three fourths", "two plus five equals seven", "twelve divided by four is three", "is greater than". Whole numbers up to twenty in words; larger numbers may be digits.

Korean
- For every English line, write a Korean line ("ko"). The teacher will read or hear the Korean and try to say the English from it, so it keeps all of the information and stays close to the English sentence's structure, while sounding like natural Korean an elementary school teacher says to students, in 해요체 (e.g. "오늘은 분수의 크기를 비교하는 방법을 알아볼 거예요.").
- When the material is in Korean, use its Korean terms (분모, 분자, 약분, ...) in the Korean lines.

Accuracy
- Teach only what the material supports. You may add a simple example of your own to make an idea clearer, but no facts the material doesn't support, and double-check every calculation.
- If part of a photo is unreadable, work with what you can read. If the material seems to contain an error, teach the correct version.
- "notes" (in Korean) lists what the teacher should check before practising: unreadable parts, guesses you made, errors you corrected. Leave it empty when there is nothing to check.
- If there is nothing to teach (a blank or unrelated photo), return no lines and say why in "notes".

Titles
- "title": a short English title for the lesson, e.g. "Comparing Fractions". "titleKo": the same in Korean, e.g. "분수의 크기 비교".

When the teacher adds a request (what to focus on or emphasise), follow it.`;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    titleKo: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          en: { type: "string" },
          ko: { type: "string" },
        },
        required: ["en", "ko"],
        additionalProperties: false,
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["title", "titleKo", "lines", "notes"],
  additionalProperties: false,
};

export type ScriptImage = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

export type ScriptInput = {
  images: ScriptImage[];
  /** Typed material (may be empty when there are photos). */
  text: string;
  /** What the teacher wants emphasised (optional). */
  request: string;
};

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

export async function writeScriptDraft(input: ScriptInput): Promise<ScriptDraft> {
  const today = new Date().toISOString().slice(0, 10);
  if ((await bumpCounter(`script:${today}`, 2 * 24 * 3600)) > DAILY_LIMIT) {
    throw new LessonError("DAILY_LIMIT", "오늘 스크립트 만들기 한도를 다 썼어요. 내일 다시 시도해 주세요.", 429);
  }

  const parts: string[] = [];
  if (input.images.length) {
    parts.push(
      input.images.length === 1
        ? "The material is in the photo above."
        : `The material is in the ${input.images.length} photos above, in order.`,
    );
  }
  if (input.text) parts.push(`<material>\n${input.text}\n</material>`);
  if (input.request) parts.push(`<teacher_request>\n${input.request}\n</teacher_request>`);
  parts.push("Write the teaching script.");

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...input.images.map(
      (img): Anthropic.Beta.BetaImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      }),
    ),
    { type: "text", text: parts.join("\n\n") },
  ];

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{ role: "user", content }],
      ...fallbackParams(MODEL),
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error("Anthropic API key was rejected");
    else if (e instanceof Anthropic.RateLimitError) console.error("Anthropic rate limit reached while writing a script");
    else console.error("Script writing failed", e);
    throw new LessonError("SCRIPT_FAILED", "스크립트를 쓰는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 502);
  }

  const tokens = tokenTotals(response.usage);
  console.log(
    `Script written with ${response.model}: ${input.images.length} photos, ${input.text.length} chars, ` +
      `${tokens.input} input / ${tokens.output} output tokens, stop ${response.stop_reason}`,
  );

  if (response.stop_reason === "refusal") {
    console.warn(`Script declined (${response.stop_details?.category ?? "none"}) by ${response.model}`);
    throw new LessonError("SCRIPT_DECLINED", "이 자료로는 스크립트를 쓰지 못했어요. 다른 자료로 시도해 주세요.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new LessonError("SCRIPT_TOO_LONG", "스크립트가 너무 길어졌어요. 자료를 나눠서 시도해 주세요.", 422);
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let parsed: { title?: unknown; titleKo?: unknown; lines?: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Script answer was not JSON", text.slice(0, 500));
    throw new LessonError("SCRIPT_FAILED", "스크립트를 쓰는 중 문제가 생겼어요. 다시 시도해 주세요.", 502);
  }

  const lines: ScriptLine[] = (Array.isArray(parsed.lines) ? parsed.lines : [])
    .map((l: { en?: unknown; ko?: unknown }) => ({ en: clean(l?.en), ko: clean(l?.ko) }))
    .filter((l) => l.en)
    .slice(0, MAX_LINES);
  const notes = (Array.isArray(parsed.notes) ? parsed.notes : []).map(clean).filter(Boolean);

  if (lines.length === 0) {
    throw new LessonError(
      "SCRIPT_EMPTY",
      notes[0] ?? "자료에서 설명할 내용을 찾지 못했어요. 사진이 잘 보이는지 확인해 주세요.",
      422,
    );
  }
  return {
    title: clean(parsed.title) || "Teaching Script",
    titleKo: clean(parsed.titleKo),
    lines,
    notes,
  };
}
