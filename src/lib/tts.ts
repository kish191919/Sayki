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
const ATTEMPTS = 3;
/** OPENAI_BASE_URL: the OpenAI SDKs' own variable, e.g. for a proxy (default: the public API). */
const ENDPOINT = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/audio/speech`;

export function canSpeak(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads one sentence aloud; returns its samples. */
export async function synthesize(text: string): Promise<Int16Array> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
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
    }

    if (res?.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Copy rather than view: the body's buffer may not be 2-byte aligned.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = new Int16Array(bytes.byteLength >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
      return samples;
    }

    if (res) {
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= ATTEMPTS) {
        console.error("OpenAI speech failed", res.status, (await res.text().catch(() => "")).slice(0, 500));
        throw new LessonError(
          "TTS_FAILED",
          res.status === 401 ? "OpenAI API 키를 확인해 주세요." : "영어 음성을 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
          502,
        );
      }
    }
    await sleep(800 * 2 ** (attempt - 1));
  }
}
