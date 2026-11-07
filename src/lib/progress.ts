/**
 * Browser-only learning progress (no account yet). Every access is wrapped
 * in try/catch: storage can be unavailable in private windows.
 */

export type WaitMode = "manual" | "auto1" | "auto15" | "continuous";

/**
 * shadow: listen, then repeat. speak: read the Korean, say the English.
 * listen: hear the Korean read aloud, say the English (scores shared with speak).
 */
export type PracticeMode = "shadow" | "speak" | "listen";

/** How many times a sentence plays while repeating; 0 = until repeating is switched off. */
export type RepeatCount = 0 | 1 | 2 | 3 | 5;

/** What each repetition plays: the original English, the Korean read aloud, or both in order. */
export type RepeatOrder = "en" | "ko" | "ko-en" | "en-ko";

/** Pause between the two languages within one repetition: seconds, or "fit" (the sentence's length). */
export type RepeatGap = 0 | 2 | 4 | "fit";

export type Settings = {
  mode: PracticeMode;
  rate: number;
  waitMode: WaitMode;
  loop: boolean;
  repeatCount: RepeatCount;
  repeatOrder: RepeatOrder;
  repeatGap: RepeatGap;
  showText: boolean;
  showKorean: boolean;
  /** Subtitle timing offset in seconds (positive = subtitles later). */
  offset: number;
  /** The "전체 문장" panel is expanded. */
  sentencesOpen: boolean;
  /** The playback settings panel (speed, sync, …) is expanded. */
  settingsOpen: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "shadow",
  rate: 1,
  waitMode: "manual",
  loop: false,
  repeatCount: 0,
  repeatOrder: "en",
  repeatGap: 2,
  showText: true,
  showKorean: true,
  offset: 0,
  sentencesOpen: true,
  settingsOpen: false,
};

export type LessonProgress = {
  /** Best shadowing score per sentence. */
  best: Record<number, number>;
  /** Best match rate per sentence in the Korean → English modes (read or heard). */
  bestSpeak: Record<number, number>;
  last: number;
};

export type RecentItem = {
  id: string;
  title: string;
  thumbnail: string | null;
  sentenceCount: number;
  practiced: number;
  at: number;
};

const SETTINGS_KEY = "sayki:settings";
const RECENTS_KEY = "sayki:recents";
const PROGRESS_PREFIX = "sayki:progress:";
const progressKey = (id: string) => `${PROGRESS_PREFIX}${id}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — progress just isn't kept */
  }
}

export const loadSettings = () => read<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s);

export const loadProgress = (id: string) =>
  read<LessonProgress>(progressKey(id), { best: {}, bestSpeak: {}, last: 0 });
export const saveProgress = (id: string, p: LessonProgress) => write(progressKey(id), p);

export function loadRecents(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function touchRecent(item: RecentItem) {
  const rest = loadRecents().filter((r) => r.id !== item.id);
  write(RECENTS_KEY, [item, ...rest].slice(0, 20));
}

/** Forgets what this browser kept about these lessons (after deleting them). */
export function forgetLessons(ids: string[]) {
  const gone = new Set(ids);
  try {
    for (const id of ids) window.localStorage.removeItem(progressKey(id));
  } catch {
    /* storage blocked — nothing was kept anyway */
  }
  const recents = loadRecents();
  const kept = recents.filter((r) => !gone.has(r.id));
  if (kept.length !== recents.length) write(RECENTS_KEY, kept);
}

export type PracticeStat = {
  /** Sentences practiced at least once, in any mode. */
  practiced: number;
  /** When the lesson was last opened (only the most recent 20 are known). */
  at: number | null;
};

/**
 * Every lesson's progress as one string: a cheap snapshot that compares by
 * value, for useSyncExternalStore. Turn it into stats with `parsePracticeStats`.
 */
export function practiceSnapshot(): string {
  try {
    const ls = window.localStorage;
    const parts: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key && (key.startsWith(PROGRESS_PREFIX) || key === RECENTS_KEY)) parts.push(key, ls.getItem(key) ?? "");
    }
    // JSON never contains a raw NUL, so it is a safe separator.
    return parts.join("\u0000");
  } catch {
    return "";
  }
}

export function parsePracticeStats(snapshot: string): Map<string, PracticeStat> {
  const stats = new Map<string, PracticeStat>();
  if (!snapshot) return stats;
  const parts = snapshot.split("\u0000");
  const at = new Map<string, number>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [key, raw] = [parts[i], parts[i + 1]];
    try {
      if (key === RECENTS_KEY) {
        const list = JSON.parse(raw) as RecentItem[];
        if (Array.isArray(list)) for (const r of list) if (r?.id && typeof r.at === "number") at.set(r.id, r.at);
        continue;
      }
      const p = JSON.parse(raw) as Partial<LessonProgress>;
      const practiced = new Set([...Object.keys(p.best ?? {}), ...Object.keys(p.bestSpeak ?? {})]).size;
      stats.set(key.slice(PROGRESS_PREFIX.length), { practiced, at: null });
    } catch {
      /* one corrupt entry shouldn't hide the rest */
    }
  }
  for (const [id, t] of at) stats.set(id, { practiced: stats.get(id)?.practiced ?? 0, at: t });
  return stats;
}
