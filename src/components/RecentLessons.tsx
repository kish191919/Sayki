import LessonCard, { lessonBadge } from "@/components/LessonCard";
import { listRecentLessons } from "@/lib/store";

/** The newest lessons (server-rendered from the lesson store). */
export default async function RecentLessons() {
  let lessons: Awaited<ReturnType<typeof listRecentLessons>>;
  try {
    lessons = await listRecentLessons(8);
  } catch (e) {
    console.error("listRecentLessons failed", e);
    return <p className="text-sm text-muted">최근 레슨을 불러오지 못했어요.</p>;
  }
  if (lessons.length === 0) {
    return <p className="text-sm text-muted">아직 만들어진 레슨이 없어요. 첫 레슨을 만들어 보세요!</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {lessons.map((l) => (
        <LessonCard
          key={l.id}
          id={l.id}
          title={l.title}
          thumbnail={l.thumbnail}
          sentenceCount={l.sentenceCount}
          badge={lessonBadge(l)}
        />
      ))}
    </div>
  );
}

export function LessonGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="aspect-[4/3.4] animate-pulse rounded-2xl bg-surface-2" />
      ))}
    </div>
  );
}
