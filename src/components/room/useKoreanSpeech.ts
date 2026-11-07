"use client";

import { useEffect, useRef, useState } from "react";

const LANG = "ko-KR";
/** No `start` this long after speak(): the browser dropped it (e.g. iOS without a tap). */
const START_TIMEOUT_MS = 4000;
/** How long to let the engine settle after cancel() before the next speak(). */
const SETTLE_MS = 80;

const isKorean = (v: SpeechSynthesisVoice) => /^ko\b/i.test(v.lang.replace("_", "-"));

/**
 * Only network voices are picked by hand (Chrome's "Google 한국의", Edge's online voices):
 * they sound best and are always there. Otherwise the OS picks its own Korean voice from
 * `lang` — choosing from the list on phones can land on a voice that isn't downloaded
 * and plays nothing.
 */
const pickVoice = (voices: SpeechSynthesisVoice[]) =>
  voices.find((v) => isKorean(v) && !v.localService && /google|online/i.test(v.name)) ?? null;

export type SpeechError = "blocked" | "unavailable" | "busy" | "failed";

type Done = (ok: boolean) => void;

/** Reads Korean text aloud with the browser's own speech synthesis. */
export function useKoreanSpeech() {
  const [supported] = useState(() => typeof speechSynthesis !== "undefined");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<SpeechError | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  /** Held so the utterance isn't garbage-collected mid-sentence (Chrome then never fires `end`). */
  const currentRef = useRef<SpeechSynthesisUtterance | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The silent unlock utterance is still queued — cancelling now can swallow the next speak(). */
  const unlockingRef = useRef(false);
  /** We cancelled a moment ago: speak() straight after cancel() is sometimes dropped. */
  const settlingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!supported) return;
    const synth = speechSynthesis;
    const load = () => {
      voiceRef.current = pickVoice(synth.getVoices());
    };
    load();
    synth.addEventListener("voiceschanged", load);

    // iOS only lets a page speak after it has spoken once inside a tap. Speak nothing on the
    // first tap anywhere, so later reads (next sentence, translation arriving) can be heard.
    const unlock = () => {
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("click", unlock, true);
      if (synth.speaking || synth.pending) return;
      const silent = new SpeechSynthesisUtterance("");
      silent.volume = 0;
      const done = () => {
        unlockingRef.current = false;
      };
      silent.onend = done;
      silent.onerror = done;
      unlockingRef.current = true;
      synth.speak(silent);
      setTimeout(done, 1000);
    };
    window.addEventListener("touchend", unlock, true);
    window.addEventListener("click", unlock, true);

    return () => {
      synth.removeEventListener("voiceschanged", load);
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("click", unlock, true);
      clearTimeout(watchdogRef.current);
      currentRef.current = null;
      synth.cancel();
    };
  }, [supported]);

  const finish = (utterance: SpeechSynthesisUtterance, err: SpeechError | null, onDone?: Done) => {
    if (currentRef.current !== utterance) return;
    clearTimeout(watchdogRef.current);
    currentRef.current = null;
    setSpeaking(false);
    if (err) setError(err);
    onDone?.(err === null);
  };

  const say = (text: string, voice: SpeechSynthesisVoice | null, onDone?: Done) => {
    const synth = speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = LANG;
    if (voice) utterance.voice = voice;

    let started = false;
    utterance.onstart = () => {
      started = true;
      clearTimeout(watchdogRef.current);
      // Some engines never fire `end` (Chrome drops it on long utterances), which would
      // stall whatever waits on it: finish anyway once the speech is long overdue.
      const startedAt = Date.now();
      const expected = Math.max(8000, text.length * 300 + 5000);
      const check = () => {
        if (currentRef.current !== utterance) return;
        if (synth.speaking && Date.now() - startedAt < expected * 2) {
          watchdogRef.current = setTimeout(check, 1000);
          return;
        }
        finish(utterance, null, onDone);
        if (synth.speaking) synth.cancel();
      };
      watchdogRef.current = setTimeout(check, expected);
    };
    utterance.onend = () => finish(utterance, null, onDone);
    utterance.onerror = (e) => {
      if (currentRef.current !== utterance) return;
      if (e.error === "interrupted" || e.error === "canceled") return finish(utterance, null, onDone);
      // A hand-picked voice can fail where the OS default for Korean works.
      if (voice) return say(text, null, onDone);
      finish(
        utterance,
        e.error === "not-allowed"
          ? "blocked"
          : e.error === "language-unavailable" || e.error === "voice-unavailable"
            ? "unavailable"
            : e.error === "audio-busy"
              ? "busy"
              : "failed",
        onDone,
      );
    };

    // Something of ours is still playing: cancel it, and give the engine a moment before
    // the next one (speak() right after cancel() is sometimes dropped).
    const interrupt = currentRef.current !== null && !unlockingRef.current;
    if (interrupt) cancel();
    const settle = settlingRef.current;
    currentRef.current = utterance;
    setSpeaking(true);
    setError(null);

    const go = () => {
      if (currentRef.current !== utterance) return;
      synth.speak(utterance);
      clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        if (started || currentRef.current !== utterance || synth.speaking) return;
        synth.cancel();
        finish(utterance, "blocked", onDone);
      }, START_TIMEOUT_MS);
    };
    if (settle) setTimeout(go, SETTLE_MS);
    else go();
  };

  const cancel = () => {
    speechSynthesis.cancel();
    settlingRef.current = true;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settlingRef.current = false;
    }, SETTLE_MS);
  };

  /**
   * Reads `text` aloud. `onDone` hears whether it was read to the end (`false` on an error);
   * it isn't called when the reading is stopped or replaced by another one.
   */
  const speak = (text: string, onDone?: Done) => {
    if (supported && text) say(text, voiceRef.current, onDone);
    else onDone?.(false);
  };

  const stop = () => {
    if (!currentRef.current) return;
    clearTimeout(watchdogRef.current);
    currentRef.current = null;
    setSpeaking(false);
    cancel();
  };

  return { supported, speaking, error, speak, stop };
}
