import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import { SaykiMark } from "@/components/icons";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sayki · 좋아하는 영상으로 영어 쉐도잉",
    template: "%s | Sayki",
  },
  description:
    "유튜브 링크만 붙여 넣으면 문장 단위로 듣고, 따라 말하고, 바로 발음 점수를 받는 영어 쉐도잉 연습 서비스.",
  applicationName: "Sayki",
  robots: { index: false, follow: false }, // personal site
  // iOS "홈 화면에 추가" → opens full-screen without Safari's UI. Icon: app/apple-icon.png.
  appleWebApp: { capable: true, title: "Sayki", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#111215" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full">
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
              <SaykiMark />
              Sayki
            </Link>
            <nav className="ml-auto flex items-center gap-1 text-sm font-semibold">
              <Link href="/script" className="rounded-full px-3 py-2 text-muted transition hover:bg-surface-2 hover:text-ink">
                스크립트
              </Link>
              <Link href="/lessons" className="rounded-full px-3 py-2 text-muted transition hover:bg-surface-2 hover:text-ink">
                내 레슨
              </Link>
              <Link href="/bookmarks" className="rounded-full px-3 py-2 text-muted transition hover:bg-surface-2 hover:text-ink">
                북마크
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line">
          <div className="mx-auto max-w-[1400px] px-4 py-8 text-sm text-muted sm:px-6">
            <p className="font-semibold text-ink">Sayki</p>
            <p className="mt-1 break-keep">
              영상은 YouTube 공식 플레이어로 재생되며, 영상과 자막의 저작권은 각 원작자에게 있습니다.
            </p>
            <p className="mt-3">© Sayki</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
