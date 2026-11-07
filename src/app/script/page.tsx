import type { Metadata } from "next";
import ScriptMakerLoader from "@/components/script/ScriptMakerLoader";

export const metadata: Metadata = { title: "강의 스크립트 만들기" };

export default function ScriptPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="break-keep text-2xl font-extrabold tracking-tight sm:text-3xl">강의 스크립트 만들기</h1>
      <p className="mt-2 break-keep leading-relaxed text-muted">
        교재 사진이나 메모를 주면 초등 4–6학년 학생에게 영어로 설명하는 2–3분 스크립트를 써요. 확인하고 고친 뒤
        영어 음성과 한글 해석으로 문장마다 연습할 수 있어요.
      </p>
      <div className="mt-6">
        <ScriptMakerLoader />
      </div>
    </div>
  );
}
