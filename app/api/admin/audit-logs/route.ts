import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import { appendAdminAuditLog } from "@/lib/platform/store-server";
import type { AdminAuditEntry, AdminRole } from "@/lib/platform/types";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const PLATFORM_AUDIT_OWNER = "__platform_admin__";

type ClearRange = "all" | "7d" | "30d" | "90d";

function cutoffForRange(range: ClearRange): string | null {
  const now = Date.now();
  if (range === "7d") return new Date(now - 7 * 86400_000).toISOString();
  if (range === "30d") return new Date(now - 30 * 86400_000).toISOString();
  if (range === "90d") return new Date(now - 90 * 86400_000).toISOString();
  return null;
}

function mapAuditRow(row: Record<string, unknown>): AdminAuditEntry & { isPermanent?: boolean } {
  const detail = (
    row.detail && typeof row.detail === "object" ? row.detail : {}
  ) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    actorId: String(detail.actorId ?? ""),
    actorEmail: String(detail.actorEmail ?? ""),
    actorRole: (String(detail.actorRole ?? "admin") as AdminRole) || "admin",
    action: String(row.action ?? ""),
    targetType: String(row.entity ?? ""),
    targetId: String(row.entity_id ?? ""),
    details: detail,
    ipAddress: String(detail.ipAddress ?? "unknown"),
    userAgent: String(detail.userAgent ?? "unknown"),
    createdAt: String(row.created_at ?? ""),
    isPermanent: Boolean(detail.isPermanent),
  };
}

function escapeCsvCell(v: unknown): string {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "support");

    const params = req.nextUrl.searchParams;
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    const rawSize = Number(params.get("pageSize") ?? 25);
    const pageSize = rawSize === 10 || rawSize === 50 ? rawSize : 25;
    const search = (params.get("search") ?? "").trim().toLowerCase();
    const roleFilter = (params.get("role") ?? "all").trim();
    const sort = params.get("sort") === "oldest" ? "oldest" : "newest";
    const format = params.get("format");

    if (!supabaseServer) {
      return NextResponse.json({ entries: [], totalCount: 0, page, pageSize });
    }

    // Fetch filtered window server-side; when search/role filter is empty, use pure SQL range + count
    if (!search && roleFilter === "all" && format !== "csv") {
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, count, error } = await supabaseServer
        .from("audit_logs")
        .select("*", { count: "exact" })
        .eq("owner_id", PLATFORM_AUDIT_OWNER)
        .order("created_at", { ascending: sort === "oldest" })
        .range(from, to);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const entries = (data ?? []).map((r) => mapAuditRow(r as Record<string, unknown>));
      return NextResponse.json(
        {
          entries,
          totalCount: count ?? entries.length,
          page,
          pageSize,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const { data, error } = await supabaseServer
      .from("audit_logs")
      .select("*")
      .eq("owner_id", PLATFORM_AUDIT_OWNER)
      .order("created_at", { ascending: sort === "oldest" })
      .limit(2000);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    let mapped = (data ?? []).map((r) => mapAuditRow(r as Record<string, unknown>));
    if (roleFilter !== "all") {
      mapped = mapped.filter((e) => e.actorRole === roleFilter);
    }
    if (search) {
      mapped = mapped.filter(
        (e) =>
          e.actorEmail.toLowerCase().includes(search) ||
          e.action.toLowerCase().includes(search) ||
          e.targetType.toLowerCase().includes(search) ||
          e.targetId.toLowerCase().includes(search) ||
          e.ipAddress.toLowerCase().includes(search),
      );
    }

    if (format === "csv") {
      const lines = [
        ["Timestamp", "Actor Email", "Role", "Action", "Target Type", "Target ID", "IP", "Permanent"].join(","),
        ...mapped.map((e) =>
          [
            escapeCsvCell(e.createdAt),
            escapeCsvCell(e.actorEmail),
            escapeCsvCell(e.actorRole),
            escapeCsvCell(e.action),
            escapeCsvCell(e.targetType),
            escapeCsvCell(e.targetId),
            escapeCsvCell(e.ipAddress),
            escapeCsvCell(e.isPermanent ? "yes" : "no"),
          ].join(","),
        ),
      ].join("\n");

      return new NextResponse(lines, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="admin-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "private, no-store, max-age=0",
        },
      });
    }

    const totalCount = mapped.length;
    const from = (page - 1) * pageSize;
    const entries = mapped.slice(from, from + pageSize);

    return NextResponse.json(
      { entries, totalCount, page, pageSize },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req, "super_admin");
    const body = (await req.json().catch(() => ({}))) as {
      action?: "preview_clear" | "clear";
      range?: ClearRange;
      totpCode?: string;
    };

    const range: ClearRange =
      body.range === "7d" || body.range === "30d" || body.range === "90d" ? body.range : "all";
    const cutoffIso = cutoffForRange(range);

    if (body.action === "preview_clear") {
      await requireAdmin(req, "super_admin");
      if (!supabaseServer) {
        return NextResponse.json({ count: 0, range });
      }
      const { data, error } = await supabaseServer
        .from("audit_logs")
        .select("id, created_at, detail")
        .eq("owner_id", PLATFORM_AUDIT_OWNER)
        .limit(5000);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const matching = (data ?? []).filter((row) => {
        const r = row as { created_at?: string; detail?: Record<string, unknown> };
        if (r.detail && Boolean(r.detail.isPermanent)) return false;
        if (cutoffIso && String(r.created_at ?? "") >= cutoffIso) return false;
        return true;
      });
      return NextResponse.json(
        { count: matching.length, range },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    if (body.action === "clear") {
      const ctx = await requireAdmin(req, "super_admin", {
        requireReauth: true,
        inlineTotpCode: body.totpCode,
      });
      if (!supabaseServer) {
        return NextResponse.json({ removedCount: 0, range });
      }
      const { data, error } = await supabaseServer
        .from("audit_logs")
        .select("id, created_at, detail")
        .eq("owner_id", PLATFORM_AUDIT_OWNER)
        .limit(5000);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const idsToDelete = (data ?? [])
        .filter((row) => {
          const r = row as { id?: string; created_at?: string; detail?: Record<string, unknown> };
          if (r.detail && Boolean(r.detail.isPermanent)) return false;
          if (cutoffIso && String(r.created_at ?? "") >= cutoffIso) return false;
          return Boolean(r.id);
        })
        .map((row) => String((row as { id: string }).id));

      for (let i = 0; i < idsToDelete.length; i += 200) {
        const chunk = idsToDelete.slice(i, i + 200);
        await supabaseServer
          .from("audit_logs")
          .delete()
          .eq("owner_id", PLATFORM_AUDIT_OWNER)
          .in("id", chunk);
      }

      const clearedAtIso = new Date().toISOString();
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "audit_log_cleared",
        targetType: "audit_log",
        targetId: range,
        details: {
          isPermanent: true,
          range,
          removedCount: idsToDelete.length,
          summary: `Audit log cleared by ${ctx.admin.email} on ${clearedAtIso}, ${idsToDelete.length} entries removed`,
        },
        req,
      });

      return NextResponse.json(
        {
          ok: true,
          removedCount: idsToDelete.length,
          range,
          summary: `Audit log cleared by ${ctx.admin.email} on ${clearedAtIso}, ${idsToDelete.length} entries removed`,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    return NextResponse.json({ error: "Unsupported audit log action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
