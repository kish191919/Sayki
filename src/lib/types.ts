export type Word = {
  text: string;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
};

/** A timed caption chunk (one subtitle line), before sentence segmentation. */
export type Cue = {
  start: number;
  end: number;
  text: string;
  /** Present when the source has real word-level timing (YouTube auto captions). */
  words?: Word[];
};

export type Sentence = {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Korean translation, when a Korean subtitle track was available. */
  ko?: string;
};

export type LessonSource =
  | { kind: "youtube"; videoId: string }
  | { kind: "media"; url: string };

export type CaptionOrigin =
  | "youtube-manual"
  | "youtube-auto"
  | "upload"
  | "whisper";

export type KoreanOrigin = "youtube-manual" | "youtube-auto-translate" | null;

export type Lesson = {
  id: string;
  title: string;
  source: LessonSource;
  captionOrigin: CaptionOrigin;
  koreanOrigin: KoreanOrigin;
  durationSec: number | null;
  thumbnail: string | null;
  sentences: Sentence[];
  createdAt: string;
};

export type LessonSummary = Omit<Lesson, "sentences"> & {
  sentenceCount: number;
};
