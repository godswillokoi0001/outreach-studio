import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Security headers across all API and Admin responses so authenticated or
  // admin JSON is never cached by shared CDNs, proxies, or browsers.
  if (req.nextUrl.pathname.startsWith("/api/") || req.nextUrl.pathname.startsWith("/admin")) {
    res.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
    res.headers.set("Pragma", "no-cache");
    res.headers.set("Expires", "0");
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("Referrer-Policy", "same-origin");
  }

  return res;
}

export const config = {
  matcher: ["/api/:path*", "/admin/:path*"],
};
