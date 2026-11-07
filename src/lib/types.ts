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
  | { kind: "media"; url: string }
  /**
   * A teaching script Claude wrote from the learner's material, read aloud by OpenAI TTS.
   * `audio` is where its MP3 lives: a private Vercel Blob URL, or "local" (`.data/audio/`).
   */
  | { kind: "script"; audio: string }
  /**
   * A video/audio file the learner uploaded (e.g. an Instagram reel saved to the phone).
   * `media` / `thumb` are private Vercel Blob URLs, or "local" (`.data/media/`); `thumb` null: none.
   * `type` is the file's media type ("audio/…" plays in an audio bar).
   */
  | { kind: "file"; media: string; type: string; thumb: string | null };

export type CaptionOrigin =
  | "youtube-manual"
  | "youtube-auto"
  | "upload"
  | "whisper"
  | "script";

/** "ai": translated sentence-by-sentence by Claude (1:1 with the English). */
export type KoreanOrigin = "youtube-manual" | "youtube-auto-translate" | "ai" | null;

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
  /** AI translation only: sentence indexes the model has not translated yet. */
  aiPending?: number[];
  /** AI translation only: how many translation passes have run. */
  aiAttempts?: number;
};

/** One line of a teaching script: what to say, and its Korean for the "Korean → English" modes. */
export type ScriptLine = { en: string; ko: string };

/** A teaching script as Claude wrote it, before the learner reviews it and its audio is made. */
export type ScriptDraft = {
  /** English title, e.g. "Comparing Fractions". */
  title: string;
  /** Korean title, e.g. "분수의 크기 비교". */
  titleKo: string;
  lines: ScriptLine[];
  /** What to check before practising (in Korean): unreadable parts of a photo, guesses, likely errors. */
  notes: string[];
};

export type LessonSummary = Omit<Lesson, "sentences"> & {
  sentenceCount: number;
};

/** What the "내 레슨" page needs per lesson (kept small: it ships every lesson). */
export type LibraryLesson = Pick<
  LessonSummary,
  "id" | "title" | "thumbnail" | "sentenceCount" | "createdAt" | "captionOrigin" | "koreanOrigin"
>;

export const FOLDER_NAME_MAX = 30;

export type Folder = { id: string; name: string };

/** How the learner organized their lessons. A lesson sits in at most one folder. */
export type LibraryState = {
  /** In the order they were created. */
  folders: Folder[];
  /** lesson id → folder id. Lessons without an entry are "미분류". */
  placement: Record<string, string>;
};

/** A sentence the learner saved to practice again later. */
export type Bookmark = {
  lessonId: string;
  /** Sentence index within the lesson. */
  index: number;
  /** When it was bookmarked (ms since epoch). */
  at: number;
};

/** One bookmarked sentence as the "북마크" page shows it. */
export type BookmarkedSentence = {
  index: number;
  start: number;
  text: string;
  ko: string | null;
  at: number;
};

/** What the practice room knows about the lesson's bookmarks when it opens. */
export type RoomBookmarks = {
  /** Bookmarked sentence indexes; null when they couldn't be loaded (bookmarking is off). */
  indexes: number[] | null;
  /** Open with only the bookmarked sentences (how the "북마크" page links here). */
  only: boolean;
  /** With `only`: the next lesson on the "북마크" page, to carry on with. */
  next: string | null;
};

/** A lesson's bookmarked sentences, in the order they appear in the video. */
export type BookmarkGroup = {
  lesson: Pick<LessonSummary, "id" | "title" | "thumbnail" | "sentenceCount">;
  sentences: BookmarkedSentence[];
  /** The most recent bookmark in this lesson (groups are sorted by it). */
  latest: number;
};

export type LibraryOp =
  | { op: "createFolder"; name: string; /** Moved into the new folder right away. */ lessonIds?: string[] }
  | { op: "renameFolder"; id: string; name: string }
  | { op: "deleteFolder"; id: string }
  | { op: "move"; lessonIds: string[]; folderId: string | null }
  | { op: "deleteLessons"; lessonIds: string[] };
