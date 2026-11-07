import { LessonError } from "@/lib/errors";
import {
  canWriteScript,
  MAX_SCRIPT_IMAGES,
  MAX_SCRIPT_REQUEST,
  MAX_SCRIPT_TEXT,
  writeScriptDraft,
  type ScriptImage,
} from "@/lib/script";

/** Claude reads the photos and writes the script: allow well over a minute. */
export const maxDuration = 300;

const IMAGE_TYPES = new Set<ScriptImage["mediaType"]>(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** The browser shrinks photos before sending; Vercel rejects request bodies above 4.5 MB anyway. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function error(code: string, message: string, status: number) {
  return Response.json({ code, error: message }, { status });
}

/**
 * Writes a teaching script draft from the learner's material.
 * Body: multipart/form-data with `photo` files (any number up to 5), `text`, and `request`.
 * Response: ScriptDraft — nothing is saved until the learner confirms it (POST /api/scripts).
 */
export async function POST(request: Request) {
  if (!canWriteScript()) {
    return error("NO_WRITER", "스크립트 만들기가 설정되지 않았어요. (관리자: ANTHROPIC_API_KEY)", 501);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요. 사진 용량이 너무 크면 장수를 줄여 주세요.", 400);
  }

  const text = String(form.get("text") ?? "").trim();
  const ask = String(form.get("request") ?? "").trim();
  const files = form.getAll("photo").filter((f): f is File => f instanceof File && f.size > 0);

  if (!text && files.length === 0) return error("NO_MATERIAL", "사진을 올리거나 내용을 적어 주세요.", 400);
  if (text.length > MAX_SCRIPT_TEXT) return error("TEXT_TOO_LONG", `내용은 ${MAX_SCRIPT_TEXT}자까지 쓸 수 있어요.`, 400);
  if (ask.length > MAX_SCRIPT_REQUEST) return error("REQUEST_TOO_LONG", `요청 사항은 ${MAX_SCRIPT_REQUEST}자까지 쓸 수 있어요.`, 400);
  if (files.length > MAX_SCRIPT_IMAGES) return error("TOO_MANY_PHOTOS", `사진은 ${MAX_SCRIPT_IMAGES}장까지 올릴 수 있어요.`, 400);

  const images: ScriptImage[] = [];
  for (const f of files) {
    const mediaType = f.type as ScriptImage["mediaType"];
    if (!IMAGE_TYPES.has(mediaType)) return error("BAD_PHOTO", "JPG·PNG·WebP 사진만 올릴 수 있어요.", 400);
    if (f.size > MAX_IMAGE_BYTES) return error("PHOTO_TOO_LARGE", "사진 한 장이 너무 커요.", 413);
    images.push({ mediaType, data: Buffer.from(await f.arrayBuffer()).toString("base64") });
  }

  try {
    return Response.json(await writeScriptDraft({ images, text, request: ask }));
  } catch (e) {
    if (e instanceof LessonError) return error(e.code, e.message, e.status);
    console.error("script draft failed", e);
    return error("INTERNAL", "스크립트를 쓰는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.", 500);
  }
}
