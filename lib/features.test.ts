import assert from "node:assert/strict";
import test from "node:test";
import { clearAllAccountClientData, syncActiveOwnerSessionMarker } from "./client-cleanup";
import { NextRequest } from "next/server";
import { sanitizeAgentContents } from "./agent-meta";
import {
  computeJobProgressAndEta,
  isJobStalled,
  JOB_STALL_MS,
  type BackgroundJobStep,
} from "./background-jobs";
import {
  DEFAULT_CRITERIA,
  INDUSTRY_OPTIONS,
  SERVICE_OPTIONS,
  criteriaSummary,
  criteriaToFocus,
  sanitizeCriteria,
} from "./criteria";
import { GEO_COUNTRIES, citiesIn, geoLabel, geoSummary, statesIn } from "./geo";
import {
  computeProfileFingerprint,
  EMPTY_GROWTH_PROFILE,
  evaluateProfileCompleteness,
  hydrateGrowthProfileFromOnboarding,
} from "./growth-advisor";
import { generateTotpAt, generateTotpSecret, verifyTotpCode, encryptSecret, decryptSecret } from "./key-vault";
import { extractErrorCode, extractErrorMessage, handleApiError } from "./api-helpers";
import { LLMGateway, LLMGatewayError } from "./llm/gateway";
import {
  clearRouterStateForTests,
  evaluateKeyHeadroom,
  isChatCapableModelId,
  rankPoolCandidates,
  recordCandidateFailure,
  recordKeyUsageHit,
} from "./llm/router";
import { GatewayProviderError } from "./llm/providers";
import {
  encryptGatewayKey,
  getUserAiSettings,
  resetGatewayCachesForTests,
  seedGatewayCachesForTests,
} from "./llm/store";
import {
  clearDiscoveryCacheForTests,
  discoverProspectsServer,
} from "./intelligence";
import {
  parseDuckDuckGoHtml,
  WebSearchService,
} from "./search/webSearch";
import type { AdminAiKeyRecord, AdminAiSettings, UserAiKeyRecord } from "./llm/types";
import { DEFAULT_ONBOARDING_ANSWERS } from "./onboarding";
import { requireAdmin } from "./platform/admin-auth";
import { hashAdminPassword, verifyAdminPassword } from "./platform/admin-credentials";
import { signAdminCookieToken, verifyAdminCookieToken } from "./platform/admin-session";

test("sanitizeCriteria keeps only allowed options and clamps numbers", () => {
  const result = sanitizeCriteria(
    {
      industry: "Dentists & dental clinics",
      businessSize: "not a real size",
      services: [SERVICE_OPTIONS[0], "Invented service"],
      count: 400,
      minScore: -10,
      auto: true,
      autoRationale: "Best fit from the knowledge base",
    },
    DEFAULT_CRITERIA,
  );

  assert.equal(result.industry, "Dentists & dental clinics");
  assert.equal(result.businessSize, DEFAULT_CRITERIA.businessSize);
  assert.deepEqual(result.services, [SERVICE_OPTIONS[0]]);
  assert.equal(result.count, 20);
  assert.equal(result.minScore, 0);
  assert.equal(result.auto, true);
});

test("criteriaToFocus describes the brief for the discovery prompt", () => {
  const focus = criteriaToFocus({
    ...DEFAULT_CRITERIA,
    industry: INDUSTRY_OPTIONS[0],
    services: [SERVICE_OPTIONS[1]],
    onlinePresence: "No website at all",
    focus: "Only Lekki",
  });

  assert.match(focus, /Industry: Dentists & dental clinics/);
  assert.match(focus, /Services we want to pitch: Business website development/);
  assert.match(focus, /Online presence: No website at all/);
  assert.match(focus, /Only Lekki/);
});

test("criteriaSummary skips neutral defaults", () => {
  assert.deepEqual(criteriaSummary(DEFAULT_CRITERIA), []);
  assert.deepEqual(criteriaSummary({ ...DEFAULT_CRITERIA, industry: INDUSTRY_OPTIONS[2] }), [INDUSTRY_OPTIONS[2]]);
});

test("the bundled location dataset cascades country -> state -> city", () => {
  assert.ok(GEO_COUNTRIES.length >= 200, "dataset should hold every country");
  assert.ok(statesIn("Nigeria").includes("Lagos"), "Nigeria should list Lagos state");
  assert.ok(citiesIn("Nigeria", "Lagos").length > 0, "Lagos should list cities");
  assert.deepEqual(citiesIn("Nigeria", "Not a state"), []);
});

test("geoLabel and geoSummary build a readable location", () => {
  const selection = { continent: "Africa", country: "Nigeria", state: "Lagos", cities: ["Ikeja"], area: "Allen Avenue" };
  assert.equal(geoLabel(selection), "Ikeja, Allen Avenue, Lagos, Nigeria");
  assert.equal(geoSummary(selection), "Ikeja, Allen Avenue, Lagos, Nigeria");
  assert.equal(geoSummary({ ...selection, cities: [], area: "", state: "", country: "" }), "Africa");
});

test("sanitizeAgentContents keeps supported inline media and drops the rest", () => {
  const image = "A".repeat(64);
  const contents = sanitizeAgentContents([
    {
      role: "user",
      parts: [
        { text: "What is wrong with this screenshot?" },
        { inlineData: { mimeType: "image/png", data: image } },
        { inlineData: { mimeType: "text/html", data: "<p>no</p>" } },
        { inlineData: { mimeType: "audio/webm", data: image } },
      ],
    },
  ]);

  const parts = contents[0]?.parts ?? [];
  const media = parts.filter((part) => part.inlineData);
  assert.equal(media.length, 2);
  assert.equal(media[0]?.inlineData?.mimeType, "image/png");
  assert.equal(media[1]?.inlineData?.mimeType, "audio/webm");
  assert.ok(parts.some((part) => part.text?.includes("screenshot")));
});

test("sanitizeAgentContents rejects oversized media", () => {
  const huge = "A".repeat(8_000_001);
  const contents = sanitizeAgentContents([
    { role: "user", parts: [{ text: "big" }, { inlineData: { mimeType: "image/png", data: huge } }] },
  ]);
  assert.equal(contents[0]?.parts.filter((part) => part.inlineData).length, 0);
});

test("normalizeCandidate enforces evidence-based research and strict qualification verdict", async () => {
  const { normalizeCandidate } = await import("./intelligence");

  const rawCandidate = {
    business: "Bright Smile Dental",
    website: "https://brightsmiledental.example",
    city: "Austin",
    country: "United States",
    contact: {
      decision_maker_name: "Dr. Jane Smith",
      decision_maker_role: "Lead Dentist & Owner",
      email: "dr.smith@brightsmiledental.example",
      email_status: "Verified",
      phone: "+1 512 555 0199",
      phone_status: "Verified",
      socials: [
        { platform: "LinkedIn", url: "https://linkedin.com/company/brightsmile", verification_status: "Verified" },
      ],
      sources: [
        { url: "https://brightsmiledental.example/about", date_found: "2026-11-26", claim: "Found owner Dr. Jane Smith" },
      ],
    },
    qualification_review: {
      verdict: "qualified",
      criteria: [
        { name: "Website needs redesign", status: "met", evidence: "Site not mobile friendly" },
        { name: "Active dental business in Austin", status: "met", evidence: "Google business profile active" },
      ],
      weaknesses_and_risks: ["Small team of 4"],
      missing_information: ["No dedicated marketing contact"],
    },
  };

  const normalized = normalizeCandidate(rawCandidate);

  assert.equal(normalized.business, "Bright Smile Dental");
  assert.equal(normalized.contact.decision_maker, "Dr. Jane Smith");
  assert.equal(normalized.contact.email_status, "Verified");
  assert.equal(normalized.contact.phone_status, "Verified");
  assert.equal(normalized.contact.socials[0].platform, "LinkedIn");
  assert.equal(normalized.contact.socials[0].verification_status, "Verified");
  assert.equal(normalized.contact.sources[0].url, "https://brightsmiledental.example/about");
  assert.equal(normalized.qualification_review?.verdict, "qualified");
  assert.equal(normalized.qualification_review?.criteria.length, 2);
  assert.equal(normalized.qualification_review?.weaknesses_and_risks[0], "Small team of 4");
});

test("normalizeCandidate defaults missing or uncertain reviews honestly", async () => {
  const { normalizeCandidate } = await import("./intelligence");

  const rawMinimal = {
    business: "Unknown Cafe",
  };

  const normalized = normalizeCandidate(rawMinimal);

  assert.equal(normalized.business, "Unknown Cafe");
  assert.equal(normalized.contact.email_status, "Not found");
  assert.equal(normalized.contact.phone_status, "Not found");
  assert.equal(normalized.qualification_review?.verdict, "uncertain");
});

