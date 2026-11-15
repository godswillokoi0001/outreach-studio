import { NextResponse, type NextRequest } from "next/server";
import { freebuff } from "./lib/freebuff";

// Refreshes expired Freebuff sessions before pages render. When Freebuff auth
// is not configured (password mode) this middleware is a pass-through.
export async function middleware(request: NextRequest) {
  if (!freebuff) return NextResponse.next();
  return freebuff.proxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
