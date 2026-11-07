import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import RoomLoader from "@/components/room/RoomLoader";
import RoomSkeleton from "@/components/room/RoomSkeleton";
import { bookmarkLessonOrder, listBookmarks } from "@/lib/bookmarks";
import { getHiddenSentences, getLesson } from "@/lib/store";
import { canTranslate } from "@/lib/translate";
import type { Lesson } from "@/lib/types";

const CAPTION_LABEL: Record<Lesson["captionOrigin"], string> = {
  "youtube-manual": "영어 자막",
  "youtube-auto": "영어 자동 자막",
  upload: "업로드한 자막",
  whisper: "AI 생성 자막",
  script: "AI 강의 스크립트",
};

const KOREAN_LABEL = {
  "youtube-manual": "한글 자막",
  "youtube-auto-translate": "한글 자동 번역",
  ai: "한글 AI 번역",
} as const;

export async function generateMetadata({ params }: PageProps<"/lesson/[id]">): Promise<Metadata> {
  const { id } = await params;
  const lesson = await getLesson(id);
  return { title: lesson ? `${lesson.title} 쉐도잉` : "레슨을 찾을 수 없어요" };
}

export default function LessonPage({ params, searchParams }: PageProps<"/lesson/[id]">) {
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
        <LessonContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

type Query = Record<string, string | string[] | undefined>;

async function LessonContent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [lesson, bookmarks, hidden] = await Promise.all([
    getLesson(id),
    // Practice works without bookmarks; the room just hides the button.
    listBookmarks().catch((e) => {
      console.error("bookmarks load failed", e);
      return null;
    }),
    // Likewise without the deleted sentences: everything shows, and deleting is off.
    getHiddenSentences(id).catch((e) => {
      console.error("hidden sentences load failed", e);
      return null;
    }),
  ]);
  if (!lesson) notFound();

  // ?only=bookmarks — practice only the bookmarked sentences; ?s=12 — open at sentence 13.
  const only = query.only === "bookmarks";
  const order = bookmarks ? bookmarkLessonOrder(bookmarks) : [];
  const at = order.indexOf(lesson.id);
  const s = Number(query.s);
  const startAt = typeof query.s === "string" && Number.isInteger(s) && s >= 0 && s < lesson.sentences.length ? s : null;

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
      <RoomLoader
        // The same lesson opened by another link (another sentence, bookmarks only or not)
        // is kept mounted by the router: start it afresh so those options apply.
        key={`${only ? "only" : "all"}:${startAt ?? ""}`}
        lesson={lesson}
        canTranslate={canTranslate()}
        startAt={startAt}
        hidden={hidden}
        bookmarks={{
          indexes: bookmarks ? bookmarks.filter((b) => b.lessonId === lesson.id).map((b) => b.index) : null,
          only,
          next: only && at >= 0 ? (order[at + 1] ?? null) : null,
        }}
      />
    </>
  );
}