test("Growth Advisor profile completeness, fingerprinting, and staleness detection work accurately", async () => {
  const {
    EMPTY_GROWTH_PROFILE,
    computeProfileFingerprint,
    evaluateProfileCompleteness,
    isReportStale,
  } = await import("./growth-advisor");

  const settings = {
    sender_company: "Acme Digital",
    sender_name: "Alice",
    sender_role: "Founder",
    physical_address: "Austin, TX",
  };

  const incomplete = evaluateProfileCompleteness(EMPTY_GROWTH_PROFILE, "", settings);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missingFields.includes("What you sell or do"));
  assert.ok(incomplete.missingFields.includes("Industry"));

  const completeProfile = {
    whoYouAre: "Acme Digital",
    whatYouSell: "B2B SEO & Web Redesign",
    industry: "Dental Clinics",
    offer: "30-day patient conversion guarantee",
    priceRange: "$3,000 - $5,000",
    location: "Austin, TX",
    idealCustomer: "Multi-chair dental clinics",
  };

  const complete = evaluateProfileCompleteness(completeProfile, "", settings);
  assert.equal(complete.complete, true);
  assert.equal(complete.score, 100);

  const fp1 = computeProfileFingerprint({
    profile: completeProfile,
    knowledgeDigest: "",
    settings,
    metricsSummary: { leads: 10, campaigns: 1, sent: 5, replies: 1, positive: 1 },
  });
  const fp2 = computeProfileFingerprint({
    profile: { ...completeProfile, priceRange: "$5,000 - $10,000" },
    knowledgeDigest: "",
    settings,
    metricsSummary: { leads: 10, campaigns: 1, sent: 5, replies: 1, positive: 1 },
  });
  assert.notEqual(fp1, fp2);

  const freshReport = {
    overallStrategy: "Focus on Austin multi-chair clinics",
    profileFingerprint: fp1,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sources: [],
    recommendations: [
      {
        id: "rec_1",
        category: "location" as const,
        title: "Target Austin North",
        summary: "High dental expansion",
        reason: "New clinic openings",
        evidence: "Austin growth report",
        sourceUrl: "https://example.com",
        sourceTitle: "Example",
        impact: "high" as const,
        confidence: 88,
        priorityOrder: 1,
        suggestedAction: {
          targetIndustry: "Dental",
          targetLocation: "Austin, TX",
          targetAudience: "Clinic Owners",
          angle: "Patient booking lift",
          hook: "Saw your site",
          subjectLine: "Quick question",
          offer: "Free audit",
          channel: "Email",
          timing: "Tue 9am",
          goal: "5 calls",
        },
      },
    ],
  };

  assert.equal(isReportStale(freshReport, fp1), false);
  assert.equal(isReportStale(freshReport, fp2), true);
  assert.equal(
    isReportStale({ ...freshReport, expiresAt: new Date(Date.now() - 10_000).toISOString() }, fp1),
    true,
  );
});

