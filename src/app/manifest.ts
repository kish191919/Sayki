import type { MetadataRoute } from "next";

/**
 * Web app manifest → installable to the phone home screen ("홈 화면에 추가").
 * Served at /manifest.webmanifest; proxy.ts leaves it (and the icons) public,
 * because browsers fetch it without the session cookie.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Sayki · 영어 쉐도잉",
    short_name: "Sayki",
    description: "좋아하는 영상으로 문장 단위 영어 쉐도잉 연습",
    lang: "ko",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f6f2",
    theme_color: "#f7f6f2",
    categories: ["education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "내 레슨", url: "/lessons", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "북마크", url: "/bookmarks", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
