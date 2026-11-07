import { issueSignedToken } from "@vercel/blob";
import {
  handleUpload,
  handleUploadPresigned,
  type HandleUploadBody,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-shared";
import { uploadMode } from "@/lib/uploads";

/** What the browser may upload: one video/audio file under uploads/, named by itself at random. */
const PATHNAME_RE = /^uploads\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/;
const CONTENT_TYPES = ["video/*", "audio/*"];
/** Long enough for a large multipart upload on a slow connection. */
const VALID_MS = 60 * 60 * 1000;

function error(code: string, message: string, status: number) {
  return Response.json({ code, error: message }, { status });
}

/**
 * Lets the browser upload a video straight to Vercel Blob (a Vercel Function only
 * takes 4.5 MB per request). Called by `upload()` / `uploadPresigned()` from
 * `@vercel/blob/client`; behind the site lock like every API route. Sayki registers
 * no upload-completed callback: the browser tells /api/lessons/file when it is done.
 */
export async function POST(request: Request) {
  const mode = uploadMode();
  if (mode !== "blob-token" && mode !== "blob-presigned") {
    return error("NO_UPLOAD_STORAGE", "영상 저장소가 아직 연결되지 않았어요.", 503);
  }

  let body: { type?: unknown; payload?: { pathname?: unknown } };
  try {
    body = await request.json();
  } catch {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }
  const pathname = body.payload?.pathname;
  if (typeof pathname !== "string" || !PATHNAME_RE.test(pathname)) {
    return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
  }

  try {
    if (mode === "blob-token") {
      if (body.type !== "blob.generate-client-token") return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
      return Response.json(
        await handleUpload({
          request,
          body: body as HandleUploadBody,
          onBeforeGenerateToken: async () => ({
            allowedContentTypes: CONTENT_TYPES,
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
            validUntil: Date.now() + VALID_MS,
          }),
        }),
      );
    }

    if (body.type !== "blob.generate-presigned-url") return error("BAD_REQUEST", "요청 형식이 올바르지 않아요.", 400);
    return Response.json(
      await handleUploadPresigned({
        request,
        body: body as HandleUploadPresignedBody,
        // Only used to verify upload-completed callbacks, which Sayki doesn't register.
        webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || "unused",
        getSignedToken: async (path) => ({
          token: await issueSignedToken({
            pathname: path,
            operations: ["put"],
            validUntil: Date.now() + VALID_MS,
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
            allowedContentTypes: CONTENT_TYPES,
          }),
          urlOptions: { maximumSizeInBytes: MAX_UPLOAD_BYTES, allowedContentTypes: CONTENT_TYPES },
        }),
      }),
    );
  } catch (e) {
    console.error("Preparing a Blob upload failed", e);
    return error("UPLOAD_TOKEN_FAILED", "영상을 올릴 준비를 하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
  }
}
