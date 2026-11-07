"use client";

import { useEffect, useRef, useState } from "react";

const isKorean = (v: SpeechSynthesisVoice) => /^ko\b/i.test(v.lang.replace("_", "-"));

/** Prefer the natural-sounding voices (Chrome's Google voice, Apple's enhanced ones). */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ko = voices.filter(isKorean);
  return (
    ko.find((v) => /google|premium|enhanced|natural|neural/i.test(v.name)) ??
    ko.find((v) => v.default) ??
    ko[0] ??
    null
  );
}

/**
 * Reads Korean text aloud with the browser's own speech synthesis.
 * `voice` is undefined while the voice list loads, null when the device has no Korean voice.
 */
export function useKoreanSpeech() {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null | undefined>(() =>
    typeof speechSynthesis === "undefined" ? null : undefined,
  );
  const [speaking, setSpeaking] = useState(false);
  /** Held so the utterance isn't garbage-collected mid-sentence (Chrome then never fires `end`). */
  const currentRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const synth = speechSynthesis;
    const load = () => {
      const voices = synth.getVoices();
      if (voices.length) setVoice(pickVoice(voices));
    };
    load();
    synth.addEventListener("voiceschanged", load);
    // Browsers with no voices at all may never fire `voiceschanged`.
    const giveUp = setTimeout(() => setVoice((v) => (v === undefined ? pickVoice(synth.getVoices()) : v)), 3000);
    return () => {
      synth.removeEventListener("voiceschanged", load);
      clearTimeout(giveUp);
      currentRef.current = null;
      synth.cancel();
    };
  }, []);

  const speak = (text: string) => {
    if (!voice || !text) return;
    const synth = speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const done = () => {
      if (currentRef.current !== utterance) return;
      currentRef.current = null;
      setSpeaking(false);
    };
    utterance.onend = done;
    utterance.onerror = done;
    currentRef.current = utterance;
    setSpeaking(true);
    synth.speak(utterance);
  };

  const stop = () => {
    if (!currentRef.current) return;
    currentRef.current = null;
    setSpeaking(false);
    speechSynthesis.cancel();
  };

  return { voice, speaking, speak, stop };
}