test("Onboarding URL validation, user prefill, completeness scoring, and Markdown compiler", async () => {
  const {
    DEFAULT_ONBOARDING_ANSWERS,
    compileSectionsToMasterMarkdown,
    computeOnboardingCompleteness,
    normalizeUrlInput,
    prefillAnswersFromUser,
    validateUrlStrict,
  } = await import("./onboarding");

  assert.equal(validateUrlStrict("https://example.com"), true);
  assert.equal(validateUrlStrict("acme.co.uk"), true);
  assert.equal(validateUrlStrict("not-a-domain"), false);
  assert.equal(normalizeUrlInput("acme.com"), "https://acme.com");

  const prefilled = prefillAnswersFromUser(DEFAULT_ONBOARDING_ANSWERS, {
    uid: "u1",
    ownerId: "u1",
    email: "alice@acme.com",
    displayName: "Alice Johnson",
    photoURL: "https://example.com/photo.jpg",
    emailVerified: true,
  });
  assert.equal(prefilled.fullName, "Alice Johnson");
  assert.equal(prefilled.email, "alice@acme.com");
  assert.equal(prefilled.photoUrl, "https://example.com/photo.jpg");

  const emptyComp = computeOnboardingCompleteness(DEFAULT_ONBOARDING_ANSWERS);
  assert.equal(emptyComp.isEssentialsComplete, false);
  assert.ok(emptyComp.missingEssentials.length >= 4);

  const partialAnswers = {
    ...prefilled,
    roleTitle: "Founder",
    businessName: "Acme Web",
    industry: "Web Design",
    businessDescription: "We build clinic websites",
    priceRange: "$3,000",
    idealCustomerSummary: "Dental clinic owners",
  };
  const partialComp = computeOnboardingCompleteness(partialAnswers);
  assert.equal(partialComp.isEssentialsComplete, true);
  assert.ok(partialComp.score >= 40);

  const markdown = compileSectionsToMasterMarkdown([
    {
      id: "sec_1",
      key: "business_overview",
      title: "Business overview",
      content: "We help clinics grow.",
      provenance: "ai_generated",
      updatedAt: "2026-11-26T17:00:00Z",
    },
    {
      id: "sec_2",
      key: "proof",
      title: "Proof and credibility",
      content: "",
      provenance: "ai_generated",
      updatedAt: "2026-11-26T17:00:00Z",
    },
  ]);
  assert.match(markdown, /## Business overview\n\nWe help clinics grow\./);
  assert.match(markdown, /## Proof and credibility\n\nNot provided\./);
});

test("Key vault encrypts/decrypts AES-256-GCM, masks secrets, validates keys, and verifies TOTP & admin tokens", async () => {
  const {
    decryptSecret,
    encryptSecret,
    generateTotpAt,
    generateTotpSecret,
    issueAdmin2faToken,
    maskSecret,
    validateApiKeyInput,
    verifyAdmin2faToken,
    verifyTotpCode,
  } = await import("./key-vault");

  const secretKey = "sk-numes-v1-test998877665544332211a91f";
  const encrypted = encryptSecret(secretKey);
  assert.ok(encrypted.startsWith("enc:v1:"), "must encrypt with versioned AES-256-GCM format");
  assert.notEqual(encrypted, secretKey);
  assert.equal(decryptSecret(encrypted), secretKey);

  const masked = maskSecret(secretKey);
  assert.ok(masked.startsWith("sk-") && masked.endsWith("a91f"), `unexpected mask: ${masked}`);
  assert.ok(!masked.includes("99887766"), "masked secret must hide middle characters");

  assert.equal(validateApiKeyInput("short").ok, false);
  assert.equal(validateApiKeyInput("sk-good-key-1234567890").ok, true);
  assert.equal(validateApiKeyInput("sk-bad key\n123456").ok, false);

  const totpSecret = generateTotpSecret();
  const step = Math.floor(Date.now() / 1000 / 30);
  const code = generateTotpAt(totpSecret, step);
  assert.equal(code.length, 6);
  assert.equal(verifyTotpCode(totpSecret, code), true);
  assert.equal(verifyTotpCode(totpSecret, "000000"), code === "000000");

  const sessionTok = issueAdmin2faToken("user_123", "session", 600);
  assert.equal(verifyAdmin2faToken(sessionTok, "user_123", "session"), true);
  assert.equal(verifyAdmin2faToken(sessionTok, "user_456", "session"), false);
  assert.equal(verifyAdmin2faToken(sessionTok, "user_123", "reauth"), false);
});

test("Platform model catalog excludes disabled providers and disabled models", async () => {
  const { buildPublicPlatformModelList } = await import("./platform/store-server");
  const list = buildPublicPlatformModelList({
    providers: [
      {
        id: "gemini",
        label: "Google Gemini",
        enabled: true,
        hasKey: true,
        maskedKey: "AIza...1234",
        models: [
          { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", enabled: true },
          { id: "gemini-disabled", displayName: "Disabled Model", enabled: false },
        ],
      },
      {
        id: "openai",
        label: "OpenAI",
        enabled: false,
        hasKey: true,
        maskedKey: "sk-...5678",
        models: [{ id: "gpt-4o", displayName: "GPT-4o", enabled: true }],
      },
    ],
    featureDefaults: {
      analytics: { provider: "gemini", model: "gemini-2.5-flash" },
      growth_advisor: { provider: "gemini", model: "gemini-2.5-flash" },
      research: { provider: "gemini", model: "gemini-2.5-flash" },
      ask_ai: { provider: "gemini", model: "gemini-2.5-flash" },
      knowledge_base: { provider: "gemini", model: "gemini-2.5-flash" },
      email_compose: { provider: "gemini", model: "gemini-2.5-flash" },
      operator_chat: { provider: "gemini", model: "gemini-2.5-flash" },
    },
    fallbackChain: [],
    quotas: {
      dailyRequestsPerUser: 100,
      monthlyRequestsPerUser: 1500,
      dailyTokensPerUser: 300000,
      monthlyTokensPerUser: 4000000,
      rateLimitPerMinute: 25,
      monthlySpendCapUsd: 250,
      alertThresholdPct: 80,
    },
    updatedAt: new Date().toISOString(),
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].model, "gemini-2.5-flash");
});

test("Phase 7 (1 & 2): GlobalKnowledgeService caches in RAM across requests (1 DB read) & falls back safely", async () => {
  const {
    __configureGlobalKnowledgeForTest,
    getGlobalKnowledgeCacheStats,
    getGlobalKnowledgeModules,
    invalidateGlobalKnowledgeCache,
    publishGlobalKnowledgeVersion,
    rollbackGlobalKnowledgeVersion,
  } = await import("./global-knowledge/service");
  const { GLOBAL_KNOWLEDGE_SEED } = await import("./global-knowledge/seed");
  type StoreAdapter = import("./global-knowledge/service").GlobalKnowledgeStoreAdapter;
  type GlobalMod = import("./global-knowledge/types").GlobalKnowledgeModule;

  // Mock PostgreSQL store tracking exact reads & immutable version history
  let dbFetchCount = 0;
  const rows: GlobalMod[] = GLOBAL_KNOWLEDGE_SEED.map((s) => ({
    id: `uuid_${s.module_key}_v1`,
    module_key: s.module_key,
    title: s.title,
    version: 1,
    content: s.content,
    is_active: true,
    updated_by: "seed",
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
  }));

  const mockAdapter: StoreAdapter = {
    async fetchActiveModules() {
      dbFetchCount += 1;
      return rows.filter((r) => r.is_active);
    },
    async fetchAllVersions() {
      return [...rows];
    },
    async insertSeedModules() {
      return { inserted: 0, skipped: rows.length, updated: 0 };
    },
    async publishVersion({ moduleKey, title, content, updatedBy }) {
      const nextVer =
        Math.max(...rows.filter((r) => r.module_key === moduleKey).map((r) => r.version), 0) + 1;
      for (const r of rows) {
        if (r.module_key === moduleKey && r.is_active) r.is_active = false;
      }
      const created: GlobalMod = {
        id: `uuid_${moduleKey}_v${nextVer}`,
        module_key: moduleKey,
        title: title || "Updated Title",
        version: nextVer,
        content,
        is_active: true,
        updated_by: updatedBy ?? "admin",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.push(created);
      return created;
    },
    async rollbackVersion({ moduleKey, version, updatedBy }) {
      for (const r of rows) {
        if (r.module_key === moduleKey) {
          r.is_active = r.version === version;
          if (r.is_active && updatedBy) r.updated_by = updatedBy;
        }
      }
      return rows.find((r) => r.module_key === moduleKey && r.is_active)!;
    },
  };

  __configureGlobalKnowledgeForTest({ adapter: mockAdapter, ttlMs: 20 * 60 * 1000, resetStats: true });

  // 5 consecutive reads (including parallel calls) trigger only ONE DB read
  const [m1, m2] = await Promise.all([getGlobalKnowledgeModules(), getGlobalKnowledgeModules()]);
  const m3 = await getGlobalKnowledgeModules();
  const m4 = await getGlobalKnowledgeModules();
  const m5 = await getGlobalKnowledgeModules();
  assert.equal(dbFetchCount, 1);
  assert.equal(m1.size, 4);
  assert.equal(m2.size, 4);
  assert.equal(m5.get("module_1_prospecting_research_qualification")?.version, 1);
  assert.ok(getGlobalKnowledgeCacheStats().hits >= 3);

  // Admin publish invalidates RAM cache -> next read sees v2
  await publishGlobalKnowledgeVersion({
    moduleKey: "module_2_copywriting_psychology_deliverability",
    content: "# MODULE 2 UPDATED V2\nCustom updated copywriting guidance.",
    updatedBy: "super_admin@knowrevo",
  });
  const afterPublish = await getGlobalKnowledgeModules();
  assert.equal(dbFetchCount, 2);
  assert.equal(afterPublish.get("module_2_copywriting_psychology_deliverability")?.version, 2);

  // Rollback reverts to v1 and invalidates cache
  await rollbackGlobalKnowledgeVersion({
    moduleKey: "module_2_copywriting_psychology_deliverability",
    version: 1,
    updatedBy: "super_admin@knowrevo",
  });
  const afterRollback = await getGlobalKnowledgeModules();
  assert.equal(dbFetchCount, 3);
  assert.equal(afterRollback.get("module_2_copywriting_psychology_deliverability")?.version, 1);

  // Cold-start unreachable DB falls back gracefully to local seed constants
  __configureGlobalKnowledgeForTest({
    adapter: {
      ...mockAdapter,
      async fetchActiveModules() {
        throw new Error("Simulated ECONNREFUSED");
      },
    },
    resetStats: true,
  });
  invalidateGlobalKnowledgeCache();
  const fallbackMods = await getGlobalKnowledgeModules();
  assert.equal(fallbackMods.size, 4);
  assert.match(
    fallbackMods.get("module_4_replies_objections_closing_compliance")?.content ?? "",
    /AUTOMATED REPLY TRIAGE/,
  );

  __configureGlobalKnowledgeForTest({ adapter: null, ttlMs: null, resetStats: true });
});

test("Phase 7 (1, 2 & 3): Zero-setup new user routing, LLM prefix caching & tenant isolation", async () => {
  const { GLOBAL_PROMPT_CACHE_SEPARATOR, WORKFLOW_MODULES, buildOrchestratedSystemPrompt } = await import(
    "./ai/orchestrator"
  );
  const { buildEmptyUserBusinessProfile, resolveUserBusinessVariables } = await import(
    "./global-knowledge/user-context"
  );

  // Workflow task module isolation: strictly scoped per task
  assert.deepEqual(WORKFLOW_MODULES.research_and_qualify, ["module_1_prospecting_research_qualification"]);
  assert.deepEqual(WORKFLOW_MODULES.draft_outreach, [
    "module_1_prospecting_research_qualification",
    "module_2_copywriting_psychology_deliverability",
    "module_3_routing_templates_cadence",
  ]);
  assert.deepEqual(WORKFLOW_MODULES.handle_reply, [
    "module_2_copywriting_psychology_deliverability",
    "module_4_replies_objections_closing_compliance",
  ]);

  // Tenant A: brand-new zero-setup user with minimal profile info
  const tenantAVars = resolveUserBusinessVariables({
    settings: { sender_name: "Sam", sender_email: "sam@gmail.com" },
  });
  assert.equal(tenantAVars.USER_NAME, "Sam");
  assert.equal(tenantAVars.USER_SENDING_TIER, "free_gmail_starter");
  assert.equal(tenantAVars.USER_PROOF, "Not provided — do not fabricate or mention");

  // Tenant B: configured custom domain agency
  const tenantBVars = resolveUserBusinessVariables({
    profile: {
      ...buildEmptyUserBusinessProfile("tenant_b"),
      user_name: "Maya",
      user_company: "Vanguard Dental Growth",
      user_offer: "Dental Implant Booking System",
      user_proof: "Increased Austin Implants Clinic by 19 bookings/mo",
      user_exclusions: "No Shopify stores or salons",
    },
    settings: { sender_name: "Maya", sender_email: "maya@vanguardgrowth.io" },
  });
  assert.equal(tenantBVars.USER_SENDING_TIER, "authenticated_custom_domain");

  const promptA = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    settings: { sender_name: "Sam", sender_email: "sam@gmail.com" },
    taskInstructions: "Draft cold email.",
  });
  const promptB = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    settings: { sender_name: "Maya", sender_company: "Vanguard Dental Growth", sender_email: "maya@vanguardgrowth.io" },
    knowledgeDigest: "Vanguard Dental Growth confidential client proof",
    taskInstructions: "Draft cold email.",
  });

  // LLM Prompt Caching: static Global Modules appear FIRST and are byte-for-byte identical across tenants
  assert.equal(promptA.staticPrefix, promptB.staticPrefix);
  assert.ok(promptA.system.startsWith(promptA.staticPrefix));
  assert.ok(promptA.system.includes(GLOBAL_PROMPT_CACHE_SEPARATOR));
  assert.match(promptA.staticPrefix, /GLOBAL SALES & OUTREACH INTELLIGENCE — MODULE 1/);
  assert.match(promptA.staticPrefix, /GLOBAL SALES & OUTREACH INTELLIGENCE — MODULE 3/);
  assert.ok(!promptA.staticPrefix.includes("MODULE 4"), "draft_outreach must NOT inject Module 4");

  // Strict tenant isolation: Tenant A prompt must NEVER see Tenant B's secrets/company
  assert.ok(!promptA.system.includes("Vanguard Dental Growth"));
  assert.ok(!promptA.system.includes("maya@vanguardgrowth.io"));
  assert.ok(promptB.system.includes("Vanguard Dental Growth"));
});

