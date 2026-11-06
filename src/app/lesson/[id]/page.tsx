import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import RoomLoader from "@/components/room/RoomLoader";
import RoomSkeleton from "@/components/room/RoomSkeleton";
import { getLesson } from "@/lib/store";
import type { Lesson } from "@/lib/types";

const CAPTION_LABEL: Record<Lesson["captionOrigin"], string> = {
  "youtube-manual": "영어 자막",
  "youtube-auto": "영어 자동 자막",
  upload: "업로드한 자막",
  whisper: "AI 생성 자막",
};

const KOREAN_LABEL = {
  "youtube-manual": "한글 자막",
  "youtube-auto-translate": "한글 자동 번역",
} as const;

export async function generateMetadata({ params }: PageProps<"/lesson/[id]">): Promise<Metadata> {
  const { id } = await params;
  const lesson = await getLesson(id);
  return { title: lesson ? `${lesson.title} 쉐도잉` : "레슨을 찾을 수 없어요" };
}

export default function LessonPage({ params }: PageProps<"/lesson/[id]">) {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <Suspense
        fallback={
          <>
            <div className="mb-5 h-8 w-2/3 animate-pulse rounded-lg bg-surface-2" />
            <RoomSkeleton />
          </>
        }
      >
        <LessonContent params={params} />
      </Suspense>
    </div>
  );
}

async function LessonContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lesson = await getLesson(id);
  if (!lesson) notFound();

  return (
    <>
      <div className="mb-5">
        <h1 className="break-keep text-xl font-extrabold leading-snug tracking-tight sm:text-2xl">{lesson.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">{lesson.sentences.length}문장</span>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">{CAPTION_LABEL[lesson.captionOrigin]}</span>
          {lesson.koreanOrigin && (
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-accent">{KOREAN_LABEL[lesson.koreanOrigin]}</span>
          )}
        </div>
        {lesson.captionOrigin === "youtube-auto" && (
          <p className="mt-2 break-keep text-xs text-muted">
            자동 생성 자막이라 문장이 어색하게 나뉘거나 단어가 틀릴 수 있어요.
          </p>
        )}
      </div>
      <RoomLoader lesson={lesson} />
    </>
  );
}
