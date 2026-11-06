/**
 * Browser-only learning progress (no account yet). Every access is wrapped
 * in try/catch: storage can be unavailable in private windows.
 */

export type WaitMode = "manual" | "auto1" | "auto15" | "continuous";

export type Settings = {
  rate: number;
  waitMode: WaitMode;
  loop: boolean;
  showText: boolean;
  showKorean: boolean;
  /** Subtitle timing offset in seconds (positive = subtitles later). */
  offset: number;
};

export const DEFAULT_SETTINGS: Settings = {
  rate: 1,
  waitMode: "manual",
  loop: false,
  showText: true,
  showKorean: true,
  offset: 0,
};

export type LessonProgress = {
  best: Record<number, number>;
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
const progressKey = (id: string) => `sayki:progress:${id}`;

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
  read<LessonProgress>(progressKey(id), { best: {}, last: 0 });
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
