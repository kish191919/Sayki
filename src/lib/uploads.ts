import "server-only";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { del, get, head, issueSignedToken, presignUrl, put, type IssuedSignedToken } from "@vercel/blob";
import { LessonError } from "./errors";
import type { Lesson } from "./types";
import { MAX_UPLOAD_BYTES, UPLOAD_PREFIX, type UploadMode } from "./upload-shared";

/**
 * Video/audio files the learner uploaded (e.g. an Instagram reel saved to the phone).
 * - Vercel Blob (private store): the browser uploads straight to it, since a Vercel
 *   Function only takes 4.5 MB per request. Played through a short-lived presigned URL.
 * - Otherwise `.data/media/{lessonId}` (+ `.jpg` thumbnail) — local development only.
 * Either way the page links to /api/lessons/[id]/media, behind the site lock.
 */

const LOCAL = "local";

export function uploadMode(): UploadMode {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "blob-token";
  if (process.env.BLOB_STORE_ID) return "blob-presigned";
  return process.env.VERCEL ? "off" : "local";
}

export function assertUploadStorage(): void {
  if (uploadMode() !== "off") return;
  console.error("No upload storage: connect a (private) Vercel Blob store to this project.");
  throw new LessonError(
    "NO_UPLOAD_STORAGE",
    "영상 저장소가 아직 연결되지 않았어요. (관리자: Vercel 프로젝트에 Private Blob 저장소를 연결해 주세요.)",
    503,
  );
}

const mediaDir = () => path.join(process.env.SAYKI_DATA_DIR || path.join(process.cwd(), ".data"), "media");
const localMedia = (lessonId: string) => path.join(mediaDir(), lessonId);
const localThumb = (lessonId: string) => path.join(mediaDir(), `${lessonId}.jpg`);

/** What `source.media` / `source.type` will hold, and the file's size. */
export type StoredMedia = { media: string; type: string; size: number };

/** A file the browser uploaded to Blob: checks it is one of ours, video/audio, and not too large. */
export async function uploadedBlob(rawUrl: string): Promise<StoredMedia> {
  const notOurs = new LessonError("BAD_UPLOAD", "올린 영상의 주소가 올바르지 않아요. 다시 올려 주세요.", 400);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw notOurs;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".blob.vercel-storage.com") ||
    !url.pathname.startsWith(`/${UPLOAD_PREFIX}`)
  ) {
    throw notOurs;
  }

  let meta: Awaited<ReturnType<typeof head>>;
  try {
    // Authenticated with this store's credentials: a blob of another store fails here too.
    meta = await head(url.href);
  } catch (e) {
    console.error("Uploaded blob lookup failed", e);
    throw new LessonError("UPLOAD_MISSING", "올린 영상을 찾지 못했어요. 다시 올려 주세요.", 422);
  }
  const type = meta.contentType.split(";")[0].trim().toLowerCase();
  if (!/^(video|audio)\//.test(type)) {
    throw new LessonError("NOT_MEDIA", "영상이나 오디오 파일이 아니에요.", 422);
  }
  if (meta.size > MAX_UPLOAD_BYTES) {
    throw new LessonError("UPLOAD_TOO_LARGE", `${MAX_UPLOAD_BYTES / 1024 / 1024}MB 이하 파일만 올릴 수 있어요.`, 413);
  }
  return { media: meta.url, type, size: meta.size };
}

