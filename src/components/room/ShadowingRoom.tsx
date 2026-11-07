"use client";

import Link from "next/link";
import { Fragment, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowRightIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CompareIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  HeadphonesIcon,
  HintIcon,
  LoopIcon,
  MicIcon,
  NextIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PrevIcon,
  ReplayIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  StopIcon,
  TrashIcon,
} from "@/components/icons";
import {
  loadProgress,
  loadSettings,
  saveProgress,
  saveSettings,
  touchRecent,
  type PracticeMode,
  type RepeatCount,
  type RepeatGap,
  type RepeatOrder,
  type Settings,
  type WaitMode,
} from "@/lib/progress";
import { bookmarkRevision, saveBookmark, subscribeBookmarks, withLocalChanges } from "@/lib/bookmarks-client";
import { hiddenRevision, hiddenWithLocalChanges, saveHidden, subscribeHidden } from "@/lib/hidden-client";
import { scoreAttempt, scoreTone, type Attempt } from "@/lib/score";
import { pendingAiLines } from "@/lib/translation-state";
import type { Lesson, RoomBookmarks } from "@/lib/types";
import { useKeepAlive, useMediaSession } from "./background";
import { MediaPlayer, YouTubePlayer, type PlayerHandle } from "./players";
import { useKoreanSpeech, type SpeechError } from "./useKoreanSpeech";
import { speechRecognitionSupported, useRecorder } from "./useRecorder";

type Try = {
  attempt: Attempt | null;
  url: string | null;
  heard: string;
  recognitionError: string | null;
};

/** One language of a repetition: the video's English, or the Korean read aloud. */
type Part = "en" | "ko";

/**
 * A repeat run on one sentence: which repetition it's on (1-based), how many of that
 * repetition's parts have started, and whether the pause before the next part was taken.
 */
type Repeat = { index: number; round: number; step: number; rested: boolean };

/** Mutable playback state read by the 40ms tick (kept out of React state). */
type Engine = {
  mode: "idle" | "segment" | "continuous";
  index: number;
  /** The player has reached the target sentence after a seek. */
  armed: boolean;
  armDeadline: number;
  /** Play this sentence once, ignoring the wait mode. */
  once: boolean;
  afterEnd: (() => void) | null;
  waitTimer: ReturnType<typeof setTimeout> | undefined;
  /** What runs when the countdown in progress ends (or is skipped). */
  waitThen: (() => void) | null;
  /** When we last paused programmatically (the player reports state late). */
  pausedAt: number;
  /** The repeat run in progress, if any. */
  repeat: Repeat | null;
  /** When the lesson last made a sound, or was asked to (the video/audio, the Korean voice). */
  heardAt: number;
};

type TranslateState = { status: "idle" | "working" | "error"; message?: string };

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

/**
 * Silence bridges the gaps of a practice run with the screen off only this long after the
 * last sound — longer than any countdown, but a run stuck in the background (e.g. a video the
 * phone won't play with the screen off) shouldn't play silence for ever.
 */
const KEEP_ALIVE_MS = 90_000;

const MODES: { value: PracticeMode; label: string }[] = [
  { value: "shadow", label: "듣고 따라 말하기" },
  { value: "listen", label: "한국어 듣고 영어로 말하기" },
];

const NO_KOREAN = "한글 해석이 없는 영상이에요";

const SPEECH_ERRORS: Record<SpeechError, string> = {
  blocked: "음성이 재생되지 않았어요. 🔊 버튼을 눌러 다시 들어 보세요.",
  unavailable: "이 기기에서 한국어 음성을 쓸 수 없어요. 기기 설정에서 한국어 음성(TTS)을 내려받아 주세요.",
  busy: "다른 소리가 재생 중이라 읽지 못했어요. 잠시 후 🔊 버튼을 다시 눌러 주세요.",
  failed: "한국어 음성을 재생하지 못했어요. 🔊 버튼을 다시 눌러 주세요.",
};

const WAIT_MODES: { value: WaitMode; label: string; hint: string }[] = [
  { value: "manual", label: "문장마다 멈춤", hint: "한 문장을 듣고 멈춰요. 따라 말한 뒤 직접 넘어가요." },
  { value: "auto1", label: "자동 넘김", hint: "문장 길이만큼 기다렸다가 다음 문장을 재생해요." },
  { value: "auto15", label: "자동 넘김 (여유)", hint: "문장 길이의 1.5배만큼 기다려요." },
  { value: "continuous", label: "이어서 재생", hint: "멈추지 않고 영상처럼 이어서 들어요." },
];

const REPEAT_COUNTS: { value: RepeatCount; label: string }[] = [
  { value: 1, label: "1번" },
  { value: 2, label: "2번" },
  { value: 3, label: "3번" },
  { value: 5, label: "5번" },
  { value: 0, label: "계속" },
];

const REPEAT_ORDERS: { value: RepeatOrder; label: string; short: string }[] = [
  { value: "en", label: "영어만", short: "" },
  { value: "ko", label: "한국어만", short: "한" },
  { value: "ko-en", label: "한국어 → 영어", short: "한→영" },
  { value: "en-ko", label: "영어 → 한국어", short: "영→한" },
];

const REPEAT_GAPS: { value: RepeatGap; label: string }[] = [
  { value: 0, label: "바로" },
  { value: 2, label: "2초" },
  { value: 4, label: "4초" },
  { value: "fit", label: "문장 길이만큼" },
];

const REPEAT_PARTS: Record<RepeatOrder, Part[]> = {
  en: ["en"],
  ko: ["ko"],
  "ko-en": ["ko", "en"],
  "en-ko": ["en", "ko"],
};

/** Countdown captions: what to do while waiting after each language. */
const SAY_IT = "지금 따라 말해 보세요";
const SAY_IN_ENGLISH = "영어로 말해 보세요";
const RECALL_MEANING = "뜻을 떠올려 보세요";

const SAY_TIMES: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "있음" },
  { value: "off", label: "없음" },
];

/** "한국어를 읽어 주고 2초 뒤에 원어민 영어를 들려줘요. 3번 들려준 뒤 다음 문장으로 넘어가요." */
function describeRepeat(order: RepeatOrder, count: RepeatCount, gap: RepeatGap, sayTime: boolean) {
  const pause = gap === 0 ? "바로" : gap === "fit" ? "문장 길이만큼 기다렸다가" : `${gap}초 뒤에`;
  const what = {
    en: "원어민 영어를 들려줘요.",
    ko: "한국어 해석을 읽어 줘요.",
    "ko-en": `한국어를 읽어 주고 ${pause} 원어민 영어를 들려줘요.`,
    "en-ko": `원어민 영어를 들려주고 ${pause} 한국어 해석을 읽어 줘요.`,
  }[order];
  const times =
    count === 0
      ? "반복을 끌 때까지 계속 되풀이해요."
      : `${count === 1 ? "한 번" : `${count}번`} 들려준 뒤 다음 문장으로 넘어가요.`;
  return `${what} ${times}${sayTime ? "" : " 따라 말할 시간 없이 바로 이어져요."}`;
}

const RECOGNITION_ERRORS: Record<string, string> = {
  network: "음성 인식 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.",
  "not-allowed": "음성 인식 권한이 없어요. 마이크 권한을 허용해 주세요.",
  "service-not-allowed": "이 브라우저에서는 음성 인식을 쓸 수 없어요.",
  "audio-capture": "마이크 소리를 받지 못했어요.",
};

const TONE_TEXT = { great: "text-good", good: "text-warn", low: "text-bad" } as const;
const TONE_BG = { great: "bg-good-soft text-good", good: "bg-warn-soft text-warn", low: "bg-bad-soft text-bad" } as const;

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "I was a major." → "I w__ a m____." — first letter of each word. */
function hintFor(text: string) {
  return text
    .split(" ")
    .map((word) => {
      let seen = false;
      return word.replace(/[\p{L}\p{N}]/gu, (c) => {
        if (seen) return "_";
        seen = true;
        return c;
      });
    })
    .join(" ");
}

type Translation = { ko: string[]; pending: number };

async function requestTranslation(lessonId: string): Promise<Translation> {
  const res = await fetch(`/api/lessons/${lessonId}/translate`, { method: "POST" });
  const data = (await res.json().catch(() => ({}))) as Partial<Translation> & { error?: string };
  if (!res.ok || !Array.isArray(data.ko)) throw new Error(data.error ?? "번역하지 못했어요.");
  return { ko: data.ko, pending: data.pending ?? 0 };
}

/** Status after a translation response: partial results get a retry link. */
const translatedState = ({ pending }: Translation): TranslateState =>
  pending > 0 ? { status: "error", message: `${pending}문장은 번역하지 못했어요.` } : { status: "idle" };

type RoomProps = {
  lesson: Lesson;
  canTranslate: boolean;
  bookmarks: RoomBookmarks;
  /** Sentence to open at instead of where practice last stopped. */
  startAt: number | null;
  /** Sentences the learner deleted; null when they couldn't be loaded (deleting is off). */
  hidden: number[] | null;
};

