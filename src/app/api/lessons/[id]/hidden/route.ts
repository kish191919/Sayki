import { LessonError } from "@/lib/errors";
import { setHidden } from "@/lib/hidden";

/**
 * Deletes sentences from the lesson's practice (they stop showing up), or restores them.
 * Body: { indexes: number[], hidden: boolean }. Response: { ok: true }.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/lessons/[id]/hidden">) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "BAD_REQUEST", error: "요청 형식이 올바르지 않아요." }, { status: 400 });
  }
  try {
    await setHidden(id, body);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof LessonError) return Response.json({ code: e.code, error: e.message }, { status: e.status });
    console.error("hide sentences failed", e);
    return Response.json(
      { code: "INTERNAL", error: "문장 삭제를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      { status: 500 },
    );
  }
}
