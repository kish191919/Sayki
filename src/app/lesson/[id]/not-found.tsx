import Link from "next/link";

export default function LessonNotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-2xl font-extrabold">레슨을 찾을 수 없어요</h1>
      <p className="mt-2 break-keep text-muted">링크가 잘못되었거나 삭제된 레슨이에요. 영상 링크로 새 레슨을 만들어 보세요.</p>
      <Link
        href="/#start"
        className="mt-6 inline-flex h-11 items-center rounded-full bg-accent px-5 font-bold text-on-accent hover:bg-accent-strong"
      >
        새 레슨 만들기
      </Link>
    </div>
  );
}
