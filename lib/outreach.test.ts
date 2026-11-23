import assert from "node:assert/strict";
import test from "node:test";
import { mapHeaders, normalizeEmail, normalizeWebsite } from "./columns";
import {
  buildRawEmail,
  checkSendWindow,
  cleanEmailText,
  columnLetter,
  computeAnalyticsMetrics,
  computeDashboardStats,
  findFollowupCandidatesFromData,
  isFetchableUrl,
  parseSheetUrl,
  sanitizeFirestoreId,
  validateEmail,
} from "./outreach-utils";
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  parseGeminiError,
  resolveModel,
} from "./gemini-utils";
import { DEFAULT_SETTINGS, type Campaign, type Lead, type Message, type Reply } from "./types";

test("mapHeaders maps typical spreadsheet headers without collisions", () => {
  const mapping = mapHeaders(["Company Name", "Contact Person", "Work Email", "Web URL", "Sector"]);
  assert.equal(mapping.business, 0);
  assert.equal(mapping.contact_name, 1);
  assert.equal(mapping.email, 2);
  assert.equal(mapping.website, 3);
  assert.equal(mapping.industry, 4);
});

test("normalizeEmail and normalizeWebsite handle common formatting variants", () => {
  assert.equal(normalizeEmail("  mailto:Founder@Acme.IO "), "founder@acme.io");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeWebsite("acme.com/"), "https://acme.com");
  assert.equal(normalizeWebsite("n/a"), null);
});

test("sanitizeFirestoreId keeps valid Firestore document IDs within bounds", () => {
  const id = sanitizeFirestoreId("user+test@example.com", "sup");
  assert.match(id, /^sup_[a-z0-9_-]+$/);
  assert.ok(id.length <= 128);
});

