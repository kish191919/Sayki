import { Suspense } from "react";
import CreateLessonForm from "@/components/CreateLessonForm";
import MyRecents from "@/components/MyRecents";
import RecentLessons, { LessonGridSkeleton } from "@/components/RecentLessons";

const STEPS = [
  {
    title: "링크 붙여 넣기",
    body: "보고 싶은 유튜브 영상의 링크를 넣으면 자막을 문장 단위로 나눠 연습 레슨을 만들어요.",
  },
  {
    title: "한 문장씩 듣기",
    body: "문장이 끝나면 영상이 멈춰요. 속도를 늦추거나 같은 문장을 반복해서 들을 수 있어요.",
  },
  {
    title: "따라 말하고 점수 받기",
    body: "마이크 버튼을 누르고 따라 말하면 단어별로 맞은 곳과 틀린 곳을 바로 보여 줘요.",
  },
];

const TIPS = [
  { title: "처음엔 듣기만", body: "자막을 끄고 한 번 들은 뒤, 자막을 켜고 다시 들어 보세요." },
  { title: "느리게 시작", body: "0.75배속으로 정확하게 따라 한 다음 1배속으로 올려요." },
  { title: "소리 내어 크게", body: "속으로 읽지 말고, 원어민의 리듬과 억양을 흉내 내듯 말해요." },
  { title: "녹음과 비교", body: "원본 → 내 녹음 순서로 들으면 차이가 확실히 들려요." },
];

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

      <section id="how" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-10 sm:px-6">
        <h2 className="text-xl font-bold">이렇게 연습해요</h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-line bg-surface p-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-sm font-extrabold text-accent">
                {i + 1}
              </span>
              <h3 className="mt-3 font-bold">{s.title}</h3>
              <p className="mt-1.5 break-keep text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 rounded-2xl bg-surface-2 p-5">
          <h3 className="font-bold">쉐도잉 잘하는 법</h3>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TIPS.map((t) => (
              <li key={t.title} className="text-sm">
                <span className="font-semibold">{t.title}</span>
                <p className="mt-0.5 break-keep text-muted">{t.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-4 pb-16 pt-4 sm:px-6">
        <h2 className="mb-4 text-xl font-bold">최근 만들어진 레슨</h2>
        <Suspense fallback={<LessonGridSkeleton />}>
          <RecentLessons />
        </Suspense>
      </section>
    </>
  );
}
