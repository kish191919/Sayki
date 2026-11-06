import { NextResponse } from "next/server";
import {
  configuredPassword,
  safeEqual,
  safeNextPath,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sessionToken,
} from "@/lib/auth";
import { bumpCounter } from "@/lib/store";

const MAX_ATTEMPTS = 10; // per IP
const WINDOW_SECONDS = 15 * 60;

/** Plain HTML form POST from /login → sets the session cookie and redirects (303). */
export async function POST(request: Request) {
  const password = configuredPassword();
  const form = await request.formData().catch(() => null);
  const next = safeNextPath(form?.get("next"));

  const back = (error: "wrong" | "locked" | "unset") => {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", error);
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  };

  if (!password) return back("unset");

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  try {
    if ((await bumpCounter(`login:${ip}`, WINDOW_SECONDS)) > MAX_ATTEMPTS) return back("locked");
  } catch (e) {
    // A storage outage must not lock the owner out; the password check still applies.
    console.error("login rate limit unavailable", e);
  }

  const submitted = String(form?.get("password") ?? "");
  const expected = await sessionToken(password);
  if (!submitted || !safeEqual(await sessionToken(submitted), expected)) return back("wrong");

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(SESSION_COOKIE, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
