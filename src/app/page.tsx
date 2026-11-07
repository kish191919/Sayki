import Link from "next/link";
import { Suspense } from "react";
import CreateLessonForm from "@/components/CreateLessonForm";
import { ArrowRightIcon, CameraIcon } from "@/components/icons";
import MyRecents from "@/components/MyRecents";
import RecentLessons, { LessonGridSkeleton } from "@/components/RecentLessons";
import { canTranscribe } from "@/lib/transcribe";
import { uploadMode } from "@/lib/uploads";

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
          {/* 의미 단위로 줄을 나눔: PC·태블릿은 2줄, 좁은 모바일은 둘째 줄이 쉼표 뒤에서 한 번 더 나뉘어 3줄 */}
          <p className="mt-5 break-keep text-base leading-relaxed text-muted sm:text-lg">
            <span className="block">유튜브 링크나 영상 파일만 있으면 끝.</span>
            <span className="block">
              <span className="inline-block">한 문장씩 듣고, 따라 말하고,</span>{" "}
              <span className="inline-block">바로 발음 점수를 받아요.</span>
            </span>
          </p>
          <div className="mt-8 w-full text-left">
            <CreateLessonForm upload={uploadMode()} transcribe={canTranscribe()} />
          </div>
          <Link
            href="/script"
            className="group mt-6 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left transition hover:border-accent"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
              <CameraIcon size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold group-hover:text-accent">교재 사진으로 강의 스크립트 만들기</span>
              <span className="mt-0.5 block break-keep text-sm text-muted">
                학생에게 설명할 영어 스크립트를 쓰고, 음성과 한글 해석으로 연습해요.
              </span>
            </span>
            <ArrowRightIcon size={18} className="shrink-0 text-muted group-hover:text-accent" />
          </Link>
        </div>
      </section>

      <MyRecents />

      <section className="mx-auto max-w-[1400px] px-4 pb-16 pt-10 sm:px-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">최근 만들어진 레슨</h2>
          <Link
            href="/lessons"
            className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-muted transition hover:text-accent"
          >
            전체 보기·정리 <ArrowRightIcon size={16} />
          </Link>
        </div>
        <Suspense fallback={<LessonGridSkeleton />}>
          <RecentLessons />
        </Suspense>
      </section>
    </>
  );
}
