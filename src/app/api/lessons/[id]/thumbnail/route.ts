import { getLesson } from "@/lib/store";
import { thumbnailResponse } from "@/lib/uploads";

/** The lesson card's picture of an uploaded video (a frame the browser grabbed). */
export async function GET(_request: Request, ctx: RouteContext<"/api/lessons/[id]/thumbnail">) {
  const { id } = await ctx.params;
  const lesson = await getLesson(id);
  if (!lesson) return Response.json({ code: "NOT_FOUND", error: "사진이 없어요." }, { status: 404 });
  try {
    return await thumbnailResponse(lesson);
  } catch (e) {
    console.error("serving thumbnail failed", e);
    return Response.json({ code: "THUMBNAIL_FAILED", error: "사진을 불러오지 못했어요." }, { status: 502 });
  }
}
