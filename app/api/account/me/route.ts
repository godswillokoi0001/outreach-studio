import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { getUserGovernance, listActiveAnnouncementsForUser } from "@/lib/platform/store-server";
import { verifyRequest } from "@/lib/server-auth";
import { getUserAvatarStateServer } from "@/lib/server-avatar";
import { userHasPasswordServer } from "@/lib/server-password";
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
    const [meta, hasPassword, avatarState] = await Promise.all([
      getUserGovernance(user.ownerId, user.email, {
        name: user.name,
        avatarUrl: user.avatarUrl,
      }),
      userHasPasswordServer(user.ownerId),
      getUserAvatarStateServer(user.ownerId, user.avatarUrl),
    ]);

    let onboardingStatus: "not_started" | "in_progress" | "completed" = "not_started";
    let onboardingStep = 1;

    if (supabaseServer) {
      const [onbRes, kbCountRes, campCountRes] = await Promise.all([
        supabaseServer
          .from("knowledge")
          .select("content")
          .eq("id", `system_onboarding_${user.ownerId}`)
          .eq("owner_id", user.ownerId)
          .maybeSingle(),
        supabaseServer
          .from("knowledge")
          .select("id", { count: "exact", head: true })
          .eq("owner_id", user.ownerId)
          .neq("content", "")
          .not("category", "like", "system_%")
          .not("category", "like", "growth_advisor_%"),
        supabaseServer
          .from("campaigns")
          .select("id", { count: "exact", head: true })
          .eq("owner_id", user.ownerId),
      ]);

      try {
        const raw = (onbRes.data as { content?: string } | null)?.content;
        if (raw) {
          const parsed = JSON.parse(raw) as { status?: string; currentStep?: number };
          if (parsed.status === "completed") onboardingStatus = "completed";
          else if (parsed.status === "in_progress") onboardingStatus = "in_progress";
          if (typeof parsed.currentStep === "number") {
            onboardingStep = Math.max(1, Math.min(12, parsed.currentStep));
          }
        } else if ((kbCountRes.count ?? 0) > 0 || (campCountRes.count ?? 0) > 0) {
          onboardingStatus = "completed";
          onboardingStep = 12;
        }
      } catch {
        onboardingStatus = "not_started";
      }
    }

    const announcements = await listActiveAnnouncementsForUser(
      user.ownerId,
      onboardingStatus === "completed",
    );

    // Zero admin hints leaked into the user-facing response.
    return NextResponse.json(
      {
        user: {
          uid: user.ownerId,
          ownerId: user.ownerId,
          email: user.email,
          displayName: user.name,
          photoURL: avatarState.effectivePhotoUrl,
          googlePhotoURL: avatarState.googleAvatarUrl,
          avatarSource: avatarState.avatarSource,
          hasPassword,
          emailVerified: true,
          status: meta.status,
          onboardingStatus,
          onboardingStep,
        },
        announcements,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
