"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CameraIcon, CloseIcon, ImageIcon, PlusIcon, SparkIcon, TrashIcon } from "@/components/icons";
import ConfirmDialog from "@/components/library/ConfirmDialog";
import MoreInfo from "@/components/script/MoreInfo";
import type { ScriptDraft } from "@/lib/types";

/**
 * Teaching script maker: material (photos and/or notes) → Claude writes a
 * draft → the learner reviews and edits it → English audio is made and it
 * opens as a lesson in the practice room.
 */

const MAX_PHOTOS = 5;
/** Photos are shrunk before upload: enough to read a textbook page, small enough for the request limit. */
const MAX_EDGE = 1800;
const JPEG_QUALITY = 0.8;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const DRAFT_KEY = "sayki:script-draft";

type Photo = { id: number; blob: Blob; url: string };
type Line = { id: number; en: string; ko: string };
type Review = { title: string; lines: Line[]; notes: string[] };

let lastId = 0;
const newId = () => ++lastId;

/** The draft being reviewed survives a reload (this browser only); photos don't. */
function loadReview(): Review | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { title?: unknown; lines?: unknown; notes?: unknown };
    if (typeof v.title !== "string" || !Array.isArray(v.lines)) return null;
    const lines = (v.lines as { en?: unknown; ko?: unknown }[])
      .filter((l) => typeof l?.en === "string")
      .map((l) => ({ id: newId(), en: l.en as string, ko: typeof l.ko === "string" ? l.ko : "" }));
    if (lines.length === 0) return null;
    const notes = Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string") : [];
    return { title: v.title, lines, notes };
  } catch {
    return null;
  }
}

function storeReview(review: Review | null) {
  try {
    if (!review) window.localStorage.removeItem(DRAFT_KEY);
    else {
      const { title, lines, notes } = review;
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, lines: lines.map(({ en, ko }) => ({ en, ko })), notes }));
    }
  } catch {
    /* storage unavailable: the draft just isn't kept */
  }
}

