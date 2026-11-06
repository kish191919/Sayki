import { LessonError } from "./errors";
import { interpolateWords } from "./segment";
import { cleanCaptionText, isAnnotationToken } from "./text";
import type { CaptionOrigin, Cue, Word } from "./types";

const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 34,
  hl: "en",
  gl: "US",
};
const USER_AGENT = `com.google.android.youtube/${CLIENT.clientVersion} (Linux; U; Android 14) gzip`;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind?: string;
};

export type VideoInfo = {
  videoId: string;
  title: string;
  durationSec: number | null;
  thumbnail: string;
  tracks: CaptionTrack[];
  canTranslateToKorean: boolean;
};

/** Extracts the 11-char video id from any common YouTube URL shape. */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1] ?? null;
  }
  return id && ID_RE.test(id) ? id : null;
}

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; lengthSeconds?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      translationLanguages?: { languageCode?: string }[];
    };
  };
};

export async function fetchVideoInfo(videoId: string): Promise<VideoInfo> {
  let res: Response;
  try {
    res = await fetch(PLAYER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ context: { client: CLIENT }, videoId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LessonError("YOUTUBE_NETWORK", "유튜브에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
  }
  if (res.status === 429) {
    throw new LessonError("YOUTUBE_RATE_LIMIT", "유튜브 요청이 많아 잠시 막혔어요. 몇 분 뒤에 다시 시도해 주세요.", 503);
  }
  if (!res.ok) {
    throw new LessonError("YOUTUBE_NETWORK", `유튜브 정보를 가져오지 못했어요 (HTTP ${res.status}).`, 502);
  }

  const data = (await res.json()) as PlayerResponse;
  const status = data.playabilityStatus?.status;
  if (status === "LOGIN_REQUIRED" && /bot/i.test(data.playabilityStatus?.reason ?? "")) {
    // Datacenter IPs (e.g. serverless hosting) often get YouTube's bot check.
    console.error(`YouTube bot check for ${videoId}: ${data.playabilityStatus?.reason}`);
    throw new LessonError(
      "YOUTUBE_BLOCKED",
      "유튜브가 서버의 자막 요청을 막았어요. 잠시 후 다시 시도하거나, 자막 파일(.srt, .vtt)을 함께 올려 주세요.",
      503,
    );
  }
  if (status !== "OK") {
    throw new LessonError(
      "YOUTUBE_UNAVAILABLE",
      "이 영상의 정보를 가져올 수 없어요. 비공개·연령 제한·지역 제한 영상인지 확인해 주세요.",
      422,
    );
  }

  const renderer = data.captions?.playerCaptionsTracklistRenderer;
  return {
    videoId,
    title: data.videoDetails?.title?.trim() || "제목 없는 영상",
    durationSec: Number(data.videoDetails?.lengthSeconds) || null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    tracks: (renderer?.captionTracks ?? []).filter((t) => t.baseUrl && t.languageCode),
    canTranslateToKorean: (renderer?.translationLanguages ?? []).some((l) => l.languageCode === "ko"),
  };
}

/**
 * Title/thumbnail through YouTube's public oEmbed endpoint — used when the
 * player API is unavailable but the learner supplied their own subtitles.
 */
export async function fetchBasicVideoInfo(videoId: string): Promise<VideoInfo> {
  let title = "유튜브 영상";
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) title = ((await res.json()) as { title?: string }).title?.trim() || title;
  } catch {
    /* keep the generic title */
  }
  return {
    videoId,
    title,
    durationSec: null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    tracks: [],
    canTranslateToKorean: false,
  };
}

const isLang = (code: string, lang: string) => code === lang || code.startsWith(`${lang}-`);

/** Human-made English captions first (punctuated), then auto-generated ones. */
export function pickEnglishTrack(
  tracks: CaptionTrack[],
): { track: CaptionTrack; origin: CaptionOrigin } | null {
  const en = tracks.filter((t) => isLang(t.languageCode, "en"));
  const manual = en.find((t) => t.kind !== "asr");
  if (manual) return { track: manual, origin: "youtube-manual" };
  const auto = en.find((t) => t.kind === "asr");
  if (auto) return { track: auto, origin: "youtube-auto" };
  return null;
}

export function pickKoreanTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  return tracks.find((t) => isLang(t.languageCode, "ko") && t.kind !== "asr") ?? null;
}

type Json3 = {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    aAppend?: number;
    segs?: { utf8?: string; tOffsetMs?: number }[];
  }[];
};

/** Longest a single auto-caption word is allowed to last (its raw end often runs into a pause). */
const MAX_WORD_SECONDS = 1.2;

/**
 * Auto captions only give each word's start time. Estimate how long the
 * word is spoken so real pauses (needed for sentence splitting) survive.
 */
const estimateWordSeconds = (word: string) => Math.min(MAX_WORD_SECONDS, 0.12 + 0.065 * word.length);

export function json3ToCues(data: Json3): Cue[] {
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    const segs = ev.segs;
    if (!segs?.length || ev.aAppend) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    const end = start + (ev.dDurationMs ?? 0) / 1000;

    const hasWordTiming = segs.some((s) => s.tOffsetMs != null);
    if (!hasWordTiming) {
      const text = cleanCaptionText(segs.map((s) => s.utf8 ?? "").join(""));
      if (text) cues.push({ start, end, text });
      continue;
    }

    const words: Word[] = [];
    segs.forEach((seg, k) => {
      const raw = (seg.utf8 ?? "").trim();
      if (!raw || isAnnotationToken(raw)) return;
      const text = cleanCaptionText(raw);
      if (!text) return;
      const ws = start + (seg.tOffsetMs ?? 0) / 1000;
      const nextOffset = segs[k + 1]?.tOffsetMs;
      const nextStart = nextOffset != null ? start + nextOffset / 1000 : end;
      const we = Math.min(nextStart, ws + estimateWordSeconds(text));
      words.push(...interpolateWords(text, ws, Math.max(we, ws + 0.05)));
    });
    if (words.length) {
      cues.push({
        start: words[0].start,
        end: words[words.length - 1].end,
        text: words.map((w) => w.text).join(" "),
        words,
      });
    }
  }
  return cues;
}

/**
 * Downloads one caption track. Pass `translateTo` to get YouTube's machine
 * translation of the track (rate-limited by YouTube — treat as best-effort).
 */
export async function fetchTrackCues(track: CaptionTrack, translateTo?: string): Promise<Cue[]> {
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  if (translateTo) url.searchParams.set("tlang", translateTo);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new LessonError("CAPTION_NETWORK", "자막을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
  }
  if (res.status === 429) {
    throw new LessonError("YOUTUBE_RATE_LIMIT", "유튜브 요청이 많아 잠시 막혔어요. 몇 분 뒤에 다시 시도해 주세요.", 503);
  }
  const body = res.ok ? await res.text() : "";
  if (!body) {
    throw new LessonError("CAPTION_NETWORK", "자막을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
  }
  return json3ToCues(JSON.parse(body) as Json3);
}
