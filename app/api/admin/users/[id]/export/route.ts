import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import { appendAdminAuditLog, listAdminUsersDirectory, listAiUsageEvents } from "@/lib/platform/store-server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { user: adminUser, meta: adminMeta } = await requireAdmin(req, "admin");
    const { id: targetOwnerId } = await context.params;

    const directory = await listAdminUsersDirectory();
    const summary = directory.find((u) => u.ownerId === targetOwnerId);
    if (!summary) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if (!supabaseServer) {
      return NextResponse.json({ error: "Database unavailable." }, { status: 503 });
    }

    const [campaigns, leads, activity, usage] = await Promise.all([
      supabaseServer.from("campaigns").select("*").eq("owner_id", targetOwnerId),
      supabaseServer.from("leads").select("*").eq("owner_id", targetOwnerId),
      supabaseServer.from("audit_logs").select("id,action,entity,entity_id,created_at").eq("owner_id", targetOwnerId).neq("action", "ai_usage").limit(200),
      listAiUsageEvents({ ownerId: targetOwnerId, limit: 500 }),
    ]);

    const exportBundle = {
      exportedAt: new Date().toISOString(),
      user: {
        ...summary,
        personalProviderHint: undefined, // Never export key metadata beyond key source type
      },
      campaigns: campaigns.data ?? [],
      leads: leads.data ?? [],
      recentActivity: activity.data ?? [],
      usageEvents: usage,
    };

    await appendAdminAuditLog({
      actorId: adminUser.ownerId,
      actorEmail: adminUser.email,
      actorRole: adminMeta.role,
      action: "user_data_exported",
      targetType: "user",
      targetId: targetOwnerId,
      details: { targetEmail: summary.email },
      req,
    });

    return NextResponse.json(exportBundle, {
      headers: {
        "Content-Disposition": `attachment; filename="user-${targetOwnerId}-export.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
