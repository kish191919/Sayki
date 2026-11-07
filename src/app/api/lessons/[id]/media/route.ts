import { getLesson } from "@/lib/store";
import { mediaResponse } from "@/lib/uploads";

/**
 * An uploaded lesson's video/audio for the practice room's player. Blob storage
 * redirects to a short-lived presigned URL (the CDN serves byte ranges itself);
 * local development serves the file with byte ranges.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/lessons/[id]/media">) {
  const { id } = await ctx.params;
  const lesson = await getLesson(id);
  if (!lesson || lesson.source.kind !== "file") {
    return Response.json({ code: "NOT_FOUND", error: "영상 파일이 없어요." }, { status: 404 });
  }
  try {
    return await mediaResponse(lesson, request);
  } catch (e) {
    console.error("serving uploaded media failed", e);
    return Response.json({ code: "MEDIA_FAILED", error: "영상 파일을 불러오지 못했어요." }, { status: 502 });
  }
}
