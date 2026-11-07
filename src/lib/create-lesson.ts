import "server-only";
import { LessonError } from "./errors";
import { attachTranslations, buildSentences } from "./segment";
import { getLesson, mediaLessonId, saveLesson, uploadLessonId, youtubeLessonId } from "./store";
import { parseSubtitleFile } from "./subtitles";
import { canTranscribe, MAX_TRANSCRIBE_BYTES, transcribeMedia } from "./transcribe";
import { fetchPublicMedia } from "./safe-fetch";
import type { CaptionOrigin, Cue, KoreanOrigin, Lesson, Sentence } from "./types";
import {
  fetchBasicVideoInfo,
  fetchTrackCues,
  fetchVideoInfo,
  parseYouTubeId,
  pickEnglishTrack,
  pickKoreanTrack,
  type CaptionTrack,
  type VideoInfo,
} from "./youtube";

const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mov|ogv|mp3|m4a|aac|wav|ogg|oga|flac)$/i;

export function sentencesFrom(cues: Cue[]): Sentence[] {
  const sentences = buildSentences(cues);
  if (sentences.length === 0) {
    throw new LessonError("NO_SENTENCES", "자막에서 연습할 문장을 찾지 못했어요.", 422);
  }
  return sentences;
}

export function subtitleCues(text: string): Cue[] {
  const cues = parseSubtitleFile(text);
  if (cues.length === 0) {
    throw new LessonError("BAD_SUBTITLE", "자막 파일을 읽지 못했어요. .srt 또는 .vtt 형식인지 확인해 주세요.", 422);
  }
  return cues;
}

async function fromYouTube(videoId: string, subtitleText: string | null): Promise<Lesson> {
  if (!subtitleText) {
    const cached = await getLesson(youtubeLessonId(videoId));
    if (cached) return cached;
  }

  let info: VideoInfo;
  try {
    info = await fetchVideoInfo(videoId);
  } catch (e) {
    // With the learner's own subtitles we only need a title, so survive
    // YouTube blocking the player API.
    if (!subtitleText || !(e instanceof LessonError) || e.code === "YOUTUBE_UNAVAILABLE") throw e;
    info = await fetchBasicVideoInfo(videoId);
  }
  let cues: Cue[];
  let captionOrigin: CaptionOrigin;
  let englishTrack: CaptionTrack | null = null;

  if (subtitleText) {
    cues = subtitleCues(subtitleText);
    captionOrigin = "upload";
  } else {
    const picked = pickEnglishTrack(info.tracks);
    if (!picked) {
      throw new LessonError(
        "NO_CAPTIONS",
        "이 영상에는 영어 자막이 없어요. 자막 파일(.srt, .vtt)을 함께 올리면 연습할 수 있어요.",
        422,
      );
    }
    cues = await fetchTrackCues(picked.track);
    captionOrigin = picked.origin;
    englishTrack = picked.track;
  }

  const sentences = sentencesFrom(cues);

  // Korean is optional: a human-made track if there is one, otherwise
  // YouTube's machine translation (frequently rate-limited — ignore failures).
  let koreanOrigin: KoreanOrigin = null;
  try {
    const koTrack = pickKoreanTrack(info.tracks);
    if (koTrack) {
      if (attachTranslations(sentences, await fetchTrackCues(koTrack)) > 0) koreanOrigin = "youtube-manual";
    } else if (englishTrack && info.canTranslateToKorean) {
      if (attachTranslations(sentences, await fetchTrackCues(englishTrack, "ko")) > 0) {
        koreanOrigin = "youtube-auto-translate";
      }
    }
  } catch (e) {
    console.warn(`Korean subtitles skipped for ${videoId}:`, (e as Error).message);
  }

  const lesson: Lesson = {
    id: subtitleText ? uploadLessonId() : youtubeLessonId(videoId),
    title: info.title,
    source: { kind: "youtube", videoId },
    captionOrigin,
    koreanOrigin,
    durationSec: info.durationSec,
    thumbnail: info.thumbnail,
    sentences,
    createdAt: new Date().toISOString(),
  };
  await saveLesson(lesson);
  return lesson;
}

async function fromMediaUrl(url: URL, subtitleText: string | null): Promise<Lesson> {
  const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const title = filename.replace(MEDIA_EXT_RE, "").replace(/[-_]+/g, " ").trim() || url.hostname;

  let id: string;
  let cues: Cue[];
  let captionOrigin: CaptionOrigin;

  if (subtitleText) {
    id = uploadLessonId();
    cues = subtitleCues(subtitleText);
    captionOrigin = "upload";
  } else {
    id = mediaLessonId(url.href);
    const cached = await getLesson(id);
    if (cached) return cached;
    if (!canTranscribe()) {
      throw new LessonError(
        "NEED_SUBTITLE",
        "유튜브가 아닌 영상은 자막 파일(.srt, .vtt)을 함께 올려 주세요.",
        422,
      );
    }
    const media = await fetchPublicMedia(url.href, MAX_TRANSCRIBE_BYTES);
    cues = await transcribeMedia(media.blob, media.filename);
    captionOrigin = "whisper";
  }

  const lesson: Lesson = {
    id,
    title,
    source: { kind: "media", url: url.href },
    captionOrigin,
    koreanOrigin: null,
    durationSec: null,
    thumbnail: null,
    sentences: sentencesFrom(cues),
    createdAt: new Date().toISOString(),
  };
  await saveLesson(lesson);
  return lesson;
}

/** Sites whose videos can't be fetched by link (no captions, playback API, or stable file URL). */
const UPLOAD_ONLY_SITES: [RegExp, string][] = [
  [/(^|\.)(instagram\.com|instagr\.am)$/, "인스타그램"],
  [/(^|\.)tiktok\.com$/, "틱톡"],
  [/(^|\.)(facebook\.com|fb\.watch)$/, "페이스북"],
  [/(^|\.)threads\.(net|com)$/, "스레드"],
  [/(^|\.)(x\.com|twitter\.com)$/, "X(트위터)"],
];

function uploadOnlySite(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  return UPLOAD_ONLY_SITES.find(([re]) => re.test(host))?.[1] ?? null;
}

/** Turns a pasted link (plus an optional subtitle file) into a saved lesson. */
export async function createLesson(rawUrl: string, subtitleText: string | null): Promise<Lesson> {
  const videoId = parseYouTubeId(rawUrl);
  if (videoId) return fromYouTube(videoId, subtitleText);

  const site = uploadOnlySite(rawUrl);
  if (site) {
    throw new LessonError(
      "NEEDS_UPLOAD",
      `${site} 영상은 링크로 가져올 수 없어요. 영상을 기기에 저장한 뒤 ‘영상 파일 올리기’로 올려 주세요.`,
      422,
    );
  }

  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {
    url = null;
  }
  if (url && (url.protocol === "https:" || url.protocol === "http:") && MEDIA_EXT_RE.test(url.pathname)) {
    return fromMediaUrl(url, subtitleText);
  }

  throw new LessonError(
    "UNSUPPORTED_URL",
    "유튜브 링크 또는 .mp4·.mp3 같은 영상/오디오 파일 링크를 넣어 주세요.",
    400,
  );
}
