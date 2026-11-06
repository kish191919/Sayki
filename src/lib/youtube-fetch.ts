import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * HTTP for YouTube endpoints only.
 *
 * YouTube bot-checks datacenter IPs (Vercel/AWS), so in production every
 * YouTube request goes through a rotating residential proxy configured as
 * YOUTUBE_PROXY_URL, e.g. `http://user:pass@proxy.example.com:80`.
 * Without it (local development) requests go out directly.
 */

export type YouTubeResponse = { status: number; ok: boolean; text: string };

type Init = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export function usingProxy(): boolean {
  return Boolean(process.env.YOUTUBE_PROXY_URL);
}

export async function youtubeFetch(url: string | URL, init: Init = {}): Promise<YouTubeResponse> {
  const options = {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  };

  const proxy = process.env.YOUTUBE_PROXY_URL;
  if (!proxy) {
    const res = await fetch(url, options);
    return { status: res.status, ok: res.ok, text: await res.text() };
  }

  // A fresh agent opens a fresh tunnel, so a rotating proxy hands out a new
  // exit IP for every request (and every retry).
  const dispatcher = new ProxyAgent(proxy);
  try {
    const res = await undiciFetch(url, { ...options, dispatcher });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (e) {
    // Never log the proxy URL: it contains credentials. The cause carries
    // the useful part, e.g. "Proxy response (407) !== 200 when HTTP Tunneling".
    const cause = (e as Error & { cause?: Error }).cause?.message;
    console.error(`YouTube request via proxy failed: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
    throw e;
  } finally {
    dispatcher.close().catch(() => {});
  }
}
