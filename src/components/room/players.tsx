"use client";

import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from "react";

/** The minimal player surface the shadowing engine needs. */
export interface PlayerHandle {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
  setRate(rate: number): void;
  isPlaying(): boolean;
  /**
   * Calls `listener` as playback moves on (a few times a second); returns how to stop.
   * Unlike timers, these keep their pace while the page is in the background.
   */
  onProgress?(listener: () => void): () => void;
}

type PlayerProps = {
  ref?: Ref<PlayerHandle>;
  onReady?: () => void;
  onError?: (message: string) => void;
};

/* ---------------------------- YouTube IFrame API --------------------------- */

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  setPlaybackRate(rate: number): void;
  getPlayerState(): number;
  destroy(): void;
  /** Undocumented but long-standing; used to hide YouTube's own captions. */
  unloadModule?(name: string): void;
};

type YTNamespace = {
  Player: new (
    el: HTMLElement,
    options: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });
  return apiPromise;
}

const YT_PLAYING = 1;
const YT_ERRORS: Record<number, string> = {
  2: "영상 ID가 올바르지 않아요.",
  5: "이 브라우저에서 영상을 재생할 수 없어요.",
  100: "삭제되었거나 비공개인 영상이에요.",
  101: "영상 소유자가 다른 사이트에서의 재생을 막아 두었어요.",
  150: "영상 소유자가 다른 사이트에서의 재생을 막아 두었어요.",
};

export function YouTubePlayer({ videoId, ref, onReady, onError }: PlayerProps & { videoId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const handleReady = useEffectEvent(() => onReady?.());
  const handleError = useEffectEvent((code: number) =>
    onError?.(YT_ERRORS[code] ?? `영상을 재생하지 못했어요 (오류 ${code}).`),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let player: YTPlayer | null = null;

    loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      // The API replaces the element it is given with an iframe, so give it a child.
      const mount = document.createElement("div");
      host.appendChild(mount);
      player = new YT.Player(mount, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            playerRef.current = player;
            handleReady();
          },
          onStateChange: (e) => {
            // Sayki shows its own sentence text (and can hide it for listening
            // practice), so switch off YouTube's burned-in captions once playing.
            if (e.data === YT_PLAYING) {
              try {
                player?.unloadModule?.("captions");
              } catch {
                /* not available on this player version */
              }
            }
          },
          onError: (e) => handleError(e.data),
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        /* already gone */
      }
      host.replaceChildren();
    };
  }, [videoId]);

  useImperativeHandle(
    ref,
    () => ({
      play: () => playerRef.current?.playVideo(),
      pause: () => playerRef.current?.pauseVideo(),
      seek: (s) => playerRef.current?.seekTo(Math.max(0, s), true),
      getTime: () => playerRef.current?.getCurrentTime() ?? 0,
      setRate: (r) => playerRef.current?.setPlaybackRate(r),
      isPlaying: () => playerRef.current?.getPlayerState() === YT_PLAYING,
    }),
    [],
  );

  return <div ref={hostRef} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full" />;
}

/* --------------------------- HTML5 <video> / <audio> ------------------------ */

/**
 * `audio`: a slim audio bar instead of a video box (script lessons have no picture).
 * `errorText`: what to say when the file won't play.
 */
export function MediaPlayer({
  src,
  audio,
  errorText,
  ref,
  onReady,
  onError,
}: PlayerProps & { src: string; audio?: boolean; errorText?: string }) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // A callback ref, so one ref serves both <audio> and <video>.
  const attach = (el: HTMLMediaElement | null) => {
    mediaRef.current = el;
  };

  // A cached file can load before React has finished putting the room on the page; the
  // `loadedmetadata` that arrives then restarts that render and its update is lost, which
  // would leave every button disabled. So check once the player is on the page.
  const handleReady = useEffectEvent(() => onReady?.());
  useEffect(() => {
    if ((mediaRef.current?.readyState ?? 0) >= HTMLMediaElement.HAVE_METADATA) handleReady();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        mediaRef.current?.play().catch(() => {});
      },
      pause: () => mediaRef.current?.pause(),
      seek: (s) => {
        if (mediaRef.current) mediaRef.current.currentTime = Math.max(0, s);
      },
      getTime: () => mediaRef.current?.currentTime ?? 0,
      setRate: (r) => {
        if (mediaRef.current) mediaRef.current.playbackRate = r;
      },
      isPlaying: () => {
        const v = mediaRef.current;
        return Boolean(v && !v.paused && !v.ended);
      },
      onProgress: (listener) => {
        const v = mediaRef.current;
        v?.addEventListener("timeupdate", listener);
        return () => v?.removeEventListener("timeupdate", listener);
      },
    }),
    [],
  );

  if (audio) {
    return (
      <audio
        ref={attach}
        src={src}
        controls
        preload="auto"
        className="block h-11 w-full"
        onLoadedMetadata={() => onReady?.()}
        onError={() => onError?.(errorText ?? "음성 파일을 재생하지 못했어요. 페이지를 새로고침해 주세요.")}
      />
    );
  }
  return (
    <video
      ref={attach}
      src={src}
      controls
      playsInline
      preload="auto"
      className="absolute inset-0 h-full w-full bg-black"
      onLoadedMetadata={() => onReady?.()}
      onError={() => onError?.(errorText ?? "영상 파일을 재생하지 못했어요. 링크가 공개된 파일인지 확인해 주세요.")}
    />
  );
}
