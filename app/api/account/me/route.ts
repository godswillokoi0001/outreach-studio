import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/** A new workspace needs the master knowledge row the editor writes to. */
async function ensureMasterKnowledge(ownerId: string): Promise<void> {
  if (!supabaseServer) return;

  const existing = await supabaseServer
    .from("knowledge")
    .select("id")
    .eq("owner_id", ownerId)
    .or("id.eq.master,is_master.eq.true,category.eq.master")
    .limit(1)
    .maybeSingle();

  if (existing.data) return;

  const { error } = await supabaseServer.from("knowledge").insert({
    id: `master_${ownerId}`,
    owner_id: ownerId,
    category: "master",
    title: "Master knowledge",
    content: "",
    sort: 0,
    is_master: true,
  } as never);

  // A concurrent first request can win the race; the row existing is all that matters.
  if (error && error.code !== "23505") {
    console.error("[account/me] could not create master knowledge:", error.message);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    await ensureMasterKnowledge(user.ownerId);

    return NextResponse.json(
      {
        user: {
          uid: user.ownerId,
          ownerId: user.ownerId,
          email: user.email,
          displayName: user.name,
          photoURL: user.avatarUrl,
          emailVerified: true,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
