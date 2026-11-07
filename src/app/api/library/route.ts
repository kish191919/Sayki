import { LessonError } from "@/lib/errors";
import { applyLibraryOp } from "@/lib/library";

/**
 * Organizes lessons: folders (create / rename / delete), moving lessons
 * between folders, and deleting lessons. Body: one `LibraryOp` as JSON.
 * Response: { library, folderId? } — the saved state.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "BAD_REQUEST", error: "요청 형식이 올바르지 않아요." }, { status: 400 });
  }
  try {
    return Response.json(await applyLibraryOp(body));
  } catch (e) {
    if (e instanceof LessonError) return Response.json({ code: e.code, error: e.message }, { status: e.status });
    console.error("library op failed", e);
    return Response.json({ code: "INTERNAL", error: "저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