test("Phase 7 (4 & 5): Hard qualification/self-send/sending-tier guardrails, reply hooks & zero placeholder leakage", async () => {
  const {
    DEFAULT_CAMPAIGN_MIN_SCORE,
    checkSendingTierDeliverability,
    evaluateLeadSendEligibility,
    findCancellableFollowupMessageIds,
    mapReplyClassMeta,
    resolveUserSendingTier,
  } = await import("./guardrails");
  const { findUnresolvedPlaceholders, stripUnresolvedPlaceholders } = await import("./ai/orchestrator");
  const { cleanEmailText, validateEmail } = await import("./outreach-utils");
  type Lead = import("./types").Lead;

  assert.equal(DEFAULT_CAMPAIGN_MIN_SCORE, 65);

  const baseLead: Lead = {
    id: "l1",
    campaign_id: "c1",
    business: "Apex Clinic",
    contact_name: "Dr. Lee",
    role: "Owner",
    email: "lee@apexclinic.com",
    email_norm: "lee@apexclinic.com",
    website: "https://apexclinic.com",
    phone: null,
    location: "Austin",
    industry: "Dental",
    notes: null,
    extra: null,
    source: null,
    source_ref: null,
    sheet_row: null,
    status: "qualified",
    score: 15,
    priority: "low",
    score_reason: null,
    research: null,
    research_at: null,
    research_ok: true,
    manual_research: null,
    last_contacted_at: null,
    created_at: "",
    updated_at: "",
  };

  // Below min_score (15 < 65) -> blocked at code level
  const lowScore = evaluateLeadSendEligibility({ lead: baseLead, minScore: 65, senderEmail: "out@agency.io" });
  assert.equal(lowScore.eligible, false);
  assert.equal(lowScore.code, "BELOW_MIN_SCORE");

  // Kill switch triggered even with score 85 -> blocked
  const killLead: Lead = {
    ...baseLead,
    score: 85,
    score_reason: {
      score: 85,
      category: "high",
      kill_switch_triggered: true,
      disqualification_reason: "Matches excluded niche",
      reasons: [],
      opportunity: "",
      value_tier: "high",
      recommended_service: "",
    },
  };
  const killGate = evaluateLeadSendEligibility({ lead: killLead, minScore: 65, senderEmail: "out@agency.io" });
  assert.equal(killGate.eligible, false);
  assert.equal(killGate.code, "KILL_SWITCH");

  // Self-send guard -> blocked
  const validLead: Lead = { ...baseLead, score: 78, email: "alex@studio.io", email_norm: "alex@studio.io" };
  const selfSend = evaluateLeadSendEligibility({ lead: validLead, minScore: 65, senderEmail: "ALEX@studio.io" });
  assert.equal(selfSend.eligible, false);
  assert.equal(selfSend.code, "SELF_SEND");

  // Qualified external recipient -> allowed
  const okGate = evaluateLeadSendEligibility({ lead: validLead, minScore: 65, senderEmail: "hello@otherdomain.io" });
  assert.equal(okGate.eligible, true);

  // Sending-tier deliverability enforcement
  assert.equal(resolveUserSendingTier("founder@gmail.com"), "free_gmail_starter");
  assert.equal(resolveUserSendingTier("founder@acmeagency.io"), "authenticated_custom_domain");
  const freeCheck = checkSendingTierDeliverability({
    tier: "free_gmail_starter",
    subject: "quick question",
    body: "See https://a.com and https://calendly.com/demo/30min plus attached deck",
    configuredDailyLimit: 50,
    isColdTouch1: true,
  });
  assert.equal(freeCheck.effectiveDailyCap, 20);
  assert.equal(freeCheck.preferPlainText, true);
  assert.ok(freeCheck.warnings.length >= 2);

  // Reply-class automation hooks (R5 snooze + R8 global suppress + cancelling unsent followups)
  assert.equal(mapReplyClassMeta("R8").sequence_action, "GLOBAL_SUPPRESS");
  assert.equal(mapReplyClassMeta("R8").suppress, true);
  assert.equal(mapReplyClassMeta("R5").sequence_action, "SNOOZE");
  assert.equal(mapReplyClassMeta("R7").sequence_action, "STOP");
  const toCancel = findCancellableFollowupMessageIds(
    [
      { id: "m1", lead_id: "l1", kind: "initial", status: "sent" },
      { id: "m2", lead_id: "l1", kind: "followup", status: "pending_approval" },
      { id: "m3", lead_id: "l1", kind: "followup", status: "approved" },
    ],
    "l1",
  );
  assert.deepEqual(toCancel, ["m2", "m3"]);

  // Zero raw {{...}} placeholder leakage check
  const leaked = "Hi {{PROSPECT_FIRST_NAME}}, see {{USER_PROOF}} and [INSERT_COMPANY] for details on your site.";
  assert.ok(findUnresolvedPlaceholders(leaked).length >= 2);
  assert.ok(validateEmail("Subject", leaked) !== null);
  const sanitized = cleanEmailText(stripUnresolvedPlaceholders(leaked));
  assert.equal(findUnresolvedPlaceholders(sanitized).length, 0);
  assert.ok(!sanitized.includes("{{"));
});

test("isolated admin authentication: scrypt hashing, TOTP 2FA, separate cookies, and zero user-token escalation", async () => {
  const secretPw = "TestAdmin#2026!Secure";
  const hash = hashAdminPassword(secretPw);
  assert.ok(hash.startsWith("scrypt:v1:"));
  assert.equal(verifyAdminPassword(secretPw, hash), true);
  assert.equal(verifyAdminPassword("wrong-password", hash), false);

  const totpSecret = generateTotpSecret();
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  const validCode = generateTotpAt(totpSecret, currentStep);
  assert.equal(verifyTotpCode(totpSecret, validCode), true);
  assert.equal(verifyTotpCode(totpSecret, "000000"), validCode === "000000");

  const sessionTok = signAdminCookieToken({
    kind: "session",
    adminId: "adm_1",
    email: "admin@example.com",
    role: "super_admin",
    ttlSeconds: 1800,
  });
  assert.equal(verifyAdminCookieToken(sessionTok.token, "session")?.adminId, "adm_1");
  // Token kind mismatch must be rejected
  assert.equal(verifyAdminCookieToken(sessionTok.token, "reauth"), null);
  assert.equal(verifyAdminCookieToken(`${sessionTok.token}tamper`, "session"), null);

  // Regular user Bearer header MUST NOT unlock admin routes
  const reqWithUserBearerOnly = new NextRequest("http://localhost:3000/api/admin/overview", {
    headers: { Authorization: "Bearer regular-google-user-token" },
  });
  await assert.rejects(
    () => requireAdmin(reqWithUserBearerOnly, "support"),
    (err: unknown) => (err as { status?: number; code?: string }).status === 401,
  );
});

test("background jobs progress & ETA track stages deterministically", () => {
  const startedAt = new Date(Date.now() - 6000).toISOString();
  const stepOneDone: BackgroundJobStep[] = [
    { key: "s1", label: "Saving profile", status: "done", weightSec: 3 },
    { key: "s2", label: "Scanning site", status: "in_progress", weightSec: 6 },
    { key: "s3", label: "Drafting KB", status: "pending", weightSec: 12 },
  ];
  const mid = computeJobProgressAndEta(stepOneDone, startedAt, "running");
  assert.ok(mid.progressPct > 10 && mid.progressPct < 99);
  assert.ok(mid.estimatedSecondsRemaining > 0);
  assert.equal(mid.currentStep, "Scanning site");

  const finished = computeJobProgressAndEta(
    stepOneDone.map((s) => ({ ...s, status: "done" })),
    startedAt,
    "succeeded",
  );
  assert.equal(finished.progressPct, 100);
  assert.equal(finished.estimatedSecondsRemaining, 0);

  const failed = computeJobProgressAndEta(
    [
      { key: "s1", label: "Saving profile", status: "done", weightSec: 3 },
      { key: "s2", label: "Scanning site", status: "failed", weightSec: 6 },
    ],
    startedAt,
    "failed",
  );
  assert.equal(failed.estimatedSecondsRemaining, 0);
  assert.equal(failed.currentStep, "Scanning site");
});

test("growth research progress never reports a frozen fake percentage", () => {
  // Regression: the pipeline used to stop after its first step, so the badge sat
  // at 37% (searching done + reading_sources at 45% of its weight) forever.
  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const steps: BackgroundJobStep[] = [
    { key: "searching_businesses", label: "Searching", status: "done", weightSec: 6 },
    { key: "reading_sources", label: "Reading", status: "in_progress", weightSec: 12 },
    { key: "checking_niche", label: "Checking", status: "pending", weightSec: 9 },
    { key: "ranking_recommendations", label: "Ranking", status: "pending", weightSec: 4 },
  ];
  const mid = computeJobProgressAndEta(steps, startedAt, "running");
  assert.equal(mid.progressPct, 37);
  assert.equal(mid.currentStep, "Reading");

  const completed = computeJobProgressAndEta(
    steps.map((s) => ({ ...s, status: "done" })),
    startedAt,
    "succeeded",
  );
  assert.equal(completed.progressPct, 100);
});

test("stalled background jobs are detected so the UI can offer a retry", () => {
  const now = Date.now();
  const running = {
    status: "running" as const,
    updatedAt: new Date(now - 5_000).toISOString(),
  };
  assert.equal(isJobStalled(running, now), false);

  const silent = {
    status: "running" as const,
    updatedAt: new Date(now - JOB_STALL_MS - 1_000).toISOString(),
  };
  assert.equal(isJobStalled(silent, now), true);

  // A finished job is never "stalled", however old the row is.
  assert.equal(
    isJobStalled({ status: "failed" as const, updatedAt: silent.updatedAt }, now),
    false,
  );
  assert.equal(
    isJobStalled({ status: "succeeded" as const, updatedAt: silent.updatedAt }, now),
    false,
  );
  // A fresh job with a shorter window can be reclaimed immediately.
  assert.equal(isJobStalled(running, now, 1_000), true);
});

