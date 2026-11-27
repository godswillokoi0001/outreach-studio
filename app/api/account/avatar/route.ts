import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { getUserAvatarStateServer, updateCustomAvatarServer } from "@/lib/server-avatar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ownerId = req.nextUrl.searchParams.get("ownerId")?.trim() || "";
    if (!ownerId) {
      return new NextResponse(null, { status: 400 });
    }
    const state = await getUserAvatarStateServer(ownerId, null);
    const targetUrl = state.avatarSource === "custom" ? state.customAvatarData : state.googleAvatarUrl;
    if (!targetUrl) {
      return new NextResponse(null, { status: 404 });
    }

    if (targetUrl.startsWith("data:image/")) {
      const m = targetUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
      if (!m) return new NextResponse(null, { status: 400 });
      const buf = Buffer.from(m[2], "base64");
      return new NextResponse(buf, {
        status: 200,
        headers: {
          "Content-Type": m[1],
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { Accept: "image/*" },
      });
      if (!upstream.ok) {
        return new NextResponse(null, { status: 502 });
      }
      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      const bytes = await upstream.arrayBuffer();
      return new NextResponse(bytes, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?: "upload" | "reset_google";
      dataUrl?: string;
    };
    const nextState = await updateCustomAvatarServer({
      ownerId: user.ownerId,
      email: user.email,
      action: body.action === "upload" ? "upload" : "reset_google",
      dataUrl: body.dataUrl,
    });
    return NextResponse.json(
      {
        photoURL: nextState.effectivePhotoUrl,
        googlePhotoURL: nextState.googleAvatarUrl,
        avatarSource: nextState.avatarSource,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
