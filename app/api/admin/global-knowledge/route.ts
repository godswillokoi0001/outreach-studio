import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireGlobalKnowledgeAdmin } from "@/lib/global-knowledge/admin-guard";
import {
  getGlobalKnowledgeCacheStats,
  listAllGlobalKnowledgeVersions,
} from "@/lib/global-knowledge/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/global-knowledge
 * Lists all 4 proprietary sales/outreach intelligence modules and their
 * immutable version history + cache telemetry (admin-only).
 */
export async function GET(req: NextRequest) {
  try {
    await requireGlobalKnowledgeAdmin(req, { requireReauth: false });
    const [{ modules, source }, cache] = await Promise.all([
      listAllGlobalKnowledgeVersions(),
      Promise.resolve(getGlobalKnowledgeCacheStats()),
    ]);
    return NextResponse.json(
      { modules, source, cache },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