test("Growth Advisor profile hydrates from Onboarding and updates fingerprint cleanly", () => {
  const hydrated = hydrateGrowthProfileFromOnboarding(
    EMPTY_GROWTH_PROFILE,
    {
      ...DEFAULT_ONBOARDING_ANSWERS,
      businessName: "Northstar Labs",
      industry: "B2B SaaS",
      businessDescription: "Workflow automation for finance teams",
      priceRange: "$3,000/mo",
      currentMarkets: "Austin, TX",
      icpRoles: ["CFO", "VP Finance"],
      marketReach: ["national"],
    },
    {
      sender_company: "Northstar Labs",
      sender_name: "Alex",
      sender_role: "Founder",
      physical_address: "Austin, TX",
    },
  );

  assert.equal(hydrated.whoYouAre, "Northstar Labs");
  assert.equal(hydrated.industry, "B2B SaaS");
  assert.deepEqual(hydrated.targetRoles, ["CFO", "VP Finance"]);
  assert.deepEqual(hydrated.marketScope, ["national"]);

  const comp = evaluateProfileCompleteness(hydrated, "", {
    sender_company: "Northstar Labs",
    sender_name: "Alex",
    sender_role: "Founder",
  });
  assert.equal(comp.complete, true);
  assert.ok(comp.score >= 70);

  const fp1 = computeProfileFingerprint({
    profile: hydrated,
    knowledgeDigest: "",
    settings: { sender_company: "Northstar Labs", sender_name: "Alex", sender_role: "Founder", physical_address: "Austin" },
    metricsSummary: { leads: 0, campaigns: 0, sent: 0, replies: 0, positive: 0 },
  });
  const fp2 = computeProfileFingerprint({
    profile: { ...hydrated, averageDealValue: 15000 },
    knowledgeDigest: "",
    settings: { sender_company: "Northstar Labs", sender_name: "Alex", sender_role: "Founder", physical_address: "Austin" },
    metricsSummary: { leads: 0, campaigns: 0, sent: 0, replies: 0, positive: 0 },
  });
  assert.notEqual(fp1, fp2);
});

