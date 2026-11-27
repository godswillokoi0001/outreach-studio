import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  computePlatformHealthAndAlerts,
  getInternalPlatformPolicy,
  listAdminAuditLogs,
  listAdminUsersDirectory,
  listAiUsageEvents,
} from "@/lib/platform/store-server";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ClearRange = "all" | "7d" | "30d" | "90d";

function cutoffForRange(range: ClearRange): string | null {
  const now = Date.now();
  if (range === "7d") return new Date(now - 7 * 86400_000).toISOString();
  if (range === "30d") return new Date(now - 30 * 86400_000).toISOString();
  if (range === "90d") return new Date(now - 90 * 86400_000).toISOString();
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const { meta } = await requireAdmin(req, "support");
    const isSupport = meta.role === "support";

    const params = req.nextUrl.searchParams;
    const range = params.get("range") ?? "30d";
    const filterUser = (params.get("user") ?? "").trim().toLowerCase();
    const filterAction = (params.get("action") ?? "all").trim();
    const feedPage = Math.max(1, Number(params.get("feedPage") ?? 1) || 1);
    const rawSize = Number(params.get("feedPageSize") ?? 25);
    const feedPageSize = rawSize === 10 || rawSize === 50 ? rawSize : 25;
    const feedSort = params.get("feedSort") === "oldest" ? "oldest" : "newest";

    let sinceDate: Date | null = null;
    if (range === "24h") sinceDate = new Date(Date.now() - 24 * 3600_000);
    else if (range === "7d") sinceDate = new Date(Date.now() - 7 * 86400_000);
    else if (range === "30d") sinceDate = new Date(Date.now() - 30 * 86400_000);

    const sinceIso = sinceDate?.toISOString();

    const [users, usageEvents, policy, adminAuditLogs, campaignsRes, leadsRes, activityRes] = await Promise.all([
      listAdminUsersDirectory(),
      listAiUsageEvents({ sinceIso, limit: 3000 }),
      getInternalPlatformPolicy(),
      listAdminAuditLogs(150),
      supabaseServer
        ? supabaseServer.from("campaigns").select("id, owner_id, created_at")
        : Promise.resolve({ data: [] }),
      supabaseServer
        ? supabaseServer.from("leads").select("id, owner_id, created_at")
        : Promise.resolve({ data: [] }),
      supabaseServer
        ? (() => {
            let q = supabaseServer
              .from("audit_logs")
              .select("*")
              .neq("owner_id", "__platform_admin__")
              .neq("action", "ai_usage")
              .order("created_at", { ascending: feedSort === "oldest" })
              .limit(1000);
            if (sinceIso) q = q.gte("created_at", sinceIso);
            return q;
          })()
        : Promise.resolve({ data: [] }),
    ]);

    const userEmailById = new Map(users.map((u) => [u.ownerId, u.email]));

    const inRange = (iso: string) => (!sinceIso ? true : iso >= sinceIso);
    const newSignups = users.filter((u) => inRange(u.createdAt)).length;
    const activeUsers = users.filter((u) => inRange(u.lastActiveAt)).length;
    const campaignsCreated = (campaignsRes.data ?? []).filter((c) =>
      inRange(String((c as { created_at?: string }).created_at ?? "")),
    ).length;
    const prospectsFound = (leadsRes.data ?? []).filter((l) =>
      inRange(String((l as { created_at?: string }).created_at ?? "")),
    ).length;
    const analysesRun = usageEvents.filter((e) => e.feature === "analytics").length;
    const totalAiRequests = usageEvents.length;
    const totalEstimatedCost = usageEvents.reduce((sum, e) => sum + e.costUsd, 0);

    // Daily chart series (last 14 days)
    const dailyMap = new Map<string, { day: string; requests: number; signups: number; prospects: number }>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const day = d.toISOString().slice(0, 10);
      dailyMap.set(day, { day, requests: 0, signups: 0, prospects: 0 });
    }
    for (const ev of usageEvents) {
      const day = ev.createdAt.slice(0, 10);
      const slot = dailyMap.get(day);
      if (slot) slot.requests += 1;
    }
    for (const u of users) {
      const day = u.createdAt.slice(0, 10);
      const slot = dailyMap.get(day);
      if (slot) slot.signups += 1;
    }
    for (const l of leadsRes.data ?? []) {
      const day = String((l as { created_at?: string }).created_at ?? "").slice(0, 10);
      const slot = dailyMap.get(day);
      if (slot) slot.prospects += 1;
    }

    const healthAndAlerts = await computePlatformHealthAndAlerts(users, usageEvents, policy);

    let liveFeed = (activityRes.data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const ownerId = String(r.owner_id ?? "");
      return {
        id: String(r.id ?? ""),
        ownerId,
        userEmail: userEmailById.get(ownerId) ?? ownerId,
        action: String(r.action ?? ""),
        entity: String(r.entity ?? ""),
        entityId: String(r.entity_id ?? ""),
        createdAt: String(r.created_at ?? ""),
      };
    });

    const distinctActions = Array.from(new Set(liveFeed.map((f) => f.action))).sort();

    if (filterUser) {
      liveFeed = liveFeed.filter(
        (f) => f.userEmail.toLowerCase().includes(filterUser) || f.ownerId.toLowerCase().includes(filterUser),
      );
    }
    if (filterAction !== "all") {
      liveFeed = liveFeed.filter((f) => f.action === filterAction);
    }

    const liveFeedTotal = liveFeed.length;
    const feedFrom = (feedPage - 1) * feedPageSize;
    const pagedFeed = liveFeed.slice(feedFrom, feedFrom + feedPageSize);

    return NextResponse.json(
      {
        kpis: {
          totalUsers: users.length,
          newSignups,
          activeUsers,
          campaignsCreated,
          analysesRun,
          prospectsFound,
          totalAiRequests,
          totalEstimatedCostUsd: isSupport ? null : Math.round(totalEstimatedCost * 100) / 100,
        },
        chartSeries: Array.from(dailyMap.values()),
        liveFeed: pagedFeed,
        liveFeedTotal,
        liveFeedPage: feedPage,
        liveFeedPageSize: feedPageSize,
        distinctActions,
        health: healthAndAlerts,
        adminAuditLogs,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "preview_clear_feed" | "clear_feed";
      range?: ClearRange;
      totpCode?: string;
    };

    const range: ClearRange =
      body.range === "7d" || body.range === "30d" || body.range === "90d" ? body.range : "all";
    const cutoffIso = cutoffForRange(range);

    if (body.action === "preview_clear_feed") {
      await requireAdmin(req, "admin");
      if (!supabaseServer) return NextResponse.json({ count: 0, range });
      let q = supabaseServer
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .neq("owner_id", "__platform_admin__")
        .neq("action", "ai_usage");
      if (cutoffIso) q = q.lt("created_at", cutoffIso);
      const { count, error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json(
        { count: count ?? 0, range },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    if (body.action === "clear_feed") {
      const ctx = await requireAdmin(req, "admin", {
        requireReauth: true,
        inlineTotpCode: body.totpCode,
      });
      if (!supabaseServer) return NextResponse.json({ removedCount: 0, range });
      let q = supabaseServer
        .from("audit_logs")
        .select("id")
        .neq("owner_id", "__platform_admin__")
        .neq("action", "ai_usage")
        .limit(5000);
      if (cutoffIso) q = q.lt("created_at", cutoffIso);
      const { data, error } = await q;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const ids = (data ?? [])
        .map((r) => String((r as { id?: string }).id ?? ""))
        .filter(Boolean);
      for (let i = 0; i < ids.length; i += 200) {
        await supabaseServer
          .from("audit_logs")
          .delete()
          .neq("owner_id", "__platform_admin__")
          .neq("action", "ai_usage")
          .in("id", ids.slice(i, i + 200));
      }

      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "activity_feed_cleared",
        targetType: "activity_feed",
        targetId: range,
        details: { range, removedCount: ids.length },
        req,
      });

      return NextResponse.json(
        { ok: true, removedCount: ids.length, range },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    return NextResponse.json({ error: "Unsupported overview action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
