import type { Metadata } from "next";
import { Suspense } from "react";
import LessonLibrary from "@/components/library/LessonLibrary";
import { LessonGridSkeleton } from "@/components/RecentLessons";
import { listAllLessons, loadLibrary } from "@/lib/store";
import type { LibraryLesson, LibraryState } from "@/lib/types";

export const metadata: Metadata = { title: "내 레슨" };

export default function LessonsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 sm:py-10">
      <Suspense fallback={<LibrarySkeleton />}>
        <Library />
      </Suspense>
    </div>
  );
}

async function Library() {
  let lessons: LibraryLesson[];
  let library: LibraryState;
  try {
    const [all, saved] = await Promise.all([listAllLessons(), loadLibrary()]);
    lessons = all.map(({ id, title, thumbnail, sentenceCount, createdAt, captionOrigin, koreanOrigin }) => ({
      id,
      title,
      thumbnail,
      sentenceCount,
      createdAt,
      captionOrigin,
      koreanOrigin,
    }));
    library = saved;
  } catch (e) {
    console.error("library load failed", e);
    return (
      <>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">내 레슨</h1>
        <p className="mt-3 text-sm text-muted">레슨 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
      </>
    );
  }
  return <LessonLibrary lessons={lessons} library={library} />;
}

function LibrarySkeleton() {
  return (
    <>
      <div className="h-9 w-32 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-2 h-4 w-40 animate-pulse rounded bg-surface-2" />
      <div className="mt-6 flex gap-2">
        {[64, 80, 96].map((w) => (
          <div key={w} className="h-9 animate-pulse rounded-full bg-surface-2" style={{ width: w }} />
        ))}
      </div>
      <div className="mb-5 mt-4 h-10 animate-pulse rounded-xl bg-surface-2" />
      <LessonGridSkeleton count={8} />
    </>
  );
}
