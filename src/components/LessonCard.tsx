import Image from "next/image";
import Link from "next/link";

type Props = {
  id: string;
  title: string;
  thumbnail: string | null;
  sentenceCount: number;
  /** Shown as a progress bar when set. */
  practiced?: number;
  badge?: string | null;
};

export default function LessonCard({ id, title, thumbnail, sentenceCount, practiced, badge }: Props) {
  const ratio = practiced != null && sentenceCount ? Math.min(1, practiced / sentenceCount) : null;
  return (
    <Link
      href={`/lesson/${id}`}
      className="group block overflow-hidden rounded-2xl border border-line bg-surface transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-video bg-surface-2">
        {thumbnail ? (
          <Image
            src={thumbnail}
            alt=""
            fill
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover"
            // YouTube already serves compressed thumbnails; skip Vercel's
            // image optimizer (and its monthly quota).
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm font-semibold text-muted">내 영상</div>
        )}
        {badge && (
          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">
            {badge}
          </span>
        )}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 text-sm font-semibold leading-snug group-hover:text-accent">{title}</p>
        <p className="mt-1 text-xs text-muted">
          {sentenceCount}문장{practiced != null && practiced > 0 && <> · {practiced}문장 연습함</>}
        </p>
        {ratio != null && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
      </div>
    </Link>
  );
}
