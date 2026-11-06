"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-2xl font-extrabold">문제가 생겼어요</h1>
      <p className="mt-2 break-keep text-muted">잠시 후 다시 시도해 주세요. 계속되면 홈에서 다시 시작해 주세요.</p>
      <div className="mt-6 flex justify-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 items-center rounded-full bg-accent px-5 font-bold text-on-accent hover:bg-accent-strong"
        >
          다시 시도
        </button>
        <Link href="/" className="inline-flex h-11 items-center rounded-full border border-line px-5 font-semibold">
          홈으로
        </Link>
      </div>
    </div>
  );
}
