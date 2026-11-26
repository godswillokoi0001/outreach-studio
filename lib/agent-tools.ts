import { Type, type FunctionDeclaration } from "@google/genai";
import { VALID_ROUTES } from "./agent-meta";

export {
  describeToolCall,
  getConfirmationPrompt,
  isConfirmationRequired,
  MUTATING_TOOLS,
  normalizeAgentTurnResponse,
  sanitizeAgentContents,
  sanitizeRoute,
  VALID_ROUTES,
  type AgentContent,
  type AgentFunctionCall,
  type AgentPart,
  type AgentTurnResponse,
  type AppRoute,
} from "./agent-meta";

export const AGENT_TOOLS: FunctionDeclaration[] = [
  {
    name: "navigate_to_page",
    description:
      "Navigate the user's visible dashboard to a specific page so they can watch changes happen live on screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route: {
          type: Type.STRING,
          enum: [...VALID_ROUTES],
          description: "Target dashboard route path.",
        },
      },
      required: ["route"],
    },
  },
  {
    name: "get_dashboard_overview",
    description:
      "Read live dashboard counts: leads by status, campaigns with metrics, emails waiting/sent/failed, replies, follow-ups due, and recent activity.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        detail: {
          type: Type.STRING,
          description: "Optional note on what to focus on.",
        },
      },
    },
  },
  {
    name: "get_analytics_summary",
    description: "Fetch measured funnel, campaign, industry, angle, and reply analytics; optionally generate a Gemini AI performance review.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        include_ai_review: {
          type: Type.BOOLEAN,
          description: "If true, also generate an AI performance analysis from the measured metrics.",
        },
      },
    },
  },
  {
    name: "get_knowledge_base",
    description: "Read the user's master business knowledge, additional notes, and configured URL/text sources.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        include_content: {
          type: Type.BOOLEAN,
          description: "Whether to include full text previews (defaults to true).",
        },
      },
    },
  },
  {
    name: "update_master_knowledge",
    description: "Save or append business information (offers, ICP, proof, tone, rules) to the master knowledge base.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        content: {
          type: Type.STRING,
          description: "Knowledge text to save or append.",
        },
        append: {
          type: Type.BOOLEAN,
          description: "If true, appends to existing master knowledge instead of replacing it.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "add_knowledge_source",
    description: "Add a website URL or pasted document text to the knowledge base sources.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        label: { type: Type.STRING, description: "Short label, e.g. 'Pricing page' or 'Case study'." },
        kind: { type: Type.STRING, enum: ["url", "text"], description: "Source type." },
        url: { type: Type.STRING, description: "Public HTTPS URL when kind is 'url'." },
        content: { type: Type.STRING, description: "Document text when kind is 'text'." },
      },
      required: ["label", "kind"],
    },
  },
  {
    name: "save_knowledge_note",
    description: "Create or update an additional knowledge note (objections, policies, testimonials).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Note title." },
        content: { type: Type.STRING, description: "Note body text." },
        id: { type: Type.STRING, description: "Optional existing note ID to update." },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "list_leads",
    description: "Search or list prospects/leads in the workspace with their IDs, statuses, scores, emails, and campaign IDs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: "Optional status filter (e.g. 'new', 'queued_research', 'researched', 'qualified', 'sent', 'replied').",
        },
        search: {
          type: Type.STRING,
          description: "Optional search term matching business, contact name, email, industry, or location.",
        },
        campaign_id: { type: Type.STRING, description: "Optional campaign ID filter." },
        limit: { type: Type.INTEGER, description: "Max leads to return (1-50, default 20)." },
      },
    },
  },
  {
    name: "add_lead",
    description: "Add a new prospect/lead manually to the workspace, optionally assigning them to a campaign.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        business: { type: Type.STRING, description: "Business or company name." },
        email: { type: Type.STRING, description: "Contact email address." },
        contact_name: { type: Type.STRING, description: "Contact person's name." },
        role: { type: Type.STRING, description: "Contact person's role or title." },
        website: { type: Type.STRING, description: "Website URL." },
        location: { type: Type.STRING, description: "City, state, or country." },
        industry: { type: Type.STRING, description: "Industry or vertical." },
        notes: { type: Type.STRING, description: "Any notes about this prospect." },
        campaign_id: { type: Type.STRING, description: "Optional campaign ID to assign immediately." },
      },
      required: ["business"],
    },
  },
  {
    name: "update_lead",
    description: "Update a lead's status, manual research observations, or notes, or requeue them for fresh AI research.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lead_id: { type: Type.STRING, description: "The lead ID." },
        status: {
          type: Type.STRING,
          enum: [
            "new",
            "queued_research",
            "qualified",
            "disqualified",
            "needs_research",
            "converted",
            "email_generated",
            "approved",
          ],
          description: "Optional new status.",
        },
        manual_research: { type: Type.STRING, description: "Optional manual research observations." },
        notes: { type: Type.STRING, description: "Optional notes." },
        requeue_research: {
          type: Type.BOOLEAN,
          description: "If true, clears old research and requeues the lead for fresh research.",
        },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "delete_lead",
    description: "Permanently delete a lead and all its messages and replies. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lead_id: { type: Type.STRING, description: "The lead ID to delete." },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "discover_prospects",
    description:
      "Use Gemini with Google Search grounding to find real businesses matching an industry/location/focus, and optionally save them straight into Leads.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        industry: { type: Type.STRING, description: "Target industry or niche, e.g. 'dental clinics'." },
        location: { type: Type.STRING, description: "City, region, or country." },
        count: { type: Type.INTEGER, description: "Number of prospects to find (3-15, default 5)." },
        focus: { type: Type.STRING, description: "Optional focus criteria (e.g. outdated websites)." },
        save_to_leads: {
          type: Type.BOOLEAN,
          description: "If true, automatically saves all discovered prospects into the user's Leads list.",
        },
        campaign_id: {
          type: Type.STRING,
          description: "Optional campaign ID to assign saved leads to.",
        },
      },
      required: ["industry"],
    },
  },
  {
    name: "inspect_google_sheet",
    description: "Read worksheet tabs and optionally preview rows and auto-mapped columns from a Google Sheet URL.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Full Google Sheets URL." },
        tab: { type: Type.STRING, description: "Optional worksheet tab name to preview." },
      },
      required: ["url"],
    },
  },
  {
    name: "import_google_sheet",
    description: "Import prospects from a Google Sheet URL into Leads (skipping duplicate emails) and optionally assign to a campaign.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Full Google Sheets URL." },
        tab: { type: Type.STRING, description: "Optional worksheet tab name (defaults to first tab)." },
        limit: { type: Type.INTEGER, description: "Maximum number of rows to import (1-500, default 50)." },
        campaign_id: { type: Type.STRING, description: "Optional campaign ID to assign imported leads to." },
      },
      required: ["url"],
    },
  },
  {
    name: "writeback_sheet_statuses",
    description: "Write current campaign prospect statuses back to the Status column of the linked Google Sheet. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Campaign ID linked to a Google Sheet." },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "list_campaigns",
    description: "List all outreach campaigns with their IDs, status, target services, min score, and lead/sent/pending/reply counts.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        include_archived: { type: Type.BOOLEAN, description: "Whether to include archived campaigns." },
      },
    },
  },
  {
    name: "plan_and_create_campaign",
    description:
      "Turn a plain-English goal into a structured outreach campaign using Gemini, create it in the workspace, and import its sheet or assign matching unprocessed leads.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instruction: {
          type: Type.STRING,
          description: "Detailed campaign goal / instruction (at least 8 characters).",
        },
        auto_create: {
          type: Type.BOOLEAN,
          description: "Defaults to true (creates the campaign immediately). Set false to only preview the plan.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "manage_campaign",
    description:
      "Assign unprocessed leads to a campaign, or approve, pause, resume, or archive a campaign. Approve, pause, and archive require explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Target campaign ID." },
        action: {
          type: Type.STRING,
          enum: ["assign", "approve", "pause", "resume", "archive"],
          description: "Action to perform on the campaign.",
        },
      },
      required: ["campaign_id", "action"],
    },
  },
  {
    name: "run_research_batch",
    description: "Fetch prospect websites and run AI prospect research for leads queued for research.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Optional campaign ID scope." },
        limit: { type: Type.INTEGER, description: "How many leads to research in this batch (1-5, default 2)." },
      },
    },
  },
  {
    name: "run_qualify_batch",
    description: "Score and qualify researched prospects against campaign criteria.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Optional campaign ID scope." },
        limit: { type: Type.INTEGER, description: "How many leads to qualify in this batch (1-6, default 3)." },
      },
    },
  },
  {
    name: "run_compose_batch",
    description: "Draft personalized initial cold outreach emails for qualified prospects and place them in the Email Review queue.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Optional campaign ID scope." },
        limit: { type: Type.INTEGER, description: "How many emails to draft in this batch (1-5, default 2)." },
      },
    },
  },
  {
    name: "run_followups_batch",
    description: "Draft scheduled follow-up emails for prospects who are due and have not replied.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Optional campaign ID scope." },
        limit: { type: Type.INTEGER, description: "How many follow-ups to draft (1-5, default 2)." },
      },
    },
  },
  {
    name: "list_messages",
    description: "List drafted, pending approval, approved, sent, or failed emails with their IDs, prospects, subjects, and bodies.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: "Optional status filter: 'pending_approval', 'approved', 'sent', 'failed', 'cancelled', or 'all'.",
        },
        campaign_id: { type: Type.STRING, description: "Optional campaign ID filter." },
        limit: { type: Type.INTEGER, description: "Max messages to return (1-30, default 15)." },
      },
    },
  },
  {
    name: "edit_or_regenerate_message",
    description: "Edit a drafted email's subject/body, regenerate it with Gemini AI, or reject/cancel it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        message_id: { type: Type.STRING, description: "Message ID." },
        action: {
          type: Type.STRING,
          enum: ["edit", "regenerate", "reject"],
          description: "Action to take on the email.",
        },
        subject: { type: Type.STRING, description: "Updated subject (required for 'edit')." },
        body: { type: Type.STRING, description: "Updated email body (required for 'edit')." },
      },
      required: ["message_id", "action"],
    },
  },
  {
    name: "approve_message",
    description: "Approve a specific email so it is ready to be sent via Gmail. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        message_id: { type: Type.STRING, description: "Message ID to approve." },
      },
      required: ["message_id"],
    },
  },
  {
    name: "approve_all_messages",
    description: "Approve all pending emails in a campaign. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Campaign ID whose pending emails should be approved." },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "send_approved_emails",
    description: "Send approved emails through the user's connected Gmail account, obeying send windows and daily limits. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        campaign_id: { type: Type.STRING, description: "Optional campaign ID scope." },
        limit: { type: Type.INTEGER, description: "How many approved emails to send (1-5, default 2)." },
      },
    },
  },
  {
    name: "sync_gmail_replies",
    description: "Check the user's connected Gmail inbox for replies and bounces from prospects, classify them with Gemini, and generate suggested replies.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: "Max inbox messages to inspect (default 15)." },
      },
    },
  },
  {
    name: "list_replies",
    description: "List synced prospect replies along with their classification, summary, and suggested draft reply.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filter: {
          type: Type.STRING,
          enum: ["all", "needs_attention", "positive", "pricing", "objection", "unsubscribe"],
          description: "Reply filter (defaults to 'all').",
        },
      },
    },
  },
  {
    name: "mark_reply_handled",
    description: "Mark a prospect reply as handled or unhandled.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reply_id: { type: Type.STRING, description: "Reply ID." },
        handled: { type: Type.BOOLEAN, description: "True to mark handled, false to mark unhandled." },
      },
      required: ["reply_id", "handled"],
    },
  },
  {
    name: "get_settings",
    description: "Read the user's sender identity, daily/campaign sending limits, sending window, Gemini model, and suppression list.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        include_suppressions: { type: Type.BOOLEAN, description: "Include suppressed addresses (defaults to true)." },
      },
    },
  },
  {
    name: "update_settings",
    description: "Update sender profile, sending limits, sending hours/days, timezone offset, minimum qualification score, or Gemini model.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        sender_name: { type: Type.STRING },
        sender_role: { type: Type.STRING },
        sender_company: { type: Type.STRING },
        sender_email: { type: Type.STRING },
        physical_address: { type: Type.STRING },
        daily_limit: { type: Type.INTEGER },
        campaign_limit: { type: Type.INTEGER },
        interval_seconds: { type: Type.INTEGER },
        send_window_start: { type: Type.INTEGER },
        send_window_end: { type: Type.INTEGER },
        send_days: { type: Type.STRING, description: "Comma-separated 1..7 (1=Mon, 7=Sun)." },
        timezone_offset: { type: Type.INTEGER, description: "Offset in minutes from UTC." },
        followup_days: { type: Type.INTEGER },
        min_score: { type: Type.INTEGER },
        model: {
          type: Type.STRING,
          description:
            "Model id from the provider connected in Settings > AI engine (for example gemini-3.5-flash or gpt-4o-mini).",
        },
      },
    },
  },
  {
    name: "suppress_email",
    description: "Add an email address to the permanent suppression list so it is never contacted again. Requires explicit user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        email: { type: Type.STRING, description: "Email address to suppress." },
        reason: { type: Type.STRING, description: "Reason for suppression." },
      },
      required: ["email"],
    },
  },
  {
    name: "test_gemini_connection",
    description: "Run a quick live connectivity and latency test against the AI provider connected in Settings.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        model: { type: Type.STRING, description: "Optional model ID override." },
      },
    },
  },
];
