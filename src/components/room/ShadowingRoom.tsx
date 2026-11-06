"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  CompareIcon,
  EyeIcon,
  EyeOffIcon,
  HeadphonesIcon,
  LoopIcon,
  MicIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  ReplayIcon,
  StopIcon,
} from "@/components/icons";
import {
  loadProgress,
  loadSettings,
  saveProgress,
  saveSettings,
  touchRecent,
  type PracticeMode,
  type Settings,
  type WaitMode,
} from "@/lib/progress";
import { scoreAttempt, scoreTone, type Attempt } from "@/lib/score";
import { pendingAiLines } from "@/lib/translation-state";
import type { Lesson } from "@/lib/types";
import { MediaPlayer, YouTubePlayer, type PlayerHandle } from "./players";
import { speechRecognitionSupported, useRecorder } from "./useRecorder";

type Try = {
  attempt: Attempt | null;
  url: string | null;
  heard: string;
  recognitionError: string | null;
};

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
  /** When we last paused programmatically (the player reports state late). */
  pausedAt: number;
};

type TranslateState = { status: "idle" | "working" | "error"; message?: string };

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

const MODES: { value: PracticeMode; label: string }[] = [
  { value: "shadow", label: "듣고 따라 말하기" },
  { value: "speak", label: "한국어 보고 영어로 말하기" },
];

const WAIT_MODES: { value: WaitMode; label: string; hint: string }[] = [
  { value: "manual", label: "문장마다 멈춤", hint: "한 문장을 듣고 멈춰요. 따라 말한 뒤 직접 넘어가요." },
  { value: "auto1", label: "자동 넘김", hint: "문장 길이만큼 기다렸다가 다음 문장을 재생해요." },
  { value: "auto15", label: "자동 넘김 (여유)", hint: "문장 길이의 1.5배만큼 기다려요." },
  { value: "continuous", label: "이어서 재생", hint: "멈추지 않고 영상처럼 이어서 들어요." },
];

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

