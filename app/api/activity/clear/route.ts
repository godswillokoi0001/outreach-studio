import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { AuthError, verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);

    const body = (await req.json().catch(() => ({}))) as {
      range?: "all" | "7d" | "30d";
    };

    const range = body.range || "all";
    let auditQuery = supabaseServer
      .from("audit_logs")
      .delete()
      .eq("owner_id", user.ownerId);

    let eventQuery = supabaseServer
      .from("lead_events")
      .delete()
      .eq("owner_id", user.ownerId);

    if (range === "7d") {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      auditQuery = auditQuery.lt("created_at", cutoff);
      eventQuery = eventQuery.lt("created_at", cutoff);
    } else if (range === "30d") {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      auditQuery = auditQuery.lt("created_at", cutoff);
      eventQuery = eventQuery.lt("created_at", cutoff);
    }

    const [auditRes, eventRes] = await Promise.all([
      auditQuery,
      eventQuery,
    ]);

    if (auditRes.error) {
      throw new Error(`Failed to clear activity logs: ${auditRes.error.message}`);
    }
    if (eventRes.error) {
      console.warn("[activity/clear] lead_events notice:", eventRes.error.message);
    }

    return NextResponse.json({ ok: true, range });
  } catch (err) {
    return handleApiError(err);
  }
}
