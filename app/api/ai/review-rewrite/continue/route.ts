import { NextRequest, NextResponse, after } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { runEmailRewriteJobPipeline, verifyRewriteContinuationToken } from "@/lib/email-rewrite-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      ownerId?: string;
      jobId?: string;
      targetIds?: string[];
      instruction?: string;
      expMs?: number;
      sig?: string;
    };

    const ownerId = String(body.ownerId ?? "").trim();
    const jobId = String(body.jobId ?? "").trim();
    const expMs = Number(body.expMs ?? 0);
    const sig = String(body.sig ?? "").trim();

    if (!ownerId || !jobId || !verifyRewriteContinuationToken(ownerId, jobId, expMs, sig)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const targetIds = Array.isArray(body.targetIds)
      ? body.targetIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (targetIds.length > 0) {
      after(
        runEmailRewriteJobPipeline({
          ownerId,
          jobId,
          targetIds,
          instruction: typeof body.instruction === "string" ? body.instruction : undefined,
          continueOrigin: req.nextUrl.origin,
        }),
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