test("cross-user browser storage cleanup clears account data on account switch while keeping theme", () => {
  const localMap = new Map<string, string>([
    ["knowrevo:theme", "dark"],
    ["os:chat:v1:userA", "{\"messages\":[1]}"],
    ["outreach-batch-job:userA", "{\"running\":true}"],
    ["reply_drafts", "{\"stale\":true}"],
  ]);
  const sessionMap = new Map<string, string>([
    ["os:announcements", "[{\"id\":\"a1\"}]"],
    ["os:active-owner-id", "userA"],
  ]);

  const makeStorage = (map: Map<string, string>) => ({
    get length() {
      return map.size;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string) {
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  });

  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: makeStorage(localMap),
    sessionStorage: makeStorage(sessionMap),
    dispatchEvent: () => true,
  };

  try {
    const res = syncActiveOwnerSessionMarker("userB");
    assert.equal(res.switched, true);
    assert.equal(localMap.get("knowrevo:theme"), "dark");
    assert.equal(localMap.has("os:chat:v1:userA"), false);
    assert.equal(localMap.has("outreach-batch-job:userA"), false);
    assert.equal(localMap.has("reply_drafts"), false);
    assert.equal(sessionMap.get("os:active-owner-id"), "userB");
    assert.equal(sessionMap.has("os:announcements"), false);

    clearAllAccountClientData();
    assert.equal(localMap.get("knowrevo:theme"), "dark");
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

// ---------------------------------------------------------------------------
// Phase 5: Unified Multi-Key LLM Gateway & Bulletproof Model Switching Tests
// ---------------------------------------------------------------------------

function makeSampleAdminSettings(overrides: Partial<AdminAiSettings> = {}): AdminAiSettings {
  return {
    id: "default",
    masterMode: "auto",
    strategy: "balanced",
    fallbackChain: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSampleAdminKey(
  id: string,
  provider: AdminAiKeyRecord["provider"],
  plaintextKey: string,
  overrides: Partial<AdminAiKeyRecord> = {},
): AdminAiKeyRecord {
  const { encryptedKey, maskedKey } = encryptGatewayKey(plaintextKey);
  const now = new Date().toISOString();
  return {
    id,
    provider,
    label: `${provider}-${id}`,
    encryptedKey,
    maskedKey,
    accountId: null,
    baseUrl: null,
    enabled: true,
    models: [
      {
        id: provider === "google" ? "gemini-2.5-flash" : `${provider}-default-model`,
        displayName: `${provider} Default`,
        enabled: true,
        seats: ["smart", "balanced", "fast"],
        capabilities: {
          json: true,
          tools: true,
          vision: false,
          reasoning: true,
          grounding: provider === "google",
        },
      },
    ],
    rpmLimit: 15,
    rpdLimit: 1500,
    healthStatus: "healthy",
    cooldownUntil: null,
    cooldownStep: 0,
    lastError: null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("BYOK mode switches models immediately across task seats and enforces strict tenant isolation", async () => {
  const prevFetch = globalThis.fetch;
  const calls: { url: string; model?: string; auth?: string }[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as { model?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, model: body.model, auth: headers.Authorization || headers.authorization });

    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ engine: "google-byok", ok: true }) }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ engine: "openai-byok", model: body.model }) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const ownerA = "owner-byok-a";
    const ownerB = "owner-byok-b";
    const keyGoogle = encryptGatewayKey("AIzaTestGoogleKey12345");
    const keyOpenAi = encryptGatewayKey("sk-TestOpenAiKey12345");
    const now = new Date().toISOString();

    const googleRec: UserAiKeyRecord = {
      id: "ukey_google",
      ownerId: ownerA,
      provider: "google",
      label: "Google BYOK",
      encryptedKey: keyGoogle.encryptedKey,
      maskedKey: keyGoogle.maskedKey,
      models: [
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          enabled: true,
          seats: ["smart", "balanced", "fast"],
          capabilities: { json: true, tools: true, vision: true, reasoning: true, grounding: true },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const openAiRec: UserAiKeyRecord = {
      id: "ukey_openai",
      ownerId: ownerA,
      provider: "openai",
      label: "OpenAI BYOK",
      encryptedKey: keyOpenAi.encryptedKey,
      maskedKey: keyOpenAi.maskedKey,
      models: [
        {
          id: "gpt-4o-mini",
          displayName: "GPT-4o Mini",
          enabled: true,
          seats: ["smart", "balanced", "fast"],
          capabilities: { json: true, tools: true, vision: true, reasoning: false },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    // Seed Owner A on Google gemini-2.5-pro, Owner B on System Auto (Groq)
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [makeSampleAdminKey("adm_sys", "groq", "gsk_AdminFallbackKey99")],
      userSettings: {
        [ownerA]: {
          ownerId: ownerA,
          mode: "byok",
          activeKeyId: googleRec.id,
          activeProvider: "google",
          activeModel: "gemini-2.5-pro",
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
        [ownerB]: {
          ownerId: ownerB,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
      },
      userKeys: {
        [ownerA]: [googleRec, openAiRec],
        [ownerB]: [],
      },
    });

    // 1. Owner A runs "smart" seat (research) -> strictly hits gemini-2.5-pro
    const res1 = await LLMGateway.completeJSON<{ engine: string }>({
      ownerId: ownerA,
      taskType: "smart",
      feature: "research",
      messages: [{ role: "user", content: "Research Acme" }],
    });
    assert.equal(res1.receipt.actualProvider, "google");
    assert.equal(res1.receipt.actualModel, "gemini-2.5-pro");
    assert.ok(calls[0].url.includes("gemini-2.5-pro"));

    // 2. Owner A switches immediately to OpenAI gpt-4o-mini
    seedGatewayCachesForTests({
      userSettings: {
        [ownerA]: {
          ownerId: ownerA,
          mode: "byok",
          activeKeyId: openAiRec.id,
          activeProvider: "openai",
          activeModel: "gpt-4o-mini",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    // Run both "smart" and "balanced" seats -> BOTH execute on gpt-4o-mini immediately
    const res2 = await LLMGateway.completeJSON<{ engine: string; model: string }>({
      ownerId: ownerA,
      taskType: "smart",
      feature: "research",
      messages: [{ role: "user", content: "Research Acme" }],
    });
    const res3 = await LLMGateway.completeJSON<{ engine: string; model: string }>({
      ownerId: ownerA,
      taskType: "balanced",
      feature: "email_compose",
      messages: [{ role: "user", content: "Draft email" }],
    });
    assert.equal(res2.receipt.actualProvider, "openai");
    assert.equal(res2.receipt.actualModel, "gpt-4o-mini");
    assert.equal(res3.receipt.actualProvider, "openai");
    assert.equal(res3.receipt.actualModel, "gpt-4o-mini");

    // 3. Owner B in system_auto never touches Owner A's BYOK key
    const resB = await LLMGateway.completeJSON<{ model: string }>({
      ownerId: ownerB,
      taskType: "fast",
      feature: "reply_classify",
      messages: [{ role: "user", content: "Classify" }],
    });
    assert.equal(resB.receipt.actualProvider, "groq");
    assert.equal(calls.at(-1)?.auth, "Bearer gsk_AdminFallbackKey99");

    // 4. When BYOK fails and fallbackToSystemAuto is OFF, throws LLMGatewayError without silently switching
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        LLMGateway.complete({
          ownerId: ownerA,
          taskType: "balanced",
          feature: "email_compose",
          messages: [{ role: "user", content: "Hello" }],
        }),
      (err: unknown) =>
        err instanceof LLMGatewayError &&
        err.code === "BYOK_CALL_FAILED" &&
        err.canFallbackToSystemAuto === true,
    );
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("Admin AUTO mode fails over silently on 429 and escalates cooldowns (2m -> 10m -> 1h -> 24h)", async () => {
  const prevFetch = globalThis.fetch;
  const hitProviders: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.groq.com")) {
      hitProviders.push("groq");
      return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    hitProviders.push("cerebras");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Failover succeeded cleanly" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const groqKey = makeSampleAdminKey("adm_groq", "groq", "gsk_PrimaryLimited", {
      models: [
        {
          id: "llama-3.3-70b-versatile",
          displayName: "Llama 3.3 70B",
          enabled: true,
          seats: ["fast", "balanced", "smart"],
          capabilities: { json: true, tools: true, vision: false, reasoning: false },
        },
      ],
    });
    const cerebrasKey = makeSampleAdminKey("adm_cerebras", "cerebras", "csk_HealthyBackup", {
      models: [
        {
          id: "llama-3.3-70b",
          displayName: "Llama 3.3 70B Cerebras",
          enabled: true,
          seats: ["fast", "balanced", "smart"],
          capabilities: { json: true, tools: true, vision: false, reasoning: false },
        },
      ],
    });

    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings({
        masterMode: "auto",
        strategy: "fastest",
        fallbackChain: [
          { provider: "groq", model: "llama-3.3-70b-versatile" },
          { provider: "cerebras", model: "llama-3.3-70b" },
        ],
      }),
      adminKeys: [groqKey, cerebrasKey],
      userSettings: {
        "auto-user": {
          ownerId: "auto-user",
          mode: "system_auto",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { "auto-user": [] },
    });

    // Call #1 hits groq (429) -> fails over silently to cerebras
    const res1 = await LLMGateway.complete({
      ownerId: "auto-user",
      taskType: "fast",
      feature: "test",
      messages: [{ role: "user", content: "Ping" }],
    });
    assert.equal(res1.receipt.actualProvider, "cerebras");
    assert.equal(res1.receipt.fallbackUsed, true);
    assert.equal(res1.receipt.fallbackHops, 1);
    assert.deepEqual(hitProviders, ["groq", "cerebras"]);
    assert.equal(groqKey.healthStatus, "cooldown");

    // Call #2 skips groq completely because it is now in cooldown
    hitProviders.length = 0;
    const res2 = await LLMGateway.complete({
      ownerId: "auto-user",
      taskType: "fast",
      feature: "test",
      messages: [{ role: "user", content: "Ping 2" }],
    });
    assert.equal(res2.receipt.actualProvider, "cerebras");
    assert.deepEqual(hitProviders, ["cerebras"]);

    // Verify escalating cooldown ladder: 2m -> 10m -> 1h -> 24h
    const testKey = makeSampleAdminKey("adm_ladder", "openai", "sk-LadderTest123");
    const rateErr = new GatewayProviderError("429 busy", { status: 429, rateLimited: true });
    const f1 = recordCandidateFailure(testKey, "m1", rateErr);
    const f2 = recordCandidateFailure(testKey, "m1", rateErr);
    const f3 = recordCandidateFailure(testKey, "m1", rateErr);
    const f4 = recordCandidateFailure(testKey, "m1", rateErr);
    assert.equal(f1.cooldownMs, 2 * 60_000);
    assert.equal(f2.cooldownMs, 10 * 60_000);
    assert.equal(f3.cooldownMs, 60 * 60_000);
    assert.equal(f4.cooldownMs, 24 * 60 * 60_000);

    // 401 benches the key as invalid immediately
    const authErr = new GatewayProviderError("Invalid key", { status: 401, authFailed: true });
    const fAuth = recordCandidateFailure(testKey, "m1", authErr);
    assert.equal(fAuth.healthStatus, "invalid");
    assert.equal(testKey.healthStatus, "invalid");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("Proactive 85% RPM headroom steering routes away before hitting 429", () => {
  clearRouterStateForTests();
  const keyBusy = makeSampleAdminKey("adm_busy", "groq", "gsk_BusyKey111", { rpmLimit: 10 });
  const keyFresh = makeSampleAdminKey("adm_fresh", "cerebras", "csk_FreshKey222", { rpmLimit: 10 });

  // Hit keyBusy 9 times out of 10 RPM (90% >= 85% threshold)
  for (let i = 0; i < 9; i += 1) {
    recordKeyUsageHit(keyBusy.id);
  }

  const headroom = evaluateKeyHeadroom(keyBusy);
  assert.equal(headroom.rpmUsed, 9);
  assert.equal(headroom.allowed, true);
  assert.equal(headroom.lowHeadroom, true);

  const ranked = rankPoolCandidates({
    keys: [keyBusy, keyFresh],
    settings: makeSampleAdminSettings({
      masterMode: "auto",
      strategy: "balanced",
      // Even with fallbackChain listing keyBusy first, healthy headroom keyFresh wins cleanly!
      fallbackChain: [{ provider: "groq", model: keyBusy.models[0].id }],
    }),
    taskType: "balanced",
  });

  assert.equal(ranked[0].key.id, keyFresh.id);
  assert.equal(ranked[0].lowHeadroom, false);
  clearRouterStateForTests();
});

test("completeGroundedJSON prioritizes Google Search grounding when available and degrades cleanly otherwise", async () => {
  const prevFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: JSON.stringify({ company: "Acme", verified: true }) }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: "https://acme.example.com", title: "Acme Official" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ company: "Acme", verified: false }) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const nvidiaKey = makeSampleAdminKey("adm_nvidia", "nvidia", "nvapi-TestKey123");
    const googleKey = makeSampleAdminKey("adm_google", "google", "AIzaTestKey123");

    // 1. Only non-Google key in pool -> degrades cleanly without crashing, zero fabricated URLs
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [nvidiaKey],
      userSettings: {
        "u-ground": {
          ownerId: "u-ground",
          mode: "system_auto",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { "u-ground": [] },
    });

    const ungrounded = await LLMGateway.completeGroundedJSON<{ company: string }>({
      ownerId: "u-ground",
      taskType: "smart",
      feature: "research",
      messages: [{ role: "user", content: "Research Acme" }],
    });
    assert.equal(ungrounded.data.company, "Acme");
    assert.equal(ungrounded.receipt.grounded, false);
    assert.deepEqual(ungrounded.groundingUrls, []);

    // 2. Google key healthy in pool alongside NVIDIA -> Google Search grounding is prioritized
    seedGatewayCachesForTests({
      adminKeys: [nvidiaKey, googleKey],
    });

    const grounded = await LLMGateway.completeGroundedJSON<{ company: string }>({
      ownerId: "u-ground",
      taskType: "smart",
      feature: "research",
      messages: [{ role: "user", content: "Research Acme" }],
    });
    assert.equal(grounded.receipt.actualProvider, "google");
    assert.equal(grounded.receipt.grounded, true);
    assert.equal(grounded.groundingUrls.length, 1);
    assert.equal(grounded.groundingUrls[0].uri, "https://acme.example.com");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("ENCRYPTION_KEY is required in production and gateway key ciphertext never exposes plaintext", () => {
  const prevEnv = process.env as Record<string, string | undefined>;
  const prevNodeEnv = prevEnv.NODE_ENV;
  const prevEnc = prevEnv.ENCRYPTION_KEY;

  try {
    prevEnv.NODE_ENV = "production";
    delete prevEnv.ENCRYPTION_KEY;

    assert.throws(() => encryptSecret("sk-secret-value-123"), /ENCRYPTION_KEY/);

    prevEnv.ENCRYPTION_KEY = "unit-test-32-byte-encryption-secret-key!";
    const { encryptedKey, maskedKey } = encryptGatewayKey("nvapi-SuperSecretTokenValue9876");
    assert.equal(encryptedKey.includes("SuperSecretTokenValue"), false);
    assert.equal(maskedKey.includes("SuperSecretTokenValue"), false);
    assert.equal(decryptSecret(encryptedKey), "nvapi-SuperSecretTokenValue9876");
  } finally {
    if (prevNodeEnv === undefined) delete prevEnv.NODE_ENV;
    else prevEnv.NODE_ENV = prevNodeEnv;
    if (prevEnc === undefined) delete prevEnv.ENCRYPTION_KEY;
    else prevEnv.ENCRYPTION_KEY = prevEnc;
  }
});

// ---------------------------------------------------------------------------
// Phase 4: Free Web Search Discovery + Slow Mega-Model Timeout Failover Tests
// ---------------------------------------------------------------------------

test("Non-Google discovery works end-to-end with WebSearchService + live site inspector + Groq LLM", async () => {
  const prevFetch = globalThis.fetch;
  let groqCalled = false;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("api.tavily.com/search")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Austin Family Dental",
              url: "https://austindental.example.com",
              content: "Family dentistry in Austin TX",
            },
            {
              title: "SmileTown Dentistry",
              url: "https://smiletown.example.com",
              content: "Cosmetic dental clinic Austin TX",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("austindental.example.com")) {
      return new Response(
        `<html><head><title>Austin Family Dental</title></head><body><h1>Austin Family Dental</h1><a href="mailto:hello@austindental.example.com">Email us</a><a href="tel:+15125550101">Call</a><p>Serving North Austin patients since 2018.</p></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url.includes("smiletown.example.com")) {
      return new Response(
        `<html><head><title>SmileTown Dentistry</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>SmileTown</h1><p>Book a call today.</p></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    if (url.includes("api.groq.com")) {
      groqCalled = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    {
                      business: "Austin Family Dental",
                      website: "https://austindental.example.com",
                      location: "Austin, TX",
                      industry: "Dentistry",
                      why: "Missing mobile viewport meta tag on live site",
                      source_url: "https://austindental.example.com",
                      contact: {
                        decision_maker: "",
                        role: "",
                        email: "hello@austindental.example.com",
                        phone: "+15125550101",
                        whatsapp: "",
                        address: "Austin, TX",
                        socials: [],
                        sources: [{ field: "email", url: "https://austindental.example.com", confidence: "high", verification_status: "Verified" }],
                      },
                      issues: [{ area: "Mobile UX", problem: "Missing viewport tag", evidence: "Not found in homepage HTML", severity: "medium" }],
                      how_we_help: [],
                      qualification_review: { verdict: "qualified", criteria: [], weaknesses_and_risks: [], missing_information: [] },
                    },
                    {
                      business: "SmileTown Dentistry",
                      website: "https://smiletown.example.com",
                      location: "Austin, TX",
                      industry: "Dentistry",
                      why: "Active cosmetic dental clinic in Austin",
                      source_url: "https://smiletown.example.com",
                      contact: {
                        decision_maker: "",
                        role: "",
                        email: "invented@hallucinated-email.org",
                        phone: "",
                        whatsapp: "",
                        address: "Austin, TX",
                        socials: [],
                        sources: [],
                      },
                      issues: [],
                      how_we_help: [],
                      qualification_review: { verdict: "uncertain", criteria: [], weaknesses_and_risks: [], missing_information: ["No email found"] },
                    },
                  ],
                  notes: "Verified via Tavily + live site inspection",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();
    clearDiscoveryCacheForTests();

    const now = new Date().toISOString();
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" }),
      // Google is disabled; only Groq is active
      adminKeys: [
        makeSampleAdminKey("adm_google_off", "google", "AIzaDisabledKey", { enabled: false }),
        makeSampleAdminKey("adm_groq_on", "groq", "gsk_GroqDiscoveryKey", {
          models: [
            {
              id: "llama-3.3-70b-versatile",
              displayName: "Llama 3.3 70B Versatile",
              enabled: true,
              seats: ["balanced", "smart", "fast"],
              capabilities: { json: true, tools: true, vision: false, reasoning: false },
            },
          ],
        }),
      ],
      searchKeys: [
        {
          id: "srch_tavily_test",
          provider: "tavily",
          label: "Tavily Test",
          apiKey: "tvly-test-123456",
          maskedKey: "tvly••••3456",
          enabled: true,
          healthStatus: "healthy",
          createdAt: now,
          updatedAt: now,
        },
      ],
      userSettings: {
        "u-disc": {
          ownerId: "u-disc",
          mode: "system_auto",
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
      },
      userKeys: { "u-disc": [] },
    });

    const result = await discoverProspectsServer({
      ownerId: "u-disc",
      industry: "dental clinics",
      location: "Austin, TX",
      count: 5,
      focus: "",
    });

    assert.equal(groqCalled, true);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].business, "Austin Family Dental");
    assert.equal(result.candidates[0].contact.email, "hello@austindental.example.com");
    // Anti-hallucination guard strips LLM-guessed email absent from search & site inspection
    assert.equal(result.candidates[1].contact.email, "");
    assert.equal(result.groundingUrls[0].uri, "https://austindental.example.com");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
    clearDiscoveryCacheForTests();
  }
});

test("Keyless DuckDuckGo + OSM Overpass fallback works with zero search API keys", async () => {
  const prevFetch = globalThis.fetch;
  const prevTavily = process.env.TAVILY_API_KEY;
  const prevBrave = process.env.BRAVE_SEARCH_API_KEY;
  const prevSerper = process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.SERPER_API_KEY;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("html.duckduckgo.com")) {
      const ddgHtml = `
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Faustinsmiles.example.com">Austin Smiles Clinic</a>
          <a class="result__snippet">Trusted family dentist in downtown Austin.</a>
        </div>`;
      return new Response(ddgHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }

    if (url.includes("nominatim.openstreetmap.org")) {
      return new Response(
        JSON.stringify([{ boundingbox: ["30.20", "30.35", "-97.80", "-97.65"] }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("overpass-api.de")) {
      return new Response(
        JSON.stringify({
          elements: [
            {
              id: 101,
              type: "node",
              tags: {
                name: "Barton Creek Dental",
                amenity: "dentist",
                website: "https://bartoncreekdental.example.com",
                phone: "+1-512-555-0199",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    seedGatewayCachesForTests({ searchKeys: [] });

    const parsedDdg = parseDuckDuckGoHtml(
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example.com">Site A</a>`,
    );
    assert.equal(parsedDdg[0].url, "https://a.example.com");

    const res = await WebSearchService.search("dental clinics in Austin TX", { maxResults: 6 });
    assert.ok(res.providersSucceeded.includes("duckduckgo"));
    assert.ok(res.providersSucceeded.includes("osm"));
    assert.ok(res.results.some((r) => r.url === "https://austinsmiles.example.com"));
    assert.ok(res.results.some((r) => r.businessName === "Barton Creek Dental"));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily;
    if (prevBrave !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevBrave;
    if (prevSerper !== undefined) process.env.SERPER_API_KEY = prevSerper;
    resetGatewayCachesForTests();
  }
});

test("Router deprioritizes slow 500B+ preview models and Gateway fails over cleanly on timeout abort", async () => {
  clearRouterStateForTests();
  const slowOrKey = makeSampleAdminKey("adm_slow_or", "openrouter", "sk-or-SlowQueue123", {
    models: [
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        displayName: "Nemotron Ultra 550B (:free)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
      },
      {
        id: "baidu/ernie-5.5-flash-preview:free",
        displayName: "ERNIE 5.5 Preview (:free)",
        enabled: true,
        seats: ["smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
      },
    ],
  });
  const fastGroqKey = makeSampleAdminKey("adm_fast_groq", "groq", "gsk_FastResponsive123", {
    models: [
      {
        id: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B Versatile",
        enabled: true,
        seats: ["balanced", "fast", "smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
      },
    ],
  });

  const rankedBalanced = rankPoolCandidates({
    keys: [slowOrKey, fastGroqKey],
    settings: makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" }),
    taskType: "balanced",
  });
  assert.equal(rankedBalanced[0].key.id, fastGroqKey.id);

  // Now simulate primary candidate throwing AbortError timeout -> Gateway benches it & fails over to Key 2 cleanly
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("openrouter.ai")) {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Fast backup answered cleanly" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings({
        masterMode: "auto",
        strategy: "smartest",
        fallbackChain: [{ provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }],
      }),
      adminKeys: [
        makeSampleAdminKey("adm_or_first", "openrouter", "sk-or-SlowPrimary", {
          models: [
            {
              id: "meta-llama/llama-3.3-70b-instruct:free",
              displayName: "Llama 3.3 70B (:free)",
              enabled: true,
              seats: ["smart", "balanced"],
              capabilities: { json: true, tools: true, vision: false, reasoning: false },
            },
          ],
        }),
        fastGroqKey,
      ],
      userSettings: {
        "u-timeout": {
          ownerId: "u-timeout",
          mode: "system_auto",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { "u-timeout": [] },
    });

    // Put OpenRouter explicitly ahead via fallbackChain boost OR smart bias so it tries & times out, then fails over
    const res = await LLMGateway.complete({
      ownerId: "u-timeout",
      taskType: "balanced",
      feature: "research",
      messages: [{ role: "user", content: "Ping" }],
    });
    assert.equal(res.text, "Fast backup answered cleanly");
    assert.equal(res.receipt.actualProvider, "groq");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("error normalizer never renders [object Object] and keeps readable messages", () => {
  assert.equal(
    extractErrorMessage({ code: "42501", message: "permission denied", details: null }),
    "permission denied",
  );
  assert.equal(extractErrorMessage({ error: { message: "relation does not exist" } }), "relation does not exist");
  assert.equal(extractErrorMessage(new Error("boom")), "boom");
  assert.equal(extractErrorMessage(new Error('[object Object]')), "Something went wrong on the server. Please try again.");
  assert.equal(extractErrorMessage("[object Object]"), "Something went wrong on the server. Please try again.");
  assert.equal(extractErrorMessage('{"error":{"message":"quota exhausted"}}'), "quota exhausted");
  assert.equal(extractErrorMessage(null), "Something went wrong on the server. Please try again.");
  assert.doesNotMatch(extractErrorMessage({}), /\[object Object\]/);

  assert.equal(extractErrorCode({ code: "42501", message: "permission denied" }), "42501");
  assert.equal(extractErrorCode(new Error("plain")), "INTERNAL_ERROR");
});

test("handleApiError always answers with clean JSON { error: string, code }", async () => {
  // Supabase/PostgREST failures arrive as plain objects, not Error instances.
  const dbErr = handleApiError({ code: "42501", message: "permission denied for table user_ai_settings" });
  assert.equal(dbErr.status, 500);
  const dbBody = (await dbErr.json()) as { error: unknown; code: unknown };
  assert.equal(typeof dbBody.error, "string");
  assert.equal(dbBody.error, "permission denied for table user_ai_settings");
  assert.equal(dbBody.code, "42501");
  assert.doesNotMatch(JSON.stringify(dbBody), /\[object Object\]/);

  // A non-Error throw still produces JSON, never an HTML crash page.
  const oddErr = handleApiError({ unexpected: { nested: true } });
  assert.equal(oddErr.status, 500);
  assert.equal(oddErr.headers.get("content-type")?.includes("application/json"), true);
  const oddBody = (await oddErr.json()) as { error: unknown; code: unknown };
  assert.equal(typeof oddBody.error, "string");
  assert.equal(typeof oddBody.code, "string");

  // User-facing validation errors stay 400.
  const validation = handleApiError(new Error("Add and save an API key first."));
  assert.equal(validation.status, 400);
  assert.equal((await validation.json()).error, "Add and save an API key first.");
});

test("regular non-admin owner on system_auto runs on the pooled admin key without BYOK setup", async () => {
  const prevFetch = globalThis.fetch;
  let sawAdminKey = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("api.groq.com") && auth === "Bearer gsk_RegularUserPoolKey") {
      sawAdminKey = true;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: "ok" }) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const regularOwner = "owner-regular-non-admin";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [makeSampleAdminKey("adm_pool", "groq", "gsk_RegularUserPoolKey")],
      // No BYOK: brand-new account defaults to the managed engine.
      userSettings: {
        [regularOwner]: {
          ownerId: regularOwner,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { [regularOwner]: [] },
    });

    const receiptResult = await LLMGateway.testActiveModel(regularOwner);
    assert.equal(receiptResult.text, JSON.stringify({ status: "ok" }));
    assert.equal(receiptResult.receipt.actualProvider, "groq");
    assert.equal(receiptResult.receipt.actualKeyId, "adm_pool");
    assert.equal(receiptResult.receipt.requestedMode, "system_auto");
    assert.equal(receiptResult.receipt.status, "success");
    assert.equal(sawAdminKey, true);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("pool fails over when a model refuses the request shape (function calling not enabled)", async () => {
  const prevFetch = globalThis.fetch;
  const hits: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      hits.push("google");
      return new Response(
        JSON.stringify({
          error: {
            message: "Function calling is not enabled for models/antigravity-preview-05-2026",
            code: 400,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    hits.push("backup");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Answered by the backup key" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const owner = "owner-auto-failover";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [
        makeSampleAdminKey("adm_google_bad", "google", "AIzaBadFunctionCallingKey"),
        makeSampleAdminKey("adm_nvidia_good", "nvidia", "nvapi-GoodBackupKey"),
      ],
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { [owner]: [] },
    });

    const result = await LLMGateway.complete({
      ownerId: owner,
      taskType: "balanced",
      feature: "operator_chat",
      messages: [{ role: "user", content: "Hello" }],
    });

    assert.equal(result.text, "Answered by the backup key");
    assert.equal(result.receipt.status, "success");
    assert.equal(hits.includes("google"), true);
    assert.equal(hits.at(-1), "backup");
    // The rejected (key, model) pair must not be attempted again in this process.
    const again = await LLMGateway.complete({
      ownerId: owner,
      taskType: "balanced",
      feature: "operator_chat",
      messages: [{ role: "user", content: "Hello again" }],
    });
    assert.equal(again.receipt.status, "success");
    assert.equal(hits.filter((h) => h === "google").length, 1);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("BYOK never calls a saved key with a model it does not own", async () => {
  const prevFetch = globalThis.fetch;
  const sentModels: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    sentModels.push(String(body.model ?? ""));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "owned model answered" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const owner = "owner-byok-model-mismatch";
    const key = encryptGatewayKey("sk-or-v1-TestOpenRouterKeyValue");
    const now = new Date().toISOString();
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [],
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "byok",
          activeKeyId: "ukey_openrouter",
          activeProvider: "openrouter",
          // Left over from another provider: this key does not own it.
          activeModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
      },
      userKeys: {
        [owner]: [
          {
            id: "ukey_openrouter",
            ownerId: owner,
            provider: "openrouter",
            label: "OpenRouter",
            encryptedKey: key.encryptedKey,
            maskedKey: key.maskedKey,
            models: [
              {
                id: "google/gemma-4-31b-it:free",
                displayName: "Gemma",
                enabled: true,
                seats: ["smart", "balanced", "fast"],
                capabilities: { json: true, tools: true, vision: false, reasoning: false },
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const result = await LLMGateway.complete({
      ownerId: owner,
      taskType: "balanced",
      feature: "operator_chat",
      messages: [{ role: "user", content: "Hi" }],
    });

    assert.equal(result.text, "owned model answered");
    assert.equal(sentModels[0], "google/gemma-4-31b-it:free");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("tool-using routing skips image, transcribe, robotics and antigravity catalog entries", () => {
  for (const id of [
    "gemini-3.5-flash",
    "gemini-2.5-pro",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "openai/gpt-4o-mini",
  ]) {
    assert.equal(isChatCapableModelId(id), true, id);
  }
  for (const id of [
    "gemini-2.5-flash-image",
    "nano-banana-pro-preview",
    "gemini-3.5-transcribe",
    "gemini-robotics-er-2-preview",
    "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-max-preview-04-2026",
    "antigravity-preview-05-2026",
  ]) {
    assert.equal(isChatCapableModelId(id), false, id);
  }

  // With tools required, the dead-weight entries never become candidates.
  const ranked = rankPoolCandidates({
    keys: [
      makeSampleAdminKey("adm_media", "google", "AIzaMediaModelsKey", {
        models: [
          {
            id: "gemini-2.5-flash-image",
            displayName: "Image",
            enabled: true,
            seats: ["balanced"],
            capabilities: { json: true, tools: true, vision: true, reasoning: false, grounding: true },
          },
        ],
      }),
      makeSampleAdminKey("adm_chat", "google", "AIzaChatModelsKey"),
    ],
    settings: makeSampleAdminSettings(),
    taskType: "balanced",
    requiresTools: true,
  });
  assert.equal(ranked.some((c) => c.key.id === "adm_media"), false);
  assert.equal(ranked.some((c) => c.key.id === "adm_chat"), true);
});

test("system_auto ignores saved BYOK keys across repeated mode switches", async () => {
  const prevFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("openrouter.ai")) {
      calls.push("byok");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    calls.push("pool");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const owner = "owner-mode-switch";
    const now = new Date().toISOString();
    const byok = encryptGatewayKey("sk-or-v1-ModeSwitchTestKey");

    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [makeSampleAdminKey("adm_pool", "groq", "gsk_ModeSwitchPoolKey")],
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
      },
      userKeys: {
        [owner]: [
          {
            id: "ukey_openrouter",
            ownerId: owner,
            provider: "openrouter",
            label: "OpenRouter",
            encryptedKey: byok.encryptedKey,
            maskedKey: byok.maskedKey,
            models: [
              {
                id: "google/gemma-4-31b-it:free",
                displayName: "Gemma",
                enabled: true,
                seats: ["smart", "balanced", "fast"],
                capabilities: { json: true, tools: true, vision: false, reasoning: false },
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const ask = (feature: string) =>
      LLMGateway.completeJSON<{ ok: boolean }>({
        ownerId: owner,
        taskType: "balanced",
        feature,
        messages: [{ role: "user", content: "Return ok" }],
      });

    // 1. Auto: never touches the saved personal key.
    const auto1 = await ask("compose");
    assert.equal(auto1.receipt.actualKeyId, "adm_pool");
    assert.equal(auto1.receipt.requestedMode, "system_auto");
    assert.deepEqual(calls, ["pool"]);

    // 2. Switch to BYOK: the personal key is used.
    seedGatewayCachesForTests({
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "byok",
          activeKeyId: "ukey_openrouter",
          activeProvider: "openrouter",
          activeModel: "google/gemma-4-31b-it:free",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    const byokRes = await ask("compose");
    assert.equal(byokRes.receipt.requestedMode, "byok");
    assert.equal(byokRes.receipt.actualKeyId, "ukey_openrouter");
    assert.equal(calls.at(-1), "byok");

    // 3. Switch back to Auto: routing returns to the pool immediately.
    seedGatewayCachesForTests({
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    calls.length = 0;
    const auto2 = await ask("compose");
    assert.equal(auto2.receipt.actualKeyId, "adm_pool");
    assert.equal(auto2.receipt.requestedMode, "system_auto");
    assert.deepEqual(calls, ["pool"]);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("completeJSON fails over when the first provider returns invalid JSON", async () => {
  const prevFetch = globalThis.fetch;
  const hits: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.groq.com")) {
      hits.push("groq");
      return new Response(JSON.stringify({ choices: [{ message: { content: "Sure! Here is the answer, no JSON at all." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    hits.push("backup");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();

    const owner = "owner-json-failover";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [
        makeSampleAdminKey("adm_groq_json", "groq", "gsk_InvalidJsonKey"),
        makeSampleAdminKey("adm_nvidia_json", "nvidia", "nvapi_ValidJsonKey"),
      ],
      userSettings: {
        [owner]: {
          ownerId: owner,
          mode: "system_auto",
          activeKeyId: null,
          activeProvider: null,
          activeModel: null,
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { [owner]: [] },
    });

    const res = await LLMGateway.completeJSON<{ ok: boolean }>({
      ownerId: owner,
      taskType: "balanced",
      feature: "research",
      messages: [{ role: "user", content: "Return JSON" }],
    });

    assert.equal(res.data.ok, true);
    assert.equal(res.receipt.status, "success");
    assert.equal(hits[0], "groq");
    assert.equal(hits.at(-1), "backup");
    assert.equal(res.receipt.actualKeyId, "adm_nvidia_json");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("getUserAiSettings resolves a default for a new account without hanging", async () => {
  resetGatewayCachesForTests();
  const settings = await Promise.race([
    getUserAiSettings("owner-brand-new-account"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("getUserAiSettings did not settle")), 3_000),
    ),
  ]);
  assert.equal(settings.mode, "system_auto");
  assert.equal(settings.activeKeyId, null);
  resetGatewayCachesForTests();
});