export default function ShadowingRoom({ lesson, canTranslate, bookmarks, startAt, hidden: hiddenOnServer }: RoomProps) {
  const { sentences } = lesson;
  const total = sentences.length;
  const needsTranslation = canTranslate && pendingAiLines(lesson).length > 0;

  const playerRef = useRef<PlayerHandle>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const myAudioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef<string[]>([]);
  const engine = useRef<Engine>({
    mode: "idle",
    index: 0,
    armed: false,
    armDeadline: 0,
    once: false,
    afterEnd: null,
    waitTimer: undefined,
    waitThen: null,
    pausedAt: 0,
    repeat: null,
    heardAt: 0,
  });

  const [ready, setReady] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [best, setBest] = useState<Record<number, number>>(() => loadProgress(lesson.id).best);
  const [bestSpeak, setBestSpeak] = useState<Record<number, number>>(() => loadProgress(lesson.id).bestSpeak);
  // Deleted sentences — left out of practice and the list — and bookmarked ones: what the
  // server sent, plus changes made in this tab since (also ones made on the "북마크" page
  // while this room waited in the back history).
  useSyncExternalStore(subscribeHidden, hiddenRevision, hiddenRevision);
  useSyncExternalStore(subscribeBookmarks, bookmarkRevision, bookmarkRevision);
  const canHide = hiddenOnServer !== null;
  const hidden = hiddenWithLocalChanges(lesson.id, hiddenOnServer ?? []);
  for (const i of hidden) if (!(i < total)) hidden.delete(i);
  /** The sentences that weren't deleted, in order. */
  const visibleList = sentences.map((_, i) => i).filter((i) => !hidden.has(i));
  const visibleCount = visibleList.length;
  const marked = withLocalChanges(lesson.id, bookmarks.indexes ?? []);
  for (const i of marked) if (!(i < total) || hidden.has(i)) marked.delete(i);
  /** `i`, or — if it was deleted — the next sentence that wasn't (else the one before). */
  const nearestVisible = (i: number) =>
    visibleList.find((j) => j >= i) ?? visibleList.findLast((j) => j < i) ?? i;

  /** "북마크만": go through the bookmarked sentences only. */
  const [onlyMarked, setOnlyMarked] = useState(bookmarks.only);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [hideError, setHideError] = useState<string | null>(null);
  /** A sentence just deleted from the card (or with the shortcut), offered back for a moment. */
  const [undoHide, setUndoHide] = useState<{ index: number } | null>(null);
  /** The sentence list is in "편집": tapping a sentence deletes or restores it. */
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(() => {
    if (startAt != null) return nearestVisible(startAt);
    // Bookmarked-only practice starts from the first bookmarked sentence.
    if (bookmarks.only && marked.size > 0) return Math.min(...marked);
    return nearestVisible(Math.min(Math.max(0, loadProgress(lesson.id).last || 0), total - 1));
  });
  const [playing, setPlaying] = useState(false);
  const [wait, setWait] = useState<{ key: number; ms: number; label: string } | null>(null);
  /** The repetition in progress (1-based), 0 when no repeat run is going. */
  const [repeatRound, setRepeatRound] = useState(0);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [tries, setTries] = useState<Record<string, Try>>({});
  const [revealed, setRevealed] = useState<number | null>(null);
  /** Sentences whose English answer is open this session (Korean → English mode). */
  const [answerShown, setAnswerShown] = useState<ReadonlySet<number>>(() => new Set());
  const [hintShown, setHintShown] = useState<number | null>(null);
  const [koAi, setKoAi] = useState<string[] | null>(null);
  const [translate, setTranslate] = useState<TranslateState>({ status: needsTranslation ? "working" : "idle" });
  const [recognitionSupported] = useState(speechRecognitionSupported);
  const recorder = useRecorder(meterRef);
  const koSpeech = useKoreanSpeech();
  /**
   * The lesson plays in the browser's own media element, which can go on with the screen
   * off. YouTube's player can't: YouTube stops it in the background on phones.
   */
  const playsInBackground = lesson.source.kind !== "youtube";
  const keepAlive = useKeepAlive(playsInBackground);
  /** Listen mode: the sentence whose hidden Korean was opened as text. */
  const [koRevealed, setKoRevealed] = useState<number | null>(null);
  /** Listen mode: a sentence to read aloud once its Korean (or the voice) is ready. */
  const pendingRead = useRef<number | null>(settings.mode === "listen" && !settings.koMuted ? current : null);

  /** Korean → English mode. */
  const speak = settings.mode === "listen";
  /** Korean → English mode reads each sentence's Korean aloud (it isn't muted). */
  const listening = speak && !settings.koMuted;
  /** Bookmarked-only practice is on, and there's something to practice. */
  const filtered = onlyMarked && marked.size > 0;
  /**
   * Korean → English mode always goes sentence by sentence, whatever the wait mode says.
   * So does bookmarked-only practice: following the video would play the sentences between.
   */
  const continuousPlay = !speak && settings.waitMode === "continuous" && !filtered;
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const koOf = (i: number) => koAi?.[i] || sentences[i].ko || "";
  const hasKorean = koAi ? koAi.some(Boolean) : sentences.some((s) => s.ko);
  const tryKey = (i: number) => `${settings.mode}:${i}`;
  /** The video is playing, or a repeat run is going (also while it reads Korean or pauses). */
  const running = playing || repeatRound > 0;

  /* --------------------------------- bookmarks ------------------------------- */

  const canBookmark = bookmarks.indexes !== null;
  const markedList = [...marked].sort((a, b) => a - b);
  // (Two lookups rather than one on `filtered ? markedList : visibleList`: React Compiler
  // can't follow that alias and then treats every handler as running during render.)
  /** The sentence after `i` (null at the end), skipping deleted ones — and, in "북마크만", unbookmarked ones. */
  const nextOf = (i: number): number | null =>
    (filtered ? markedList.find((m) => m > i) : visibleList.find((m) => m > i)) ?? null;
  /** The sentence before `i` (null at the start), skipping deleted ones — and, in "북마크만", unbookmarked ones. */
  const prevOf = (i: number): number | null =>
    (filtered ? markedList.findLast((m) => m < i) : visibleList.findLast((m) => m < i)) ?? null;

  const toggleBookmark = (i: number) => {
    if (!canBookmark) return;
    const on = !marked.has(i);
    // Removing the last bookmark ends bookmarked-only practice rather than leaving an empty list.
    if (!on && marked.size === 1) setOnlyMarked(false);
    setBookmarkError(null);
    // Shows at once; the store undoes it if saving fails.
    saveBookmark(lesson.id, i, on).catch((e: Error) => setBookmarkError(e.message));
  };

  /** Switches bookmarked-only practice on or off; on, it moves to a bookmarked sentence. */
  const showOnlyMarked = (only: boolean) => {
    if (only && markedList.length === 0) return;
    setOnlyMarked(only);
    if (!only || marked.has(current) || recorder.status !== "idle") return;
    const target = markedList.find((m) => m > current) ?? markedList[0];
    // Moving there shouldn't start the video; Korean → English mode moves as usual.
    if (speak) goTo(target);
    else {
      pause();
      stopMine();
      setCurrent(target);
    }
  };

  /* ---------------------------- deleted sentences ---------------------------- */

  /** Why sentence `i` can't be deleted right now, if it can't. */
  const hideBlocked = (i: number): string | undefined => {
    if (!canHide || hidden.has(i)) return undefined;
    if (visibleCount <= 1) return "마지막 남은 문장은 삭제할 수 없어요";
    if (i === current && recorder.status !== "idle") return "녹음이 끝난 뒤에 삭제할 수 있어요";
    return undefined;
  };

  /**
   * Deletes a sentence from practice — it stops showing up, here and next time — or brings
   * it back. Deleting the current sentence moves on (playing on if something was playing).
   * Returns whether anything changed.
   */
  const setHiddenAt = (i: number, on: boolean): boolean => {
    if (!canHide || hidden.has(i) === on || (on && hideBlocked(i))) return false;
    // A bookmark on it stays, just out of sight (here and on the "북마크" page) until it's restored.
    if (on) {
      if (i === current) {
        const target =
          nextOf(i) ?? prevOf(i) ?? visibleList.find((m) => m > i) ?? visibleList.findLast((m) => m < i) ?? i;
        if (running) goTo(target);
        else {
          pause();
          stopMine();
          stopKorean();
          setCurrent(target);
        }
      }
    }
    setHideError(null);
    saveHidden(lesson.id, [i], on).catch((e: Error) => setHideError(e.message));
    return true;
  };

  /** "삭제" on the card (or the Delete key): deletes the current sentence, with a way back. */
  const deleteCurrent = () => {
    const i = current;
    if (setHiddenAt(i, true)) setUndoHide({ index: i });
  };

  const undoDelete = () => {
    if (!undoHide) return;
    const { index } = undoHide;
    setUndoHide(null);
    if (!setHiddenAt(index, false)) return;
    // Back to where it was, without playing it.
    if (recorder.status === "idle") {
      pause();
      stopMine();
      stopKorean();
      setCurrent(index);
    }
  };

  useEffect(() => {
    if (!undoHide) return;
    const id = setTimeout(() => setUndoHide(null), 8000);
    return () => clearTimeout(id);
  }, [undoHide]);

  /* ------------------------------ timing helpers ----------------------------- */

  const startOf = (i: number) => sentences[i].start + settings.offset;
  const endOf = (i: number) => sentences[i].end + settings.offset;
  const indexAt = (t: number) => {
    let lo = 0;
    let hi = total - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (startOf(mid) <= t + 0.05) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const clamp = (i: number) => Math.min(Math.max(0, i), total - 1);

  /* ------------------------------ playback control --------------------------- */

  const clearWait = () => {
    clearTimeout(engine.current.waitTimer);
    engine.current.waitTimer = undefined;
    engine.current.waitThen = null;
    setWait(null);
  };

  /** Ends the countdown in progress now and carries on as if it had run out ("건너뛰기"). */
  const skipWait = () => {
    const then = engine.current.waitThen;
    clearWait();
    then?.();
  };

  /**
   * The room is between two sounds of a practice run — a countdown, or (with the screen off)
   * anything in a repeat run such as the Korean voice — so silence should keep the page
   * awake (see `useKeepAlive`). Only for a while after the last sound: see KEEP_ALIVE_MS.
   */
  const needsKeepAlive = (isPlaying: boolean) => {
    const e = engine.current;
    if (isPlaying || performance.now() - e.heardAt > KEEP_ALIVE_MS) return false;
    return e.waitThen !== null || (e.repeat !== null && document.visibilityState === "hidden");
  };

  /** Shows a countdown (time to speak), then runs `then`. */
  const holdThen = (ms: number, label: string, then: () => void) => {
    clearWait();
    setWait({ key: Date.now(), ms, label });
    engine.current.waitThen = then;
    engine.current.waitTimer = setTimeout(skipWait, ms);
    // The video/audio has just paused: without a sound the phone would put the page to sleep
    // (screen off) before the countdown ends.
    keepAlive(needsKeepAlive(false));
  };

  /** Ends the repeat run in progress (repeating itself stays switched on). */
  const endRepeat = () => {
    if (!engine.current.repeat) return;
    engine.current.repeat = null;
    setRepeatRound(0);
  };

  const stopMine = () => {
    myAudioRef.current?.pause();
    myAudioRef.current = null;
  };

  const playUrl = (url: string) => {
    stopMine();
    const audio = new Audio(url);
    myAudioRef.current = audio;
    audio.play().catch(() => {});
  };

  const stopKorean = () => {
    pendingRead.current = null;
    koSpeech.stop();
  };

  /** Plays one sentence of the video; `afterEnd` runs when it ends, instead of the wait mode. */
  const playSegment = (i: number, opts: { once?: boolean; afterEnd?: () => void } = {}) => {
    const p = playerRef.current;
    if (!p || !ready || recorder.status !== "idle") return;
    const idx = clamp(i);
    clearWait();
    stopMine();
    stopKorean();
    const e = engine.current;
    e.once = Boolean(opts.once);
    e.mode = !e.once && !opts.afterEnd && continuousPlay ? "continuous" : "segment";
    e.index = idx;
    e.armed = false;
    e.armDeadline = performance.now() + 1500;
    e.afterEnd = opts.afterEnd ?? null;
    e.heardAt = performance.now();
    setCurrent(idx);
    p.seek(startOf(idx));
    p.play();
  };

  /** Plays a sentence — through the repeat settings while repeating is on. */
  const play = (i: number) => {
    if (settings.loop) return startRepeat(i);
    endRepeat();
    playSegment(i);
  };

  /** Plays a sentence's English once, whatever the repeat and wait settings say. */
  const playOnce = (i: number, afterEnd?: () => void) => {
    endRepeat();
    playSegment(i, { once: true, afterEnd });
  };

  /**
   * Stops what's playing or counting down, but not the silence that keeps a phone awake (see
   * `useKeepAlive`): for starting another sound right after.
   */
  const halt = () => {
    clearWait();
    const e = engine.current;
    if (e.repeat) {
      endRepeat();
      koSpeech.stop();
    }
    e.mode = "idle";
    e.afterEnd = null;
    e.pausedAt = performance.now();
    playerRef.current?.pause();
  };

  /** Stops playback — and the silence, so the phone may sleep again. */
  const pause = () => {
    halt();
    keepAlive(false);
  };

  /* ------------------------------- repeat runs ------------------------------- */

  const spokenMs = (i: number) => ((sentences[i].end - sentences[i].start) / settings.rate) * 1000;

  /** Time to say a sentence after hearing it — none when playing straight through. */
  const sayTimeMs = (i: number) => {
    // "이어서 재생" (in bookmarked-only practice: one bookmarked sentence straight after another).
    if (!speak && settings.waitMode === "continuous") return 0;
    const factor = !speak && settings.waitMode === "auto15" ? 1.5 : 1;
    return Math.max(1200, spokenMs(i) * factor);
  };

  /** The pause between the two languages of one repetition. */
  const gapMs = (i: number) => {
    const gap = settings.repeatGap;
    return gap === "fit" ? Math.max(2000, spokenMs(i) * 1.5 + 1000) : gap * 1000;
  };

  /** One repetition's parts — just the English where there's no Korean to read aloud. */
  const partsFor = (i: number): Part[] =>
    koOf(i) && koSpeech.supported ? REPEAT_PARTS[settings.repeatOrder] : ["en"];

  /** Starts repeating a sentence from its first repetition. */
  const startRepeat = (i: number) => {
    if (!ready || recorder.status !== "idle") return;
    const idx = clamp(i);
    // Not `pause()`: when a run moves on to the next sentence by itself, that would stop the
    // silence just before the sentence starts — and a phone doesn't start a sound after a
    // silent moment like that, so the run stopped there. The silence stops by itself once the
    // sentence plays (see `onTick`), as it does between two repetitions of one sentence.
    halt();
    stopMine();
    stopKorean();
    engine.current.repeat = { index: idx, round: 1, step: 0, rested: false };
    setRepeatRound(1);
    setCurrent(idx);
    runRepeat();
  };

  // Video ends, speech ends and timers outlive the render that started them: they carry
  // the run on through this ref, so it follows the latest settings (e.g. a new count).
  const repeatLatest = useRef<(() => void) | null>(null);
  const resumeRepeat = () => repeatLatest.current?.();
  /** A run that played its last repetition moves on from sentence `i` (see the effect below). */
  const advanceLatest = useRef<((i: number) => void) | null>(null);

  /** Plays the run's next part — or, after the last one, the next repetition or sentence. */
  const runRepeat = () => {
    const run = engine.current.repeat;
    if (!run) return;
    const i = run.index;
    const parts = partsFor(i);

    if (run.step > 0 && run.step < parts.length && !run.rested) {
      run.rested = true;
      const gap = gapMs(i);
      if (gap > 0) return holdThen(gap, parts[run.step - 1] === "ko" ? SAY_IN_ENGLISH : RECALL_MEANING, resumeRepeat);
    }

    if (run.step < parts.length) {
      const part = parts[run.step];
      run.step += 1;
      run.rested = false;
      const done = () => {
        if (engine.current.repeat === run) resumeRepeat();
      };
      if (part === "en") playSegment(i, { afterEnd: done });
      else {
        stopMine();
        const e = engine.current;
        e.heardAt = performance.now();
        // The browser's voice doesn't keep the page awake with the screen off; silence under
        // it does. (On screen, silence is stopped instead, so it can't get in the voice's way.)
        keepAlive(needsKeepAlive(false));
        koSpeech.speak(koOf(i), (ok) => {
          if (ok) e.heardAt = performance.now();
          // A voice that won't play would fail the same way every time round: stop and say so.
          // With the screen off the phone may just not allow it: carry on with the English.
          if (ok || document.visibilityState === "hidden") done();
          else endRepeat();
        });
      }
      return;
    }

    // This repetition is over: repeat the sentence again or, after the last one, move on
    // to the next sentence (stopping at the end).
    const count = settings.repeatCount;
    const again = count === 0 || run.round < count;
    if (!again && nextOf(i) === null) return endRepeat();
    const go = () => {
      if (engine.current.repeat !== run) return;
      if (!again) return advanceLatest.current?.(i);
      const next: Repeat = { index: i, round: run.round + 1, step: 0, rested: false };
      engine.current.repeat = next;
      setRepeatRound(next.round);
      resumeRepeat();
    };
    const ms = settings.repeatSayTime ? sayTimeMs(i) : 0;
    if (ms > 0) holdThen(ms, parts[parts.length - 1] === "ko" ? SAY_IN_ENGLISH : SAY_IT, go);
    else go();
  };

  /** Reads a sentence's Korean aloud — or, while it isn't ready yet, as soon as it is. */
  const readKorean = (i: number) => {
    const text = koOf(i);
    if (!text || !koSpeech.supported) {
      pendingRead.current = i;
      return;
    }
    if (recorder.status !== "idle") return;
    pendingRead.current = null;
    pause();
    stopMine();
    koSpeech.speak(text);
  };

  const toggleKorean = () => (koSpeech.speaking ? stopKorean() : readKorean(current));

  /**
   * Moves to a sentence. In Korean → English mode it must not play (that would reveal
   * the answer); listen mode reads the new sentence's Korean instead.
   */
  const goTo = (i: number) => {
    if (!speak) return play(i);
    if (recorder.status !== "idle") return;
    const idx = clamp(i);
    // Repeating that starts from the Korean doesn't give the answer away: keep repeating there.
    if (settings.loop && partsFor(idx)[0] === "ko") return startRepeat(idx);
    pause();
    stopMine();
    setCurrent(idx);
    if (listening) readKorean(idx);
    else stopKorean();
  };

  const setAnswer = (i: number, show: boolean) =>
    setAnswerShown((prev) => {
      if (prev.has(i) === show) return prev;
      const next = new Set(prev);
      if (show) next.add(i);
      else next.delete(i);
      return next;
    });

  /** The hint is for an answer still hidden, so asking for it closes the answer again. */
  const toggleHint = () => {
    if (answerShown.has(current)) {
      setAnswer(current, false);
      setHintShown(current);
    } else setHintShown((h) => (h === current ? null : current));
  };

  const switchMode = (mode: PracticeMode) => {
    if (mode === settings.mode || recorder.status !== "idle") return;
    pause();
    stopMine();
    stopKorean();
    update({ mode });
    if (mode === "listen" && !settings.koMuted) readKorean(current);
  };

  /** Muted, listen mode shows each sentence's Korean as text instead of reading it aloud. */
  const toggleKoMuted = () => {
    const koMuted = !settings.koMuted;
    update({ koMuted });
    if (koMuted) {
      pendingRead.current = null;
      // A repeat run reads Korean by its own settings: leave it be.
      if (!engine.current.repeat) koSpeech.stop();
    }
    // The sentence on screen was just read as text: keep it open rather than blur it again.
    else setKoRevealed(current);
  };

  /** "이 문장 반복": switching it on starts the current sentence right away. */
  const toggleLoop = () => {
    const loop = !settings.loop;
    update({ loop });
    const e = engine.current;
    if (loop) {
      // Already playing: hold this sentence — the run takes over where it ends.
      if (e.mode === "continuous") e.mode = "segment";
      else if (!playing && !wait) startRepeat(current);
    } else if (e.repeat) {
      // Let what's playing finish, then carry on as without repeating.
      endRepeat();
      e.afterEnd = null;
      clearWait();
    } else if (speak || settings.waitMode === "manual") clearWait();
  };

  // Timers outlive the render that created them; route them through a ref
  // so they act on the latest settings (e.g. loop switched off mid-countdown).
  const afterWaitLatest = useRef<((i: number) => void) | null>(null);
  useEffect(() => {
    repeatLatest.current = runRepeat;
    advanceLatest.current = (i) => {
      const next = nextOf(i);
      if (next === null) return endRepeat();
      // Repeats the next sentence the same way — in Korean → English mode too, even when a
      // repetition starts with the English: the learner chose to hear it. (Moving by hand
      // there still waits instead of playing the answer: see `goTo`.)
      startRepeat(next);
    };
    afterWaitLatest.current = (i) => {
      if (settings.loop) play(i);
      // Never run on to the next sentence in Korean → English mode: its audio is the answer.
      else if (!speak && settings.waitMode !== "manual") {
        const next = nextOf(i);
        if (next !== null) play(next);
      }
    };
  });

  const finishSegment = () => {
    const e = engine.current;
    const i = e.index;
    e.mode = "idle";
    e.pausedAt = performance.now();
    const after = e.afterEnd;
    e.afterEnd = null;
    if (after) return after();
    if (e.once) return;
    // Repeating was switched on mid-sentence, or playback was started from the video's own
    // controls: carry on as a repeat run that has just played this sentence's English.
    if (settings.loop) {
      e.repeat = { index: i, round: 1, step: partsFor(i).indexOf("en") + 1, rested: false };
      setRepeatRound(1);
      return runRepeat();
    }
    if (continuousPlay) return;
    // "문장마다 멈춤" stops here, and so does Korean → English mode (each sentence's audio
    // is its answer).
    if (speak || settings.waitMode === "manual" || nextOf(i) === null) return;
    const ms = sayTimeMs(i);
    if (ms > 0) holdThen(ms, SAY_IT, () => afterWaitLatest.current?.(i));
    else afterWaitLatest.current?.(i);
  };

  const onTick = useEffectEvent(() => {
    const p = playerRef.current;
    if (!p) return;
    const isPlaying = p.isPlaying();
    setPlaying(isPlaying);
    if (isPlaying) engine.current.heardAt = performance.now();
    // Silence only fills gaps: it stops once the video/audio plays, the run ends or it's paused.
    keepAlive(needsKeepAlive(isPlaying));
    if (!isPlaying) return;

    const t = p.getTime();
    const e = engine.current;

    if (e.mode === "idle") {
      if (performance.now() - e.pausedAt < 600) return;
      // Playback was started from the video's own controls: follow along.
      let j = indexAt(t);
      if (t >= endOf(j) - 0.1 && j < total - 1) j += 1;
      clearWait();
      endRepeat();
      stopKorean();
      e.once = false;
      // A deleted sentence is skipped: on to the next one that wasn't deleted.
      const k = hidden.has(j) ? (visibleList.find((m) => m > j) ?? null) : j;
      if (k === null) {
        // Only deleted sentences are left.
        p.pause();
        e.pausedAt = performance.now();
        return;
      }
      // While repeating, stop at the sentence's end: the run picks it up from there.
      e.mode = continuousPlay && !settings.loop ? "continuous" : "segment";
      e.index = k;
      e.armed = k === j;
      e.armDeadline = performance.now() + 1500;
      if (k !== j) p.seek(startOf(k));
      setCurrent(k);
      return;
    }

    const start = startOf(e.index);
    const end = endOf(e.index);
    if (!e.armed) {
      if ((t >= start - 0.6 && t < end - 0.05) || performance.now() > e.armDeadline) e.armed = true;
      else return;
    }

    if (e.mode === "continuous") {
      const j = indexAt(t);
      if (j === e.index) return;
      // Deleted sentences were just skipped and the seek landed a little early: wait for it.
      if (j < e.index && hidden.has(j) && t >= start - 1.5) return;
      const k = hidden.has(j) ? (visibleList.find((m) => m > j) ?? null) : j;
      if (k === null) {
        // Only deleted sentences are left.
        p.pause();
        e.mode = "idle";
        e.pausedAt = performance.now();
        return;
      }
      if (k !== j) {
        p.seek(startOf(k));
        e.armed = false;
        e.armDeadline = performance.now() + 1500;
      }
      e.index = k;
      setCurrent(k);
      return;
    }

    if (t < start - 1.5 || t > end + 1.5) {
      // The learner scrubbed the timeline. A repeat run starts over on the new sentence.
      if (e.repeat) {
        endRepeat();
        e.afterEnd = null;
      }
      const j = indexAt(t);
      const k = hidden.has(j) ? (visibleList.find((m) => m > j) ?? null) : j;
      if (k === null) {
        p.pause();
        e.mode = "idle";
        e.afterEnd = null;
        e.pausedAt = performance.now();
        return;
      }
      if (k !== j) {
        p.seek(startOf(k));
        e.armed = false;
        e.armDeadline = performance.now() + 1500;
      }
      e.index = k;
      setCurrent(k);
      return;
    }
    if (t >= end - 0.03) {
      p.pause();
      finishSegment();
    }
  });

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(onTick, 40);
    // With the screen off, timers slow to about once a second, which would run a sentence on
    // into the next one: the audio's own progress events keep its end on time. Turning the
    // screen off or on starts or stops the silence that keeps a run going in the background.
    const tick = () => onTick();
    const stopProgress = playerRef.current?.onProgress?.(tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      stopProgress?.();
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ready]);

  /* ------------------------------ AI translation ----------------------------- */

  useEffect(() => {
    if (!needsTranslation) return;
    let cancelled = false;
    requestTranslation(lesson.id).then(
      (t) => {
        if (cancelled) return;
        setKoAi(t.ko);
        setTranslate(translatedState(t));
      },
      (e: Error) => {
        if (!cancelled) setTranslate({ status: "error", message: e.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsTranslation, lesson.id]);

  // Listen mode waits for the Korean (AI translation, voice list) before reading it out.
  const koReady = Boolean(koOf(current) && koSpeech.supported);
  const onKoreanReady = useEffectEvent(() => {
    if (!listening || pendingRead.current !== current) return;
    // Browsers won't speak before the first tap on the page; the 🔊 button is right there.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    readKorean(current);
  });
  useEffect(() => {
    if (!koReady) return;
    const id = setTimeout(onKoreanReady, 0);
    return () => clearTimeout(id);
  }, [koReady, current]);

  const retryTranslation = () => {
    setTranslate({ status: "working" });
    requestTranslation(lesson.id).then(
      (t) => {
        setKoAi(t.ko);
        setTranslate(translatedState(t));
      },
      (e: Error) => setTranslate({ status: "error", message: e.message }),
    );
  };

  /* -------------------------------- recording -------------------------------- */

  const record = async () => {
    if (recorder.status === "recording") {
      recorder.stop();
      return;
    }
    if (recorder.status !== "idle") return;
    pause();
    stopMine();
    stopKorean();
    const i = current;
    const mode = settings.mode;
    const composing = mode !== "shadow";
    const sentence = sentences[i];
    const length = sentence.end - sentence.start;
    const result = await recorder.start(
      composing
        ? // Composing a sentence takes longer than repeating one.
          { maxSeconds: Math.min(40, Math.max(10, length * 3 + 6)), trailingSilenceMs: 2200, noSpeechMs: 12000 }
        : { maxSeconds: Math.min(30, Math.max(5, length * 2.5 + 2)) },
    );
    if (!result) return;
    if (result.url) urlsRef.current.push(result.url);

    const attempt = result.transcript ? scoreAttempt(sentence.text, result.transcript) : null;
    setTries((prev) => ({
      ...prev,
      [`${mode}:${i}`]: {
        attempt,
        url: result.url,
        heard: result.transcript,
        recognitionError: result.recognitionError,
      },
    }));
    // Open the answer to compare against, even when the speech wasn't recognised.
    if (composing) setAnswer(i, true);
    if (!attempt) return;
    const setter = composing ? setBestSpeak : setBest;
    setter((prev) => ((prev[i] ?? -1) >= attempt.score ? prev : { ...prev, [i]: attempt.score }));
    if (!composing) setRevealed(i);
  };

  const compare = (i: number) => {
    const url = tries[tryKey(i)]?.url;
    if (url) playOnce(i, () => playUrl(url));
  };

  const playMine = (i: number) => {
    const url = tries[tryKey(i)]?.url;
    if (!url) return;
    pause();
    playUrl(url);
  };

  /* ------------------------------- side effects ------------------------------ */

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(
    () => saveProgress(lesson.id, { best, bestSpeak, last: current }),
    [lesson.id, best, bestSpeak, current],
  );
  useEffect(() => {
    touchRecent({
      id: lesson.id,
      title: lesson.title,
      thumbnail: lesson.thumbnail,
      sentenceCount: total,
      practiced: new Set([...Object.keys(best), ...Object.keys(bestSpeak)]).size,
      at: Date.now(),
    });
  }, [lesson.id, lesson.title, lesson.thumbnail, total, best, bestSpeak]);

  useEffect(() => {
    if (ready) playerRef.current?.setRate(settings.rate);
  }, [ready, settings.rate]);

  // Keep the current sentence centred in the list — also when the list is expanded again.
  const sentencesOpen = settings.sentencesOpen;
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!sentencesOpen || !list || !item) return;
    const top = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [current, sentencesOpen, filtered, editing]);

  useEffect(() => {
    const e = engine.current;
    const urls = urlsRef.current;
    return () => {
      clearTimeout(e.waitTimer);
      myAudioRef.current?.pause();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const onKey = useEffectEvent((ev: KeyboardEvent) => {
    const target = ev.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key) {
      case " ":
        ev.preventDefault();
        if (running) pause();
        else play(current);
        break;
      case "ArrowRight":
        ev.preventDefault();
        // At the end it replays the last sentence, as before.
        goTo(nextOf(current) ?? current);
        break;
      case "ArrowLeft":
        ev.preventDefault();
        goTo(prevOf(current) ?? current);
        break;
      case "b":
      case "B":
        toggleBookmark(current);
        break;
      case "Delete":
      case "Backspace":
        ev.preventDefault();
        deleteCurrent();
        break;
      case "r":
      case "R":
        ev.preventDefault();
        void record();
        break;
      case "l":
      case "L":
        toggleLoop();
        break;
      case "s":
      case "S":
        if (wait) skipWait();
        break;
      case "h":
      case "H":
        if (speak) toggleHint();
        break;
      case "k":
      case "K":
        if (speak) toggleKorean();
        break;
      case "m":
      case "M":
        if (speak && koSpeech.supported) toggleKoMuted();
        break;
    }
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* --------------------------------- render ---------------------------------- */

  const sentence = sentences[current];
  const ko = koOf(current);
  const attemptState = tries[tryKey(current)];
  const attempt = attemptState?.attempt ?? null;
  const showEnglish = settings.showText || revealed === current;
  const modeBest = speak ? bestSpeak : best;
  // Deleted sentences don't count towards progress.
  const keptScores = Object.entries(modeBest)
    .filter(([i]) => !hidden.has(Number(i)))
    .map(([, score]) => score);
  const practicedCount = keptScores.length;
  const average = practicedCount ? Math.round(keptScores.reduce((a, b) => a + b, 0) / practicedCount) : null;
  const recording = recorder.status === "recording" || recorder.status === "starting";
  const busy = recorder.status !== "idle";
  const waitMode = WAIT_MODES.find((m) => m.value === settings.waitMode);
  const settingsSummary = [
    `${settings.rate}x`,
    !speak && waitMode?.label,
    `자막 싱크 ${settings.offset > 0 ? "+" : ""}${settings.offset.toFixed(1)}초`,
  ]
    .filter(Boolean)
    .join(" · ");
  const answerVisible = answerShown.has(current);
  const speakUnavailable = !hasKorean && translate.status !== "working";
  /** No speech synthesis in this browser: listen mode falls back to showing the text. */
  const noVoice = !koSpeech.supported;
  /** Listen mode keeps a sentence's Korean hidden until it's opened or answered. */
  const koHiddenAt = (i: number) => listening && !noVoice && koRevealed !== i && !answerShown.has(i);
  const koHidden = koHiddenAt(current);
  const currentMarked = marked.has(current);
  /** Where the current sentence sits among the bookmarked ones (1-based; 0 if it isn't one). */
  const markedPosition = markedList.indexOf(current) + 1;
  const prevIndex = prevOf(current);
  const nextIndex = nextOf(current);

  // The lock screen shows the English sentence only where it's on screen anyway (shadowing
  // with the text shown): listening practice and the Korean → English answer stay hidden.
  const sentenceOnLockScreen = !speak && settings.showText;
  useMediaSession(
    playsInBackground,
    {
      title: sentenceOnLockScreen ? sentence.text : lesson.title,
      artist: `${sentenceOnLockScreen ? `${lesson.title} · ` : ""}문장 ${current + 1}/${total}`,
      // The script cover is an SVG, which lock screens don't show: the app icon stands in.
      artwork: lesson.thumbnail && !lesson.thumbnail.endsWith(".svg") ? lesson.thumbnail : null,
    },
    running || wait !== null,
    {
      // Starts the current sentence over, as "듣기" does.
      play: () => play(current),
      pause,
      previous: () => {
        if (prevIndex !== null) goTo(prevIndex);
      },
      next: () => {
        if (nextIndex !== null) goTo(nextIndex);
      },
    },
  );

  /** Why the repeat settings can't read Korean aloud here, if they can't. */
  const repeatKoBlocked = noVoice ? "이 브라우저는 음성 읽기를 지원하지 않아요" : speakUnavailable ? NO_KOREAN : undefined;
  const repeatOrder = repeatKoBlocked ? "en" : settings.repeatOrder;
  const repeatSummary = describeRepeat(
    repeatOrder,
    settings.repeatCount,
    settings.repeatGap,
    settings.repeatSayTime,
  );
  const repeatTag =
    settings.repeatCount === 0
      ? "∞"
      : repeatRound > 0
        ? `${repeatRound}/${settings.repeatCount}`
        : `${settings.repeatCount}번`;
  const repeatOrderTag = REPEAT_ORDERS.find((o) => o.value === repeatOrder)?.short;
  /** Keyboard shortcuts for this mode, listed in the settings: playback, speaking, then the rest. */
  const shortcuts = [
    { keys: ["Space"], label: speak ? "원어민 듣기/멈춤" : "듣기/멈춤" },
    { keys: ["←", "→"], label: "이전/다음 문장" },
    { keys: ["R"], label: speak ? "영어로 말하기" : "녹음" },
    speak && { keys: ["K"], label: "한국어 듣기" },
    speak && !noVoice && { keys: ["M"], label: "한국어 음소거" },
    speak && { keys: ["H"], label: "힌트" },
    { keys: ["L"], label: "반복 켜기/끄기" },
    { keys: ["S"], label: "기다리기 건너뛰기" },
    canBookmark && { keys: ["B"], label: "북마크" },
    canHide && { keys: ["Del"], label: "문장 삭제" },
  ].filter((s): s is { keys: string[]; label: string } => Boolean(s));

  const englishLine = attempt
    ? attempt.marks.map((m, k) => (
        <span key={k} className={m.ok ? "" : "rounded bg-bad-soft px-0.5 text-bad underline decoration-wavy underline-offset-4"}>
          {m.text}{" "}
        </span>
      ))
    : sentence.text;

  const recordButton = (
    <button
      type="button"
      onClick={() => void record()}
      disabled={!ready || recorder.status === "finishing" || (speak && !ko)}
      className={`relative inline-flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-full px-6 font-semibold text-on-accent transition disabled:opacity-40 sm:ml-auto sm:w-auto ${
        recording ? "animate-pulse bg-bad" : "bg-accent hover:bg-accent-strong"
      }`}
      aria-label={recording ? "녹음 멈추기 (R)" : speak ? "영어로 말하기 (R)" : "따라 말하고 녹음하기 (R)"}
    >
      {recording ? <StopIcon /> : <MicIcon />}
      {recording ? "멈추기" : recorder.status === "finishing" ? "분석 중…" : speak ? "영어로 말하기" : "따라 말하기"}
      {/* Microphone level while recording — inside the button so it takes no room in the row. */}
      <span
        ref={meterRef}
        aria-hidden="true"
        className={`absolute inset-x-6 bottom-1.5 h-1 overflow-hidden rounded-full bg-white/25 ${recording ? "" : "invisible"}`}
      >
        <span className="block h-full w-[calc(var(--level,0)*100%)] rounded-full bg-white transition-[width] duration-75" />
      </span>
    </button>
  );

  return (
    <div
      className={`grid gap-6 ${
        sentencesOpen ? "lg:grid-cols-[minmax(0,1fr)_380px]" : "lg:grid-cols-[minmax(0,1fr)_3rem]"
      }`}
    >
      <section className="min-w-0 space-y-4">
        {lesson.source.kind === "script" || (lesson.source.kind === "file" && lesson.source.type.startsWith("audio/")) ? (
          /* No picture (script lessons, uploaded audio): a slim audio bar. Scripts offer their MP3 to take along. */
          <div className="rounded-2xl border border-line bg-surface p-3 shadow-sm">
            <MediaPlayer
              ref={playerRef}
              audio
              src={`/api/lessons/${lesson.id}/${lesson.source.kind === "script" ? "audio" : "media"}`}
              errorText={lesson.source.kind === "file" ? "오디오 파일을 재생하지 못했어요. 페이지를 새로고침해 주세요." : undefined}
              onReady={() => setReady(true)}
              onError={setPlayerError}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <HeadphonesIcon size={14} />
                {lesson.source.kind === "script" ? "AI 영어 음성" : "내 오디오 파일"}
                {lesson.durationSec ? ` · ${formatTime(lesson.durationSec)}` : ""}
              </span>
              {lesson.source.kind === "script" && (
                <a
                  href={`/api/lessons/${lesson.id}/audio?download`}
                  download
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 font-semibold text-ink transition hover:bg-surface-2"
                >
                  <DownloadIcon size={14} />
                  음성 파일 받기 (MP3)
                </a>
              )}
            </div>
            {playerError && (
              <p role="alert" className="mt-2 px-1 text-sm font-semibold text-bad">
                {playerError}
              </p>
            )}
          </div>
        ) : (
        /* Video — height-capped on desktop so the practice controls stay on screen. */
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-sm lg:max-h-[max(18rem,calc(100dvh_-_34rem))]">
          {lesson.source.kind === "youtube" ? (
            <YouTubePlayer
              ref={playerRef}
              videoId={lesson.source.videoId}
              onReady={() => setReady(true)}
              onError={setPlayerError}
            />
          ) : (
            <MediaPlayer
              ref={playerRef}
              src={lesson.source.kind === "file" ? `/api/lessons/${lesson.id}/media` : lesson.source.url}
              errorText={lesson.source.kind === "file" ? "영상을 재생하지 못했어요. 페이지를 새로고침해 주세요." : undefined}
              onReady={() => setReady(true)}
              onError={setPlayerError}
            />
          )}
          {playerError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-6 text-center text-white">
              <p className="font-semibold">{playerError}</p>
              {lesson.source.kind === "youtube" && (
                <a
                  className="rounded-full bg-white/15 px-4 py-2 text-sm hover:bg-white/25"
                  href={`https://www.youtube.com/watch?v=${lesson.source.videoId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  유튜브에서 열기
                </a>
              )}
            </div>
          )}
        </div>
        )}

        {/* Current sentence */}
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {/* Mode switch sits with the controls so it stays on screen while practising. */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-muted">
                문장 <span className="text-ink">{current + 1}</span> / {total}
                <span className="ml-2 font-normal tabular-nums">{formatTime(sentence.start)}</span>
              </span>
              {canBookmark && (
                <button
                  type="button"
                  onClick={() => toggleBookmark(current)}
                  aria-pressed={currentMarked}
                  aria-label={currentMarked ? "북마크 해제 (B)" : "나중에 연습하게 북마크 (B)"}
                  title={currentMarked ? "북마크 해제 (B)" : "나중에 연습하게 북마크 (B)"}
                  className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition ${
                    currentMarked
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <BookmarkIcon size={14} filled={currentMarked} />
                  {currentMarked ? "북마크됨" : "북마크"}
                </button>
              )}
              {canHide && (
                <button
                  type="button"
                  onClick={deleteCurrent}
                  disabled={Boolean(hideBlocked(current))}
                  aria-label="이 문장 삭제 (Del) — 다음부터 보이지 않아요"
                  title={hideBlocked(current) ?? "이 문장 삭제 (Del) — 다음부터 보이지 않아요"}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-xs font-semibold text-muted transition enabled:hover:bg-bad-soft enabled:hover:text-bad disabled:opacity-40"
                >
                  <TrashIcon size={14} />
                  삭제
                </button>
              )}
              {modeBest[current] != null && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TONE_BG[scoreTone(modeBest[current])]}`}>
                  {speak ? `최고 일치율 ${modeBest[current]}%` : `최고 ${modeBest[current]}점`}
                </span>
              )}
            </div>
            <ModeSwitch
              value={settings.mode}
              onChange={switchMode}
              // Without a voice the mode still works: it shows the Korean as text.
              disabled={{ listen: speakUnavailable ? NO_KOREAN : undefined }}
            />
          </div>
          {filtered && (
            <div className="-mt-1 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
              <span className="flex items-center gap-1.5">
                <BookmarkIcon size={14} filled />
                북마크한 문장만 연습 중
                {markedPosition > 0 && (
                  <span className="tabular-nums">
                    · {markedPosition}/{markedList.length}
                  </span>
                )}
              </span>
              <span className="ml-auto flex items-center gap-3">
                {bookmarks.next && (
                  <Link
                    href={`/lesson/${bookmarks.next}?only=bookmarks`}
                    className={nextIndex === null ? "underline" : "font-medium opacity-80 hover:opacity-100"}
                  >
                    다음 영상 북마크 →
                  </Link>
                )}
                <button type="button" onClick={() => showOnlyMarked(false)} className="font-medium opacity-80 hover:opacity-100">
                  모든 문장 보기
                </button>
              </span>
            </div>
          )}
          {bookmarkError && <p className="-mt-2 mb-3 text-xs text-bad">{bookmarkError}</p>}
          {hideError && <p className="-mt-2 mb-3 text-xs text-bad">{hideError}</p>}
          {undoHide && (
            <div
              role="status"
              className="-mt-1 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface-2 px-3 py-2 text-xs font-semibold text-muted"
            >
              <span className="break-keep">
                {undoHide.index + 1}번 문장을 삭제했어요. 다음부터 보이지 않아요.
              </span>
              <button type="button" onClick={undoDelete} className="ml-auto text-ink underline">
                되돌리기
              </button>
            </div>
          )}
          {translate.status === "working" && (
            <p className="-mt-2 mb-3 flex items-center gap-2 text-xs font-semibold text-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> AI가 문장별 한글 해석을 만드는 중…
            </p>
          )}
          {translate.status === "error" && (
            <p className="-mt-2 mb-3 text-xs text-bad">
              {translate.message}{" "}
              <button type="button" className="font-semibold underline" onClick={retryTranslation}>
                다시 시도
              </button>
            </p>
          )}

          {speak ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-accent">
                  {listening ? "한국어를 듣고 영어로 말해 보세요" : "이 뜻을 영어로 말해 보세요"}
                </p>
                {!noVoice && (
                  <button
                    type="button"
                    onClick={toggleKoMuted}
                    aria-pressed={settings.koMuted}
                    aria-label={settings.koMuted ? "한국어 음소거 해제 (M)" : "한국어 음소거 (M) — 읽어 주지 않고 글로 보여 줘요"}
                    title={settings.koMuted ? "한국어 음소거 해제 (M)" : "한국어 음소거 (M) — 읽어 주지 않고 글로 보여 줘요"}
                    className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition ${
                      settings.koMuted
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line text-muted hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {settings.koMuted ? <SpeakerOffIcon size={14} /> : <SpeakerIcon size={14} />}
                    {settings.koMuted ? "음소거됨" : "음소거"}
                  </button>
                )}
              </div>
              {listening && noVoice && (
                <p className="mt-1 text-xs text-muted">이 브라우저는 음성 읽기를 지원하지 않아 글로 보여 드려요.</p>
              )}
              {ko ? (
                <div className="mt-1 flex items-start gap-3">
                  {!noVoice && (
                    <button
                      type="button"
                      onClick={toggleKorean}
                      disabled={busy}
                      aria-pressed={koSpeech.speaking}
                      aria-label={koSpeech.speaking ? "읽기 멈추기 (K)" : "한국어로 듣기 (K)"}
                      title={koSpeech.speaking ? "읽기 멈추기 (K)" : "한국어로 듣기 (K)"}
                      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40 ${
                        koSpeech.speaking ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2"
                      }`}
                    >
                      <SpeakerIcon size={18} className={koSpeech.speaking ? "animate-pulse" : undefined} />
                    </button>
                  )}
                  <div className="relative min-w-0 flex-1">
                    <p
                      className={`break-keep text-[1.35rem] font-semibold leading-relaxed sm:text-2xl ${
                        koHidden ? "select-none blur-md" : ""
                      }`}
                      aria-hidden={koHidden || undefined}
                    >
                      {ko}
                    </p>
                    {koHidden && (
                      <button
                        type="button"
                        onClick={() => setKoRevealed(current)}
                        className="absolute inset-0 m-auto flex h-10 w-fit items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-bg"
                      >
                        <EyeIcon size={16} /> 글로 보기
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-1 text-muted">
                  {translate.status === "working" ? "한글 해석을 준비하고 있어요…" : "이 문장은 한글 해석이 없어요."}
                </p>
              )}
              {koSpeech.error && ko && <p className="mt-2 text-xs text-bad">{SPEECH_ERRORS[koSpeech.error]}</p>}
              {hintShown === current && !answerVisible && (
                <p className="mt-2 text-lg tracking-wide text-muted" lang="en">
                  {hintFor(sentence.text)}
                </p>
              )}
              {answerVisible && (
                <div className="mt-4 rounded-xl border border-line p-4">
                  <div className="mb-1 text-xs font-semibold text-muted">원문</div>
                  <p className="text-lg font-semibold leading-relaxed" lang="en">
                    {englishLine}
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="relative">
                <p
                  className={`text-[1.35rem] font-semibold leading-relaxed tracking-[-0.01em] sm:text-2xl ${
                    showEnglish ? "" : "select-none blur-md"
                  }`}
                  lang="en"
                >
                  {englishLine}
                </p>
                {!showEnglish && (
                  <button
                    type="button"
                    onClick={() => setRevealed(current)}
                    className="absolute inset-0 m-auto flex h-10 w-fit items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-bg"
                  >
                    <EyeIcon size={16} /> 문장 보기
                  </button>
                )}
              </div>
              {hasKorean && settings.showKorean && ko && <p className="mt-2 break-keep text-base text-muted">{ko}</p>}
              {/* Only repeating reads Korean aloud here. */}
              {koSpeech.error && (
                <p className="mt-2 text-xs text-bad">
                  {koSpeech.error === "unavailable"
                    ? SPEECH_ERRORS.unavailable
                    : "한국어 음성을 재생하지 못해 반복을 멈췄어요. 듣기 버튼으로 다시 시작하거나 반복 설정을 '영어만'으로 바꿔 보세요."}
                </p>
              )}
            </>
          )}

          {wait && (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-accent">{wait.label}</span>
                <button
                  type="button"
                  onClick={skipWait}
                  title="건너뛰기 (S)"
                  className="-my-1 inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-semibold text-muted transition hover:bg-surface-2 hover:text-ink"
                >
                  건너뛰기 <NextIcon size={12} />
                </button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  key={wait.key}
                  className="h-full origin-left animate-countdown rounded-full bg-accent"
                  style={{ animationDuration: `${wait.ms}ms` }}
                />
              </div>
            </div>
          )}

          {/* Transport: playback (with repeat) · answer aids · speak. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <IconButton
              label={filtered ? "이전 북마크 문장 (←)" : "이전 문장 (←)"}
              onClick={() => prevIndex !== null && goTo(prevIndex)}
              disabled={!ready || prevIndex === null}
            >
              <PrevIcon />
            </IconButton>
            <button
              type="button"
              onClick={() => (running ? pause() : play(current))}
              disabled={!ready || busy}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-semibold text-bg transition hover:opacity-90 disabled:opacity-40"
              aria-label={running ? "일시정지 (Space)" : "문장 듣기 (Space)"}
            >
              {running ? <PauseIcon /> : <PlayIcon />}
              {running ? "일시정지" : "듣기"}
            </button>
            <IconButton
              label={filtered ? "다음 북마크 문장 (→)" : "다음 문장 (→)"}
              onClick={() => nextIndex !== null && goTo(nextIndex)}
              disabled={!ready || nextIndex === null}
            >
              <NextIcon />
            </IconButton>
            {/* Repeat: the left half switches it on/off, the chevron opens its settings. */}
            <div
              className={`inline-flex h-12 overflow-hidden rounded-full border transition ${
                settings.loop ? "border-accent bg-accent-soft text-accent" : "border-line"
              }`}
            >
              <button
                type="button"
                onClick={toggleLoop}
                aria-pressed={settings.loop}
                aria-label={settings.loop ? `반복 끄기 (L) — ${repeatSummary}` : "이 문장 반복 듣기 (L)"}
                title={settings.loop ? `반복 끄기 (L)\n${repeatSummary}` : "이 문장 반복 듣기 (L)"}
                className={`inline-flex items-center gap-1.5 pl-4 pr-3 transition ${
                  settings.loop ? "hover:bg-accent/10" : "hover:bg-surface-2"
                }`}
              >
                <LoopIcon size={18} />
                {settings.loop ? (
                  <span className="text-sm font-bold tabular-nums">
                    <span className="mr-1 hidden sm:inline">{repeatOrderTag || "반복"}</span>
                    {repeatTag}
                  </span>
                ) : (
                  <span className="text-sm font-semibold">반복</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setRepeatOpen((open) => !open)}
                aria-expanded={repeatOpen}
                aria-controls="repeat-options"
                aria-label="반복 설정"
                title="반복 설정"
                className={`inline-flex w-10 items-center justify-center border-l transition ${
                  settings.loop ? "border-accent/30 hover:bg-accent/10" : "border-line hover:bg-surface-2"
                }`}
              >
                <ChevronDownIcon size={16} className={`transition-transform ${repeatOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
            {speak && (
              <>
                <span aria-hidden="true" className="mx-1 hidden h-7 w-px bg-line sm:block" />
                <IconButton
                  label="힌트: 단어 첫 글자 (H)"
                  onClick={toggleHint}
                  active={hintShown === current && !answerVisible}
                >
                  <HintIcon size={18} />
                  <span className="text-sm font-semibold">힌트</span>
                </IconButton>
                <IconButton
                  label={answerVisible ? "정답 숨기기" : "정답 보기"}
                  onClick={() => setAnswer(current, !answerVisible)}
                  active={answerVisible}
                >
                  {answerVisible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                  <span className="text-sm font-semibold">정답</span>
                </IconButton>
              </>
            )}
            {recordButton}
          </div>

          {repeatOpen && (
            <RepeatPanel
              on={settings.loop}
              onToggle={toggleLoop}
              order={repeatOrder}
              count={settings.repeatCount}
              gap={settings.repeatGap}
              sayTime={settings.repeatSayTime}
              koBlocked={repeatKoBlocked}
              summary={repeatSummary}
              onChange={update}
              onClose={() => setRepeatOpen(false)}
            />
          )}

          {/* Result */}
          {(recording || attemptState || recorder.error) && (
            <div className="mt-4 rounded-xl bg-surface-2 p-4 text-sm">
              {recorder.error ? (
                <p className="font-semibold text-bad">{recorder.error}</p>
              ) : recording ? (
                <p className="text-muted">
                  <span className="font-semibold text-ink">듣고 있어요…</span>{" "}
                  {speak ? "생각한 영어 문장을 말해 보세요. 말을 마치면 자동으로 멈춰요." : "문장을 소리 내어 말하면 자동으로 멈춰요."}
                  {recorder.liveText && (
                    <span className="mt-1 block text-ink" lang="en">
                      {recorder.liveText}
                    </span>
                  )}
                </p>
              ) : (
                <div className="space-y-3">
                  {attempt ? (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className={`text-3xl font-extrabold tabular-nums ${TONE_TEXT[scoreTone(attempt.score)]}`}>
                        {attempt.score}
                        <span className="text-base">{speak ? "%" : "점"}</span>
                      </span>
                      <span className="break-keep text-muted">
                        {speak
                          ? "원문 일치율이에요. 뜻이 같다면 다른 표현도 괜찮아요 — 원어민 문장과 비교해 보세요."
                          : scoreTone(attempt.score) === "great"
                            ? "아주 좋아요! 다음 문장으로 넘어가 볼까요?"
                            : scoreTone(attempt.score) === "good"
                              ? "좋아요. 빨간 단어에 집중해서 한 번 더!"
                              : "원본을 다시 듣고 천천히 따라 해 보세요."}
                      </span>
                    </div>
                  ) : attemptState ? (
                    <p className="text-muted">
                      {!recognitionSupported
                        ? "이 브라우저는 음성 인식을 지원하지 않아 점수를 매길 수 없어요. Chrome·Edge·Safari에서 이용해 주세요."
                        : RECOGNITION_ERRORS[attemptState.recognitionError ?? ""] ??
                          "말소리를 알아듣지 못했어요. 마이크에 조금 더 가까이 말해 보세요."}
                    </p>
                  ) : null}
                  {attemptState?.heard && (
                    <p className="text-muted">
                      {speak ? "내가 말한 문장" : "인식된 문장"}:{" "}
                      <span className="text-ink" lang="en">
                        {attemptState.heard}
                      </span>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {attemptState?.url && (
                      <>
                        <SmallButton onClick={() => playMine(current)}>
                          <HeadphonesIcon size={16} /> 내 녹음 듣기
                        </SmallButton>
                        <SmallButton onClick={() => compare(current)} disabled={!ready}>
                          <CompareIcon size={16} /> 원어민 → 내 녹음
                        </SmallButton>
                      </>
                    )}
                    {!speak && attemptState?.url && (
                      <SmallButton onClick={() => playOnce(current)} disabled={!ready}>
                        <ReplayIcon size={16} /> 원본 다시 듣기
                      </SmallButton>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Settings — collapsed to a one-line summary until opened. */}
        <div className="overflow-hidden rounded-2xl border border-line bg-surface text-sm shadow-sm">
          <button
            type="button"
            onClick={() => update({ settingsOpen: !settings.settingsOpen })}
            aria-expanded={settings.settingsOpen}
            aria-controls="room-settings"
            className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-surface-2"
          >
            <span className="shrink-0 font-semibold">재생 설정</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{settingsSummary}</span>
            <Chevron open={settings.settingsOpen} />
          </button>
          {settings.settingsOpen && (
            <div id="room-settings" className="@container grid gap-5 border-t border-line p-5 sm:grid-cols-2">
              <Field label="재생 속도">
                <Segmented
                  options={RATES.map((r) => ({ value: r, label: `${r}x` }))}
                  value={settings.rate}
                  onChange={(rate) => update({ rate })}
                />
              </Field>
              {!speak && (
                <Field label="재생 방식" hint={waitMode?.hint}>
                  <select
                    value={settings.waitMode}
                    onChange={(e) => {
                      // A repeat run reads the new mode when it gets there; a plain countdown is dropped.
                      if (!engine.current.repeat) clearWait();
                      update({ waitMode: e.target.value as WaitMode });
                    }}
                    className="h-10 w-full rounded-xl border border-line bg-surface px-3 font-medium"
                  >
                    {WAIT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {!speak && (
                <Field label="자막 표시">
                  <div className="flex flex-wrap gap-2">
                    <Toggle checked={settings.showText} onChange={(showText) => update({ showText })}>
                      영어 문장
                    </Toggle>
                    {hasKorean && (
                      <Toggle checked={settings.showKorean} onChange={(showKorean) => update({ showKorean })}>
                        한글 해석
                      </Toggle>
                    )}
                  </div>
                </Field>
              )}
              <Field label="자막 싱크" hint="문장이 소리보다 빠르거나 늦게 끊기면 조절하세요.">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-10 items-stretch overflow-hidden rounded-xl border border-line">
                    <button
                      type="button"
                      onClick={() => update({ offset: Math.round((settings.offset - 0.1) * 10) / 10 })}
                      aria-label="자막 0.1초 앞당기기"
                      className="px-3 font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
                    >
                      −0.1초
                    </button>
                    <span className="flex w-16 items-center justify-center border-x border-line font-semibold tabular-nums">
                      {settings.offset > 0 ? "+" : ""}
                      {settings.offset.toFixed(1)}초
                    </span>
                    <button
                      type="button"
                      onClick={() => update({ offset: Math.round((settings.offset + 0.1) * 10) / 10 })}
                      aria-label="자막 0.1초 늦추기"
                      className="px-3 font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
                    >
                      +0.1초
                    </button>
                  </div>
                  {settings.offset !== 0 && (
                    <button type="button" className="text-muted underline" onClick={() => update({ offset: 0 })}>
                      초기화
                    </button>
                  )}
                </div>
              </Field>
              {/* Phones have no keyboard: no shortcuts there. */}
              <div className="hidden border-t border-line pt-4 sm:col-span-2 sm:block">
                <div className="mb-2.5 text-xs font-semibold text-muted">단축키</div>
                <ul className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4">
                  {shortcuts.map((s) => (
                    <li key={s.label} className="flex items-center gap-2">
                      <span className="flex w-14 shrink-0 gap-1">
                        {s.keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                      <span className="break-keep text-muted">{s.label}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 break-keep text-xs text-muted">
                  영상을 클릭한 뒤에는 영상 바깥을 한 번 클릭하면 단축키가 동작해요.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Sentence list — on desktop it folds into a slim rail on the right so the practice column widens;
          stacked under the video on small screens, it folds upward instead. */}
      <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        {!sentencesOpen && (
          <button
            type="button"
            onClick={() => update({ sentencesOpen: true })}
            aria-expanded={false}
            aria-controls="room-sentences"
            title="문장 목록 펼치기"
            className="hidden w-full flex-col items-center gap-3 rounded-2xl border border-line bg-surface py-4 text-muted shadow-sm transition hover:bg-surface-2 hover:text-ink lg:flex"
          >
            <ChevronDownIcon size={18} className="shrink-0 rotate-90" />
            <span className="font-bold text-ink [writing-mode:vertical-rl]">{filtered ? "북마크한 문장" : "전체 문장"}</span>
            <span className="text-xs tabular-nums [writing-mode:vertical-rl]">
              {practicedCount}/{visibleCount}
            </span>
          </button>
        )}
        <div
          className={`overflow-hidden rounded-2xl border border-line bg-surface shadow-sm ${sentencesOpen ? "" : "lg:hidden"}`}
        >
          <h2>
            <button
              type="button"
              onClick={() => update({ sentencesOpen: !sentencesOpen })}
              aria-expanded={sentencesOpen}
              aria-controls="room-sentences"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-surface-2"
            >
              <span className="font-bold">{editing ? "문장 편집" : filtered ? "북마크한 문장" : "전체 문장"}</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                <span>
                  연습 {practicedCount}/{visibleCount}
                  {average != null && <> · 평균 {average}{speak ? "%" : "점"}</>}
                </span>
                {/* Points up on small screens (folds upward), right on desktop (folds into the rail). */}
                <ChevronDownIcon
                  size={18}
                  className={`shrink-0 transition-transform ${sentencesOpen ? "rotate-180 lg:-rotate-90" : ""}`}
                />
              </span>
            </button>
          </h2>
          {sentencesOpen && (canBookmark || canHide) && (
            <div className="flex items-center gap-1 border-t border-line px-2 pt-2">
              {editing ? (
                <p className="min-w-0 flex-1 break-keep px-1 text-xs text-muted">
                  필요 없는 문장을 누르면 삭제돼요. 다시 누르면 되돌려요.
                  {hidden.size > 0 && <span className="font-semibold text-ink"> {hidden.size}문장 삭제됨</span>}
                </p>
              ) : (
                canBookmark && (
                  <div className="flex gap-1" role="tablist" aria-label="문장 보기">
                    {[
                      { only: false, label: "전체", count: visibleCount },
                      { only: true, label: "북마크", count: markedList.length },
                    ].map((tab) => (
                      <button
                        key={tab.label}
                        type="button"
                        role="tab"
                        aria-selected={filtered === tab.only}
                        onClick={() => showOnlyMarked(tab.only)}
                        disabled={tab.only && tab.count === 0}
                        title={tab.only && tab.count === 0 ? "북마크한 문장이 아직 없어요" : undefined}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition disabled:opacity-40 ${
                          filtered === tab.only ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"
                        }`}
                      >
                        {tab.only && <BookmarkIcon size={13} filled={filtered} />}
                        {tab.label} <span className="tabular-nums">{tab.count}</span>
                      </button>
                    ))}
                  </div>
                )
              )}
              {canHide && (
                <button
                  type="button"
                  onClick={() => setEditing((on) => !on)}
                  aria-pressed={editing}
                  title={editing ? "편집 마치기" : "필요 없는 문장 삭제하기"}
                  className={`ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition ${
                    editing ? "bg-accent text-on-accent hover:bg-accent-strong" : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  {editing ? <CheckIcon size={14} /> : <PencilIcon size={13} />}
                  {editing ? "완료" : "편집"}
                  {!editing && hidden.size > 0 && (
                    <span className="font-normal tabular-nums">· 삭제 {hidden.size}</span>
                  )}
                </button>
              )}
            </div>
          )}
          {sentencesOpen && (
            <ol
              id="room-sentences"
              ref={listRef}
              className={`relative max-h-[55vh] overflow-y-auto p-2 lg:max-h-[calc(100dvh-13rem)] ${
                canBookmark || canHide ? "" : "border-t border-line"
              }`}
            >
              {sentences.map((s, i) => {
                const isHidden = hidden.has(i);
                const isMarked = marked.has(i);
                // "편집" shows every sentence, deleted ones too, so they can be brought back.
                if (!editing && (isHidden || (filtered && !isMarked))) return null;
                const score = modeBest[i];
                const active = i === current;
                const lineKo = koOf(i);
                const englishOpen = !speak || answerShown.has(i);
                const blocked = editing ? hideBlocked(i) : undefined;
                return (
                  <li key={i} data-index={i} className="relative">
                    {canBookmark && !editing && (
                      <button
                        type="button"
                        onClick={() => toggleBookmark(i)}
                        aria-pressed={isMarked}
                        aria-label={`${i + 1}번 문장 ${isMarked ? "북마크 해제" : "북마크"}`}
                        title={isMarked ? "북마크 해제" : "북마크"}
                        className={`absolute right-1 top-1.5 z-10 inline-flex size-8 items-center justify-center rounded-full transition hover:bg-surface hover:opacity-100 ${
                          isMarked ? "text-accent" : `text-muted ${active ? "opacity-70" : "opacity-30"}`
                        }`}
                      >
                        <BookmarkIcon size={16} filled={isMarked} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => (editing ? setHiddenAt(i, !isHidden) : goTo(i))}
                      disabled={editing ? Boolean(blocked) : !ready}
                      aria-pressed={editing ? isHidden : undefined}
                      title={editing ? (blocked ?? (isHidden ? "눌러서 되돌리기" : "눌러서 삭제")) : undefined}
                      className={`flex w-full gap-3 rounded-xl py-2.5 pl-3 text-left text-sm transition disabled:cursor-not-allowed ${
                        canBookmark && !editing ? "pr-10" : "pr-3"
                      } ${active && !isHidden ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                    >
                      <span className={`w-6 shrink-0 pt-0.5 text-xs tabular-nums ${active ? "font-bold text-accent" : "text-muted"}`}>
                        {i + 1}
                      </span>
                      <span className={`min-w-0 flex-1 ${isHidden ? "line-through opacity-45" : ""}`}>
                        {speak ? (
                          <>
                            <span
                              className={`block break-keep leading-snug ${active ? "font-semibold" : ""} ${
                                lineKo && koHiddenAt(i) ? "select-none blur-[3px]" : ""
                              }`}
                            >
                              {lineKo || <span className="text-muted">…</span>}
                            </span>
                            {englishOpen && (
                              <span className="mt-0.5 block text-xs text-muted" lang="en">
                                {s.text}
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <span
                              className={`block leading-snug ${active ? "font-semibold" : ""} ${settings.showText ? "" : "blur-[3px]"}`}
                              lang="en"
                            >
                              {s.text}
                            </span>
                            {hasKorean && settings.showKorean && lineKo && (
                              <span className="mt-0.5 block break-keep text-xs text-muted">{lineKo}</span>
                            )}
                          </>
                        )}
                      </span>
                      {score != null && !isHidden && (
                        <span className={`h-fit shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_BG[scoreTone(score)]}`}>
                          {score}
                        </span>
                      )}
                      {editing &&
                        (isHidden ? (
                          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 text-[11px] font-semibold text-ink">
                            <ReplayIcon size={12} /> 되돌리기
                          </span>
                        ) : (
                          <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted" aria-hidden="true">
                            <TrashIcon size={15} />
                          </span>
                        ))}
                      {editing && <span className="sr-only">{isHidden ? "삭제됨, 눌러서 되돌리기" : "눌러서 삭제"}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------- small pieces -------------------------------- */

function ModeSwitch({
  value,
  onChange,
  disabled: reasons,
}: {
  value: PracticeMode;
  onChange: (mode: PracticeMode) => void;
  /** Why a mode can't be picked, by mode. */
  disabled: Partial<Record<PracticeMode, string>>;
}) {
  return (
    <div
      className="flex w-full max-w-full rounded-xl bg-surface-2 p-1 sm:inline-flex sm:w-auto"
      role="tablist"
      aria-label="연습 방식"
    >
      {MODES.map((m) => {
        const reason = reasons[m.value];
        const disabled = Boolean(reason);
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={value === m.value}
            onClick={() => onChange(m.value)}
            disabled={disabled}
            title={reason}
            className={`min-h-9 flex-1 break-keep rounded-lg px-3 py-1.5 text-sm font-semibold leading-tight transition disabled:opacity-40 sm:flex-initial sm:px-4 ${
              value === m.value ? "bg-raised text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-12 min-w-12 items-center justify-center gap-1.5 rounded-full border px-3.5 transition disabled:opacity-40 ${
        active ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function SmallButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 font-medium transition hover:bg-surface-2 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 font-semibold">{label}</div>
      {children}
      {hint && <p className="mt-2 break-keep text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  /** `disabled`: why the option can't be picked. */
  options: { value: T; label: string; disabled?: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-xl bg-surface-2 p-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={Boolean(o.disabled)}
          title={o.disabled}
          aria-pressed={o.value === value}
          className={`h-9 flex-auto whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition disabled:opacity-40 sm:h-8 ${
            o.value === value ? "bg-raised text-ink shadow-sm" : "text-muted enabled:hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RepeatPanel({
  on,
  onToggle,
  order,
  count,
  gap,
  sayTime,
  koBlocked,
  summary,
  onChange,
  onClose,
}: {
  on: boolean;
  onToggle: () => void;
  order: RepeatOrder;
  count: RepeatCount;
  gap: RepeatGap;
  sayTime: boolean;
  /** Why Korean can't be read aloud here, if it can't. */
  koBlocked?: string;
  summary: string;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const bothLanguages = order === "ko-en" || order === "en-ko";
  return (
    <div id="repeat-options" className="@container mt-4 rounded-xl border border-line p-4 text-sm sm:p-5">
      <div className="flex items-center gap-3">
        <span className="font-semibold">반복 재생</span>
        <Switch checked={on} onChange={onToggle} label="반복 재생" />
        <button
          type="button"
          onClick={onClose}
          aria-label="반복 설정 닫기"
          title="닫기"
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <CloseIcon size={18} />
        </button>
      </div>

      {/* What one sentence will sound like with these settings. */}
      <div className="mt-3 rounded-lg bg-surface-2 px-3.5 py-3">
        {!on && <p className="mb-2 text-xs font-semibold text-muted">반복이 꺼져 있어요. 켜면 이렇게 들려줘요.</p>}
        <div className={on ? "" : "opacity-60"}>
          <RepeatFlow order={order} count={count} gap={gap} sayTime={sayTime} />
        </div>
        <p className="mt-2.5 break-keep text-xs leading-relaxed text-muted">
          {koBlocked && <>{koBlocked}. 영어만 반복해요. </>}
          {summary}
        </p>
      </div>

      <div className="mt-4 grid gap-x-6 gap-y-4 @xl:grid-cols-2">
        <RepeatField label="듣는 순서">
          <Segmented
            label="듣는 순서"
            options={REPEAT_ORDERS.map((o) => ({ ...o, disabled: o.value === "en" ? undefined : koBlocked }))}
            value={order}
            onChange={(repeatOrder) => onChange({ repeatOrder })}
          />
        </RepeatField>
        {bothLanguages && (
          <RepeatField label={order === "ko-en" ? "한국어와 영어 사이" : "영어와 한국어 사이"}>
            <Segmented
              label="사이 간격"
              options={REPEAT_GAPS}
              value={gap}
              onChange={(repeatGap) => onChange({ repeatGap })}
            />
          </RepeatField>
        )}
        <RepeatField label="반복 횟수">
          <Segmented
            label="반복 횟수"
            options={REPEAT_COUNTS}
            value={count}
            onChange={(repeatCount) => onChange({ repeatCount })}
          />
        </RepeatField>
        <RepeatField label="따라 말할 시간">
          <Segmented
            label="따라 말할 시간"
            options={SAY_TIMES}
            value={sayTime ? "on" : "off"}
            onChange={(v) => onChange({ repeatSayTime: v === "on" })}
          />
        </RepeatField>
      </div>
    </div>
  );
}

/**
 * The repeat settings as a picture: [한국어] → 2초 → [영어] → [따라 말하기] × 3 → 다음 문장.
 * Hidden from screen readers: the sentence under it says the same.
 */
function RepeatFlow({
  order,
  count,
  gap,
  sayTime,
}: {
  order: RepeatOrder;
  count: RepeatCount;
  gap: RepeatGap;
  sayTime: boolean;
}) {
  const pause = gap === 0 ? undefined : gap === "fit" ? "문장 길이만큼" : `${gap}초`;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
      {/* The dashed box is one repetition. */}
      <div className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-muted/50 p-1.5">
        {REPEAT_PARTS[order].map((part, k) => (
          <Fragment key={part}>
            {k > 0 && <FlowArrow label={pause} />}
            {part === "ko" ? (
              <FlowStep className="bg-raised text-ink">
                <SpeakerIcon size={13} /> 한국어
              </FlowStep>
            ) : (
              <FlowStep className="bg-accent-soft text-accent">
                <HeadphonesIcon size={13} /> 영어
              </FlowStep>
            )}
          </Fragment>
        ))}
        {sayTime && (
          <>
            <FlowArrow />
            <FlowStep className="border border-dashed border-muted/60 text-muted">
              <MicIcon size={13} /> 따라 말하기
            </FlowStep>
          </>
        )}
      </div>
      <span className="text-sm font-bold tabular-nums">{count === 0 ? "× 계속" : `× ${count}`}</span>
      {count !== 0 && (
        <>
          <FlowArrow />
          <span className="text-xs font-semibold text-muted">다음 문장</span>
        </>
      )}
    </div>
  );
}

function FlowStep({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-bold ${className}`}>{children}</span>
  );
}

function FlowArrow({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
      {label}
      <ArrowRightIcon size={12} />
    </span>
  );
}

function RepeatField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
    </div>
  );
}

/** An on/off switch that says which it is. */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="inline-flex h-9 items-center gap-2 rounded-full pr-1 text-sm font-semibold"
    >
      <span
        className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? "bg-accent" : "bg-line"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : ""}`}
        />
      </span>
      <span className={checked ? "text-accent" : "text-muted"}>{checked ? "켜짐" : "꺼짐"}</span>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-3.5 font-medium transition ${
        checked ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-surface-2"
      }`}
    >
      {checked && <CheckIcon size={14} />}
      {children}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronDownIcon size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink">
      {children}
    </kbd>
  );
}
