import type { Metadata } from "next";
import { Suspense } from "react";
import { SaykiMark } from "@/components/icons";
import { safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "로그인" };

const ERRORS: Record<string, string> = {
  wrong: "비밀번호가 맞지 않아요.",
  locked: "시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요.",
  unset: "서버에 SAYKI_PASSWORD가 설정되지 않았어요.",
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-4 pb-24 pt-20 text-center sm:pt-28">
      <SaykiMark />
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Sayki</h1>
      <p className="mt-2 break-keep text-sm text-muted">개인용 사이트예요. 비밀번호를 입력해 주세요.</p>
      <Suspense fallback={<LoginForm next="/" />}>
        <LoginFormWithParams searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LoginFormWithParams({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next, error } = await searchParams;
  return <LoginForm next={safeNextPath(next)} error={typeof error === "string" ? ERRORS[error] : undefined} />;
}

function LoginForm({ next, error }: { next: string; error?: string }) {
  return (
    <form method="post" action="/api/auth/login" className="mt-8 w-full text-left">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm font-semibold" htmlFor="password">
        비밀번호
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoFocus
        autoComplete="current-password"
        className="mt-2 h-12 w-full rounded-xl border border-line bg-surface px-4 text-base outline-none focus:border-accent"
      />
      {error && (
        <p role="alert" className="mt-3 break-keep text-sm font-semibold text-bad">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="mt-4 h-12 w-full rounded-xl bg-accent font-bold text-on-accent transition hover:bg-accent-strong"
      >
        들어가기
      </button>
    </form>
  );
}
