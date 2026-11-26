import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  getUserByokPublicState,
  getUserGovernance,
  listAdminUsersDirectory,
  listAiUsageEvents,
  saveUserGovernance,
} from "@/lib/platform/store-server";
import type { AdminRole, PlatformQuotaConfig } from "@/lib/platform/types";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { meta: adminMeta } = await requireAdmin(req, "support");
    const isSupport = adminMeta.role === "support";
    const { id: targetOwnerId } = await context.params;

    const directory = await listAdminUsersDirectory();
    const summary = directory.find((u) => u.ownerId === targetOwnerId);
    if (!summary) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if (!supabaseServer) {
      return NextResponse.json({ error: "Database unavailable." }, { status: 503 });
    }

    const [meta, byokState, usageEvents, activityRes, campaignsRes] = await Promise.all([
      getUserGovernance(targetOwnerId, summary.email),
      getUserByokPublicState(targetOwnerId, summary.email),
      listAiUsageEvents({ ownerId: targetOwnerId, limit: 200 }),
      supabaseServer
        .from("audit_logs")
        .select("id, action, entity, entity_id, created_at")
        .eq("owner_id", targetOwnerId)
        .neq("action", "ai_usage")
        .order("created_at", { ascending: false })
        .limit(40),
      supabaseServer
        .from("campaigns")
        .select("id, name, status, created_at")
        .eq("owner_id", targetOwnerId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    return NextResponse.json(
      {
        user: {
          ...summary,
          plan: meta.plan,
          quotaOverride: meta.quotaOverride ?? null,
          usageResetAt: meta.usageResetAt ?? null,
          totpEnabled: meta.totpEnabled,
          aiCostMonthUsd: isSupport ? 0 : summary.aiCostMonthUsd,
        },
        keySourceSummary: isSupport
          ? { mode: byokState.mode, label: byokState.mode === "personal" ? "Personal key (hidden)" : "Platform key" }
          : {
              mode: byokState.mode,
              label:
                byokState.mode === "personal" && byokState.activePersonalProvider
                  ? `Personal (${byokState.activePersonalProvider.label} ${byokState.activePersonalProvider.maskedKey})`
                  : "Platform shared key",
              usageStats: byokState.usageStats,
            },
        campaigns: campaignsRes.data ?? [],
        recentActivity: activityRes.data ?? [],
        usageEvents: isSupport
          ? usageEvents.map((e) => ({ ...e, costUsd: 0 }))
          : usageEvents,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: targetOwnerId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: "suspend" | "reactivate" | "change_role" | "reset_usage" | "set_plan" | "set_quota_override";
      role?: AdminRole;
      plan?: string;
      quotaOverride?: Partial<PlatformQuotaConfig> | null;
      totpCode?: string;
    };

    const needsSuperAdmin = body.action === "change_role";
    const needsReauth = body.action === "change_role" || body.action === "suspend" || body.action === "reset_usage";

    const { user, meta: adminMeta } = await requireAdmin(
      req,
      needsSuperAdmin ? "super_admin" : "admin",
      { requireReauth: needsReauth, inlineTotpCode: body.totpCode },
    );

    const directory = await listAdminUsersDirectory();
    const summary = directory.find((u) => u.ownerId === targetOwnerId);
    if (!summary) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const targetMeta = await getUserGovernance(targetOwnerId, summary.email);

    if (body.action === "suspend" || body.action === "reactivate") {
      if (targetOwnerId === user.ownerId && body.action === "suspend") {
        return NextResponse.json({ error: "You cannot suspend your own account." }, { status: 400 });
      }
      if (targetMeta.role === "super_admin" && adminMeta.role !== "super_admin") {
        return NextResponse.json({ error: "Only a Super Admin can modify another Super Admin." }, { status: 403 });
      }
      const nextStatus = body.action === "suspend" ? "suspended" : "active";
      await saveUserGovernance({ ...targetMeta, status: nextStatus });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: adminMeta.role,
        action: `user_${body.action}`,
        targetType: "user",
        targetId: targetOwnerId,
        details: { targetEmail: summary.email },
        req,
      });
      return NextResponse.json({ ok: true, status: nextStatus });
    }

    if (body.action === "change_role") {
      const nextRole = body.role;
      if (!nextRole || !["user", "support", "admin", "super_admin"].includes(nextRole)) {
        return NextResponse.json({ error: "Invalid role." }, { status: 400 });
      }
      if (targetOwnerId === user.ownerId && nextRole !== "super_admin") {
        return NextResponse.json({ error: "You cannot demote yourself from Super Admin." }, { status: 400 });
      }
      await saveUserGovernance({ ...targetMeta, role: nextRole });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: adminMeta.role,
        action: "user_role_changed",
        targetType: "user",
        targetId: targetOwnerId,
        details: { targetEmail: summary.email, fromRole: targetMeta.role, toRole: nextRole },
        req,
      });
      return NextResponse.json({ ok: true, role: nextRole });
    }

    if (body.action === "reset_usage") {
      const usageResetAt = new Date().toISOString();
      await saveUserGovernance({ ...targetMeta, usageResetAt });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: adminMeta.role,
        action: "user_usage_limits_reset",
        targetType: "user",
        targetId: targetOwnerId,
        details: { targetEmail: summary.email, usageResetAt },
        req,
      });
      return NextResponse.json({ ok: true, usageResetAt });
    }

    if (body.action === "set_plan") {
      const plan = String(body.plan ?? "standard").trim().slice(0, 40) || "standard";
      await saveUserGovernance({ ...targetMeta, plan });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: adminMeta.role,
        action: "user_plan_updated",
        targetType: "user",
        targetId: targetOwnerId,
        details: { targetEmail: summary.email, plan },
        req,
      });
      return NextResponse.json({ ok: true, plan });
    }

    if (body.action === "set_quota_override") {
      await saveUserGovernance({ ...targetMeta, quotaOverride: body.quotaOverride ?? undefined });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: adminMeta.role,
        action: "user_quota_override_updated",
        targetType: "user",
        targetId: targetOwnerId,
        details: { targetEmail: summary.email, quotaOverride: body.quotaOverride },
        req,
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown user action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: targetOwnerId } = await context.params;
    const { user, meta: adminMeta } = await requireAdmin(req, "super_admin", { requireReauth: true });

    if (targetOwnerId === user.ownerId) {
      return NextResponse.json({ error: "You cannot delete your own Super Admin account." }, { status: 400 });
    }
    if (!supabaseServer) {
      return NextResponse.json({ error: "Database unavailable." }, { status: 503 });
    }

    const directory = await listAdminUsersDirectory();
    const summary = directory.find((u) => u.ownerId === targetOwnerId);

    const tables = [
      "messages",
      "replies",
      "send_logs",
      "lead_events",
      "leads",
      "campaigns",
      "knowledge_sources",
      "knowledge",
      "suppressions",
      "email_opens",
      "operator_conversations",
      "audit_logs",
    ];

    for (const table of tables) {
      await supabaseServer.from(table as never).delete().eq("owner_id", targetOwnerId);
    }
    await supabaseServer.from("account_links").delete().eq("legacy_owner_id", targetOwnerId);

    await appendAdminAuditLog({
      actorId: user.ownerId,
      actorEmail: user.email,
      actorRole: adminMeta.role,
      action: "user_deleted_permanently",
      targetType: "user",
      targetId: targetOwnerId,
      details: { targetEmail: summary?.email ?? "unknown" },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
