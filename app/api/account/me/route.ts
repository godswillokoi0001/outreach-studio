import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { getUserGovernance, listActiveAnnouncementsForUser } from "@/lib/platform/store-server";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

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

  if (error && error.code !== "23505") {
    console.error("[account/me] could not create master knowledge:", error.message);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    await ensureMasterKnowledge(user.ownerId);
    const meta = await getUserGovernance(user.ownerId, user.email, {
      name: user.name,
      avatarUrl: user.avatarUrl,
    });

    let onboardingCompleted = false;
    if (supabaseServer) {
      const onb = await supabaseServer
        .from("knowledge")
        .select("content")
        .eq("id", `system_onboarding_${user.ownerId}`)
        .eq("owner_id", user.ownerId)
        .maybeSingle();
      try {
        const parsed = JSON.parse(String((onb.data as { content?: string } | null)?.content ?? "{}")) as {
          status?: string;
        };
        onboardingCompleted = parsed.status === "completed";
      } catch {
        onboardingCompleted = false;
      }
    }

    const announcements = await listActiveAnnouncementsForUser(user.ownerId, onboardingCompleted);

    return NextResponse.json(
      {
        user: {
          uid: user.ownerId,
          ownerId: user.ownerId,
          email: user.email,
          displayName: user.name,
          photoURL: user.avatarUrl,
          emailVerified: true,
          role: meta.role,
          status: meta.status,
          twoFactorEnabled: meta.totpEnabled,
        },
        announcements,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
