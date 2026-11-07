"use client";

import { useEffect, useEffectEvent, useRef } from "react";

/*
 * Practice with the screen off (e.g. the home-screen app on a locked phone).
 *
 * A phone keeps a web page running in the background only while it plays a sound. The room
 * pauses the audio between sounds — the countdown to speak, the pause between the two
 * languages of a repetition, the Korean read by the browser's own voice — and in that
 * silence the page is put to sleep, so the next sentence never starts. A silent sound
 * bridges those gaps.
 */

/** A silent WAV (8 kHz, 8-bit mono, ten seconds; it loops), made once per page. */
let silenceUrl: string | null = null;
function silence() {
  if (silenceUrl) return silenceUrl;
  const rate = 8000;
  const length = rate * 10;
  const wav = new DataView(new ArrayBuffer(44 + length));
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  wav.setUint32(4, 36 + length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  wav.setUint32(16, 16, true); // fmt chunk size
  wav.setUint16(20, 1, true); // PCM
  wav.setUint16(22, 1, true); // mono
  wav.setUint32(24, rate, true); // samples per second
  wav.setUint32(28, rate, true); // bytes per second
  wav.setUint16(32, 1, true); // bytes per sample
  wav.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  wav.setUint32(40, length, true);
  new Uint8Array(wav.buffer, 44).fill(128); // 8-bit PCM is unsigned: 128 is silence
  silenceUrl = URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
  return silenceUrl;
}

/** After the browser refused to start the silence, don't ask again for this long. */
const RETRY_MS = 1000;

/**
 * A silent sound for the gaps between the room's sounds, so a phone with its screen off
 * doesn't put the page to sleep. Returns `hold(on)`: keep it going (true) or stop it (false).
 * Calling it again with the same value does nothing, so it can run on every tick.
 */
export function useKeepAlive(enabled: boolean) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantedRef = useRef(false);
  const refusedAtRef = useRef(-Infinity);

  useEffect(() => {
    if (!enabled) return;
    const audio = new Audio(silence());
    audio.loop = true;
    audioRef.current = audio;

    // A phone lets a page start a sound on its own only once that sound has been started
    // inside a tap: start (and at once stop) it on the first tap anywhere.
    const unlock = () => {
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("click", unlock, true);
      if (!audio.paused) return;
      audio.play().then(
        () => {
          if (!wantedRef.current) audio.pause();
        },
        () => {},
      );
    };
    window.addEventListener("touchend", unlock, true);
    window.addEventListener("click", unlock, true);

    return () => {
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("click", unlock, true);
      audio.pause();
      audioRef.current = null;
    };
  }, [enabled]);

  return (on: boolean) => {
    wantedRef.current = on;
    const audio = audioRef.current;
    if (!audio) return;
    if (!on) {
      if (!audio.paused) audio.pause();
      return;
    }
    if (!audio.paused || performance.now() - refusedAtRef.current < RETRY_MS) return;
    audio.play().catch((e: Error) => {
      // Stopping it again before it started isn't a refusal.
      if (e.name === "NotAllowedError") refusedAtRef.current = performance.now();
    });
  };
}

type SessionActions = { play(): void; pause(): void; previous(): void; next(): void };

type NowPlaying = { title: string; artist: string; artwork: string | null };

const APP_ICON: MediaImage = { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" };

/**
 * The lock screen's (and headphones') player: what is playing, and play / pause / previous /
 * next — which move sentence by sentence instead of skipping seconds.
 */
export function useMediaSession(enabled: boolean, nowPlaying: NowPlaying, playing: boolean, actions: SessionActions) {
  const act = useEffectEvent((name: keyof SessionActions) => actions[name]());

  useEffect(() => {
    if (!enabled || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, keyof SessionActions][] = [
      ["play", "play"],
      ["pause", "pause"],
      ["stop", "pause"],
      ["previoustrack", "previous"],
      ["nexttrack", "next"],
    ];
    for (const [action, name] of handlers) {
      try {
        session.setActionHandler(action, () => act(name));
      } catch {
        /* this browser doesn't offer that button */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* never set */
        }
      }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [enabled]);

  const { title, artist, artwork } = nowPlaying;
  useEffect(() => {
    if (!enabled || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: "Sayki",
      artwork: artwork ? [{ src: artwork }, APP_ICON] : [APP_ICON],
    });
  }, [enabled, title, artist, artwork]);

  useEffect(() => {
    if (!enabled || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [enabled, playing]);
}
