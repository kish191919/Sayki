"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/* Web Speech API — not in TypeScript's DOM lib, so declare the bits we use. */
type RecognitionResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return typeof window !== "undefined" && getRecognitionCtor() !== null;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

export type RecorderStatus = "idle" | "starting" | "recording" | "finishing";

export type RecordingResult = {
  /** Object URL of the recording (caller revokes it). */
  url: string | null;
  /** What speech recognition heard; empty if nothing / unsupported. */
  transcript: string;
  recognitionError: string | null;
};

type Session = {
  recorder: MediaRecorder;
  chunks: Blob[];
  recognition: Recognition | null;
  recognitionDone: boolean;
  recorderDone: boolean;
  finalText: string;
  interimText: string;
  recognitionError: string | null;
  audioContext: AudioContext | null;
  raf: number;
  maxTimer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  stopping: boolean;
  settled: boolean;
  resolve: (r: RecordingResult) => void;
};

/** Volume (RMS) above which we consider the learner to be speaking. */
const SPEECH_RMS = 0.02;
/** Default: stop after this much silence once the learner has started speaking. */
const TRAILING_SILENCE_MS = 1300;
/** Default: stop if the learner never starts speaking. */
const NO_SPEECH_MS = 6000;

export type StartOptions = {
  maxSeconds: number;
  /** Silence that ends the recording after speech (longer when composing a sentence). */
  trailingSilenceMs?: number;
  /** How long to wait for the learner to start speaking. */
  noSpeechMs?: number;
};

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "마이크 권한이 필요해요. 주소창의 사이트 설정에서 마이크를 허용해 주세요.",
  NotFoundError: "마이크를 찾을 수 없어요. 마이크가 연결되어 있는지 확인해 주세요.",
  NotReadableError: "다른 앱이 마이크를 사용 중이에요.",
};

/**
 * Records the learner (MediaRecorder) while running browser speech
 * recognition, and stops automatically when they finish speaking.
 * `meterRef` gets a `--level` CSS variable (0–1) for a volume meter.
 */
export function useRecorder(meterRef: RefObject<HTMLElement | null>) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const settle = useCallback((s: Session) => {
    if (s.settled || !s.recorderDone || !s.recognitionDone) return;
    s.settled = true;
    clearTimeout(s.graceTimer);
    const blob = s.chunks.length ? new Blob(s.chunks, { type: s.recorder.mimeType || "audio/webm" }) : null;
    sessionRef.current = null;
    setStatus("idle");
    s.resolve({
      url: blob ? URL.createObjectURL(blob) : null,
      transcript: (s.finalText || s.interimText).trim(),
      recognitionError: s.recognitionError,
    });
  }, []);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.stopping) return;
    s.stopping = true;
    setStatus("finishing");
    clearTimeout(s.maxTimer);
    cancelAnimationFrame(s.raf);
    s.audioContext?.close().catch(() => {});
    meterRef.current?.style.setProperty("--level", "0");
    if (s.recorder.state !== "inactive") s.recorder.stop();
    else s.recorderDone = true;
    if (s.recognition) {
      try {
        s.recognition.stop();
      } catch {
        s.recognitionDone = true;
      }
      // Some browsers never fire `end`; don't wait forever for final results.
      s.graceTimer = setTimeout(() => {
        s.recognitionDone = true;
        settle(s);
      }, 2000);
    }
    settle(s);
  }, [meterRef, settle]);

  const start = useCallback(
    async ({ maxSeconds, trailingSilenceMs = TRAILING_SILENCE_MS, noSpeechMs = NO_SPEECH_MS }: StartOptions): Promise<RecordingResult | null> => {
      if (sessionRef.current) return null;
      setError(null);
      setLiveText("");
      setStatus("starting");

      let stream = streamRef.current;
      try {
        if (!stream || !stream.active) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          streamRef.current = stream;
        }
      } catch (e) {
        setStatus("idle");
        setError(MIC_ERRORS[(e as DOMException).name] ?? "마이크를 사용할 수 없어요.");
        return null;
      }
      const micStream = stream;

      return new Promise<RecordingResult>((resolve) => {
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
        const s: Session = {
          recorder,
          chunks: [],
          recognition: null,
          recognitionDone: true,
          recorderDone: false,
          finalText: "",
          interimText: "",
          recognitionError: null,
          audioContext: null,
          raf: 0,
          maxTimer: undefined,
          graceTimer: undefined,
          stopping: false,
          settled: false,
          resolve,
        };
        sessionRef.current = s;

        recorder.ondataavailable = (e) => {
          if (e.data.size) s.chunks.push(e.data);
        };
        recorder.onstop = () => {
          s.recorderDone = true;
          settle(s);
        };
        recorder.start();

        const Ctor = getRecognitionCtor();
        if (Ctor) {
          const r = new Ctor();
          r.lang = "en-US";
          r.continuous = true;
          r.interimResults = true;
          r.maxAlternatives = 1;
          r.onresult = (e) => {
            let fin = "";
            let interim = "";
            for (let i = 0; i < e.results.length; i++) {
              const res = e.results[i];
              if (res.isFinal) fin += `${res[0].transcript} `;
              else interim += `${res[0].transcript} `;
            }
            s.finalText = fin.trim();
            s.interimText = `${fin}${interim}`.trim();
            setLiveText(s.interimText);
          };
          r.onerror = (e) => {
            if (e.error !== "no-speech" && e.error !== "aborted") s.recognitionError = e.error;
          };
          r.onend = () => {
            s.recognitionDone = true;
            if (s.stopping) settle(s);
          };
          try {
            r.start();
            s.recognition = r;
            s.recognitionDone = false;
          } catch {
            s.recognitionError = "start-failed";
          }
        }

        // Volume meter + automatic stop on trailing silence.
        try {
          const ctx = new AudioContext();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaStreamSource(micStream).connect(analyser);
          s.audioContext = ctx;
          const buf = new Float32Array(analyser.fftSize);
          const startedAt = performance.now();
          let spoke = false;
          let silentSince = 0;
          const tick = () => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            meterRef.current?.style.setProperty("--level", Math.min(1, rms * 10).toFixed(3));
            const now = performance.now();
            if (rms > SPEECH_RMS) {
              spoke = true;
              silentSince = 0;
            } else if (spoke) {
              if (!silentSince) silentSince = now;
              else if (now - silentSince > trailingSilenceMs) return stop();
            }
            if (!spoke && now - startedAt > noSpeechMs) return stop();
            s.raf = requestAnimationFrame(tick);
          };
          s.raf = requestAnimationFrame(tick);
        } catch {
          /* no analyser — rely on the manual stop and the max timer */
        }

        s.maxTimer = setTimeout(stop, maxSeconds * 1000);
        setStatus("recording");
      });
    },
    [meterRef, settle, stop],
  );

  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) {
        clearTimeout(s.maxTimer);
        clearTimeout(s.graceTimer);
        cancelAnimationFrame(s.raf);
        s.recognition?.abort();
        if (s.recorder.state !== "inactive") s.recorder.stop();
        s.audioContext?.close().catch(() => {});
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return { status, liveText, error, start, stop };
}
