import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireGlobalKnowledgeAdmin } from "@/lib/global-knowledge/admin-guard";
import {
  getGlobalKnowledgeCacheStats,
  isGlobalKnowledgeModuleKey,
  publishGlobalKnowledgeVersion,
} from "@/lib/global-knowledge/service";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/global-knowledge/[moduleKey]/versions
 * Publishes a new immutable version of a global module, activates it atomically,
 * and invalidates the server memory cache across requests.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ moduleKey: string }> },
) {
  try {
    const admin = await requireGlobalKnowledgeAdmin(req, { requireReauth: true });
    const { moduleKey } = await context.params;
    if (!isGlobalKnowledgeModuleKey(moduleKey)) {
      return NextResponse.json({ error: `Unknown global knowledge module: ${moduleKey}` }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      content?: string;
    };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length < 40) {
      return NextResponse.json(
        { error: "Module content must be at least 40 characters." },
        { status: 400 },
      );
    }

    const published = await publishGlobalKnowledgeVersion({
      moduleKey,
      title: body.title,
      content,
      updatedBy: admin.actorEmail,
    });

    await appendAdminAuditLog({
      actorId: admin.actorId,
      actorEmail: admin.actorEmail,
      actorRole: admin.actorRole,
      action: "global_knowledge_version_published",
      targetType: "global_knowledge_module",
      targetId: `${moduleKey}@v${published.version}`,
      details: { moduleKey, version: published.version, title: published.title },
      req,
    });

    return NextResponse.json({
      module: published,
      cache: getGlobalKnowledgeCacheStats(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
