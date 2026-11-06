/**
 * Single-password lock for a personal deployment.
 *
 * The session cookie holds HMAC-SHA256(key = SAYKI_PASSWORD, "sayki-session-v1"),
 * so it is stateless: no session store, and changing the password signs
 * every device out. Uses Web Crypto only, so it runs in `proxy.ts`.
 */

export const SESSION_COOKIE = "sayki_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // one year: it's a personal device

const encoder = new TextEncoder();

export function configuredPassword(): string | null {
  return process.env.SAYKI_PASSWORD || null;
}

/** Token derived from a password. Equal tokens ⇔ equal passwords. */
export async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode("sayki-session-v1"));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidSession(cookie: string | undefined, password: string): Promise<boolean> {
  return !!cookie && safeEqual(cookie, await sessionToken(password));
}

/** Only same-site paths are allowed as a post-login destination (no open redirect). */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}
