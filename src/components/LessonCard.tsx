import Image from "next/image";
import Link from "next/link";
import { CheckIcon, FolderIcon } from "@/components/icons";
import type { LessonSummary } from "@/lib/types";

const CAPTION_BADGE = {
  "youtube-manual": null,
  "youtube-auto": "자동 자막",
  upload: "업로드 자막",
  whisper: "AI 자막",
  script: "강의 스크립트",
} as const;

export function lessonBadge(l: Pick<LessonSummary, "captionOrigin" | "koreanOrigin">): string | null {
  if (l.captionOrigin === "script") return CAPTION_BADGE.script;
  return l.koreanOrigin ? "한글 해석" : CAPTION_BADGE[l.captionOrigin];
}

type Props = {
  id: string;
  title: string;
  thumbnail: string | null;
  sentenceCount: number;
  /** Shown as a progress bar when set. */
  practiced?: number;
  badge?: string | null;
  /** Folder the lesson sits in. */
  folder?: string | null;
  /** Extra meta such as the creation date (row layout only). */
  date?: string;
  layout?: "grid" | "row";
  /** Turns the card into a toggle (for picking lessons) instead of a link. */
  selection?: { selected: boolean; onToggle: () => void };
};

export default function LessonCard({
  id,
  title,
  thumbnail,
  sentenceCount,
  practiced,
  badge,
  folder,
  date,
  layout = "grid",
  selection,
}: Props) {
  const row = layout === "row";
  const ratio = practiced != null && sentenceCount ? Math.min(1, practiced / sentenceCount) : null;
  const done = ratio === 1;
  const selected = selection?.selected ?? false;

  const content = (
    <>
      <div
        className={
          row
            ? "relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-36"
            : "relative aspect-video bg-surface-2"
        }
      >
        {thumbnail ? (
          <Image
            src={thumbnail}
            alt=""
            fill
            sizes={row ? "144px" : "(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"}
            className="object-cover"
            // YouTube already serves compressed thumbnails; skip Vercel's
            // image optimizer (and its monthly quota).
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm font-semibold text-muted">내 영상</div>
        )}
        {badge && !row && (
          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">
            {badge}
          </span>
        )}
        {selection && (
          <span
            className={`absolute flex items-center justify-center rounded-full border-2 transition ${
              row ? "left-1.5 top-1.5 size-5" : "right-2 top-2 size-6"
            } ${selected ? "border-accent bg-accent text-on-accent" : "border-white bg-black/35 text-transparent"}`}
          >
            <CheckIcon size={row ? 12 : 14} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className={row ? "min-w-0 flex-1 py-0.5 pr-1" : "p-3"}>
        <p className="line-clamp-2 text-sm font-semibold leading-snug group-hover:text-accent">{title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-muted">
          <span>{sentenceCount}문장</span>
          {done ? (
            <span className="font-semibold text-good">· 완주</span>
          ) : (
            practiced != null && practiced > 0 && <span>· {practiced}문장 연습함</span>
          )}
          {row && badge && <span>· {badge}</span>}
          {row && date && <span>· {date}</span>}
        </p>
        {folder && (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted">
            <FolderIcon size={12} className="shrink-0" />
            <span className="truncate">{folder}</span>
          </p>
        )}
        {ratio != null && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full ${done ? "bg-good" : "bg-accent"}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        )}
      </div>
    </>
  );

  const className = `group w-full text-left transition ${
    row
      ? "flex items-center gap-3 rounded-xl border bg-surface p-2 hover:bg-surface-2"
      : "block overflow-hidden rounded-2xl border bg-surface hover:-translate-y-0.5 hover:shadow-md"
  } ${selected ? "border-accent ring-2 ring-accent" : "border-line"}`;

  if (selection) {
    return (
      <button type="button" aria-pressed={selected} onClick={selection.onToggle} className={className}>
        {content}
      </button>
    );
  }
  return (
    <Link href={`/lesson/${id}`} className={className}>
      {content}
    </Link>
  );
}
