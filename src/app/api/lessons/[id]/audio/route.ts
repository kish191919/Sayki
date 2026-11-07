import { readScriptAudio } from "@/lib/script-audio";
import { getLesson } from "@/lib/store";

/**
 * A script lesson's MP3, for the practice room's player and for downloading
 * (`?download`). Supports byte ranges, which media elements use to seek.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/lessons/[id]/audio">) {
  const { id } = await ctx.params;
  const lesson = await getLesson(id);
  if (!lesson || lesson.source.kind !== "script") {
    return Response.json({ code: "NOT_FOUND", error: "음성 파일이 없어요." }, { status: 404 });
  }

  let bytes: Buffer | null;
  try {
    bytes = await readScriptAudio(lesson);
  } catch (e) {
    console.error("reading script audio failed", e);
    return Response.json({ code: "AUDIO_FAILED", error: "음성 파일을 불러오지 못했어요." }, { status: 502 });
  }
  if (!bytes) return Response.json({ code: "NOT_FOUND", error: "음성 파일이 없어요." }, { status: 404 });

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    // A lesson's audio never changes (a new script is a new lesson).
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (new URL(request.url).searchParams.has("download")) {
    const name = `${lesson.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "script"}.mp3`;
    headers.set("Content-Disposition", `attachment; filename="sayki-script.mp3"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }

  const size = bytes.length;
  const range = request.headers.get("range");
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    headers.set("Content-Length", String(size));
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  }

  // "bytes=500-" (from 500), "bytes=500-999", or "bytes=-500" (the last 500).
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
}
