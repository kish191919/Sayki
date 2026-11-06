import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LessonError } from "./errors";

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Blocks requests to localhost / private networks (SSRF guard). */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LessonError("INVALID_URL", "http 또는 https 링크만 사용할 수 있어요.", 400);
  }
  if (url.username || url.password) {
    throw new LessonError("INVALID_URL", "로그인 정보가 포함된 링크는 사용할 수 없어요.", 400);
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new LessonError("MEDIA_UNREACHABLE", "링크의 주소를 찾을 수 없어요.", 422);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new LessonError("INVALID_URL", "이 주소의 파일은 가져올 수 없어요.", 400);
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

/** Downloads a public audio/video file with a hard size cap. */
export async function fetchPublicMedia(
  rawUrl: string,
  maxBytes: number,
): Promise<{ blob: Blob; filename: string }> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!res.ok || !res.body) {
      throw new LessonError("MEDIA_UNREACHABLE", `동영상 파일을 받지 못했어요 (HTTP ${res.status}).`, 422);
    }

    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type && !/^(audio|video)\//.test(type) && type !== "application/octet-stream") {
      throw new LessonError("NOT_MEDIA", "동영상·오디오 파일 링크가 아니에요.", 422);
    }
    const tooLarge = new LessonError(
      "MEDIA_TOO_LARGE",
      `파일이 너무 커요. ${Math.round(maxBytes / 1024 / 1024)}MB 이하 파일만 자동 자막을 만들 수 있어요.`,
      413,
    );
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge;
      }
      chunks.push(value);
    }

    let filename = decodeURIComponent(url.pathname.split("/").pop() || "media");
    if (!/\.[a-z0-9]{2,4}$/i.test(filename)) filename += `.${EXT_BY_TYPE[type] ?? "mp4"}`;
    return { blob: new Blob(chunks as BlobPart[], { type: type || "application/octet-stream" }), filename };
  }
  throw new LessonError("MEDIA_UNREACHABLE", "리다이렉트가 너무 많은 링크예요.", 422);
}