export default function ShadowingRoom({ lesson, canTranslate }: { lesson: Lesson; canTranslate: boolean }) {
  const { sentences } = lesson;
  const total = sentences.length;
  const needsTranslation = canTranslate && pendingAiLines(lesson).length > 0;

  const playerRef = useRef<PlayerHandle>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
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
    pausedAt: 0,
  });

  const [ready, setReady] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [best, setBest] = useState<Record<number, number>>(() => loadProgress(lesson.id).best);
  const [bestSpeak, setBestSpeak] = useState<Record<number, number>>(() => loadProgress(lesson.id).bestSpeak);
  const [current, setCurrent] = useState(() =>
    Math.min(Math.max(0, loadProgress(lesson.id).last || 0), total - 1),
  );
  const [playing, setPlaying] = useState(false);
  const [wait, setWait] = useState<{ key: number; ms: number } | null>(null);
  const [tries, setTries] = useState<Record<string, Try>>({});
  const [revealed, setRevealed] = useState<number | null>(null);
  /** Sentences whose English answer is open this session (Korean → English mode). */
  const [answerShown, setAnswerShown] = useState<ReadonlySet<number>>(() => new Set());
  const [hintShown, setHintShown] = useState<number | null>(null);
  const [koAi, setKoAi] = useState<string[] | null>(null);
  const [translate, setTranslate] = useState<TranslateState>({ status: needsTranslation ? "working" : "idle" });
  const [recognitionSupported] = useState(speechRecognitionSupported);
  const recorder = useRecorder(meterRef);

  const speak = settings.mode === "speak";
  /** Korean → English mode always goes sentence by sentence, whatever the wait mode says. */
  const continuousPlay = !speak && settings.waitMode === "continuous";
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const koOf = (i: number) => koAi?.[i] || sentences[i].ko || "";
  const hasKorean = koAi ? koAi.some(Boolean) : sentences.some((s) => s.ko);
  const tryKey = (i: number) => `${settings.mode}:${i}`;

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
    setWait(null);
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

  const play = (i: number, opts: { once?: boolean; afterEnd?: () => void } = {}) => {
    const p = playerRef.current;
    if (!p || !ready || recorder.status !== "idle") return;
    const idx = clamp(i);
    clearWait();
    stopMine();
    const e = engine.current;
    e.once = Boolean(opts.once);
    e.mode = !e.once && continuousPlay ? "continuous" : "segment";
    e.index = idx;
    e.armed = false;
    e.armDeadline = performance.now() + 1500;
    e.afterEnd = opts.afterEnd ?? null;
    setCurrent(idx);
    p.seek(startOf(idx));
    p.play();
  };

  const pause = () => {
    clearWait();
    const e = engine.current;
    e.mode = "idle";
    e.afterEnd = null;
    e.pausedAt = performance.now();
    playerRef.current?.pause();
  };

  /** Moves to a sentence. In Korean → English mode it must not play (that would reveal the answer). */
  const goTo = (i: number) => {
    if (!speak) return play(i);
    if (recorder.status !== "idle") return;
    pause();
    stopMine();
    setCurrent(clamp(i));
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
    update({ mode });
  };

  /** "이 문장 반복": switching it on starts the current sentence right away. */
  const toggleLoop = () => {
    const loop = !settings.loop;
    update({ loop });
    if (loop && !playing && !wait) play(current);
    else if (!loop && (speak || settings.waitMode === "manual")) clearWait();
  };

  // Timers outlive the render that created them; route them through a ref
  // so they act on the latest settings (e.g. loop switched off mid-countdown).
  const afterWaitLatest = useRef<((i: number) => void) | null>(null);
  useEffect(() => {
    afterWaitLatest.current = (i) => {
      if (settings.loop) play(i);
      // Never run on to the next sentence in Korean → English mode: its audio is the answer.
      else if (!speak && settings.waitMode !== "manual" && i + 1 < total) play(i + 1);
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
    if (e.once || continuousPlay) return;
    // "문장마다 멈춤" stops here, and so does Korean → English mode (each sentence's audio
    // is its answer) — unless looping, which replays after a pause to speak in.
    if (!settings.loop && (speak || settings.waitMode === "manual" || i + 1 >= total)) return;

    const factor = !speak && settings.waitMode === "auto15" ? 1.5 : 1;
    const spoken = (sentences[i].end - sentences[i].start) / settings.rate;
    const ms = Math.max(1200, spoken * factor * 1000);
    setWait({ key: Date.now(), ms });
    e.waitTimer = setTimeout(() => {
      setWait(null);
      afterWaitLatest.current?.(i);
    }, ms);
  };

  const onTick = useEffectEvent(() => {
    const p = playerRef.current;
    if (!p) return;
    const isPlaying = p.isPlaying();
    setPlaying(isPlaying);
    if (!isPlaying) return;

    const t = p.getTime();
    const e = engine.current;

    if (e.mode === "idle") {
      if (performance.now() - e.pausedAt < 600) return;
      // Playback was started from the video's own controls: follow along.
      let j = indexAt(t);
      if (t >= endOf(j) - 0.1 && j < total - 1) j += 1;
      clearWait();
      e.once = false;
      e.mode = continuousPlay ? "continuous" : "segment";
      e.index = j;
      e.armed = true;
      setCurrent(j);
      return;
    }

    const start = startOf(e.index);
    const end = endOf(e.index);
    if (!e.armed) {
      if ((t >= start - 0.6 && t < end - 0.05) || performance.now() > e.armDeadline) e.armed = true;
      else return;
    }

    if (e.mode === "continuous") {
      // Looping holds this sentence — the next one often starts right where it
      // ends, so following `indexAt` would drift onward — unless the learner scrubbed away.
      if (settings.loop && t > start - 1.5 && t < end + 1.5) {
        if (t >= end - 0.03) p.seek(start);
        return;
      }
      const j = indexAt(t);
      if (j !== e.index) {
        e.index = j;
        setCurrent(j);
      }
      return;
    }

    if (t < start - 1.5 || t > end + 1.5) {
      // The learner scrubbed the timeline.
      const j = indexAt(t);
      e.index = j;
      setCurrent(j);
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
    return () => clearInterval(id);
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
    const i = current;
    const mode = settings.mode;
    const sentence = sentences[i];
    const length = sentence.end - sentence.start;
    const result = await recorder.start(
      mode === "speak"
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
    if (mode === "speak") setAnswer(i, true);
    if (!attempt) return;
    const setter = mode === "speak" ? setBestSpeak : setBest;
    setter((prev) => ((prev[i] ?? -1) >= attempt.score ? prev : { ...prev, [i]: attempt.score }));
    if (mode !== "speak") setRevealed(i);
  };

  const compare = (i: number) => {
    const url = tries[tryKey(i)]?.url;
    if (url) play(i, { once: true, afterEnd: () => playUrl(url) });
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
  }, [current, sentencesOpen]);

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
        if (playing) pause();
        else play(current);
        break;
      case "ArrowRight":
        ev.preventDefault();
        goTo(current + 1);
        break;
      case "ArrowLeft":
        ev.preventDefault();
        goTo(current - 1);
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
      case "h":
      case "H":
        if (speak) toggleHint();
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
  const practicedCount = Object.keys(modeBest).length;
  const average = practicedCount
    ? Math.round(Object.values(modeBest).reduce((a, b) => a + b, 0) / practicedCount)
    : null;
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

  const englishLine = attempt
    ? attempt.marks.map((m, k) => (
        <span key={k} className={m.ok ? "" : "rounded bg-bad-soft px-0.5 text-bad underline decoration-wavy underline-offset-4"}>
          {m.text}{" "}
        </span>
      ))
    : sentence.text;

  const recordButton = (
    <div className="flex w-full flex-row-reverse items-center gap-3 sm:ml-auto sm:w-auto sm:flex-row">
      <div
        ref={meterRef}
        className={`h-2 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2 ${recording ? "" : "invisible"}`}
        aria-hidden="true"
      >
        <div className="h-full w-[calc(var(--level,0)*100%)] rounded-full bg-accent transition-[width] duration-75" />
      </div>
      <button
        type="button"
        onClick={() => void record()}
        disabled={!ready || recorder.status === "finishing" || (speak && !ko)}
        className={`inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full px-5 font-semibold text-on-accent transition disabled:opacity-40 sm:flex-none ${
          recording ? "animate-pulse bg-bad" : "bg-accent hover:bg-accent-strong"
        }`}
        aria-label={recording ? "녹음 멈추기 (R)" : speak ? "영어로 말하기 (R)" : "따라 말하고 녹음하기 (R)"}
      >
        {recording ? <StopIcon /> : <MicIcon />}
        {recording ? "멈추기" : recorder.status === "finishing" ? "분석 중…" : speak ? "영어로 말하기" : "따라 말하기"}
      </button>
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="min-w-0 space-y-4">
        {/* Video — height-capped on desktop so the practice controls stay on screen. */}
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
              src={lesson.source.url}
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

        {/* Current sentence */}
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {/* Mode switch sits with the controls so it stays on screen while practising. */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-muted">
                문장 <span className="text-ink">{current + 1}</span> / {total}
                <span className="ml-2 font-normal tabular-nums">{formatTime(sentence.start)}</span>
              </span>
              {modeBest[current] != null && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TONE_BG[scoreTone(modeBest[current])]}`}>
                  {speak ? `최고 일치율 ${modeBest[current]}%` : `최고 ${modeBest[current]}점`}
                </span>
              )}
            </div>
            <ModeSwitch value={settings.mode} onChange={switchMode} speakDisabled={speakUnavailable} />
          </div>
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
              <p className="text-xs font-semibold text-accent">이 뜻을 영어로 말해 보세요</p>
              {ko ? (
                <p className="mt-1 break-keep text-[1.35rem] font-semibold leading-relaxed sm:text-2xl">{ko}</p>
              ) : (
                <p className="mt-1 text-muted">
                  {translate.status === "working" ? "한글 해석을 준비하고 있어요…" : "이 문장은 한글 해석이 없어요."}
                </p>
              )}
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
            </>
          )}

          {wait && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold text-accent">지금 따라 말해 보세요</div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  key={wait.key}
                  className="h-full origin-left animate-countdown rounded-full bg-accent"
                  style={{ animationDuration: `${wait.ms}ms` }}
                />
              </div>
            </div>
          )}

          {/* Transport */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <IconButton label="이전 문장 (←)" onClick={() => goTo(current - 1)} disabled={!ready || current === 0}>
              <PrevIcon />
            </IconButton>
            <button
              type="button"
              onClick={() => (playing ? pause() : play(current))}
              disabled={!ready || busy}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-semibold text-bg transition hover:opacity-90 disabled:opacity-40"
              aria-label={playing ? "일시정지 (Space)" : "문장 듣기 (Space)"}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
              {playing ? "일시정지" : "듣기"}
            </button>
            <IconButton label="다음 문장 (→)" onClick={() => goTo(current + 1)} disabled={!ready || current >= total - 1}>
              <NextIcon />
            </IconButton>
            <IconButton
              label={settings.loop ? "반복 끄기 (L)" : "이 문장 반복 듣기 (L)"}
              onClick={toggleLoop}
              active={settings.loop}
            >
              <LoopIcon />
            </IconButton>
            {speak && (
              <>
                <IconButton
                  label="힌트: 단어 첫 글자 (H)"
                  onClick={toggleHint}
                  active={hintShown === current && !answerVisible}
                >
                  <span className="text-sm font-bold">힌트</span>
                </IconButton>
                <IconButton
                  label={answerVisible ? "정답 숨기기" : "정답 보기"}
                  onClick={() => setAnswer(current, !answerVisible)}
                  active={answerVisible}
                >
                  {answerVisible ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              </>
            )}
            {recordButton}
          </div>

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
                      <SmallButton onClick={() => play(current, { once: true })} disabled={!ready}>
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
            <div id="room-settings" className="grid gap-4 border-t border-line p-5 sm:grid-cols-2">
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
                      clearWait();
                      update({ waitMode: e.target.value as WaitMode });
                    }}
                    className="h-9 w-full rounded-lg border border-line bg-surface px-2 font-medium"
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
                <div className="flex items-center gap-2">
                  <SmallButton onClick={() => update({ offset: Math.round((settings.offset - 0.1) * 10) / 10 })}>
                    −0.1초
                  </SmallButton>
                  <span className="w-14 text-center font-semibold tabular-nums">
                    {settings.offset > 0 ? "+" : ""}
                    {settings.offset.toFixed(1)}초
                  </span>
                  <SmallButton onClick={() => update({ offset: Math.round((settings.offset + 0.1) * 10) / 10 })}>
                    +0.1초
                  </SmallButton>
                  {settings.offset !== 0 && (
                    <button type="button" className="text-muted underline" onClick={() => update({ offset: 0 })}>
                      초기화
                    </button>
                  )}
                </div>
              </Field>
              <p className="text-xs text-muted sm:col-span-2">
                {speak ? (
                  <>
                    단축키: <Kbd>R</Kbd> 영어로 말하기 · <Kbd>H</Kbd> 힌트 · <Kbd>Space</Kbd> 듣기/멈춤 ·<Kbd>←</Kbd>{" "}
                    <Kbd>→</Kbd> 이전/다음 · <Kbd>L</Kbd> 반복
                  </>
                ) : (
                  <>
                    단축키: <Kbd>Space</Kbd> 듣기/멈춤 · <Kbd>←</Kbd> <Kbd>→</Kbd> 이전/다음 · <Kbd>R</Kbd> 녹음 · <Kbd>L</Kbd> 반복
                  </>
                )}
                <span className="block sm:ml-1 sm:inline">(영상을 클릭한 뒤에는 영상 바깥을 한 번 클릭하면 단축키가 동작해요)</span>
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Sentence list */}
      <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <h2>
            <button
              type="button"
              onClick={() => update({ sentencesOpen: !sentencesOpen })}
              aria-expanded={sentencesOpen}
              aria-controls="room-sentences"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-surface-2"
            >
              <span className="font-bold">전체 문장</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                <span>
                  연습 {practicedCount}/{total}
                  {average != null && <> · 평균 {average}{speak ? "%" : "점"}</>}
                </span>
                <Chevron open={sentencesOpen} />
              </span>
            </button>
          </h2>
          {sentencesOpen && (
            <ol
              id="room-sentences"
              ref={listRef}
              className="relative max-h-[55vh] overflow-y-auto border-t border-line p-2 lg:max-h-[calc(100dvh-13rem)]"
            >
              {sentences.map((s, i) => {
                const score = modeBest[i];
                const active = i === current;
                const lineKo = koOf(i);
                const englishOpen = !speak || answerShown.has(i);
                return (
                  <li key={i} data-index={i}>
                    <button
                      type="button"
                      onClick={() => goTo(i)}
                      disabled={!ready}
                      className={`flex w-full gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                        active ? "bg-accent-soft" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className={`w-6 shrink-0 pt-0.5 text-xs tabular-nums ${active ? "font-bold text-accent" : "text-muted"}`}>
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        {speak ? (
                          <>
                            <span className={`block break-keep leading-snug ${active ? "font-semibold" : ""}`}>
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
                      {score != null && (
                        <span className={`h-fit shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TONE_BG[scoreTone(score)]}`}>
                          {score}
                        </span>
                      )}
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
  speakDisabled,
}: {
  value: PracticeMode;
  onChange: (mode: PracticeMode) => void;
  speakDisabled: boolean;
}) {
  return (
    <div className="flex w-full rounded-xl bg-surface-2 p-1 sm:inline-flex sm:w-auto" role="tablist" aria-label="연습 방식">
      {MODES.map((m) => {
        const disabled = m.value === "speak" && speakDisabled;
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={value === m.value}
            onClick={() => onChange(m.value)}
            disabled={disabled}
            title={disabled ? "한글 해석이 없는 영상이에요" : undefined}
            className={`min-h-9 flex-1 break-keep rounded-lg px-3 py-1.5 text-sm font-semibold leading-tight transition disabled:opacity-40 sm:flex-none sm:px-4 ${
              value === m.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
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
      className={`inline-flex h-12 min-w-12 items-center justify-center rounded-full border px-3 transition disabled:opacity-40 ${
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
      <div className="mb-1.5 font-semibold">{label}</div>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`h-7 rounded-md px-2.5 text-xs font-semibold transition ${
            o.value === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
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
      className={`h-9 rounded-lg border px-3 font-medium transition ${
        checked ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-surface-2"
      }`}
    >
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
