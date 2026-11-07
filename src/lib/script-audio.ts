import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Mp3Encoder } from "@breezystack/lamejs";
import { del, get, put } from "@vercel/blob";
import { LessonError } from "./errors";
import { synthesize, TTS_SAMPLE_RATE } from "./tts";
import type { Lesson } from "./types";

/**
 * A script lesson's audio: every sentence read aloud on its own, joined into
 * one MP3 with a short pause between sentences, so the practice room can play
 * it like any other media file. Sentence timings come from the joined samples,
 * so they are exact. The MP3 is constant-bitrate (browsers seek it exactly).
 */

const RATE = TTS_SAMPLE_RATE;
const KBPS = 64;
/** Silence before the first sentence, between sentences, and after the last. */
const LEAD_SEC = 0.3;
const GAP_SEC = 0.45;
const TAIL_SEC = 0.6;
/** How much of each clip's own silence to keep around the speech. */
const KEEP_BEFORE_SEC = 0.06;
const KEEP_AFTER_SEC = 0.15;
/** Samples quieter than this (about -36 dBFS) count as silence when trimming. */
const SILENCE = 520;
/** LAME's encoder delay: decoded audio starts this much later than the samples given. */
const ENCODER_DELAY_SEC = 1105 / RATE;
const CONCURRENCY = 6;

/** The clip without its leading and trailing silence (keeping a little of each). */
function trim(clip: Int16Array): Int16Array {
  let first = 0;
  while (first < clip.length && Math.abs(clip[first]) < SILENCE) first++;
  if (first === clip.length) return clip; // all quiet: keep as is
  let last = clip.length - 1;
  while (last > first && Math.abs(clip[last]) < SILENCE) last--;
  const from = Math.max(0, first - Math.round(KEEP_BEFORE_SEC * RATE));
  const to = Math.min(clip.length, last + 1 + Math.round(KEEP_AFTER_SEC * RATE));
  return clip.subarray(from, to);
}

function encodeMp3(samples: Int16Array): Uint8Array {
  const encoder = new Mp3Encoder(1, RATE, KBPS);
  const chunks: Uint8Array[] = [];
  const step = 1152 * 16;
  for (let i = 0; i < samples.length; i += step) {
    const out = encoder.encodeBuffer(samples.subarray(i, i + step));
    if (out.length) chunks.push(out);
  }
  const end = encoder.flush();
  if (end.length) chunks.push(end);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

export type ScriptAudio = {
  mp3: Uint8Array;
  /** Per sentence, in seconds within the MP3. */
  timings: { start: number; end: number }[];
  durationSec: number;
};

/** Reads every sentence aloud (a few at a time) and joins them into one MP3. */
export async function buildScriptAudio(sentences: string[]): Promise<ScriptAudio> {
  const clips: Int16Array[] = new Array(sentences.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, sentences.length) }, async () => {
    while (next < sentences.length) {
      const i = next++;
      clips[i] = trim(await synthesize(sentences[i]));
    }
  });
  await Promise.all(workers);

  const lead = Math.round(LEAD_SEC * RATE);
  const gap = Math.round(GAP_SEC * RATE);
  const tail = Math.round(TAIL_SEC * RATE);
  const total = lead + clips.reduce((n, c) => n + c.length, 0) + gap * (clips.length - 1) + tail;
  const samples = new Int16Array(total); // zero-filled: the pauses are already silent

  const timings: ScriptAudio["timings"] = [];
  let at = lead;
  clips.forEach((clip, i) => {
    samples.set(clip, at);
    const start = at / RATE + ENCODER_DELAY_SEC;
    const end = (at + clip.length) / RATE + ENCODER_DELAY_SEC;
    timings.push({ start: round(start), end: round(end) });
    at += clip.length + (i < clips.length - 1 ? gap : 0);
  });

  return { mp3: encodeMp3(samples), timings, durationSec: total / RATE };
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/* --------------------------------- Storage -------------------------------- */

/**
 * - Vercel Blob (private store) when BLOB_STORE_ID (connected store, authenticated with the
 *   function's Vercel OIDC token) or BLOB_READ_WRITE_TOKEN is set.
 * - Otherwise `.data/audio/{lessonId}.mp3` — local development only.
 * Either way the browser gets the audio from /api/lessons/[id]/audio, behind the site lock.
 */
const LOCAL = "local";
const blobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const localFile = (lessonId: string) =>
  path.join(process.env.SAYKI_DATA_DIR || path.join(process.cwd(), ".data"), "audio", `${lessonId}.mp3`);

/** Throws when there is nowhere to keep audio (checked before paying for speech). */
export function assertAudioStorage(): void {
  if (blobConfigured() || !process.env.VERCEL) return;
  console.error("No audio storage: connect a (private) Vercel Blob store to this project.");
  throw new LessonError(
    "NO_AUDIO_STORAGE",
    "음성 파일 저장소가 아직 연결되지 않았어요. (관리자: Vercel 프로젝트에 Blob 저장소를 연결해 주세요.)",
    503,
  );
}

/** Saves a lesson's MP3; returns what to keep in `source.audio`. */
export async function saveScriptAudio(lessonId: string, mp3: Uint8Array): Promise<string> {
  if (blobConfigured()) {
    try {
      const blob = await put(`scripts/${lessonId}.mp3`, Buffer.from(mp3), {
        access: "private",
        contentType: "audio/mpeg",
        addRandomSuffix: true,
      });
      return blob.url;
    } catch (e) {
      console.error("Saving script audio to Vercel Blob failed", e);
      throw new LessonError("AUDIO_SAVE_FAILED", "음성 파일을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
    }
  }
  assertAudioStorage();
  const file = localFile(lessonId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, mp3);
  return LOCAL;
}

/** Recently served MP3s, so the range requests a player makes don't each re-download it. */
const recent = new Map<string, Buffer>();
const RECENT_MAX = 6;

/** The lesson's MP3, or null when it is gone. */
export async function readScriptAudio(lesson: Lesson): Promise<Buffer | null> {
  if (lesson.source.kind !== "script") return null;
  const { audio } = lesson.source;
  const hit = recent.get(lesson.id);
  if (hit) return hit;

  let bytes: Buffer | null;
  if (audio === LOCAL) {
    bytes = await fs.readFile(localFile(lesson.id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
  } else {
    const result = await get(audio, { access: "private" });
    bytes = result?.statusCode === 200 ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
  }
  if (bytes) {
    recent.set(lesson.id, bytes);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
  }
  return bytes;
}

/** Deletes the audio of the script lessons among `lessons` (best effort). */
export async function deleteScriptAudio(lessons: Lesson[]): Promise<void> {
  const blobs: string[] = [];
  const files: string[] = [];
  for (const l of lessons) {
    if (l.source.kind !== "script") continue;
    recent.delete(l.id);
    if (l.source.audio === LOCAL) files.push(localFile(l.id));
    else blobs.push(l.source.audio);
  }
  try {
    await Promise.all([
      blobs.length ? del(blobs) : null,
      ...files.map((f) => fs.rm(f, { force: true })),
    ]);
  } catch (e) {
    console.error("Deleting script audio failed", e);
  }
}