test("parseSheetUrl and columnLetter parse sheet IDs and Excel-style columns", () => {
  const parsed = parseSheetUrl(
    "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=12345",
  );
  assert.equal(parsed.spreadsheetId, "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
  assert.equal(parsed.gid, "12345");
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
});

test("cleanEmailText, validateEmail, and buildRawEmail format clean outreach messages", () => {
  const cleaned = cleanEmailText("**Hello**\n\n- bullet one\n\n\n\nSecond paragraph.");
  assert.ok(!cleaned.includes("**"));
  const shortErr = validateEmail("Quick note", "Too short");
  assert.ok(shortErr !== null);

  const validBody =
    "Hi Sarah, I reviewed your clinic website today and noticed the mobile booking form requires horizontal scrolling on phones. Would updating that flow before next quarter be useful for your team?";
  assert.equal(validateEmail("Mobile booking flow", validBody), null);

  const raw = buildRawEmail({
    to: "sarah@clinic.com",
    from: "alex@studio.com",
    fromName: "Alex",
    subject: "Mobile booking flow",
    body: validBody,
    rfcMessageId: "<test@studio.com>",
    unsubscribeEmail: "alex@studio.com",
  });
  assert.ok(raw.includes("List-Unsubscribe: <mailto:alex@studio.com?subject=unsubscribe>"));
  assert.ok(raw.includes("Content-Transfer-Encoding: base64"));
});

test("checkSendWindow respects configured hours and days", () => {
  // 2025-01-06 is Monday (day 1). 10:00 UTC + 60m offset = 11:00 local.
  const mon11 = Date.UTC(2025, 0, 6, 10, 0, 0);
  const ok = checkSendWindow({ ...DEFAULT_SETTINGS, timezone_offset: 60 }, mon11);
  assert.equal(ok.allowed, true);
  assert.equal(ok.localTime, "11:00");

  // Sunday 2025-01-05 should be blocked under Mon-Fri settings
  const sun11 = Date.UTC(2025, 0, 5, 10, 0, 0);
  const weekend = checkSendWindow({ ...DEFAULT_SETTINGS, timezone_offset: 60 }, sun11);
  assert.equal(weekend.allowed, false);
});

test("isFetchableUrl blocks SSRF internal hosts and allows public HTTPS URLs", () => {
  assert.equal(isFetchableUrl("https://example.com"), true);
  assert.equal(isFetchableUrl("http://127.0.0.1:3000"), false);
  assert.equal(isFetchableUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isFetchableUrl("ftp://example.com"), false);
});

test("computeDashboardStats, computeAnalyticsMetrics, and findFollowupCandidatesFromData aggregate pipeline state", () => {
  const now = Date.UTC(2025, 0, 15, 12, 0, 0);
  const fiveDaysAgo = new Date(now - 5 * 86_400_000).toISOString();
  const campaign: Campaign = {
    id: "camp_1",
    name: "Clinics Q1",
    instruction: "Target clinics",
    config: {
      services: ["Website redesign"],
      target_industry: "Clinics",
      objective: "Book calls",
      tone: "direct",
      min_score: 55,
      lead_count: 10,
      send_limit: 50,
      interval_seconds: 45,
      followup_days: [4, 9],
      auto_approve_initial: false,
      auto_approve_followups: false,
      require_approval: true,
      identity: "company",
      extra_instructions: "",
    },
    status: "approved",
    sheet_source: null,
    created_at: fiveDaysAgo,
    approved_at: fiveDaysAgo,
    updated_at: fiveDaysAgo,
  };
  const leads: Lead[] = [
    {
      id: "lead_1",
      campaign_id: "camp_1",
      business: "North Clinic",
      contact_name: "Sarah",
      role: "Owner",
      email: "sarah@northclinic.com",
      email_norm: "sarah@northclinic.com",
      website: "https://northclinic.com",
      phone: null,
      location: "Austin",
      industry: "Healthcare",
      notes: null,
      extra: null,
      source: "manual",
      source_ref: null,
      sheet_row: null,
      status: "sent",
      score: 82,
      priority: "high",
      score_reason: null,
      research: null,
      research_at: fiveDaysAgo,
      research_ok: true,
      manual_research: null,
      last_contacted_at: fiveDaysAgo,
      created_at: fiveDaysAgo,
      updated_at: fiveDaysAgo,
    },
  ];
  const messages: Message[] = [
    {
      id: "msg_1",
      lead_id: "lead_1",
      campaign_id: "camp_1",
      step: 1,
      kind: "initial",
      subject: "Booking flow",
      body: "Hello Sarah...",
      angle: "Mobile form",
      rationale: "Evidence",
      service: "Website redesign",
      status: "sent",
      gmail_id: "gm_1",
      thread_id: "th_1",
      rfc_message_id: "<1@test>",
      sent_at: fiveDaysAgo,
      error: null,
      approved_at: fiveDaysAgo,
      created_at: fiveDaysAgo,
      updated_at: fiveDaysAgo,
    },
  ];
  const replies: Reply[] = [];

  const due = findFollowupCandidatesFromData({ leads, campaigns: [campaign], messages, replies, nowMs: now });
  assert.equal(due.length, 1);
  assert.equal(due[0].step, 2);

  const dash = computeDashboardStats({
    leads,
    campaigns: [campaign],
    messages,
    replies,
    sendLogs: [],
    auditLogs: [],
  });
  assert.equal(dash.emails.sent, 1);
  assert.equal(dash.leads.qualified, 1);

  const metrics = computeAnalyticsMetrics({ leads, campaigns: [campaign], messages, replies });
  assert.equal(metrics.delivery.sent, 1);
  assert.equal(metrics.totals.leads, 1);
});

test("resolveModel normalizes models/ prefix and maps deprecated models safely", () => {
  assert.equal(resolveModel("models/gemini-4-hydrogen"), "gemini-4-hydrogen");
  assert.equal(resolveModel("gemini-1.5-flash"), DEFAULT_GEMINI_MODEL);
  assert.equal(resolveModel("gemini-2.0-flash"), DEFAULT_GEMINI_MODEL);
  assert.equal(resolveModel("gemini-3.1-flash-lite"), FALLBACK_GEMINI_MODEL);
  assert.equal(resolveModel(""), DEFAULT_GEMINI_MODEL);
});

test("parseGeminiError turns raw 429 RESOURCE_EXHAUSTED JSON into actionable message", () => {
  const rawJson = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
      details: [{ retryDelay: "8s" }],
    },
  });
  const parsed = parseGeminiError(new Error(rawJson));
  assert.equal(parsed.status, 429);
  assert.equal(parsed.retryAfterMs, 8000);
  assert.ok(!parsed.message.startsWith("{"));
  assert.ok(parsed.message.includes("Settings > Secrets"));
  assert.ok(parsed.message.includes("Gemini 3.1 Flash Lite"));
});
