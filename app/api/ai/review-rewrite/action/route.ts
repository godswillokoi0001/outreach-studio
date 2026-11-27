import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { applyRewriteItemAction } from "@/lib/email-rewrite-server";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?: "accept" | "accept_all_passed" | "edit" | "reject" | "regenerate" | "restore_version";
      messageId?: string;
      subject?: string;
      body?: string;
      instruction?: string;
      versionId?: string;
    };

    const allowed = new Set([
      "accept",
      "accept_all_passed",
      "edit",
      "reject",
      "regenerate",
      "restore_version",
    ]);
    if (!body.action || !allowed.has(body.action)) {
      return NextResponse.json({ error: "Invalid rewrite action." }, { status: 400 });
    }

    const res = await applyRewriteItemAction({
      ownerId: user.ownerId,
      action: body.action,
      messageId: body.messageId,
      subject: body.subject,
      body: body.body,
      instruction: body.instruction,
      versionId: body.versionId,
    });

    return NextResponse.json(res, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
