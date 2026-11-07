import "server-only";
import { sentencesFrom, subtitleCues } from "./create-lesson";
import { LessonError } from "./errors";
import { fileLessonId, saveLesson } from "./store";
import { canTranscribe, MAX_TRANSCRIBE_BYTES, transcribeMedia } from "./transcribe";
import type { CaptionOrigin, Cue, Lesson, Sentence } from "./types";
import { extensionFor, MAX_UPLOAD_BYTES, mediaTypeOf } from "./upload-shared";
import {
  assertUploadStorage,
  discardLocalMedia,
  readUploadedMedia,
  saveLocalMedia,
  saveThumbnail,
  uploadedBlob,
  uploadMode,
  type StoredMedia,
} from "./uploads";

export type FileLessonInput = {
  /** Blob storage: the URL the browser uploaded the file to. Local development: the file itself. */
  media: string | File;
  /** The file's name on the learner's device (a title, when it reads like one). */
  name: string;
  durationSec: number | null;
  /** The speech, extracted in the browser as a small MP3. Absent: Whisper gets the file itself. */
  speech: File | null;
  /** An .srt/.vtt the learner chose instead of automatic captions. */
  subtitle: string | null;
  /** A frame of the video for the lesson card. */
  thumbnail: File | null;
};

/** Turns an uploaded video/audio file into a saved lesson (captions from Whisper or a subtitle file). */
export async function createFileLesson(input: FileLessonInput): Promise<Lesson> {
  assertUploadStorage();
  if (!input.subtitle && !canTranscribe()) {
    throw new LessonError(
      "NEED_SUBTITLE",
      "자동 자막을 만들 수 없어요. 영어 자막 파일(.srt, .vtt)을 함께 올려 주세요.",
      422,
    );
  }

  const id = fileLessonId();
  const local = uploadMode() === "local";
  let stored: StoredMedia;
  if (local) {
    if (!(input.media instanceof File) || input.media.size === 0) {
      throw new LessonError("NO_MEDIA", "영상 파일을 골라 주세요.", 400);
    }
    const type = mediaTypeOf(input.media.name, input.media.type);
    if (!type) throw new LessonError("NOT_MEDIA", "영상이나 오디오 파일이 아니에요.", 422);
    if (input.media.size > MAX_UPLOAD_BYTES) {
      throw new LessonError("UPLOAD_TOO_LARGE", `${MAX_UPLOAD_BYTES / 1024 / 1024}MB 이하 파일만 올릴 수 있어요.`, 413);
    }
    stored = await saveLocalMedia(id, input.media, type);
  } else {
    if (typeof input.media !== "string") throw new LessonError("NO_MEDIA", "영상 파일을 골라 주세요.", 400);
    // Kept on failure: the browser retries with the same upload instead of sending it again.
    stored = await uploadedBlob(input.media);
  }

  try {
    let cues: Cue[];
    let captionOrigin: CaptionOrigin;
    if (input.subtitle) {
      cues = subtitleCues(input.subtitle);
      captionOrigin = "upload";
    } else {
      cues = await transcribe(id, stored, input.speech);
      captionOrigin = "whisper";
    }
    const sentences = sentencesFrom(cues);
    const thumb = input.thumbnail ? await saveThumbnail(id, input.thumbnail) : null;

    const lesson: Lesson = {
      id,
      title: titleFromName(input.name) ?? titleFromSpeech(sentences),
      source: { kind: "file", media: stored.media, type: stored.type, thumb },
      captionOrigin,
      koreanOrigin: null,
      durationSec:
        input.durationSec && Number.isFinite(input.durationSec) && input.durationSec > 0
          ? Math.round(input.durationSec)
          : Math.ceil(sentences[sentences.length - 1].end),
      thumbnail: thumb ? `/api/lessons/${id}/thumbnail` : null,
      sentences,
      createdAt: new Date().toISOString(),
    };
    await saveLesson(lesson);
    return lesson;
  } catch (e) {
    if (local) await discardLocalMedia(id);
    throw e;
  }
}

async function transcribe(lessonId: string, stored: StoredMedia, speech: File | null): Promise<Cue[]> {
  if (speech) return transcribeMedia(speech, "speech.mp3");
  if (stored.size > MAX_TRANSCRIBE_BYTES) {
    throw new LessonError(
      "MEDIA_TOO_LARGE",
      "이 브라우저에서 영상의 소리를 뽑지 못했고, 파일이 25MB보다 커서 자동 자막도 만들 수 없어요. 자막 파일(.srt, .vtt)을 함께 올리거나 다른 브라우저로 올려 주세요.",
      422,
    );
  }
  return transcribeMedia(await readUploadedMedia(lessonId, stored), `media.${extensionFor(stored.type)}`);
}

/* ---------------------------------- Title --------------------------------- */

/** First words of names that cameras, screen recorders and download sites give files. */
const MACHINE_NAME =
  /^(img|vid|video|mov|movie|clip|rec|record|recording|screen|screenrecording|audio|voice|trim|untitled|new|download|reel|reels|snapinsta|ssstik|snaptik|savefrom|igram|fastdl|instadown|tiktok|instagram)$/i;

/** The file's name as a title, unless it is a machine-made one ("IMG_1234", "6F1A…-…", "SnapInsta.to_AQN…"). */
function titleFromName(name: string): string | null {
  const base = name
    .normalize("NFC")
    .replace(/\.[^.]+$/, "")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = base.split(" ").filter(Boolean);
  if (words.length === 0 || MACHINE_NAME.test(words[0])) return null;
  if (words.some((w) => w.length >= 8 && /\d/.test(w))) return null;
  if (!words.some((w) => /^[\p{L}']{3,}$/u.test(w))) return null;
  return clip(base, 80);
}

/** The opening words of the video, e.g. "Here's how to sound more natural…". */
function titleFromSpeech(sentences: Sentence[]): string {
  let text = "";
  for (const s of sentences) {
    text = text ? `${text} ${s.text}` : s.text;
    if (text.length >= 24) break;
  }
  return clip(text, 60) || "내 영상";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}