/** Downscales a photo to a JPEG (also turns PNG transparency white and applies EXIF rotation). */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    let source: ImageBitmap | HTMLImageElement;
    let width: number;
    let height: number;
    try {
      source = await createImageBitmap(file);
      ({ width, height } = source);
    } catch {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if ("close" in source) source.close();
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}분 ${s}초` : `${s}초`;
}

async function readError(res: Response, fallback: string) {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? fallback;
}

export default function ScriptMaker() {
  const router = useRouter();
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  /** Preview URLs still alive, revoked when the page goes away. */
  const previewUrls = useRef(new Set<string>());

  const [review, setReview] = useState<Review | null>(loadReview);
  const [step, setStep] = useState<"input" | "review">(() => (review ? "review" : "input"));
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [text, setText] = useState("");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<null | "photos" | "writing" | "creating">(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The draft was changed by hand since Claude wrote it. */
  const [edited, setEdited] = useState(false);
  const [confirm, setConfirm] = useState<null | "rewrite" | "discard">(null);
  /** A line just added, to focus. */
  const [focusId, setFocusId] = useState<number | null>(null);

  useEffect(() => {
    const urls = previewUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  useEffect(() => {
    if (busy !== "writing" && busy !== "creating") return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const hasMaterial = photos.length > 0 || text.trim().length > 0;

  /* --------------------------------- material -------------------------------- */

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photos.length;
    const picked = [...files].slice(0, Math.max(0, room));
    setError(files.length > room ? `사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요.` : null);
    if (picked.length === 0) return;
    setBusy("photos");
    const added: Photo[] = [];
    for (const file of picked) {
      try {
        const blob = await shrink(file);
        const url = URL.createObjectURL(blob);
        previewUrls.current.add(url);
        added.push({ id: newId(), blob, url });
      } catch {
        setError("읽을 수 없는 사진이 있어요. JPG나 PNG 사진으로 다시 올려 주세요.");
      }
    }
    setPhotos((p) => [...p, ...added].slice(0, MAX_PHOTOS));
    setBusy(null);
  };

  const removePhoto = (id: number) => {
    const photo = photos.find((p) => p.id === id);
    if (photo) {
      URL.revokeObjectURL(photo.url);
      previewUrls.current.delete(photo.url);
    }
    setPhotos((p) => p.filter((x) => x.id !== id));
  };

  const write = async () => {
    setConfirm(null);
    if (!hasMaterial) {
      setError("사진을 올리거나 내용을 적어 주세요.");
      return;
    }
    if (photos.reduce((n, p) => n + p.blob.size, 0) > MAX_UPLOAD_BYTES) {
      setError("사진 용량이 너무 커요. 장수를 줄여 주세요.");
      return;
    }
    const body = new FormData();
    photos.forEach((p, i) => body.append("photo", p.blob, `photo-${i + 1}.jpg`));
    body.append("text", text.trim());
    body.append("request", ask.trim());

    setBusy("writing");
    setElapsed(0);
    setError(null);
    try {
      const res = await fetch("/api/scripts/draft", { method: "POST", body });
      if (!res.ok) {
        setError(await readError(res, "스크립트를 쓰지 못했어요. 잠시 후 다시 시도해 주세요."));
        return;
      }
      const draft = (await res.json()) as ScriptDraft;
      const next: Review = {
        title: [draft.title, draft.titleKo].filter(Boolean).join(" · "),
        lines: draft.lines.map((l) => ({ id: newId(), en: l.en, ko: l.ko })),
        notes: draft.notes,
      };
      setReview(next);
      storeReview(next);
      setEdited(false);
      setStep("review");
      window.scrollTo({ top: 0 });
    } catch {
      setError("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------- review --------------------------------- */

  const change = (next: Review) => {
    setReview(next);
    storeReview(next);
    setEdited(true);
  };
  const editLine = (id: number, patch: Partial<Omit<Line, "id">>) =>
    review && change({ ...review, lines: review.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const removeLine = (id: number) => review && change({ ...review, lines: review.lines.filter((l) => l.id !== id) });
  const addLineAfter = (id: number | null) => {
    if (!review) return;
    const line = { id: newId(), en: "", ko: "" };
    const at = id === null ? review.lines.length : review.lines.findIndex((l) => l.id === id) + 1;
    change({ ...review, lines: [...review.lines.slice(0, at), line, ...review.lines.slice(at)] });
    setFocusId(line.id);
  };

  const discard = () => {
    setConfirm(null);
    setReview(null);
    storeReview(null);
    setEdited(false);
    setError(null);
    setStep("input");
  };

  const create = async () => {
    if (!review) return;
    const lines = review.lines.map((l) => ({ en: l.en.trim(), ko: l.ko.trim() })).filter((l) => l.en);
    if (!review.title.trim()) {
      setError("제목을 입력해 주세요.");
      return;
    }
    if (lines.length === 0) {
      setError("연습할 문장이 없어요.");
      return;
    }
    setBusy("creating");
    setElapsed(0);
    setError(null);
    try {
      const res = await fetch("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: review.title.trim(), lines }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error ?? "음성을 만들지 못했어요. 잠시 후 다시 시도해 주세요.");
        setBusy(null);
        return;
      }
      storeReview(null);
      router.push(`/lesson/${data.id}`);
    } catch {
      setError("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
      setBusy(null);
    }
  };

  const errorBox = error && (
    <p role="alert" className="break-keep text-sm font-semibold text-bad">
      {error}
    </p>
  );

  /* ---------------------------------- render --------------------------------- */

  if (step === "review" && review) {
    const lines = review.lines;
    const words = lines.reduce((n, l) => n + wordCount(l.en), 0);
    // About 145 words a minute, plus the pauses between sentences.
    const estimate = Math.round(words / 2.4 + lines.length * 0.6);
    const working = busy === "creating";

    return (
      <div className="space-y-5">
        {review.notes.length > 0 && (
          <div className="rounded-2xl border border-warn/30 bg-warn-soft p-4 text-sm">
            <p className="font-bold text-warn">연습하기 전에 확인해 주세요</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 break-keep text-ink">
              {review.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5">
          <label className="block text-sm font-semibold text-muted" htmlFor="script-title">
            제목
          </label>
          <input
            id="script-title"
            value={review.title}
            onChange={(e) => change({ ...review, title: e.target.value })}
            maxLength={120}
            disabled={working}
            className="mt-1.5 h-11 w-full rounded-xl border border-line bg-bg px-3 font-semibold outline-none focus:border-accent"
          />
          <p className="mt-3 text-xs font-semibold text-muted">
            {lines.length}문장 · {words}단어 · 예상 길이 약 {formatDuration(estimate)}
          </p>
        </div>

        <ol className="space-y-2.5">
          {lines.map((l, i) => (
            <li key={l.id} className="rounded-2xl border border-line bg-surface p-3 shadow-sm sm:p-4">
              <div className="flex items-start gap-3">
                <span className="mt-2 w-6 shrink-0 text-right text-xs font-bold tabular-nums text-muted">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <textarea
                    aria-label={`${i + 1}번 문장 영어`}
                    value={l.en}
                    onChange={(e) => editLine(l.id, { en: e.target.value })}
                    rows={1}
                    autoFocus={l.id === focusId}
                    disabled={working}
                    placeholder="영어 문장"
                    className="block w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 font-semibold leading-snug outline-none [field-sizing:content] hover:border-line focus:border-accent focus:bg-bg"
                  />
                  <textarea
                    aria-label={`${i + 1}번 문장 한국어`}
                    value={l.ko}
                    onChange={(e) => editLine(l.id, { ko: e.target.value })}
                    rows={1}
                    disabled={working}
                    placeholder="한국어 해석 (비워 두면 자동 번역)"
                    className="block w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm leading-snug text-muted outline-none [field-sizing:content] hover:border-line focus:border-accent focus:bg-bg focus:text-ink"
                  />
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => removeLine(l.id)}
                    disabled={working}
                    aria-label={`${i + 1}번 문장 삭제`}
                    title="문장 삭제"
                    className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-bad-soft hover:text-bad disabled:opacity-40"
                  >
                    <TrashIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => addLineAfter(l.id)}
                    disabled={working}
                    aria-label={`${i + 1}번 문장 아래에 문장 추가`}
                    title="아래에 문장 추가"
                    className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                  >
                    <PlusIcon size={16} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {lines.length === 0 && (
          <button
            type="button"
            onClick={() => addLineAfter(null)}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2"
          >
            <PlusIcon size={16} /> 문장 추가
          </button>
        )}

        <div className="sticky bottom-3 z-10 space-y-3 rounded-2xl border border-line bg-surface/95 p-3 shadow-lg backdrop-blur sm:p-4">
          {errorBox}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep("input");
                }}
                disabled={working}
                className="h-11 flex-1 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2 disabled:opacity-40 sm:flex-none"
              >
                {hasMaterial ? "자료 고쳐서 다시 쓰기" : "새 자료로 쓰기"}
              </button>
              {hasMaterial && (
                <button
                  type="button"
                  onClick={() => (edited ? setConfirm("rewrite") : void write())}
                  disabled={working || busy === "writing"}
                  className="h-11 flex-1 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2 disabled:opacity-40 sm:flex-none"
                >
                  {busy === "writing" ? `다시 쓰는 중… ${elapsed}초` : "다시 쓰기"}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy !== null || lines.length === 0}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 font-bold text-on-accent transition hover:bg-accent-strong disabled:opacity-50 sm:ml-auto"
            >
              {working ? (
                `영어 음성 만드는 중… ${elapsed}초`
              ) : (
                <>
                  음성 만들고 연습하기 <ArrowRightIcon size={18} />
                </>
              )}
            </button>
          </div>
          {working && (
            <p className="break-keep text-xs text-muted">
              문장마다 영어 음성을 만들어 하나의 파일로 잇고 있어요. 보통 30초 안팎 걸려요.
            </p>
          )}
        </div>

        <ConfirmDialog
          open={confirm === "rewrite"}
          title="스크립트를 다시 쓸까요?"
          confirmLabel="다시 쓰기"
          onConfirm={() => void write()}
          onClose={() => setConfirm(null)}
        >
          직접 고친 내용은 사라지고 같은 자료로 새 스크립트를 써요.
        </ConfirmDialog>
      </div>
    );
  }

  const writing = busy === "writing";
  return (
    <div className="space-y-5">
      {review && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setStep("review");
          }}
          className="text-sm font-semibold text-muted underline-offset-4 hover:text-accent hover:underline"
        >
          ← 쓰던 스크립트로 돌아가기
        </button>
      )}

      <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold">교재 사진</h2>
          <span className="text-xs font-semibold tabular-nums text-muted">
            {photos.length}/{MAX_PHOTOS}장
          </span>
        </div>
        <MoreInfo label="사진 올리는 방법" className="mt-1">
          <p className="break-keep text-sm text-muted">설명할 페이지를 찍거나 골라 주세요. 여러 장이면 순서대로 올려 주세요.</p>
        </MoreInfo>

        {photos.length > 0 && (
          <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {photos.map((p, i) => (
              <li key={p.id} className="relative aspect-[3/4] overflow-hidden rounded-xl border border-line bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL) */}
                <img src={p.url} alt={`${i + 1}번째 사진`} className="h-full w-full object-cover" />
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 text-[11px] font-bold text-white">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removePhoto(p.id)}
                  disabled={writing}
                  aria-label={`${i + 1}번째 사진 빼기`}
                  className="absolute right-1 top-1 grid size-7 place-items-center rounded-full bg-black/65 text-white transition hover:bg-black/80"
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => cameraInput.current?.click()}
            disabled={writing || busy === "photos" || photos.length >= MAX_PHOTOS}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-sm font-semibold transition hover:bg-surface-2 disabled:opacity-40"
          >
            <CameraIcon size={16} /> 사진 찍기
          </button>
          <button
            type="button"
            onClick={() => libraryInput.current?.click()}
            disabled={writing || busy === "photos" || photos.length >= MAX_PHOTOS}
            className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-sm font-semibold transition hover:bg-surface-2 disabled:opacity-40"
          >
            <ImageIcon size={16} /> 사진 고르기
          </button>
          {busy === "photos" && <span className="self-center text-sm text-muted">사진 준비 중…</span>}
        </div>
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void addPhotos(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={libraryInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addPhotos(e.target.files);
            e.target.value = "";
          }}
        />
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-5">
        <label htmlFor="script-text" className="font-bold">
          내용 직접 적기 <span className="text-sm font-normal text-muted">(선택)</span>
        </label>
        <textarea
          id="script-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          rows={5}
          disabled={writing}
          placeholder="교재 내용이나 수업 메모를 붙여 넣거나 적어 주세요. 사진과 함께 써도 돼요."
          className="mt-2 block w-full resize-y rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-accent"
        />

        <label htmlFor="script-ask" className="mt-4 block font-bold">
          요청 사항 <span className="text-sm font-normal text-muted">(선택)</span>
        </label>
        <input
          id="script-ask"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          maxLength={500}
          disabled={writing}
          placeholder="예: 통분하는 방법 위주로, 학생들이 자주 하는 실수도 짚어 주세요"
          className="mt-2 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent"
        />
      </section>

      <div className="space-y-3">
        {errorBox}
        <button
          type="button"
          onClick={() => (review && edited ? setConfirm("discard") : void write())}
          disabled={busy !== null || !hasMaterial}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 font-bold text-on-accent transition hover:bg-accent-strong disabled:opacity-50"
        >
          <SparkIcon size={18} />
          {writing ? `스크립트 쓰는 중… ${elapsed}초` : "스크립트 쓰기"}
        </button>
        <p className="break-keep text-center text-xs text-muted">
          {writing
            ? "자료를 읽고 2–3분 분량의 설명을 쓰고 있어요. 1분 정도 걸려요."
            : "인사나 수업 진행 멘트는 빼고, 학생에게 설명하는 핵심 내용만 2–3분 분량으로 써요."}
        </p>
      </div>

      <ConfirmDialog
        open={confirm === "discard"}
        title="새 스크립트를 쓸까요?"
        confirmLabel="새로 쓰기"
        onConfirm={() => {
          discard();
          void write();
        }}
        onClose={() => setConfirm(null)}
      >
        쓰던 스크립트에서 직접 고친 내용은 사라져요.
      </ConfirmDialog>
    </div>
  );
}
