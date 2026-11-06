import "server-only";
import { LessonError } from "./errors";
import { cleanCaptionText } from "./text";
import type { Cue } from "./types";

/** OpenAI's transcription endpoint rejects uploads above 25 MB. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export function canTranscribe(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Generates timed English captions for an audio/video file with Whisper.
 * Segment-level timestamps are used (they keep punctuation, which drives
 * sentence splitting); word timings are interpolated later.
 */
export async function transcribeMedia(blob: Blob, filename: string): Promise<Cue[]> {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("language", "en");

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new LessonError("TRANSCRIBE_FAILED", "자동 자막 생성 서버에 연결하지 못했어요.", 502);
  }
  if (!res.ok) {
    console.error("OpenAI transcription failed", res.status, await res.text().catch(() => ""));
    throw new LessonError("TRANSCRIBE_FAILED", "자동 자막 생성에 실패했어요. 다른 파일로 시도해 주세요.", 502);
  }

  const json = (await res.json()) as { segments?: { start: number; end: number; text: string }[] };
  return (json.segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: cleanCaptionText(s.text) }))
    .filter((c) => c.text && c.end > c.start);
}
