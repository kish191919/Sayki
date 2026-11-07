import { createScriptLesson, parseScriptLessonInput } from "@/lib/create-script-lesson";
import { LessonError } from "@/lib/errors";
import { canSpeak } from "@/lib/tts";

/** Every sentence is read aloud (a few at a time) and encoded: allow a couple of minutes. */
export const maxDuration = 300;

function error(code: string, message: string, status: number) {
  return Response.json({ code, error: message }, { status });
}

/**
 * Turns a reviewed teaching script into a lesson: English audio for every
 * sentence, joined into one MP3 with exact sentence timings.
 * Body: JSON { title, lines: [{ en, ko }] }. Response: { id }.
 */
export async function POST(request: Request) {
  if (!canSpeak()) {
    return error("NO_TTS", "영어 음성 만들기가 설정되지 않았어요. (관리자: OPENAI_API_KEY)", 501);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }
  try {
    const lesson = await createScriptLesson(parseScriptLessonInput(body));
    return Response.json({ id: lesson.id });
  } catch (e) {
    if (e instanceof LessonError) return error(e.code, e.message, e.status);
    console.error("script lesson failed", e);
    return error("INTERNAL", "레슨을 만드는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 500);
  }
}
