/** Shared by the browser and the server: limits and file types of uploaded video/audio. */

/**
 * Where uploaded files go (decided on the server from its env):
 * - "blob-token": Vercel Blob, browser uploads with a client token (BLOB_READ_WRITE_TOKEN).
 * - "blob-presigned": Vercel Blob, browser uploads to a presigned URL (OIDC + BLOB_STORE_ID).
 * - "local": the browser sends the file to the server, kept under `.data/media/` (local development).
 * - "off": a deployment without a Blob store.
 */
export type UploadMode = "blob-token" | "blob-presigned" | "local" | "off";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

/**
 * Longest file whose speech the browser extracts for automatic captions. The
 * extracted MP3 (32 kbps) must fit in one request to a Vercel Function (4.5 MB).
 */
export const MAX_SPEECH_SEC = 15 * 60;

/** Blob pathnames of uploaded media start with this. */
export const UPLOAD_PREFIX = "uploads/";

const TYPE_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
};

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

/** The file's media type (by its extension when the picker gave none), or null when it isn't video/audio. */
export function mediaTypeOf(name: string, type: string): string | null {
  const t = type.split(";")[0].trim().toLowerCase();
  if (/^(video|audio)\/[\w.+-]+$/.test(t)) return t;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXT[ext] ?? null;
}

/** A file extension for the media type (Whisper and Blob go by it). */
export function extensionFor(type: string): string {
  return EXT_BY_TYPE[type] ?? (type.startsWith("audio/") ? "m4a" : "mp4");
}
