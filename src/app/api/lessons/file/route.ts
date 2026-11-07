import { createFileLesson } from "@/lib/create-file-lesson";
import { LessonError } from "@/lib/errors";
import { MAX_TRANSCRIBE_BYTES } from "@/lib/transcribe";

/** Whisper on a long recording can take a while. */
export const maxDuration = 300;

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;

function error(code: string, message: string, status: number) {
  return Response.json({ code, error: message }, { status });
}

function fileField(form: FormData, name: string): File | null {
  const value = form.get(name);
  return value instanceof File && value.size > 0 ? value : null;
}

/**
 * Creates a lesson from a video/audio file the learner uploaded.
 * Body: multipart/form-data with
 * - `media`: the Blob URL the browser uploaded to (Blob storage), or the file itself (local development)
 * - `name`, `duration`: the file's name and length (seconds), as the browser read them
 * - `speech` (optional): the speech as a small MP3, for Whisper
 * - `subtitle` (optional): an .srt/.vtt file instead of automatic captions
 * - `thumbnail` (optional): a JPEG frame for the lesson card
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }

  const raw = form.get("media");
  const media = raw instanceof File ? (raw.size > 0 ? raw : null) : typeof raw === "string" ? raw.trim() : null;
  if (!media) return error("NO_MEDIA", "영상 파일을 골라 주세요.", 400);
  if (typeof media === "string" && media.length > 2048) return error("BAD_UPLOAD", "요청 형식이 올바르지 않아요.", 400);

  const subtitle = fileField(form, "subtitle");
  if (subtitle && subtitle.size > MAX_SUBTITLE_BYTES) {
    return error("SUBTITLE_TOO_LARGE", "자막 파일은 2MB 이하만 올릴 수 있어요.", 413);
  }
  const speech = fileField(form, "speech");
  if (speech && speech.size > MAX_TRANSCRIBE_BYTES) {
    return error("MEDIA_TOO_LARGE", "영상이 너무 길어요. 자막 파일(.srt, .vtt)을 함께 올려 주세요.", 413);
  }
  const picture = fileField(form, "thumbnail");
  const thumbnail = picture && picture.size <= MAX_THUMBNAIL_BYTES && picture.type === "image/jpeg" ? picture : null;
  const duration = Number(form.get("duration"));

  try {
    const lesson = await createFileLesson({
      media,
      name: String(form.get("name") ?? "").slice(0, 300),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      speech,
      subtitle: subtitle ? await subtitle.text() : null,
      thumbnail,
    });
    return Response.json({ id: lesson.id });
  } catch (e) {
    if (e instanceof LessonError) return error(e.code, e.message, e.status);
    console.error("createFileLesson failed", e);
    return error("INTERNAL", "레슨을 만드는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 500);
  }
}
