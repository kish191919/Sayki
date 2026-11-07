import type { Metadata } from "next";
import { Suspense } from "react";
import ScriptList from "@/components/script/ScriptList";
import ScriptMakerLoader from "@/components/script/ScriptMakerLoader";
import MoreInfo from "@/components/script/MoreInfo";
import { isScriptLessonId, listAllLessons } from "@/lib/store";
import type { ScriptListItem } from "@/lib/types";

export const metadata: Metadata = { title: "강의 스크립트 만들기" };

export default function ScriptPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="break-keep text-2xl font-extrabold tracking-tight sm:text-3xl">강의 스크립트 만들기</h1>
      <MoreInfo label="어떻게 쓰나요?" className="mt-2">
        <p className="break-keep leading-relaxed text-muted">
          교재 사진이나 메모를 주면 초등 4–6학년 학생에게 영어로 설명하는 2–3분 스크립트를 써요. 확인하고 고친 뒤
          영어 음성과 한글 해석으로 문장마다 연습할 수 있어요.
        </p>
      </MoreInfo>
      <div className="mt-6">
        <ScriptMakerLoader />
      </div>
      <section aria-labelledby="my-scripts" className="mt-12 border-t border-line pt-8">
        <Suspense fallback={<ScriptListSkeleton />}>
          <Scripts />
        </Suspense>
      </section>
    </div>
  );
}

async function Scripts() {
  let scripts: ScriptListItem[];
  try {
    scripts = (await listAllLessons())
      .filter((l) => isScriptLessonId(l.id))
      .map(({ id, title, sentenceCount, durationSec, createdAt }) => ({ id, title, sentenceCount, durationSec, createdAt }));
  } catch (e) {
    console.error("script list load failed", e);
    return (
      <>
        <h2 id="my-scripts" className="text-lg font-bold">
          내 스크립트
        </h2>
        <p className="mt-2 text-sm text-muted">스크립트 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
      </>
    );
  }
  return <ScriptList scripts={scripts} />;
}

function ScriptListSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-7 w-28 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-3 h-60 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}
