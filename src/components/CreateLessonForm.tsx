"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { CloseIcon, FileIcon, LinkIcon, VideoIcon } from "@/components/icons";
import {
  extractSpeech,
  probeMedia,
  tooLongForCaptions,
  UploadError,
  uploadToBlob,
  type MediaProbe,
} from "@/lib/media-client";
import { MAX_SPEECH_SEC, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, mediaTypeOf, type UploadMode } from "@/lib/upload-shared";

const EXAMPLES = [
  { label: "TED · 미루는 습관", url: "https://www.youtube.com/watch?v=arj7oStGLkU" },
  { label: "TED · 학교와 창의력", url: "https://www.youtube.com/watch?v=iG9CE55wbtY" },
  { label: "스탠퍼드 졸업 연설", url: "https://www.youtube.com/watch?v=UF8uR6Z6KLc" },
];

const NEEDS_FILE = new Set(["NO_CAPTIONS", "NEED_SUBTITLE", "YOUTUBE_BLOCKED", "YOUTUBE_RATE_LIMIT", "TOO_LONG", "MEDIA_TOO_LARGE", "NO_SENTENCES"]);
const SUBTITLE_RE = /\.(srt|vtt)$/i;
const MEDIA_ACCEPT = "video/*,audio/*,.mp4,.m4v,.mov,.webm,.mp3,.m4a,.aac,.wav";

/** An uploaded file being turned into a lesson. Progress values are 0–1; null: that step isn't needed. */
type Job = {
  file: File;
  stage: "probe" | "work" | "create";
  upload: number | null;
  speech: number | null;
  withSubtitle: boolean;
};

/** What a file's earlier attempt already did, so trying again doesn't redo it. */
type Done = { file: File; probe?: MediaProbe; blobUrl?: string; speech?: Blob | null };

type Props = {
  /** Where uploaded files go (from the server's env). */
  upload: UploadMode;
  /** Whether the server can make captions (Whisper); otherwise uploads need a subtitle file. */
  transcribe: boolean;
};

