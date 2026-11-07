/**
 * Browser side of uploading a video/audio file: check it plays here, grab a
 * frame for the lesson card, extract the speech as a small MP3 for Whisper,
 * and upload the file itself to Vercel Blob.
 */
import { extensionFor, MAX_SPEECH_SEC, UPLOAD_PREFIX, type UploadMode } from "./upload-shared";

/** An error whose message is safe to show the learner (Korean). */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

/* --------------------------------- Probe ---------------------------------- */

export type MediaProbe = {
  durationSec: number | null;
  /** A 16:9 JPEG frame (null: audio only, or the browser wouldn't give one). */
  thumbnail: Blob | null;
};

const THUMB_W = 480;
const THUMB_H = 270;

function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext("2d");
  if (!ctx || !vw || !vh) return Promise.resolve(null);
  // Cover-crop to 16:9 like the lesson cards. Tall videos keep their upper part (where faces are).
  const scale = Math.max(THUMB_W / vw, THUMB_H / vh);
  const sw = THUMB_W / scale;
  const sh = THUMB_H / scale;
  const sx = (vw - sw) / 2;
  const sy = vh > vw ? (vh - sh) * 0.3 : (vh - sh) / 2;
  try {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
}

/** Loads the file in a hidden <video>: checks this browser can play it, reads its length, grabs a frame. */
export function probeMedia(file: File): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let durationSec: number | null = null;
    let settled = false;

    const finish = (result: MediaProbe | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    // Some browsers never seek a hidden video: go on without a picture.
    const timer = setTimeout(() => finish({ durationSec, thumbnail: null }), 10_000);

    video.onerror = () =>
      finish(new UploadError("이 브라우저에서 재생할 수 없는 파일이에요. MP4 영상이나 MP3·M4A 오디오로 올려 주세요.", "UNPLAYABLE"));
    video.onloadedmetadata = () => {
      durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      if (!video.videoWidth) {
        finish({ durationSec, thumbnail: null });
        return;
      }
      // A little way in: past fade-ins and black first frames.
      video.currentTime = Math.min(1.5, (durationSec ?? 0) * 0.2) || 0.01;
    };
    video.onseeked = () => {
      void grabFrame(video).then((thumbnail) => finish({ durationSec, thumbnail }));
    };
    video.src = url;
  });
}

/* --------------------------------- Speech --------------------------------- */

/** Whisper works at 16 kHz anyway; 32 kbps mono keeps 15 minutes under 4 MB. */
const SPEECH_RATE = 16_000;
const SPEECH_KBPS = 32;

async function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
  let ctx: OfflineAudioContext;
  try {
    // decodeAudioData resamples to the context's rate.
    ctx = new OfflineAudioContext(1, 1, SPEECH_RATE);
  } catch {
    ctx = new OfflineAudioContext(1, 1, 44_100);
  }
  return ctx.decodeAudioData(bytes);
}

/** Mixes to mono and (when the browser decoded at another rate) averages down to 16 kHz. */
function toSpeechSamples(buffer: AudioBuffer): Int16Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const ratio = buffer.sampleRate / SPEECH_RATE;
  const length = Math.floor(buffer.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) for (const ch of channels) sum += ch[j];
    const v = sum / ((to - from) * channels.length);
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

async function encodeMp3(samples: Int16Array, onProgress: (ratio: number) => void, signal: AbortSignal): Promise<Blob> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const encoder = new Mp3Encoder(1, SPEECH_RATE, SPEECH_KBPS);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const step = 1152 * 32;
  let lastYield = performance.now();
  for (let i = 0; i < samples.length; i += step) {
    const out = encoder.encodeBuffer(samples.subarray(i, i + step));
    if (out.length) chunks.push(new Uint8Array(out));
    // Give the page a moment now and then, so progress shows and buttons respond.
    if (performance.now() - lastYield > 40) {
      onProgress(i / samples.length);
      await new Promise((r) => setTimeout(r, 0));
      throwIfAborted(signal);
      lastYield = performance.now();
    }
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  onProgress(1);
  return new Blob(chunks, { type: "audio/mpeg" });
}

/**
 * The file's speech as a small MP3 for Whisper. Null when this browser can't
 * decode the file's audio (the server then sends Whisper the file itself).
 */
export async function extractSpeech(
  file: File,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<Blob | null> {
  let decoded: AudioBuffer;
  try {
    const bytes = await file.arrayBuffer();
    throwIfAborted(signal);
    decoded = await decodeAudio(bytes);
  } catch (e) {
    throwIfAborted(signal);
    console.warn("Could not decode the file's audio in this browser", e);
    return null;
  }
  throwIfAborted(signal);
  if (decoded.duration > MAX_SPEECH_SEC) throw tooLongForCaptions();
  return encodeMp3(toSpeechSamples(decoded), onProgress, signal);
}

export function tooLongForCaptions(): UploadError {
  return new UploadError(
    `자동 자막은 ${MAX_SPEECH_SEC / 60}분 이하 영상만 만들 수 있어요. 영어 자막 파일(.srt, .vtt)을 함께 올리면 더 긴 영상도 연습할 수 있어요.`,
    "TOO_LONG",
  );
}

/* --------------------------------- Upload --------------------------------- */

function randomName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uploads the file straight to Vercel Blob (private); returns its URL. */
export async function uploadToBlob(
  file: File,
  type: string,
  mode: Extract<UploadMode, "blob-token" | "blob-presigned">,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<string> {
  const client = await import("@vercel/blob/client");
  const send = mode === "blob-token" ? client.upload : client.uploadPresigned;
  try {
    const blob = await send(`${UPLOAD_PREFIX}${randomName()}.${extensionFor(type)}`, file, {
      access: "private",
      handleUploadUrl: "/api/uploads",
      contentType: type,
      // Parts are retried on their own: safer for big files on mobile connections.
      multipart: file.size > 16 * 1024 * 1024,
      abortSignal: signal,
      onUploadProgress: ({ percentage }) => onProgress(percentage / 100),
    });
    return blob.url;
  } catch (e) {
    throwIfAborted(signal);
    console.error("Blob upload failed", e);
    throw new UploadError("영상을 올리지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.", "UPLOAD_FAILED");
  }
}
