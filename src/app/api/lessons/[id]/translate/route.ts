import { LessonError } from "@/lib/errors";
import { canTranslate, ensureAiTranslation } from "@/lib/translate";

/**
 * Translates a lesson's sentences into Korean with Claude (once; later calls
 * return the stored result). Response: { ko: string[] } aligned to sentences.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/lessons/[id]/translate">) {
  const { id } = await ctx.params;
  if (!canTranslate()) {
    return Response.json({ code: "NO_TRANSLATOR", error: "번역 기능이 설정되지 않았어요." }, { status: 501 });
  }
  try {
    return Response.json({ ko: await ensureAiTranslation(id) });
  } catch (e) {
    if (e instanceof LessonError) return Response.json({ code: e.code, error: e.message }, { status: e.status });
    console.error("translate route failed", e);
    return Response.json({ code: "INTERNAL", error: "번역 중 문제가 생겼어요." }, { status: 500 });
  }
}
