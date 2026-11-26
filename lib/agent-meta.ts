export const VALID_ROUTES = [
  "/",
  "/leads",
  "/sheets",
  "/research",
  "/campaigns",
  "/review",
  "/sent",
  "/conversations",
  "/followups",
  "/analytics",
  "/knowledge",
  "/integrations",
  "/settings",
] as const;

export type AppRoute = (typeof VALID_ROUTES)[number];

export interface AgentFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface AgentPart {
  text?: string;
  /** Base64 media (image or audio) attached to a user turn. */
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: AgentFunctionCall;
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface AgentContent {
  role: "user" | "model";
  parts: AgentPart[];
}

export interface AgentTurnResponse {
  text: string;
  functionCalls: AgentFunctionCall[];
  modelContent: AgentContent | null;
  modelUsed: string;
}

/**
 * Safely trims and normalizes multi-turn Gemini function-calling history so:
 * - Every functionResponse.response is a plain JSON object (required by Gemini API).
 * - Trimming never starts mid-exchange on a model turn or a functionResponse turn.
 */
export function sanitizeAgentContents(contents: unknown, maxTurns = 24): AgentContent[] {
  if (!Array.isArray(contents)) return [];

  const cleaned: AgentContent[] = [];
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { role?: unknown; parts?: unknown };
    const role: "user" | "model" = raw.role === "model" ? "model" : "user";
    if (!Array.isArray(raw.parts)) continue;

    const parts: AgentPart[] = [];
    for (const p of raw.parts) {
      if (!p || typeof p !== "object") continue;
      const part = p as AgentPart;
      if (part.functionResponse && typeof part.functionResponse === "object") {
        const resp = part.functionResponse.response;
        const safeResp: Record<string, unknown> =
          resp && typeof resp === "object" && !Array.isArray(resp)
            ? resp
            : { result: resp ?? null };
        parts.push({
          functionResponse: {
            ...(part.functionResponse.id ? { id: String(part.functionResponse.id) } : {}),
            name: String(part.functionResponse.name || "tool"),
            response: safeResp,
          },
        });
      } else if (part.functionCall && typeof part.functionCall === "object") {
        parts.push({
          ...(part.thought !== undefined ? { thought: part.thought } : {}),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          functionCall: {
            ...(part.functionCall.id ? { id: String(part.functionCall.id) } : {}),
            name: String(part.functionCall.name || "tool"),
            args:
              part.functionCall.args &&
              typeof part.functionCall.args === "object" &&
              !Array.isArray(part.functionCall.args)
                ? part.functionCall.args
                : {},
          },
        });
      } else if (part.inlineData && typeof part.inlineData === "object") {
        const mimeType = String(part.inlineData.mimeType || "");
        const data = String(part.inlineData.data || "");
        const allowed = /^(image\/(png|jpe?g|webp|gif)|audio\/(webm|ogg|mpeg|mp4|wav|mp3|x-m4a))$/i.test(mimeType);
        // 8 MB of base64 is ~6 MB of media: enough for a photo or a voice note.
        if (allowed && data.length > 0 && data.length <= 8_000_000) {
          parts.push({ inlineData: { mimeType, data } });
        }
      } else if (typeof part.text === "string" || part.thoughtSignature) {
        parts.push({
          ...(typeof part.text === "string" ? { text: part.text } : {}),
          ...(part.thought !== undefined ? { thought: part.thought } : {}),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    }

    if (parts.length > 0) {
      cleaned.push({ role, parts });
    }
  }

  let sliced = cleaned.length > maxTurns ? cleaned.slice(-maxTurns) : cleaned;
  // Ensure the history starts cleanly on a plain user text turn, never a model or functionResponse turn
  while (
    sliced.length > 0 &&
    (sliced[0].role !== "user" || sliced[0].parts.some((p) => Boolean(p.functionResponse)))
  ) {
    sliced = sliced.slice(1);
  }
  return sliced;
}

/**
 * Validates and normalizes the JSON response from POST /api/ai/chat so the UI
 * can never crash with a null/malformed dereference.
 */
export function normalizeAgentTurnResponse(raw: unknown): {
  text: string;
  functionCalls: AgentFunctionCall[];
  modelContent: AgentContent;
  modelUsed: string;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("The operator received an empty response from the server. Please try again.");
  }
  const obj = raw as Partial<AgentTurnResponse> & { error?: unknown };
  if (typeof obj.error === "string" && obj.error.trim()) {
    throw new Error(obj.error.trim());
  }

  const text = typeof obj.text === "string" ? obj.text : "";
  const functionCalls = Array.isArray(obj.functionCalls)
    ? obj.functionCalls.filter((fc): fc is AgentFunctionCall => Boolean(fc && typeof fc === "object" && fc.name))
    : [];
  const modelUsed = typeof obj.modelUsed === "string" ? obj.modelUsed : "";

  const hasValidModelContent =
    obj.modelContent &&
    typeof obj.modelContent === "object" &&
    Array.isArray(obj.modelContent.parts) &&
    obj.modelContent.parts.length > 0;

  const modelContent: AgentContent = hasValidModelContent
    ? {
        role: "model",
        parts: obj.modelContent!.parts,
      }
    : {
        role: "model",
        parts: [
          ...(text ? [{ text }] : []),
          ...functionCalls.map((fc) => ({ functionCall: fc })),
        ],
      };

  return { text, functionCalls, modelContent, modelUsed };
}

export function sanitizeRoute(input: unknown): AppRoute {
  const raw = String(input ?? "/").trim().toLowerCase();
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const matched = VALID_ROUTES.find((r) => r === normalized);
  return matched ?? "/";
}

export const MUTATING_TOOLS = new Set<string>([
  "update_master_knowledge",
  "add_knowledge_source",
  "save_knowledge_note",
  "add_lead",
  "update_lead",
  "move_leads_to_campaign",
  "delete_lead",
  "discover_prospects",
  "import_google_sheet",
  "writeback_sheet_statuses",
  "plan_and_create_campaign",
  "manage_campaign",
  "run_research_batch",
  "run_qualify_batch",
  "run_compose_batch",
  "run_followups_batch",
  "edit_or_regenerate_message",
  "approve_message",
  "approve_all_messages",
  "send_approved_emails",
  "sync_gmail_replies",
  "mark_reply_handled",
  "update_settings",
  "suppress_email",
]);

export function isConfirmationRequired(toolName: string, args?: Record<string, unknown>): boolean {
  if (
    toolName === "send_approved_emails" ||
    toolName === "writeback_sheet_statuses" ||
    toolName === "delete_lead" ||
    toolName === "approve_message" ||
    toolName === "approve_all_messages" ||
    toolName === "suppress_email"
  ) {
    return true;
  }
  if (toolName === "manage_campaign") {
    const action = String(args?.action ?? "").toLowerCase();
    return action === "approve" || action === "pause" || action === "archive";
  }
  return false;
}

export function getConfirmationPrompt(
  toolName: string,
  args?: Record<string, unknown>,
): { title: string; detail: string; confirmLabel: string; tone: "warn" | "bad" } {
  switch (toolName) {
    case "send_approved_emails":
      return {
        title: "Send approved emails via Gmail",
        detail: `This will send up to ${Number(args?.limit) || 2} approved outreach email(s) to real prospects from your connected Gmail account${args?.campaign_id ? ` for campaign ${String(args.campaign_id)}` : ""}.`,
        confirmLabel: "Confirm & send via Gmail",
        tone: "warn",
      };
    case "writeback_sheet_statuses":
      return {
        title: "Write statuses back to Google Sheets",
        detail: `This will update the Status column in the linked Google Sheet for campaign ${String(args?.campaign_id ?? "")}. Existing columns will not be overwritten.`,
        confirmLabel: "Confirm & update Sheet",
        tone: "warn",
      };
    case "delete_lead":
      return {
        title: "Permanently delete prospect",
        detail: `This will permanently delete lead ${String(args?.lead_id ?? "")} and all associated messages and replies.`,
        confirmLabel: "Confirm delete",
        tone: "bad",
      };
    case "approve_message":
      return {
        title: "Approve email for sending",
        detail: `Mark message ${String(args?.message_id ?? "")} as approved and ready for Gmail dispatch.`,
        confirmLabel: "Approve email",
        tone: "warn",
      };
    case "approve_all_messages":
      return {
        title: "Bulk approve campaign emails",
        detail: `Approve all pending emails in campaign ${String(args?.campaign_id ?? "")} so they become eligible for Gmail sending.`,
        confirmLabel: "Approve all pending",
        tone: "warn",
      };
    case "suppress_email":
      return {
        title: "Add address to suppression list",
        detail: `Permanently block ${String(args?.email ?? "")} from receiving any future outreach emails.`,
        confirmLabel: "Suppress address",
        tone: "bad",
      };
    case "manage_campaign": {
      const action = String(args?.action ?? "");
      return {
        title: `${action.charAt(0).toUpperCase() + action.slice(1)} campaign`,
        detail: `Apply "${action}" to campaign ${String(args?.campaign_id ?? "")}.`,
        confirmLabel: `Confirm ${action}`,
        tone: action === "archive" ? "bad" : "warn",
      };
    }
    default:
      return {
        title: "Confirm action",
        detail: describeToolCall(toolName, args),
        confirmLabel: "Confirm",
        tone: "warn",
      };
  }
}

export function describeToolCall(toolName: string, args?: Record<string, unknown>): string {
  const a = args ?? {};
  switch (toolName) {
    case "navigate_to_page":
      return `Open ${sanitizeRoute(a.route)}`;
    case "get_dashboard_overview":
      return "Read dashboard pipeline summary";
    case "get_analytics_summary":
      return a.include_ai_review ? "Load analytics & run AI performance review" : "Load analytics metrics";
    case "get_knowledge_base":
      return "Read business knowledge base & sources";
    case "update_master_knowledge":
      return a.append ? "Append to master knowledge base" : "Update master knowledge base";
    case "add_knowledge_source":
      return `Add knowledge source "${String(a.label ?? "Source")}"`;
    case "save_knowledge_note":
      return `Save knowledge note "${String(a.title ?? "Note")}"`;
    case "list_leads":
      return `List leads${a.status ? ` (${String(a.status)})` : ""}${a.search ? ` matching "${String(a.search)}"` : ""}`;
    case "add_lead":
      return `Add lead "${String(a.business ?? a.email ?? "Prospect")}"`;
    case "update_lead":
      return `Update lead ${String(a.lead_id ?? "")}`;
    case "delete_lead":
      return `Delete lead ${String(a.lead_id ?? "")}`;
    case "discover_prospects":
      return `Discover ${Number(a.count) || 5} prospects in "${String(a.industry ?? "target market")}"`;
    case "inspect_google_sheet":
      return "Inspect Google Sheet worksheets & columns";
    case "import_google_sheet":
      return `Import up to ${Number(a.limit) || 50} prospects from Google Sheet`;
    case "writeback_sheet_statuses":
      return "Write campaign statuses back to Google Sheet";
    case "list_campaigns":
      return "List campaigns & live counts";
    case "plan_and_create_campaign":
      return a.auto_create === false ? "Plan campaign with Gemini" : "Plan & create campaign";
    case "manage_campaign":
      return `${String(a.action ?? "Update")} campaign ${String(a.campaign_id ?? "")}`;
    case "run_research_batch":
      return `Run prospect research batch (up to ${Number(a.limit) || 2})`;
    case "run_qualify_batch":
      return `Run qualification batch (up to ${Number(a.limit) || 3})`;
    case "run_compose_batch":
      return `Draft outreach emails (up to ${Number(a.limit) || 2})`;
    case "run_followups_batch":
      return `Prepare due follow-ups (up to ${Number(a.limit) || 2})`;
    case "list_messages":
      return `List emails${a.status ? ` (${String(a.status)})` : ""}`;
    case "edit_or_regenerate_message":
      return `${String(a.action ?? "Update")} email ${String(a.message_id ?? "")}`;
    case "approve_message":
      return `Approve email ${String(a.message_id ?? "")}`;
    case "approve_all_messages":
      return "Approve all pending emails in campaign";
    case "send_approved_emails":
      return `Send approved emails via Gmail (up to ${Number(a.limit) || 2})`;
    case "sync_gmail_replies":
      return "Sync & classify Gmail replies";
    case "list_replies":
      return `List prospect replies${a.filter ? ` (${String(a.filter)})` : ""}`;
    case "mark_reply_handled":
      return `Mark reply ${a.handled ? "handled" : "unhandled"}`;
    case "get_settings":
      return "Read sender settings & suppression list";
    case "update_settings":
      return "Update sender & outreach settings";
    case "suppress_email":
      return `Suppress ${String(a.email ?? "address")}`;
    case "test_gemini_connection":
      return "Test Gemini AI connection";
    default:
      return toolName.replace(/_/g, " ");
  }
}
