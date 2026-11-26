import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireGlobalKnowledgeAdmin } from "@/lib/global-knowledge/admin-guard";
import {
  getGlobalKnowledgeCacheStats,
  isGlobalKnowledgeModuleKey,
  rollbackGlobalKnowledgeVersion,
} from "@/lib/global-knowledge/service";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/global-knowledge/[moduleKey]/rollback/[version]
 * Atomically activates a previous immutable version and invalidates RAM cache.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ moduleKey: string; version: string }> },
) {
  try {
    const admin = await requireGlobalKnowledgeAdmin(req, { requireReauth: true });
    const { moduleKey, version: rawVersion } = await context.params;
    if (!isGlobalKnowledgeModuleKey(moduleKey)) {
      return NextResponse.json({ error: `Unknown global knowledge module: ${moduleKey}` }, { status: 400 });
    }

    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json({ error: "Invalid module version number." }, { status: 400 });
    }

    const restored = await rollbackGlobalKnowledgeVersion({
      moduleKey,
      version,
      updatedBy: admin.actorEmail,
    });

    await appendAdminAuditLog({
      actorId: admin.actorId,
      actorEmail: admin.actorEmail,
      actorRole: admin.actorRole,
      action: "global_knowledge_version_rolled_back",
      targetType: "global_knowledge_module",
      targetId: `${moduleKey}@v${restored.version}`,
      details: { moduleKey, rolledBackToVersion: restored.version },
      req,
    });

    return NextResponse.json({
      module: restored,
      cache: getGlobalKnowledgeCacheStats(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
