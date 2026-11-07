import { NextResponse, type NextRequest } from "next/server";
import { configuredPassword, isValidSession, SESSION_COOKIE } from "@/lib/auth";

const LOGIN_PAGE = "/login";
const LOGIN_API = "/api/auth/login";

/** Locks the whole site behind SAYKI_PASSWORD (pages and APIs alike). */
export async function proxy(request: NextRequest) {
  const password = configuredPassword();
  const { pathname, search } = request.nextUrl;

  if (!password) {
    // Local development without a password stays open; a deployment never does.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("SAYKI_PASSWORD 환경 변수가 설정되지 않아 사이트를 잠가 두었어요.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (pathname === LOGIN_API) return NextResponse.next();

  const signedIn = await isValidSession(request.cookies.get(SESSION_COOKIE)?.value, password);

  if (pathname === LOGIN_PAGE) {
    return signedIn ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (signedIn) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return Response.json({ code: "UNAUTHORIZED", error: "로그인이 필요해요. 페이지를 새로고침해 주세요." }, { status: 401 });
  }
  const login = new URL(LOGIN_PAGE, request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except build assets, app icons and the web app manifest. Browsers fetch the
  // manifest and home-screen icons without cookies, so they must not redirect to /login.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico|apple-icon|icons/|manifest.webmanifest).*)"],
};
