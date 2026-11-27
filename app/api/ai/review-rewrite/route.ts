import { NextRequest, NextResponse, after } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import type { RewriteScope } from "@/lib/email-rewrite";
import {
  getRewriteJobAndWorkspace,
  getRewritePreflightAndWorkspace,
  runEmailRewriteJobPipeline,
  startEmailRewriteJob,
} from "@/lib/email-rewrite-server";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const params = req.nextUrl.searchParams;
    const isPreflight = params.get("preflight") === "1";

    if (isPreflight) {
      const scopeRaw = params.get("scope");
      const scope: RewriteScope =
        scopeRaw === "selected" || scopeRaw === "unapproved" ? scopeRaw : "all";
      const selectedRaw = params.get("selected") ?? "";
      const selectedIds = selectedRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const data = await getRewritePreflightAndWorkspace({
        ownerId: user.ownerId,
        scope,
        selectedIds,
      });
      return NextResponse.json(data, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    const jobId = params.get("jobId")?.trim() || undefined;
    const state = await getRewriteJobAndWorkspace({ ownerId: user.ownerId, jobId });
    return NextResponse.json(state, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      scope?: RewriteScope;
      selectedIds?: string[];
      retryFailedOnly?: boolean;
      instruction?: string;
    };

    const scope: RewriteScope =
      body.scope === "selected" || body.scope === "unapproved" ? body.scope : "all";
    const selectedIds = Array.isArray(body.selectedIds)
      ? body.selectedIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    const started = await startEmailRewriteJob({
      ownerId: user.ownerId,
      scope,
      selectedIds,
      retryFailedOnly: Boolean(body.retryFailedOnly),
      instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 400) : undefined,
    });

    if (!started.reused) {
      const origin = req.nextUrl.origin;
      after(
        runEmailRewriteJobPipeline({
          ownerId: user.ownerId,
          jobId: started.job.id,
          targetIds: started.targetIds,
          instruction: typeof body.instruction === "string" ? body.instruction.slice(0, 400) : undefined,
          continueOrigin: origin,
        }),
      );
    }

    return NextResponse.json(
      { job: started.job, workspace: started.workspace, reused: started.reused },
      { status: started.reused ? 200 : 202, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
