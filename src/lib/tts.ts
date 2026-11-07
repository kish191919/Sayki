import "server-only";
import { LessonError } from "./errors";

/**
 * English speech with OpenAI's text-to-speech. Asks for raw PCM (24 kHz,
 * 16-bit signed little-endian, mono) so sentences can be joined with exact
 * timings before encoding (see script-audio.ts).
 */

export const TTS_SAMPLE_RATE = 24_000;

const MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const VOICE = process.env.OPENAI_TTS_VOICE || "marin";
/** Only the gpt-4o TTS models take a style prompt (tts-1 rejects it). */
const INSTRUCTIONS = MODEL.startsWith("gpt-")
  ? "You are a warm, clear elementary school teacher explaining a lesson to students aged 10 to 12. " +
    "Speak at a calm, steady teaching pace with natural classroom intonation, and say numbers and math terms carefully. " +
    "Read the text exactly as written."
  : undefined;
const ATTEMPTS = 4;
/** OPENAI_BASE_URL: the OpenAI SDKs' own variable, e.g. for a proxy (default: the public API). */
const ENDPOINT = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/audio/speech`;

export function canSpeak(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Out of credit: a 429 that no amount of waiting fixes. OpenAI has used several codes for it
 * (insufficient_quota, credit_balance_exhausted, billing_hard_limit_reached …), so match loosely.
 */
const outOfCredit = (code: string) => /quota|credit|billing/i.test(code);

/** OpenAI's error code (e.g. insufficient_quota) and message from an error response body. */
function parseError(body: string): { code: string; message: string } {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string | null; type?: string; message?: string } }).error;
    return { code: e?.code || e?.type || "", message: e?.message || "" };
  } catch {
    return { code: "", message: body };
  }
}

/** What to tell the learner, by OpenAI's status and error code. */
function failureMessage(status: number, code: string): string {
  if (status === 401) return "OpenAI API 키가 올바르지 않아요. Vercel의 OPENAI_API_KEY를 확인해 주세요.";
  if (outOfCredit(code)) return "OpenAI 크레딧이 부족해요. platform.openai.com → Billing에서 크레딧을 충전해 주세요.";
  if (status === 429) return "OpenAI 요청 한도에 걸렸어요. 1–2분 뒤 다시 시도해 주세요.";
  if (status === 403 || status === 404) {
    return `이 OpenAI 키로는 음성 모델(${MODEL})을 쓸 수 없어요. 키 권한이나 프로젝트의 모델 허용 설정을 확인해 주세요.`;
  }
  if (status === 400) return `OpenAI가 음성 요청을 거절했어요. 모델(${MODEL})과 목소리(${VOICE}) 설정을 확인해 주세요.`;
  return "OpenAI 음성 서버에 문제가 있어요. 잠시 후 다시 시도해 주세요.";
}

/** How long to wait before retrying: OpenAI's Retry-After when given (capped), else exponential. */
function retryDelay(attempt: number, res?: Response): number {
  const ms = Number(res?.headers.get("retry-after-ms")) || Number(res?.headers.get("retry-after")) * 1000;
  if (ms > 0) return Math.min(ms, 20_000);
  return 1000 * 2 ** (attempt - 1) + Math.random() * 500;
}

/** Reads one sentence aloud; returns its samples. */
export async function synthesize(text: string): Promise<Int16Array> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: INSTRUCTIONS, response_format: "pcm" }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt >= ATTEMPTS) {
        console.error("OpenAI speech request failed", e);
        throw new LessonError("TTS_FAILED", "음성 생성 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
      }
      await sleep(retryDelay(attempt));
      continue;
    }

    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Copy rather than view: the body's buffer may not be 2-byte aligned.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = new Int16Array(bytes.byteLength >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
      return samples;
    }

    const { code, message } = parseError(await res.text().catch(() => ""));
    const retry = !outOfCredit(code) && (res.status === 429 || res.status >= 500);
    if (!retry || attempt >= ATTEMPTS) {
      console.error(`OpenAI speech failed: ${res.status} ${code} (model ${MODEL}, voice ${VOICE})`, message.slice(0, 500));
      // The status and code go on screen too: the server log is a dashboard away.
      const detail = `OpenAI ${res.status}${code ? ` · ${code}` : ""}`;
      throw new LessonError("TTS_FAILED", `${failureMessage(res.status, code)} (${detail})`, 502);
    }
    await sleep(retryDelay(attempt, res));
  }
}
