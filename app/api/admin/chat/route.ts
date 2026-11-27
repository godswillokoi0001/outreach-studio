import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { normalizeAgentTurnResponse, type AgentContent, type AgentFunctionCall } from "@/lib/agent-meta";
import { handleApiError } from "@/lib/api-helpers";
import { LLMGateway } from "@/lib/llm/gateway";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  ADMIN_ASSISTANT_TOOLS,
  ADMIN_CHAT_CONFIRM_TOOLS,
  clearAdminChatConversations,
  createNewAdminConversation,
  executeAdminChatTool,
  listAdminChatConversations,
  redactAdminChatText,
  saveAdminChatConversation,
  type AdminChatConversation,
  type AdminChatMessage,
} from "@/lib/platform/admin-chat";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ADMIN_ASSISTANT_SYSTEM = `You are the Knowrevo Platform Admin AI Assistant — a focused internal Site Reliability & Security Engineer.

STRICT RULES:
1. You ONLY assist verified administrators inside the Admin Console.
2. Evidence discipline: clearly distinguish CONFIRMED FACTS returned by diagnostic tools ("Confirmed:") from hypotheses ("Likely cause:"). Never invent telemetry, table rows, or file contents you did not observe.
3. Read-only diagnostics (get_system_health, list_recent_admin_notifications, list_background_jobs, read_audit_and_error_logs, run_cleanup_scan) execute automatically.
4. Any state change or remediation (rerun_module_check, clear_stuck_job, retry_failed_job, mark_notification_resolved, propose_code_or_config_fix) pauses for explicit admin confirmation ("Apply this fix?").
5. Secrets & Privacy: NEVER output API keys, hashes, TOTP secrets, cookies, or private user content. Always treat redacted tokens as confidential.
6. Code fixes MUST be presented as clean before -> after diffs inside propose_code_or_config_fix — never pretend edits have already been written to disk.`;

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "admin");
    const conversations = await listAdminChatConversations(ctx.admin.id);
    return NextResponse.json(
      { conversations },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "admin");
    const body = (await req.json().catch(() => ({}))) as {
      action?: "send" | "confirm_action" | "clear_history";
      conversationId?: string;
      message?: string;
      supportCaseId?: string;
      approved?: boolean;
      pendingAction?: {
        assistantMsgId: string;
        modelContent: AgentContent;
        baseHistory: AgentContent[];
        priorResponses: { id?: string; name: string; response: Record<string, unknown> }[];
        gatedCalls: AgentFunctionCall[];
      };
    };

    if (body.action === "clear_history") {
      await clearAdminChatConversations(ctx.admin.id);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_ai_chat_history_cleared",
        targetType: "admin_chat",
        targetId: ctx.admin.id,
        req,
      });
      return NextResponse.json({ ok: true, conversations: [] });
    }

    const existingList = await listAdminChatConversations(ctx.admin.id);
    let conv: AdminChatConversation | undefined = body.conversationId
      ? existingList.find((c) => c.id === body.conversationId)
      : undefined;

    if (body.action === "confirm_action" && body.pendingAction) {
      if (!conv) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      const startedAt = Date.now();
      const gatedResponses: { id?: string; name: string; response: Record<string, unknown> }[] = [];
      const toolActionLogs: NonNullable<AdminChatMessage["toolActions"]> = [];
      const proposedDiffs: NonNullable<AdminChatMessage["proposedDiffs"]> = [];

      for (const fc of body.pendingAction.gatedCalls) {
        const toolName = fc.name ?? "unknown";
        const args = (fc.args && typeof fc.args === "object" ? fc.args : {}) as Record<string, unknown>;
        if (!body.approved) {
          gatedResponses.push({
            id: fc.id,
            name: toolName,
            response: { cancelled_by_admin: true },
          });
          toolActionLogs.push({
            id: `act_${randomBytes(3).toString("hex")}`,
            name: toolName,
            status: "cancelled",
            summary: "Declined by administrator.",
            args,
          });
          continue;
        }

        const res = await executeAdminChatTool({
          name: toolName,
          args,
          adminId: ctx.admin.id,
          adminEmail: ctx.admin.email,
          adminRole: ctx.admin.role,
          supportCaseId: body.supportCaseId,
        });
        gatedResponses.push({
          id: fc.id,
          name: toolName,
          response: res.data,
        });
        toolActionLogs.push({
          id: `act_${randomBytes(3).toString("hex")}`,
          name: toolName,
          status: res.ok ? "done" : "error",
          summary: res.summary,
          args,
        });
        if (toolName === "propose_code_or_config_fix" && res.data.proposal) {
          proposedDiffs.push(
            res.data.proposal as NonNullable<AdminChatMessage["proposedDiffs"]>[number],
          );
        }
      }

      const responseTurn: AgentContent = {
        role: "user",
        parts: [...body.pendingAction.priorResponses, ...gatedResponses].map((r) => ({
          functionResponse: {
            ...(r.id ? { id: r.id } : {}),
            name: r.name,
            response: r.response,
          },
        })),
      };

      const nextHistory = [
        ...body.pendingAction.baseHistory,
        body.pendingAction.modelContent,
        responseTurn,
      ];

      const rawTurn = await LLMGateway.agentTurn({
        ownerId: "__platform_admin__",
        taskType: "balanced",
        feature: "admin_assistant",
        maxTokens: 1600,
        systemPrompt: ADMIN_ASSISTANT_SYSTEM,
        messages: [],
        agentContents: nextHistory,
        tools: ADMIN_ASSISTANT_TOOLS,
      });
      const turn = normalizeAgentTurnResponse(rawTurn);
      const finalContents = [...nextHistory, turn.modelContent];
      const safeText = redactAdminChatText(
        turn.text.trim() || "Action completed.",
        body.supportCaseId,
      );
      const elapsedMs = Math.max(100, Date.now() - startedAt);

      conv = {
        ...conv,
        contents: finalContents.slice(-36),
        messages: conv.messages.map((m) =>
          m.id === body.pendingAction!.assistantMsgId
            ? {
                ...m,
                text: safeText,
                responseTimeMs: elapsedMs,
                toolActions: [
                  ...(m.toolActions ?? []).filter((t) => t.status !== "awaiting_confirmation"),
                  ...toolActionLogs,
                ],
                proposedDiffs: proposedDiffs.length > 0 ? proposedDiffs : m.proposedDiffs,
              }
            : m,
        ),
      };
      await saveAdminChatConversation(conv);
      return NextResponse.json({
        conversation: conv,
        pendingAction: null,
        conversations: [conv, ...existingList.filter((c) => c.id !== conv!.id)],
      });
    }

    // Normal "send" message
    const text = String(body.message ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }
    if (!conv) {
      conv = createNewAdminConversation(ctx.admin.id, text);
    }

    const startedAt = Date.now();
    const userMsg: AdminChatMessage = {
      id: `au_${Date.now().toString(36)}`,
      role: "user",
      text: redactAdminChatText(text, body.supportCaseId),
      createdAt: new Date().toISOString(),
    };
    const assistantMsgId = `aa_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;

    let workingHistory: AgentContent[] = [
      ...conv.contents.slice(-24),
      { role: "user", parts: [{ text }] },
    ];
    const readActions: NonNullable<AdminChatMessage["toolActions"]> = [];
    let pendingAction: {
      assistantMsgId: string;
      modelContent: AgentContent;
      baseHistory: AgentContent[];
      priorResponses: { id?: string; name: string; response: Record<string, unknown> }[];
      gatedCalls: AgentFunctionCall[];
    } | null = null;
    let finalText = "";

    for (let round = 0; round < 5; round += 1) {
      const rawTurn = await LLMGateway.agentTurn({
        ownerId: "__platform_admin__",
        taskType: "balanced",
        feature: "admin_assistant",
        maxTokens: 1600,
        systemPrompt: ADMIN_ASSISTANT_SYSTEM,
        messages: [],
        agentContents: workingHistory,
        tools: ADMIN_ASSISTANT_TOOLS,
      });
      const turn = normalizeAgentTurnResponse(rawTurn);

      if (turn.functionCalls.length === 0) {
        workingHistory = [...workingHistory, turn.modelContent];
        finalText = turn.text.trim();
        break;
      }

      const safeCalls: AgentFunctionCall[] = [];
      const gatedCalls: AgentFunctionCall[] = [];
      for (const fc of turn.functionCalls) {
        if (ADMIN_CHAT_CONFIRM_TOOLS.has(fc.name ?? "")) {
          gatedCalls.push(fc);
        } else {
          safeCalls.push(fc);
        }
      }

      const responses: { id?: string; name: string; response: Record<string, unknown> }[] = [];
      for (const fc of safeCalls) {
        const res = await executeAdminChatTool({
          name: fc.name ?? "",
          args: (fc.args && typeof fc.args === "object" ? fc.args : {}) as Record<string, unknown>,
          adminId: ctx.admin.id,
          adminEmail: ctx.admin.email,
          adminRole: ctx.admin.role,
          supportCaseId: body.supportCaseId,
        });
        readActions.push({
          id: `act_${randomBytes(3).toString("hex")}`,
          name: fc.name ?? "",
          status: res.ok ? "done" : "error",
          summary: res.summary,
        });
        responses.push({
          id: fc.id,
          name: fc.name ?? "",
          response: res.data,
        });
      }

      if (gatedCalls.length > 0) {
        for (const fc of gatedCalls) {
          readActions.push({
            id: `act_${randomBytes(3).toString("hex")}`,
            name: fc.name ?? "",
            status: "awaiting_confirmation",
            summary: `Awaiting confirmation to run ${fc.name}`,
            args: (fc.args && typeof fc.args === "object" ? fc.args : {}) as Record<string, unknown>,
          });
        }
        pendingAction = {
          assistantMsgId,
          modelContent: turn.modelContent,
          baseHistory: workingHistory,
          priorResponses: responses,
          gatedCalls,
        };
        finalText =
          turn.text.trim() ||
          `I am ready to run ${gatedCalls.map((g) => g.name).join(", ")}. Confirm below before applying this fix.`;
        break;
      }

      const responseTurn: AgentContent = {
        role: "user",
        parts: responses.map((r) => ({
          functionResponse: {
            ...(r.id ? { id: r.id } : {}),
            name: r.name,
            response: r.response,
          },
        })),
      };
      workingHistory = [...workingHistory, turn.modelContent, responseTurn];
    }

    const responseTimeMs = Math.max(100, Date.now() - startedAt);
    const assistantMsg: AdminChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      text: redactAdminChatText(finalText || "Analysis complete.", body.supportCaseId),
      createdAt: new Date().toISOString(),
      responseTimeMs,
      toolActions: readActions.length > 0 ? readActions : undefined,
    };

    conv = {
      ...conv,
      contents: workingHistory.slice(-36),
      messages: [...conv.messages, userMsg, assistantMsg],
    };
    await saveAdminChatConversation(conv);

    return NextResponse.json(
      {
        conversation: conv,
        pendingAction,
        conversations: [conv, ...existingList.filter((c) => c.id !== conv!.id)],
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
