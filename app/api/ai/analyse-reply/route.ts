import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { analyseReplyServer } from "@/lib/intelligence";
import { findCancellableFollowupMessageIds } from "@/lib/guardrails";
import { supabaseServer } from "@/lib/supabase-server";
import type { Lead, Message, Settings } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      replyText?: string;
      lead?: Lead;
      settings?: Settings;
      knowledge?: string;
      model?: string;
      threadMessages?: Message[];
      applyHooks?: boolean;
    };
    if (!body.lead || !body.settings) {
      return NextResponse.json({ error: "Lead and settings are required." }, { status: 400 });
    }

    // Fetch full thread messages server-side (strictly scoped to caller's owner_id) when omitted.
    let threadMessages = Array.isArray(body.threadMessages) ? body.threadMessages : [];
    if (threadMessages.length === 0 && supabaseServer && body.lead.id) {
      try {
        const { data } = await supabaseServer
          .from("messages")
          .select("id, owner_id, lead_id, campaign_id, step, kind, subject, body, status, sent_at, created_at, updated_at")
          .eq("owner_id", user.ownerId)
          .eq("lead_id", body.lead.id)
          .order("created_at", { ascending: true })
          .limit(20);
        threadMessages = ((data ?? []) as Message[]) ?? [];
      } catch {
        threadMessages = [];
      }
    }

    const analysis = await runWithAiConfig(aiConfig, () =>
      analyseReplyServer(
        String(body.replyText ?? ""),
        body.lead!,
        body.settings!,
        body.knowledge ?? "",
        body.model ?? body.settings!.model,
        {
          ownerId: user.ownerId,
          threadMessages,
        },
      ),
    );

    // Phase 5 Reply-Class Automation Hooks (R1-R7 halt active follow-ups; R8 suppresses globally).
    if (body.applyHooks !== false && supabaseServer && body.lead.id) {
      try {
        const nowIso = new Date().toISOString();
        const { data: leadMsgs } = await supabaseServer
          .from("messages")
          .select("id, lead_id, kind, status")
          .eq("owner_id", user.ownerId)
          .eq("lead_id", body.lead.id);

        const toCancel = findCancellableFollowupMessageIds(
          ((leadMsgs ?? []) as Pick<Message, "id" | "lead_id" | "kind" | "status">[]),
          body.lead.id,
        );

        if (toCancel.length > 0) {
          await supabaseServer
            .from("messages")
            .update({
              status: "cancelled",
              error:
                analysis.sequence_action === "SNOOZE" && analysis.snooze_until
                  ? `Snoozed until ${analysis.snooze_until} (${analysis.reply_class})`
                  : `Stopped automatically by reply triage (${analysis.reply_class} -> ${analysis.sequence_action})`,
              updated_at: nowIso,
            } as never)
            .eq("owner_id", user.ownerId)
            .in("id", toCancel);
        }

        if (analysis.sequence_action === "GLOBAL_SUPPRESS" && (body.lead.email_norm || body.lead.email)) {
          const emailNorm = String(body.lead.email_norm || body.lead.email).trim().toLowerCase();
          await supabaseServer.from("suppressions").upsert(
            {
              id: `sup_${emailNorm.replace(/[^a-z0-9_-]/g, "_").slice(0, 96)}`,
              owner_id: user.ownerId,
              email: emailNorm,
              reason: `Hard opt-out detected (${analysis.reply_class})`,
              updated_at: nowIso,
            } as never,
            { onConflict: "id" },
          );
        }
      } catch {
        // Non-fatal server hook safety; pipeline client also enforces locally.
      }
    }

    return NextResponse.json({ analysis });
  } catch (err) {
    return handleApiError(err);
  }
}
