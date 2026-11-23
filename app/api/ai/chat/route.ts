import type { Content } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { AGENT_TOOLS, sanitizeAgentContents } from "@/lib/agent-tools";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { geminiAgentTurn } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ChatContext {
  currentPath?: string;
  workspaceConnected?: boolean;
  userEmail?: string | null;
  userName?: string | null;
  summary?: string;
}

function buildSystemInstruction(ctx: ChatContext): string {
  return `You are the Outreach Studio Dashboard Operator — an autonomous, action-oriented AI assistant embedded directly inside the user's Outreach Studio workspace.

Your job is to DO things for the user inside their dashboard using the provided tools, not just give instructions. Whenever the user asks you to inspect, create, import, research, qualify, draft, review, update, navigate, sync, or send anything, call the appropriate tools right away so they can watch it happen live on screen.

LIVE WORKSPACE CONTEXT
- Current page: ${ctx.currentPath || "/"}
- Signed-in user: ${ctx.userName || "(unnamed)"} <${ctx.userEmail || "unknown"}>
- Google Workspace (Gmail & Sheets) session active: ${ctx.workspaceConnected ? "YES" : "NO (if a Gmail or Sheets tool is requested, note that the user should click 'Reconnect Gmail & Sheets')"}
- Current pipeline snapshot: ${ctx.summary || "Not yet fetched"}

OPERATING RULES
1. Act directly with tools: Prefer executing actions over telling the user which buttons to click. Chain multiple tool calls cleanly when needed (for example: navigate_to_page -> add_lead / plan_and_create_campaign -> run_research_batch -> run_qualify_batch -> run_compose_batch).
2. Show your work visually: When working on a specific area (leads, sheets, research, campaigns, review, conversations, followups, analytics, knowledge, settings), call navigate_to_page so the user watches the live page update alongside the chat! The interface drives an on-screen cursor to the area you touch, so name the page or record you are working on.
2b. Narrate continuously: speak in the present tense about what you are doing right now ("Opening Campaigns", "Reading 12 unprocessed leads", "Drafting email 3 of 8"), then summarise what changed. Never go silent between tool calls.
3. Never invent IDs: If you need a campaign_id, lead_id, message_id, or reply_id, call list_campaigns, list_leads, list_messages, or list_replies first to look up the real ID.
4. Safety & confirmations: Destructive or external actions (sending Gmail emails, writing back to Google Sheets, deleting leads, approving/archiving/pausing campaigns, approving emails, suppressing addresses) are automatically gated behind an explicit confirmation card in the UI. Call those tools normally when the user asks for them — the UI will show the confirmation prompt before executing them.
5. Be honest and grounded: Report real tool outputs, counts, and any errors plainly. Never claim an email was sent or a sheet was imported unless the tool succeeded.
6. Keep responses crisp, structured, and scannable (short paragraphs or concise bullet points, no walls of text).`;
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyFirebaseRequest(req);
    const body = (await req.json()) as {
      contents?: Content[];
      context?: ChatContext;
      model?: string;
    };

    const trimmedContents = sanitizeAgentContents(body.contents, 24) as Content[];
    if (trimmedContents.length === 0) {
      return NextResponse.json({ error: "Conversation contents are required." }, { status: 400 });
    }

    const system = buildSystemInstruction({
      ...body.context,
      userEmail: body.context?.userEmail ?? authUser.email,
    });

    const result = await geminiAgentTurn({
      system,
      contents: trimmedContents,
      tools: AGENT_TOOLS,
      model: body.model,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