export default function CreateLessonForm({ upload, transcribe }: Props) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const doneRef = useRef<Done | null>(null);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [showFile, setShowFile] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [failed, setFailed] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  /** A pasted Instagram/TikTok… link: point at the upload button. */
  const [nudge, setNudge] = useState(false);
  const busy = pending || job !== null;

  const create = async (link: string) => {
    const value = link.trim();
    if (!value || busy) return;
    setPending(true);
    setError(null);

    const body = new FormData();
    body.append("url", value);
    if (file) body.append("subtitle", file);

    try {
      const res = await fetch("/api/lessons", { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; code?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? "레슨을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
        if (data.code && NEEDS_FILE.has(data.code)) setShowFile(true);
        setPending(false);
        setNudge(data.code === "NEEDS_UPLOAD");
        return;
      }
      router.push(`/lesson/${data.id}`);
    } catch {
      setError("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
      setPending(false);
    }
  };

  /** Uploads a video/audio file and makes a lesson of it. */
  const createFromFile = async (media: File) => {
    if (busy) return;
    setError(null);
    setNudge(false);
    const type = mediaTypeOf(media.name, media.type);
    if (!type) {
      setError("영상(MP4·MOV)이나 오디오(MP3·M4A) 파일을 골라 주세요.");
      return;
    }
    if (media.size > MAX_UPLOAD_BYTES) {
      setError(`${MAX_UPLOAD_MB}MB 이하 파일만 올릴 수 있어요.`);
      return;
    }
    if (upload === "off") {
      setError("영상 저장소가 아직 연결되지 않았어요. (관리자: Vercel 프로젝트에 Private Blob 저장소를 연결해 주세요.)");
      return;
    }
    const subtitle = file;
    if (!subtitle && !transcribe) {
      setError("이 서버는 자동 자막을 만들 수 없어요. 영어 자막 파일(.srt, .vtt)을 먼저 골라 주세요.");
      setShowFile(true);
      return;
    }

    const done: Done = doneRef.current?.file === media ? doneRef.current : { file: media };
    doneRef.current = done;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const update = (patch: Partial<Job>) => setJob((j) => (j ? { ...j, ...patch } : j));
    setFailed(null);
    setJob({ file: media, stage: "probe", upload: null, speech: null, withSubtitle: Boolean(subtitle) });

    try {
      done.probe ??= await probeMedia(media);
      if (signal.aborted) throw signal.reason;
      if (!subtitle && done.probe.durationSec && done.probe.durationSec > MAX_SPEECH_SEC) throw tooLongForCaptions();

      const blobMode = upload === "blob-token" || upload === "blob-presigned" ? upload : null;
      const needUpload = blobMode !== null && done.blobUrl === undefined;
      const needSpeech = !subtitle && done.speech === undefined;
      update({ stage: "work", upload: needUpload ? 0 : null, speech: needSpeech ? 0 : null });

      // The upload waits on the network and the speech on the CPU: do both at once.
      await Promise.all([
        needUpload &&
          uploadToBlob(media, type, blobMode, (r) => update({ upload: r }), signal).then((u) => {
            done.blobUrl = u;
          }),
        needSpeech &&
          extractSpeech(media, (r) => update({ speech: r }), signal).then((s) => {
            done.speech = s;
          }),
      ]);

      update({ stage: "create" });
      const body = new FormData();
      body.append("media", blobMode ? done.blobUrl! : media);
      body.append("name", media.name);
      if (done.probe.durationSec) body.append("duration", String(done.probe.durationSec));
      if (subtitle) body.append("subtitle", subtitle);
      else if (done.speech) body.append("speech", done.speech, "speech.mp3");
      if (done.probe.thumbnail) body.append("thumbnail", done.probe.thumbnail, "thumbnail.jpg");

      const res = await fetch("/api/lessons/file", { method: "POST", body, signal });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; code?: string };
      if (!res.ok || !data.id) {
        throw new UploadError(data.error ?? "레슨을 만들지 못했어요. 잠시 후 다시 시도해 주세요.", data.code);
      }
      doneRef.current = null;
      router.push(`/lesson/${data.id}`);
    } catch (e) {
      const cancelled = signal.aborted && signal.reason === "cancel";
      controller.abort(); // stop the other half (upload or speech)
      setJob(null);
      if (cancelled) return;
      if (e instanceof UploadError) {
        setError(e.message);
        if (e.code && NEEDS_FILE.has(e.code)) setShowFile(true);
      } else {
        console.error(e);
        setError("레슨을 만들지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.");
      }
      setFailed(media);
    }
  };

  const cancel = () => abortRef.current?.abort("cancel");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create(url);
  };

  const clearUrl = () => {
    setUrl("");
    setError(null);
    urlInput.current?.focus();
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (!dropped || busy) return;
    if (SUBTITLE_RE.test(dropped.name)) {
      setFile(dropped);
      setShowFile(true);
    } else {
      void createFromFile(dropped);
    }
  };

  return (
    <div className="w-full">
      <form
        onSubmit={onSubmit}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={`rounded-2xl border bg-surface p-2 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.18)] transition ${
          dragging ? "border-accent ring-2 ring-accent" : "border-line"
        }`}
      >
        {job ? (
          <UploadStatus job={job} onCancel={cancel} />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3">
              <LinkIcon className="shrink-0 text-muted" />
              <span className="sr-only">영상 링크</span>
              <input
                ref={urlInput}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && url) {
                    e.preventDefault();
                    clearUrl();
                  }
                }}
                placeholder="유튜브 링크를 붙여 넣으세요"
                className="h-12 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted"
                disabled={pending}
              />
              {url && !pending && (
                <button
                  type="button"
                  onClick={clearUrl}
                  aria-label="링크 지우기"
                  title="링크 지우기 (Esc)"
                  className="-mr-1 grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink"
                >
                  <CloseIcon size={16} />
                </button>
              )}
            </label>
            <button
              type="submit"
              disabled={pending || !url.trim()}
              className="h-12 shrink-0 rounded-xl bg-accent px-6 font-bold text-on-accent transition hover:bg-accent-strong disabled:opacity-50"
            >
              {pending ? "자막 불러오는 중…" : "레슨 만들기"}
            </button>
          </div>
        )}

        {!job && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 pb-1 pt-3 text-sm">
            <button
              type="button"
              disabled={pending}
              onClick={() => mediaInput.current?.click()}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 font-medium transition hover:bg-surface-2 disabled:opacity-50 ${
                nudge ? "border-accent text-accent ring-2 ring-accent-soft" : "border-line"
              }`}
            >
              <VideoIcon size={16} /> 영상 파일 올리기
            </button>
            {failed && (
              <button
                type="button"
                title={failed.name}
                onClick={() => void createFromFile(failed)}
                className="font-semibold text-accent underline-offset-4 hover:underline"
              >
                다시 시도
              </button>
            )}
            <span className="w-full min-w-0 break-keep text-muted sm:w-auto sm:flex-1">
              인스타그램·틱톡 영상은 기기에 저장한 뒤 올려 주세요
            </span>
            <input
              ref={mediaInput}
              type="file"
              accept={MEDIA_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = ""; // picking the same file again still fires
                if (picked) void createFromFile(picked);
              }}
            />
          </div>
        )}

        {showFile && (
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line px-3 pb-1 pt-3 text-sm">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              <FileIcon size={16} /> 자막 파일 선택
            </button>
            <span className="min-w-0 truncate text-muted">
              {file ? file.name : ".srt 또는 .vtt 영어 자막 (2MB 이하)"}
            </span>
            {file && !busy && (
              <button type="button" className="text-muted underline" onClick={() => setFile(null)}>
                빼기
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        )}
      </form>

      {error && (
        <p role="alert" className="mt-3 break-keep text-sm font-semibold text-bad">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">이걸로 시작해 보세요</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.url}
            type="button"
            disabled={busy}
            onClick={() => {
              setUrl(ex.url);
              void create(ex.url);
            }}
            className="rounded-full border border-line bg-surface px-3 py-1.5 font-medium transition hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {ex.label}
          </button>
        ))}
        {!showFile && (
          <button type="button" className="ml-auto text-muted underline-offset-4 hover:underline" onClick={() => setShowFile(true)}>
            자막 파일 직접 올리기
          </button>
        )}
      </div>
    </div>
  );
}

function UploadStatus({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const working = job.stage === "work" && (job.upload !== null || job.speech !== null);
  const message =
    job.stage === "probe"
      ? "영상 확인 중…"
      : job.withSubtitle
        ? "레슨 만드는 중…"
        : "AI가 자막을 만드는 중… 1분쯤 걸려요";

  return (
    <div className="flex items-start gap-3 px-2 py-2" role="status" aria-live="polite">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <VideoIcon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{job.file.name}</p>
        {working ? (
          <div className="mt-2 space-y-2">
            {job.upload !== null && <Progress label="영상 올리기" ratio={job.upload} />}
            {job.speech !== null && <Progress label="자막용 소리 뽑기" ratio={job.speech} />}
          </div>
        ) : (
          <>
            <p className="mt-0.5 text-sm text-muted">{message}</p>
            <div className="mt-2 h-1.5 animate-pulse rounded-full bg-accent-soft" />
          </>
        )}
      </div>
      {job.stage !== "create" && (
        <button
          type="button"
          onClick={onCancel}
          className="h-9 shrink-0 rounded-lg border border-line px-3 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          취소
        </button>
      )}
    </div>
  );
}

function Progress({ label, ratio }: { label: string; ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <div>
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(3, pct)}%` }} />
      </div>
    </div>
  );
}
