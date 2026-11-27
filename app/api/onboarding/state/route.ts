import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  DEFAULT_ONBOARDING_ANSWERS,
  prefillAnswersFromUser,
  type OnboardingAnswers,
  type OnboardingState,
} from "@/lib/onboarding";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function onboardingDocId(ownerId: string): string {
  return `system_onboarding_${ownerId}`;
}

export async function loadOnboardingStateServer(
  ownerId: string,
  userHints?: { name?: string; email?: string; avatarUrl?: string | null },
): Promise<OnboardingState> {
  const nowIso = new Date().toISOString();
  const basePrefill = prefillAnswersFromUser(
    { ...DEFAULT_ONBOARDING_ANSWERS },
    userHints
      ? {
          uid: ownerId,
          ownerId,
          displayName: userHints.name || userHints.email?.split("@")[0] || "",
          email: userHints.email || "",
          photoURL: userHints.avatarUrl || "",
          emailVerified: true,
        }
      : null,
  );

  if (!supabaseServer) {
    return {
      status: "not_started",
      currentStep: 1,
      answers: basePrefill,
      updatedAt: nowIso,
    };
  }

  const { data } = await supabaseServer
    .from("knowledge")
    .select("content, updated_at")
    .eq("id", onboardingDocId(ownerId))
    .eq("owner_id", ownerId)
    .maybeSingle();

  const raw = (data as { content?: string } | null)?.content;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<OnboardingState>;
      const mergedAnswers: OnboardingAnswers = {
        ...basePrefill,
        ...(parsed.answers ?? {}),
      };
      return {
        status:
          parsed.status === "completed" || parsed.status === "in_progress" || parsed.status === "not_started"
            ? parsed.status
            : "not_started",
        currentStep:
          typeof parsed.currentStep === "number"
            ? Math.max(1, Math.min(12, Math.floor(parsed.currentStep)))
            : 1,
        answers: mergedAnswers,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt || nowIso,
        completedAt: parsed.completedAt,
      };
    } catch {
      /* fallback below */
    }
  }

  const [kbRes, campRes, leadRes] = await Promise.all([
    supabaseServer
      .from("knowledge")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId)
      .not("id", "like", "system_%"),
    supabaseServer
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId),
    supabaseServer
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId),
  ]);

  const isEstablished = (kbRes.count ?? 0) > 0 || (campRes.count ?? 0) > 0 || (leadRes.count ?? 0) > 0;
  return {
    status: isEstablished ? "completed" : "not_started",
    currentStep: isEstablished ? 12 : 1,
    answers: basePrefill,
    updatedAt: nowIso,
    completedAt: isEstablished ? nowIso : undefined,
  };
}

export async function saveOnboardingStateServer(
  ownerId: string,
  state: OnboardingState,
): Promise<OnboardingState> {
  const nowIso = new Date().toISOString();
  const next: OnboardingState = {
    status:
      state.status === "completed" || state.status === "in_progress" || state.status === "not_started"
        ? state.status
        : "in_progress",
    currentStep: Math.max(1, Math.min(12, Math.floor(Number(state.currentStep || 1)))),
    answers: { ...DEFAULT_ONBOARDING_ANSWERS, ...(state.answers ?? {}) },
    startedAt: state.startedAt || nowIso,
    updatedAt: nowIso,
    completedAt: state.status === "completed" ? state.completedAt || nowIso : undefined,
  };

  if (supabaseServer) {
    await supabaseServer.from("knowledge").upsert(
      {
        id: onboardingDocId(ownerId),
        owner_id: ownerId,
        category: "system_onboarding_state",
        title: "Onboarding Progress & Answers",
        content: JSON.stringify(next),
        sort: 999,
        is_master: false,
        updated_at: nowIso,
      } as never,
      { onConflict: "id" },
    );
  }
  return next;
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const state = await loadOnboardingStateServer(user.ownerId, {
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
    });
    return NextResponse.json(
      { state },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as Partial<OnboardingState>;
    const saved = await saveOnboardingStateServer(user.ownerId, {
      status: body.status ?? "in_progress",
      currentStep: typeof body.currentStep === "number" ? body.currentStep : 1,
      answers: { ...DEFAULT_ONBOARDING_ANSWERS, ...(body.answers ?? {}) },
      startedAt: body.startedAt,
      updatedAt: new Date().toISOString(),
      completedAt: body.completedAt,
    });
    return NextResponse.json(
      { state: saved },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
