import { setBookmark } from "@/lib/bookmarks";
import { LessonError } from "@/lib/errors";

/**
 * Bookmarks one sentence, or removes its bookmark.
 * Body: { lessonId, index, bookmarked: boolean }. Response: { ok: true }.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "BAD_REQUEST", error: "요청 형식이 올바르지 않아요." }, { status: 400 });
  }
  try {
    await setBookmark(body);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof LessonError) return Response.json({ code: e.code, error: e.message }, { status: e.status });
    console.error("bookmark failed", e);
    return Response.json({ code: "INTERNAL", error: "북마크를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