/** Local development: keeps the file the browser sent. */
export async function saveLocalMedia(lessonId: string, file: File, type: string): Promise<StoredMedia> {
  const target = localMedia(lessonId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
  return { media: LOCAL, type, size: file.size };
}

/** Local development: removes a file kept for a lesson that then failed. */
export async function discardLocalMedia(lessonId: string): Promise<void> {
  await Promise.all([fs.rm(localMedia(lessonId), { force: true }), fs.rm(localThumb(lessonId), { force: true })]);
}

/** The uploaded file itself (for Whisper, when the browser couldn't extract the speech). */
export async function readUploadedMedia(lessonId: string, stored: StoredMedia): Promise<Blob> {
  if (stored.media === LOCAL) {
    return new Blob([new Uint8Array(await fs.readFile(localMedia(lessonId)))], { type: stored.type });
  }
  const result = await get(stored.media, { access: "private" });
  if (result?.statusCode !== 200 || !result.stream) {
    throw new LessonError("UPLOAD_MISSING", "올린 영상을 찾지 못했어요. 다시 올려 주세요.", 422);
  }
  return new Blob([await new Response(result.stream).arrayBuffer()], { type: stored.type });
}

/** Saves the lesson card's picture (a frame the browser grabbed); null when it couldn't. */
export async function saveThumbnail(lessonId: string, jpeg: File): Promise<string | null> {
  try {
    const bytes = Buffer.from(await jpeg.arrayBuffer());
    if (uploadMode() === "local") {
      const file = localThumb(lessonId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      return LOCAL;
    }
    const blob = await put(`${UPLOAD_PREFIX}${lessonId}-thumb.jpg`, bytes, {
      access: "private",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (e) {
    console.error("Saving the thumbnail failed", e);
    return null;
  }
}

/* -------------------------------- Serving -------------------------------- */

type FileSource = Extract<Lesson["source"], { kind: "file" }>;

const notFound = () => Response.json({ code: "NOT_FOUND", error: "파일이 없어요." }, { status: 404 });

/** "bytes=500-", "bytes=500-999" or "bytes=-500"; null: the whole file; "invalid": unsatisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

async function localFileResponse(file: string, type: string, rangeHeader: string | null): Promise<Response> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return notFound();
  }
  const headers = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    // A lesson's file never changes (a new upload is a new lesson).
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Read delegations, reused while they have plenty of time left (signing a URL is then local). */
const delegations = new Map<string, IssuedSignedToken>();
const DELEGATION_MS = 6 * 60 * 60 * 1000;
const DELEGATION_MIN_LEFT_MS = 2 * 60 * 60 * 1000;
/** How long the browser may reuse a redirect (well inside the delegation's remaining time). */
const REDIRECT_MAX_AGE_SEC = 60 * 60;

async function presignedGet(blobUrl: string): Promise<string> {
  const pathname = decodeURIComponent(new URL(blobUrl).pathname.slice(1));
  let token = delegations.get(pathname);
  if (!token || token.validUntil - Date.now() < DELEGATION_MIN_LEFT_MS) {
    token = await issueSignedToken({ pathname, operations: ["get"], validUntil: Date.now() + DELEGATION_MS });
    delegations.set(pathname, token);
    if (delegations.size > 50) delegations.delete(delegations.keys().next().value!);
  }
  const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private" });
  return presignedUrl;
}

/** Streams a private blob through the function (fallback when presigning isn't available). */
async function proxiedBlob(blobUrl: string, type: string, range: string | null): Promise<Response> {
  const result = await get(blobUrl, { access: "private", headers: range ? { range } : undefined });
  if (!result?.stream) return notFound();
  const headers = new Headers({ "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = result.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(result.stream, { status: headers.has("content-range") ? 206 : 200, headers });
}

/** The lesson's video/audio for the practice room's player (byte ranges supported, for seeking). */
export async function mediaResponse(lesson: Lesson, request: Request): Promise<Response> {
  if (lesson.source.kind !== "file") return notFound();
  const source: FileSource = lesson.source;
  const range = request.headers.get("range");
  if (source.media === LOCAL) return localFileResponse(localMedia(lesson.id), source.type, range);

  // The CDN serves the bytes (and every seek) itself; the function only signs the URL.
  try {
    const location = await presignedGet(source.media);
    return new Response(null, {
      status: 307,
      headers: { Location: location, "Cache-Control": `private, max-age=${REDIRECT_MAX_AGE_SEC}` },
    });
  } catch (e) {
    console.warn("Presigning the media URL failed; streaming it through the function", e);
    return proxiedBlob(source.media, source.type, range);
  }
}

export async function thumbnailResponse(lesson: Lesson): Promise<Response> {
  const thumb = lesson.source.kind === "file" ? lesson.source.thumb : null;
  if (!thumb) return notFound();
  let bytes: Uint8Array<ArrayBuffer> | null;
  if (thumb === LOCAL) {
    bytes = await fs.readFile(localThumb(lesson.id)).then((b) => new Uint8Array(b), () => null);
  } else {
    const result = await get(thumb, { access: "private" });
    bytes = result?.statusCode === 200 ? new Uint8Array(await new Response(result.stream).arrayBuffer()) : null;
  }
  if (!bytes) return notFound();
  return new Response(bytes, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

/** Deletes the uploaded files of the file lessons among `lessons` (best effort). */
export async function deleteUploadedMedia(lessons: Lesson[]): Promise<void> {
  const blobs: string[] = [];
  const files: string[] = [];
  for (const l of lessons) {
    if (l.source.kind !== "file") continue;
    const stored: [string | null, string][] = [
      [l.source.media, localMedia(l.id)],
      [l.source.thumb, localThumb(l.id)],
    ];
    for (const [where, local] of stored) {
      if (!where) continue;
      if (where === LOCAL) files.push(local);
      else blobs.push(where);
    }
  }
  try {
    await Promise.all([blobs.length ? del(blobs) : null, ...files.map((f) => fs.rm(f, { force: true }))]);
  } catch (e) {
    console.error("Deleting uploaded media failed", e);
  }
}
