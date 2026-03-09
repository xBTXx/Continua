import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/authSession";

function stripBasePath(pathname: string, basePath: string) {
  if (!basePath || basePath === "/") {
    return pathname;
  }
  if (!pathname.startsWith(basePath)) {
    return pathname;
  }
  const stripped = pathname.slice(basePath.length);
  return stripped.length > 0 ? stripped : "/";
}

function isPublicAsset(pathname: string) {
  if (pathname.startsWith("/_next")) {
    return true;
  }
  if (pathname === "/favicon.ico") {
    return true;
  }
  return /\.[a-zA-Z0-9]+$/.test(pathname);
}

function redirectToLogin(request: NextRequest, pathname: string) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const nextPath = pathname === "/" ? "/" : `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set("next", nextPath);
  return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest) {
  const pathname = stripBasePath(
    request.nextUrl.pathname,
    request.nextUrl.basePath || ""
  );

  if (isPublicAsset(pathname)) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/api/auth/login") ||
    pathname.startsWith("/api/auth/logout")
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value ?? "";
  const session = token ? await verifySessionToken(token) : null;
  const isAuthenticated = Boolean(session);

  if (pathname === "/login") {
    if (isAuthenticated) {
      const destination = request.nextUrl.clone();
      destination.pathname = "/";
      destination.search = "";
      return NextResponse.redirect(destination);
    }
    return NextResponse.next();
  }

  if (!isAuthenticated) {
    if (pathname.startsWith("/api/")) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    return redirectToLogin(request, pathname);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
