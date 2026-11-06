import { Suspense } from "react";
import CreateLessonForm from "@/components/CreateLessonForm";
import MyRecents from "@/components/MyRecents";
import RecentLessons, { LessonGridSkeleton } from "@/components/RecentLessons";

export default function Home() {
  return (
    <>
      <section id="start" className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-soft),transparent)]" />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center px-4 pb-14 pt-16 text-center sm:pt-24">
          <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-muted">
            영어 쉐도잉 연습
          </span>
          <h1 className="mt-5 break-keep text-[2.1rem] font-extrabold leading-tight tracking-tight sm:text-5xl">
            좋아하는 영상으로,
            <br />
            <span className="text-accent">원어민처럼</span> 말해 보세요
          </h1>
          <p className="mt-5 max-w-xl break-keep text-base text-muted sm:text-lg">
            유튜브 링크만 붙여 넣으면 끝. 한 문장씩 듣고, 따라 말하고, 바로 발음 점수를 받아요.
          </p>
          <div className="mt-8 w-full text-left">
            <CreateLessonForm />
          </div>
        </div>
      </section>

      <MyRecents />

      <section className="mx-auto max-w-[1400px] px-4 pb-16 pt-10 sm:px-6">
        <h2 className="mb-4 text-xl font-bold">최근 만들어진 레슨</h2>
        <Suspense fallback={<LessonGridSkeleton />}>
          <RecentLessons />
        </Suspense>
      </section>
    </>
  );
}
