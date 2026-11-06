import { createLesson } from "@/lib/create-lesson";
import { LessonError } from "@/lib/errors";

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

function error(code: string, message: string, status: number) {
  return Response.json({ code, error: message }, { status });
}

/**
 * Creates (or reuses) a lesson from a pasted link.
 * Body: multipart/form-data with `url` and an optional `subtitle` file (.srt/.vtt).
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }

  const url = String(form.get("url") ?? "").trim();
  if (!url) return error("NO_URL", "영상 링크를 입력해 주세요.", 400);
  if (url.length > 2048) return error("INVALID_URL", "링크가 너무 길어요.", 400);

  const file = form.get("subtitle");
  const subtitle = file instanceof File && file.size > 0 ? file : null;
  if (subtitle && subtitle.size > MAX_SUBTITLE_BYTES) {
    return error("SUBTITLE_TOO_LARGE", "자막 파일은 2MB 이하만 올릴 수 있어요.", 413);
  }

  try {
    const lesson = await createLesson(url, subtitle ? await subtitle.text() : null);
    return Response.json({ id: lesson.id });
  } catch (e) {
    if (e instanceof LessonError) return error(e.code, e.message, e.status);
    console.error("createLesson failed", e);
    return error("INTERNAL", "레슨을 만드는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 500);
  }
}
