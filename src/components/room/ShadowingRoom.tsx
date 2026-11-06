"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CompareIcon,
  EyeIcon,
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
  type Settings,
  type WaitMode,
} from "@/lib/progress";
import { scoreAttempt, scoreTone, type Attempt } from "@/lib/score";
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

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

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

export default function ShadowingRoom({ lesson }: { lesson: Lesson }) {
  const { sentences } = lesson;
  const total = sentences.length;
  const hasKorean = useMemo(() => sentences.some((s) => s.ko), [sentences]);

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
  const [current, setCurrent] = useState(() =>
    Math.min(Math.max(0, loadProgress(lesson.id).last || 0), total - 1),
  );
  const [playing, setPlaying] = useState(false);
  const [wait, setWait] = useState<{ key: number; ms: number } | null>(null);
  const [tries, setTries] = useState<Record<number, Try>>({});
  const [revealed, setRevealed] = useState<number | null>(null);
  const [recognitionSupported] = useState(speechRecognitionSupported);
  const recorder = useRecorder(meterRef);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

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
    const idx = Math.min(Math.max(0, i), total - 1);
    clearWait();
    stopMine();
    const e = engine.current;
    e.mode = !opts.once && settings.waitMode === "continuous" ? "continuous" : "segment";
    e.index = idx;
    e.armed = false;
    e.armDeadline = performance.now() + 1500;
    e.once = Boolean(opts.once);
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

  // Timers outlive the render that created them; route them through a ref
  // so they always call the latest `play`.
  const playLatest = useRef(play);
  useEffect(() => {
    playLatest.current = play;
  });

  const finishSegment = () => {
    const e = engine.current;
    const i = e.index;
    e.mode = "idle";
    e.pausedAt = performance.now();
    const after = e.afterEnd;
    e.afterEnd = null;
    if (after) return after();
    if (e.once || settings.waitMode === "manual" || settings.waitMode === "continuous") return;

    const factor = settings.waitMode === "auto15" ? 1.5 : 1;
    const spoken = (sentences[i].end - sentences[i].start) / settings.rate;
    const ms = Math.max(1200, spoken * factor * 1000);
    const next = settings.loop ? i : i + 1;
    if (next >= total) return;
    setWait({ key: Date.now(), ms });
    e.waitTimer = setTimeout(() => {
      setWait(null);
      playLatest.current(next);
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
      e.mode = settings.waitMode === "continuous" ? "continuous" : "segment";
      e.index = j;
      e.armed = true;
      e.once = false;
      setCurrent(j);
      return;
    }

    if (e.mode === "continuous") {
      if (settings.loop && t >= endOf(e.index) - 0.03) {
        p.seek(startOf(e.index));
        return;
      }
      const j = indexAt(t);
      if (j !== e.index) {
        e.index = j;
        setCurrent(j);
      }
      return;
    }

    const start = startOf(e.index);
    const end = endOf(e.index);
    if (!e.armed) {
      if ((t >= start - 0.6 && t < end - 0.05) || performance.now() > e.armDeadline) e.armed = true;
      else return;
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
    const sentence = sentences[i];
    const result = await recorder.start({
      maxSeconds: Math.min(30, Math.max(5, (sentence.end - sentence.start) * 2.5 + 2)),
    });
    if (!result) return;
    if (result.url) urlsRef.current.push(result.url);

    const attempt = result.transcript ? scoreAttempt(sentence.text, result.transcript) : null;
    setTries((prev) => ({
      ...prev,
      [i]: { attempt, url: result.url, heard: result.transcript, recognitionError: result.recognitionError },
    }));
    if (attempt) {
      setBest((prev) => ((prev[i] ?? -1) >= attempt.score ? prev : { ...prev, [i]: attempt.score }));
      setRevealed(i);
    }
  };

  const compare = (i: number) => {
    const url = tries[i]?.url;
    if (url) play(i, { once: true, afterEnd: () => playUrl(url) });
  };

  const playMine = (i: number) => {
    const url = tries[i]?.url;
    if (!url) return;
    pause();
    playUrl(url);
  };

  /* ------------------------------- side effects ------------------------------ */

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveProgress(lesson.id, { best, last: current }), [lesson.id, best, current]);
  useEffect(() => {
    touchRecent({
      id: lesson.id,
      title: lesson.title,
      thumbnail: lesson.thumbnail,
      sentenceCount: total,
      practiced: Object.keys(best).length,
      at: Date.now(),
    });
  }, [lesson.id, lesson.title, lesson.thumbnail, total, best]);

  useEffect(() => {
    if (ready) playerRef.current?.setRate(settings.rate);
  }, [ready, settings.rate]);

  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!list || !item) return;
    const top = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [current]);

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
        play(current + 1);
        break;
      case "ArrowLeft":
        ev.preventDefault();
        play(current - 1);
        break;
      case "r":
      case "R":
        ev.preventDefault();
        void record();
        break;
      case "l":
      case "L":
        update({ loop: !settings.loop });
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
  const attemptState = tries[current];
  const attempt = attemptState?.attempt ?? null;
  const showEnglish = settings.showText || revealed === current;
  const practicedCount = Object.keys(best).length;
  const average = practicedCount
    ? Math.round(Object.values(best).reduce((a, b) => a + b, 0) / practicedCount)
    : null;
  const recording = recorder.status === "recording" || recorder.status === "starting";
  const busy = recorder.status !== "idle";
  const waitHint = WAIT_MODES.find((m) => m.value === settings.waitMode)?.hint;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="min-w-0 space-y-4">
        {/* Video */}
        {/* Height-capped on desktop so the practice controls stay on screen. */}
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-sm lg:max-h-[max(18rem,calc(100dvh_-_31rem))]">
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
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-muted">
              문장 <span className="text-ink">{current + 1}</span> / {total}
              <span className="ml-2 font-normal tabular-nums">{formatTime(sentence.start)}</span>
            </span>
            {best[current] != null && (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TONE_BG[scoreTone(best[current])]}`}>
                최고 {best[current]}점
              </span>
            )}
          </div>

          <div className="relative">
            <p
              className={`text-[1.35rem] font-semibold leading-relaxed tracking-[-0.01em] sm:text-2xl ${
                showEnglish ? "" : "select-none blur-md"
              }`}
              lang="en"
            >
              {attempt
                ? attempt.marks.map((m, k) => (
                    <span key={k} className={m.ok ? "" : "rounded bg-bad-soft px-0.5 text-bad underline decoration-wavy underline-offset-4"}>
                      {m.text}{" "}
                    </span>
                  ))
                : sentence.text}
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
          {hasKorean && settings.showKorean && sentence.ko && (
            <p className="mt-2 break-keep text-base text-muted">{sentence.ko}</p>
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
            <IconButton label="이전 문장 (←)" onClick={() => play(current - 1)} disabled={!ready || current === 0}>
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
            <IconButton label="다음 문장 (→)" onClick={() => play(current + 1)} disabled={!ready || current >= total - 1}>
              <NextIcon />
            </IconButton>
            <IconButton
              label={settings.loop ? "반복 끄기 (L)" : "이 문장 반복 (L)"}
              onClick={() => update({ loop: !settings.loop })}
              active={settings.loop}
            >
              <LoopIcon />
            </IconButton>

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
                disabled={!ready || recorder.status === "finishing"}
                className={`inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full px-5 font-semibold text-on-accent transition disabled:opacity-40 sm:flex-none ${
                  recording ? "animate-pulse bg-bad" : "bg-accent hover:bg-accent-strong"
                }`}
                aria-label={recording ? "녹음 멈추기 (R)" : "따라 말하고 녹음하기 (R)"}
              >
                {recording ? <StopIcon /> : <MicIcon />}
                {recording ? "멈추기" : recorder.status === "finishing" ? "분석 중…" : "따라 말하기"}
              </button>
            </div>
          </div>

          {/* Result */}
          {(recording || attemptState || recorder.error) && (
            <div className="mt-4 rounded-xl bg-surface-2 p-4 text-sm">
              {recorder.error ? (
                <p className="font-semibold text-bad">{recorder.error}</p>
              ) : recording ? (
                <p className="text-muted">
                  <span className="font-semibold text-ink">듣고 있어요…</span> 문장을 소리 내어 말하면 자동으로 멈춰요.
                  {recorder.liveText && <span className="mt-1 block text-ink" lang="en">{recorder.liveText}</span>}
                </p>
              ) : attemptState ? (
                <div className="space-y-3">
                  {attempt ? (
                    <div className="flex items-baseline gap-3">
                      <span className={`text-3xl font-extrabold tabular-nums ${TONE_TEXT[scoreTone(attempt.score)]}`}>
                        {attempt.score}
                        <span className="text-base">점</span>
                      </span>
                      <span className="text-muted">
                        {scoreTone(attempt.score) === "great"
                          ? "아주 좋아요! 다음 문장으로 넘어가 볼까요?"
                          : scoreTone(attempt.score) === "good"
                            ? "좋아요. 빨간 단어에 집중해서 한 번 더!"
                            : "원본을 다시 듣고 천천히 따라 해 보세요."}
                      </span>
                    </div>
                  ) : (
                    <p className="text-muted">
                      {!recognitionSupported
                        ? "이 브라우저는 음성 인식을 지원하지 않아 점수를 매길 수 없어요. Chrome·Edge·Safari에서 이용해 주세요."
                        : RECOGNITION_ERRORS[attemptState.recognitionError ?? ""] ??
                          "말소리를 알아듣지 못했어요. 마이크에 조금 더 가까이 말해 보세요."}
                    </p>
                  )}
                  {attemptState.heard && (
                    <p className="text-muted">
                      인식된 문장: <span className="text-ink" lang="en">{attemptState.heard}</span>
                    </p>
                  )}
                  {attemptState.url && (
                    <div className="flex flex-wrap gap-2">
                      <SmallButton onClick={() => playMine(current)}>
                        <HeadphonesIcon size={16} /> 내 녹음 듣기
                      </SmallButton>
                      <SmallButton onClick={() => compare(current)} disabled={!ready}>
                        <CompareIcon size={16} /> 원본 → 내 녹음
                      </SmallButton>
                      <SmallButton onClick={() => play(current, { once: true })} disabled={!ready}>
                        <ReplayIcon size={16} /> 원본 다시 듣기
                      </SmallButton>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Settings */}
        <div className="grid gap-4 rounded-2xl border border-line bg-surface p-5 text-sm shadow-sm sm:grid-cols-2">
          <Field label="재생 속도">
            <Segmented
              options={RATES.map((r) => ({ value: r, label: `${r}x` }))}
              value={settings.rate}
              onChange={(rate) => update({ rate })}
            />
          </Field>
          <Field label="재생 방식" hint={waitHint}>
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
            단축키: <Kbd>Space</Kbd> 듣기/멈춤 · <Kbd>←</Kbd> <Kbd>→</Kbd> 이전/다음 · <Kbd>R</Kbd> 녹음 · <Kbd>L</Kbd> 반복
            <span className="block sm:inline sm:ml-1">(영상을 클릭한 뒤에는 영상 바깥을 한 번 클릭하면 단축키가 동작해요)</span>
          </p>
        </div>
      </section>

      {/* Sentence list */}
      <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-bold">전체 문장</h2>
            <span className="text-xs text-muted">
              연습 {practicedCount}/{total}
              {average != null && <> · 평균 {average}점</>}
            </span>
          </div>
          <ol ref={listRef} className="relative max-h-[55vh] overflow-y-auto p-2 lg:max-h-[calc(100dvh-10rem)]">
            {sentences.map((s, i) => {
              const score = best[i];
              const active = i === current;
              return (
                <li key={i} data-index={i}>
                  <button
                    type="button"
                    onClick={() => play(i)}
                    disabled={!ready}
                    className={`flex w-full gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                      active ? "bg-accent-soft" : "hover:bg-surface-2"
                    }`}
                  >
                    <span className={`w-6 shrink-0 pt-0.5 text-xs tabular-nums ${active ? "font-bold text-accent" : "text-muted"}`}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block leading-snug ${active ? "font-semibold" : ""} ${settings.showText ? "" : "blur-[3px]"}`} lang="en">
                        {s.text}
                      </span>
                      {hasKorean && settings.showKorean && s.ko && (
                        <span className="mt-0.5 block break-keep text-xs text-muted">{s.ko}</span>
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
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------- small pieces -------------------------------- */

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
      className={`inline-flex h-12 w-12 items-center justify-center rounded-full border transition disabled:opacity-40 ${
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

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-ink">
      {children}
    </kbd>
  );
}
