"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { CloseIcon, FileIcon, LinkIcon } from "@/components/icons";

const EXAMPLES = [
  { label: "TED · 미루는 습관", url: "https://www.youtube.com/watch?v=arj7oStGLkU" },
  { label: "TED · 학교와 창의력", url: "https://www.youtube.com/watch?v=iG9CE55wbtY" },
  { label: "스탠퍼드 졸업 연설", url: "https://www.youtube.com/watch?v=UF8uR6Z6KLc" },
];

const NEEDS_FILE = new Set(["NO_CAPTIONS", "NEED_SUBTITLE", "YOUTUBE_BLOCKED", "YOUTUBE_RATE_LIMIT"]);

export default function CreateLessonForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [showFile, setShowFile] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (link: string) => {
    const value = link.trim();
    if (!value || pending) return;
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
        return;
      }
      router.push(`/lesson/${data.id}`);
    } catch {
      setError("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
      setPending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create(url);
  };

  const clearUrl = () => {
    setUrl("");
    setError(null);
    urlInput.current?.focus();
  };

  return (
    <div className="w-full">
      <form onSubmit={onSubmit} className="rounded-2xl border border-line bg-surface p-2 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.18)]">
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

        {showFile && (
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line px-3 pb-1 pt-3 text-sm">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 font-medium hover:bg-surface-2"
            >
              <FileIcon size={16} /> 자막 파일 선택
            </button>
            <span className="min-w-0 truncate text-muted">
              {file ? file.name : ".srt 또는 .vtt 영어 자막 (2MB 이하)"}
            </span>
            {file && (
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
            disabled={pending}
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
