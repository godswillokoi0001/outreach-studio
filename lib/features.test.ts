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
import { executeAgentTool, clearVerifiedDiscoveryForTests } from "./agent-executor";
import { decodeCfEmail, extractJsonLdContacts, findDeepContactsForProspect } from "./search/contactFinder";
import { validateContactableLead, validateOperatorAddLead } from "./search/contactGate";
import {
  clearAllInMemoryModelCooldowns,
  clearRouterStateForTests,
  evaluateKeyHeadroom,
  isCandidateCoolingDown,
  isChatCapableModelId,
  MAX_AUTO_ATTEMPTS,
  rankPoolCandidates,
  recordCandidateFailure,
  recordKeyUsageHit,
} from "./llm/router";
import { summarizeKeyAnalytics } from "./llm/analytics";
import {
  buildSearchProviderStates,
  computeSearchProviderStatus,
  isSearchProviderSelectable,
} from "./search/providerStatus";
import { SEARCH_PROVIDER_CATALOG, type AiExecutionLogRecord } from "./llm/types";
import { normalizeSearchProviderId } from "./llm/types";
import { readFileSync } from "node:fs";
import { composeInitialServer, validateEmailQuality } from "./compose";
import { isUsableContactName, normalizeEmailGreeting } from "./outreach-utils";
import { hasSendableEmail, MAX_REWRITE_BATCH, prospectDisplayName } from "./review-queue";
import type { CampaignConfig, Lead, ResearchResult, Settings } from "./types";
import { GatewayProviderError } from "./llm/providers";
import {
  encryptGatewayKey,
  getUserAiSettings,
  listAdminSearchKeys,
  mergeSearchKeySources,
  resetGatewayCachesForTests,
  seedGatewayCachesForTests,
  type DecryptedAdminSearchKey,
} from "./llm/store";
import {
  clearDiscoveryCacheForTests,
  discoverProspectsServer,
} from "./intelligence";
import {
  clearGrowthRunStoreForTests,
  executeGrowthStageDiscover,
  executeGrowthStageInspect,
  executeGrowthStageScoreAndBuild,
  executeGrowthStageStrategy,
} from "./growth-advisor-server";
import { getRegionalComplianceGuidance } from "./compliance/regionalRules";
import { classifyEmailType, clearEmailMxCacheForTests, verifyEmailDeliverability } from "./search/emailVerify";
import {
  clearSearchCacheAndQuotasForTests,
  getSearchQuotaMonitorSnapshot,
  resetSearchProviderQuota,
  type SearchQuotaRecord,
} from "./search/quotaAndCache";
import { inspectProspectWebsite } from "./search/siteInspector";
import {
  parseDuckDuckGoHtml,
  WebSearchService,
} from "./search/webSearch";
import { DEFAULT_SETTINGS } from "./types";
import type { AdminAiKeyRecord, AdminAiSettings, AdminSearchKeyPublic, UserAiKeyRecord } from "./llm/types";
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
    totpVerified: true,
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

test("Admin AUTO mode fails over silently on a burst 429 without multi-hour lockouts", async () => {
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
    // A transient RPM 429 benches only that (key, model) pair: the key itself
    // must stay healthy so other models on the same key keep answering.
    assert.equal(groqKey.healthStatus, "healthy");
    assert.equal(groqKey.cooldownUntil, null);
    assert.equal(isCandidateCoolingDown(groqKey, groqKey.models[0].id), true);

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

    // A burst 429 (no daily wording) cools the pair for at most a minute, no
    // matter how many times it repeats. This is the "5h left at RPM 0/15" bug.
    const testKey = makeSampleAdminKey("adm_ladder", "openai", "sk-LadderTest123");
    const rateErr = new GatewayProviderError("429 Rate limit exceeded", { status: 429, rateLimited: true });
    const f1 = recordCandidateFailure(testKey, "m1", rateErr);
    const f2 = recordCandidateFailure(testKey, "m1", rateErr);
    assert.ok(f1.cooldownMs >= 45_000 && f1.cooldownMs <= 60_000, `burst cooldown was ${f1.cooldownMs}ms`);
    assert.ok(f2.cooldownMs >= 45_000 && f2.cooldownMs <= 60_000, `repeat cooldown was ${f2.cooldownMs}ms`);
    assert.equal(testKey.healthStatus, "healthy");
    assert.equal(testKey.cooldownUntil, null);

    // Upstream Retry-After is honoured, but capped at two minutes.
    const slowBurst = new GatewayProviderError("429 slow down", {
      status: 429,
      rateLimited: true,
      retryAfterMs: 900_000,
    });
    assert.equal(recordCandidateFailure(testKey, "m2", slowBurst).cooldownMs, 120_000);

    // Only explicit daily exhaustion earns the long bench.
    const dailyErr = new GatewayProviderError("429 quota exceeded for per day limit", {
      status: 429,
      rateLimited: true,
      dailyQuotaExhausted: true,
    });
    const fDaily = recordCandidateFailure(testKey, "m3", dailyErr);
    assert.equal(fDaily.cooldownMs, 24 * 60 * 60_000);
    assert.equal(testKey.healthStatus, "cooldown");
    assert.ok(testKey.cooldownUntil !== null);

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
    // Hard "No Verified Contact = Do Not Save" gate keeps Austin Family Dental and discards SmileTown (whose hallucinated email left 0 verified contacts)
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].business, "Austin Family Dental");
    assert.equal(result.candidates[0].contact.email, "hello@austindental.example.com");
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

// ---------------------------------------------------------------------------
// Next-Level Growth Advisor 4-Stage Pipeline + $0 Cache/Quota/MX/Jina Tests
// ---------------------------------------------------------------------------

test("Staged Growth Advisor runs Stages 1->4 cleanly without Google grounding and blocks hallucinated emails", async () => {
  const prevFetch = globalThis.fetch;
  let groqCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("api.tavily.com/search")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Austin Smiles Dental",
              url: "https://austinsmiles.example.com",
              content: "Family dentist in North Austin, TX",
            },
            {
              title: "SPA Blank Dental Studio",
              url: "https://spadental.example.com",
              content: "Modern cosmetic clinic in Austin, TX",
            },
            {
              title: "Already Contacted Dental",
              url: "https://existing.example.com",
              content: "Existing dental office",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("austinsmiles.example.com")) {
      return new Response(
        `<html><head><title>Austin Smiles Dental</title></head><body><h1>Austin Smiles Dental</h1><a href="mailto:hello@austinsmiles.example.com">Contact</a><p>Serving Austin families since 2019.</p></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }

    // SPA page with <250 chars triggers Jina Reader keyless fallback
    if (url.startsWith("https://spadental.example.com")) {
      return new Response(`<html><head><title>SPA Dental</title></head><body><div id="root"></div></body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (url.startsWith("https://r.jina.ai/https://spadental.example.com")) {
      return new Response(
        "SPA Blank Dental Studio - Cosmetic and Implant Dentistry in Austin, TX. Reach our patient care coordinator at dr.patel@spadental.example.com for consultation bookings and dental smile makeovers.",
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    }

    if (url.includes("existing.example.com")) {
      return new Response(`<html><body>Already contacted</body></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.includes("api.groq.com")) {
      groqCalls += 1;
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      if (bodyStr.includes("STAGE 1")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    offerFitDiagnosis: "Local clinics without mobile viewports lose booking conversions.",
                    campaignName: "Austin Dental Mobile UX Sprint",
                    targetAudience: "Practice Owners & Clinic Directors",
                    targetLocation: "Austin, TX",
                    targetIndustry: "Dental Clinics",
                    messagingAngle: "Mobile booking & patient speed",
                    hook: "Missing mobile viewport tag on booking page",
                    subjectLine: "quick mobile site note",
                    sampleEmailBody: "Saw your site lacks a mobile viewport tag. Want a 2-minute fix walkthrough? Reply stop to opt out.",
                    channel: "Cold Email",
                    schedule: { sendDays: "mon,tue,wed", windowStart: 9, windowEnd: 17, followupDays: [3, 7], dailyLimit: 20 },
                    goal: "Book 5 clinic audits",
                    searchQueries: ["dental clinics in Austin TX"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // STAGE 4 scoring & drafts (intentionally includes a fake email on prospect #1 to verify anti-hallucination!)
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prospects: [
                    {
                      business: "SPA Blank Dental Studio",
                      contactName: "Dr. Patel",
                      role: "Lead Dentist",
                      email: "dr.patel@spadental.example.com",
                      phone: "",
                      website: "https://spadental.example.com",
                      location: "Austin, TX",
                      industry: "Dental Clinics",
                      sourceUrl: "https://spadental.example.com",
                      buyingIntentScore: 86,
                      buyingIntentReasoning: "Active cosmetic dentistry practice with direct doctor inbox.",
                      signals: [{ signal: "Direct email found", strength: "strong", evidence: "dr.patel@spadental.example.com verified via Jina fallback" }],
                      recommendedTemplateId: "T1",
                      firstLine: "Noticed SPA Blank Dental Studio highlights cosmetic smile makeovers in Austin.",
                      draftSubject: "smile makeover booking flow",
                      draftBody: "Hi Dr. Patel, noticed SPA Blank Dental Studio highlights cosmetic smile makeovers in Austin. Happy to send a brief note on mobile conversions if helpful. Reply stop to opt out.",
                    },
                    {
                      business: "Austin Smiles Dental",
                      contactName: "",
                      role: "",
                      email: "totally.fake.invented@hallucinated-domain.org",
                      phone: "",
                      website: "https://austinsmiles.example.com",
                      location: "Austin, TX",
                      industry: "Dental Clinics",
                      sourceUrl: "https://austinsmiles.example.com",
                      buyingIntentScore: 72,
                      buyingIntentReasoning: "Homepage lacks mobile viewport meta tag.",
                      signals: [{ signal: "Missing viewport", strength: "moderate", evidence: "No mobile viewport tag in homepage HTML" }],
                      recommendedTemplateId: "T10",
                      firstLine: "Checked Austin Smiles Dental and spotted a missing mobile viewport meta tag.",
                      draftSubject: "austin smiles mobile view",
                      draftBody: "Hi team, spotted that Austin Smiles Dental is missing a mobile viewport tag. Want a 2-step fix list? Reply stop to opt out.",
                    },
                  ],
                }),
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
    clearRouterStateForTests();
    clearGrowthRunStoreForTests();
    clearSearchCacheAndQuotasForTests();
    clearEmailMxCacheForTests();

    const now = new Date().toISOString();
    const ownerId = "owner-ga-staged";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" }),
      adminKeys: [
        makeSampleAdminKey("adm_google_off_ga", "google", "AIzaOff", { enabled: false }),
        makeSampleAdminKey("adm_groq_ga", "groq", "gsk_GroqStaged", {
          models: [
            {
              id: "llama-3.3-70b-versatile",
              displayName: "Llama 3.3 70B Versatile",
              enabled: true,
              seats: ["balanced", "fast", "smart"],
              capabilities: { json: true, tools: true, vision: false, reasoning: false },
            },
          ],
        }),
      ],
      searchKeys: [
        {
          id: "srch_tavily_ga",
          provider: "tavily",
          label: "Tavily GA",
          apiKey: "tvly-ga-test",
          maskedKey: "tvly••••test",
          enabled: true,
          healthStatus: "healthy",
          createdAt: now,
          updatedAt: now,
        },
      ],
      userSettings: {
        [ownerId]: {
          ownerId,
          mode: "system_auto",
          fallbackToSystemAuto: false,
          updatedAt: now,
        },
      },
      userKeys: { [ownerId]: [] },
    });

    const profile = {
      ...EMPTY_GROWTH_PROFILE,
      whoYouAre: "Apex Web Studio",
      whatYouSell: "Mobile UX & Conversion Audits",
      industry: "Dental Clinics",
      offer: "Free 2-minute mobile UX audit",
      priceRange: "$2,500",
      location: "Austin, TX",
      idealCustomer: "Clinic Owners",
    };

    // Stage 1: Strategy & Compliance
    const s1 = await executeGrowthStageStrategy({
      ownerId,
      profile,
      knowledgeDigest: "Apex Web Studio fixes mobile conversion bottlenecks for local clinics.",
      settings: { ...DEFAULT_SETTINGS, physical_address: "100 Congress Ave, Austin, TX" },
    });
    assert.ok(s1.runId.startsWith("grun_"));
    assert.ok(s1.state.strategy?.complianceFramework.includes("CAN-SPAM"));
    assert.ok((s1.state.strategy?.searchQueries.length ?? 0) >= 1);

    // Stage 2: Discovery & Deduplication
    const s2 = await executeGrowthStageDiscover({
      runId: s1.runId,
      ownerId,
      existingWebsites: ["https://existing.example.com"],
    });
    assert.equal(s2.state.discovered?.duplicatesRemoved, 1);
    assert.equal(s2.state.discovered?.candidates.length, 2);

    // Stage 3: Live Site Inspection (direct HTML + Jina Reader JS fallback) + MX guard
    const spaInspected = await inspectProspectWebsite("https://spadental.example.com", { bypassCache: true });
    assert.equal(spaInspected?.enrichmentSource, "jina_reader");
    assert.ok(spaInspected?.emails.includes("dr.patel@spadental.example.com"));

    const s3 = await executeGrowthStageInspect({
      runId: s1.runId,
      ownerId,
    });
    assert.equal(s3.state.inspected?.reachableCount, 2);
    assert.equal(s3.state.inspected?.verifiedEmailsCount, 2);

    // Stage 4: Scoring & Anti-hallucination guard
    const s4 = await executeGrowthStageScoreAndBuild({
      runId: s1.runId,
      ownerId,
      profile,
      knowledgeDigest: "",
      settings: DEFAULT_SETTINGS,
    });
    assert.equal(groqCalls, 2);
    assert.equal(s4.blueprint.prospects.length, 2);
    // Ordered highest buying intent first
    assert.equal(s4.blueprint.prospects[0].business, "SPA Blank Dental Studio");
    assert.equal(s4.blueprint.prospects[0].buyingIntentScore, 86);
    assert.equal(s4.blueprint.prospects[0].email, "dr.patel@spadental.example.com");
    // Prospect #2 had invented email stripped cleanly and replaced by verified homepage email (never the hallucinated one)
    assert.equal(s4.blueprint.prospects[1].email, "hello@austinsmiles.example.com");
    assert.notEqual(s4.blueprint.prospects[1].email, "totally.fake.invented@hallucinated-domain.org");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
    clearGrowthRunStoreForTests();
    clearSearchCacheAndQuotasForTests();
    clearEmailMxCacheForTests();
  }
});

test("Search 7d cache saves credits, exhausted quotas auto-skip cleanly, and emailVerify classifies direct vs role inboxes", async () => {
  const prevFetch = globalThis.fetch;
  let exaAttempts = 0;
  let tavilyCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.exa.ai/search")) {
      exaAttempts += 1;
      // Exa returns HTTP 402 credits exhausted -> auto-benched silently!
      return new Response(JSON.stringify({ error: "Out of credits" }), { status: 402 });
    }
    if (url.includes("api.tavily.com/search")) {
      tavilyCalls += 1;
      return new Response(
        JSON.stringify({
          results: [
            { title: "Oakwood Accounting", url: "https://oakwoodcpa.example.com", content: "CPA firm in Chicago" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearSearchCacheAndQuotasForTests();
    clearEmailMxCacheForTests();

    const now = new Date().toISOString();
    seedGatewayCachesForTests({
      searchKeys: [
        {
          id: "srch_exa_402",
          provider: "exa",
          label: "Exa 402",
          apiKey: "exa-test-402",
          maskedKey: "exa••••402",
          enabled: true,
          healthStatus: "healthy",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "srch_tavily_ok",
          provider: "tavily",
          label: "Tavily OK",
          apiKey: "tvly-ok",
          maskedKey: "tvly••••ok",
          enabled: true,
          healthStatus: "healthy",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    // 1. Call #1 hits Exa (402 exhausted) -> silently fails over to Tavily
    const r1 = await WebSearchService.search("CPA firms Chicago", { maxResults: 5 });
    assert.equal(r1.results.length, 1);
    assert.equal(r1.results[0].sourceProvider, "tavily");
    assert.equal(exaAttempts, 1);
    assert.equal(tavilyCalls, 1);

    // 2. Call #2 with same query hits 7-day search cache at 0 credits (Tavily NOT called again)
    const r2 = await WebSearchService.search("CPA firms Chicago", { maxResults: 5 });
    assert.equal(r2.cacheHit, true);
    assert.equal(tavilyCalls, 1);

    // 3. Call #3 with NEW query skips exhausted Exa completely (exaAttempts stays 1!)
    await WebSearchService.search("Tax advisors Boston", { maxResults: 5 });
    assert.equal(exaAttempts, 1);
    assert.equal(tavilyCalls, 2);

    const snap = await getSearchQuotaMonitorSnapshot();
    const exaQuota = snap.quotas.find((q) => q.provider === "exa");
    assert.equal(exaQuota?.status, "exhausted");
    assert.ok(snap.totalCacheHitsSaved >= 1);

    const resetExa = await resetSearchProviderQuota("exa");
    assert.equal(resetExa.status, "healthy");

    // 4. Email MX & role/direct classification + Regional compliance checks
    assert.equal(classifyEmailType("sarah.chen@oakwoodcpa.com"), "direct");
    assert.equal(classifyEmailType("info@oakwoodcpa.com"), "role_inbox");
    assert.equal(classifyEmailType("not-an-email"), "invalid");

    const disposableCheck = await verifyEmailDeliverability("spam@mailinator.com", { skipDnsLookup: false });
    assert.equal(disposableCheck.deliverable, false);
    assert.equal(disposableCheck.disposable, true);

    const ukRules = getRegionalComplianceGuidance({ targetLocation: "London, UK" });
    assert.equal(ukRules.region, "UK");
    assert.ok(ukRules.frameworkName.includes("PECR"));
    const deRules = getRegionalComplianceGuidance({ targetLocation: "Berlin, Germany" });
    assert.equal(deRules.region, "EU");
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearSearchCacheAndQuotasForTests();
    clearEmailMxCacheForTests();
  }
});

test("contactFinder decodes Cloudflare cfemail, parses JSON-LD, and crawls /contact and /about subpages", async () => {
  // Encode "dr.patel@brightdentalaustin.com" with XOR key 0x42
  const plain = "dr.patel@brightdentalaustin.com";
  const key = 0x42;
  const cfHex =
    key.toString(16).padStart(2, "0") +
    Array.from(plain, (ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  assert.equal(decodeCfEmail(cfHex), plain);

  const ldSample = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Bright Dental Austin","telephone":"+1 512-555-0192","address":{"streetAddress":"401 Congress Ave","addressLocality":"Austin","addressRegion":"TX"},"sameAs":["https://www.linkedin.com/company/bright-dental-austin"],"founder":{"@type":"Person","name":"Dr. Maya Patel","jobTitle":"Practice Owner"}}</script>`;
  const parsedLd = extractJsonLdContacts(ldSample);
  assert.deepEqual(parsedLd.phones, ["+1 512-555-0192"]);
  assert.equal(parsedLd.decisionMakers[0]?.name, "Dr. Maya Patel");
  assert.equal(parsedLd.socials[0]?.platform, "LinkedIn");

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input);
    if (u === "https://brightdentalaustin.com/" || u === "https://brightdentalaustin.com") {
      return new Response(
        `<html><head><title>Bright Dental Austin</title></head><body><h1>Austin Family Dentist</h1><a href="/contact">Contact Us</a><a href="/about">About Team</a>${ldSample}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (u === "https://brightdentalaustin.com/contact") {
      return new Response(
        `<html><body><a href="/cdn-cgi/l/email-protection#${cfHex}" data-cfemail="${cfHex}">Email Us</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (u === "https://brightdentalaustin.com/about") {
      return new Response(
        `<html><body><p>Dr. Maya Patel, Founder & Lead Dentist</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    // Seed offline DNS MX response by mocking verifyEmailDeliverability? Instead test subpage + JSON-LD + cfemail directly,
    // and ensure phones, socials, decisionMakers, location, and checked pages are populated cleanly even offline.
    const profile = await findDeepContactsForProspect({
      business: "Bright Dental Austin",
      website: "https://brightdentalaustin.com",
      allowTargetedSearch: false,
      timeoutMs: 2_000,
    });
    assert.ok(profile.emails.includes("dr.patel@brightdentalaustin.com"));
    assert.ok(profile.phones.includes("+1 512-555-0192"));
    assert.equal(profile.socials[0]?.platform, "LinkedIn");
    assert.equal(profile.decisionMakers[0]?.name, "Dr. Maya Patel");
    assert.ok(profile.location.includes("Austin"));
    assert.equal(profile.hasVerifiedContact, true);
    assert.ok(profile.contactPagesChecked.some((p) => p.includes("/contact")));
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("hard contact gate & add_lead firewall block zero-contact and synthetic placeholder emails", async () => {
  clearVerifiedDiscoveryForTests();

  const zeroContact = validateContactableLead({
    business: "Ghost LLC",
    website: "https://ghostllc.com",
    email: "",
    phone: "",
    socials: [],
  });
  assert.equal(zeroContact.contactable, false);

  const synthetic = validateContactableLead({
    business: "Fake Biz",
    website: "https://fakebiz.com",
    email: "placeholder@example.com",
  });
  assert.equal(synthetic.contactable, false);

  const validDirect = validateContactableLead({
    business: "Bright Dental Austin",
    website: "https://brightdentalaustin.com",
    location: "Austin, TX",
    email: "dr.patel@brightdentalaustin.com",
    decisionMaker: "Dr. Maya Patel",
    mxVerified: true,
  });
  assert.equal(validDirect.contactable, true);
  assert.ok(validDirect.completenessRank >= 150);

  const opBlockedSynthetic = validateOperatorAddLead(
    { business: "Austin Smile", website: "https://austinsmile.com", email: "info@austinsmile.com" },
    { userTextCorpus: "find me 5 dental clinics in Austin and add them" },
  );
  assert.equal(opBlockedSynthetic.allowed, false);

  const blockedRes = await executeAgentTool(
    "add_lead",
    { business: "Austin Smile", website: "https://austinsmile.com", email: "info@austinsmile.com" },
    {
      uid: "u-gate-test",
      navigate: () => {},
      onDataMutated: () => {},
      hasWorkspaceToken: () => true,
      userTextCorpus: "find me 5 dental clinics in Austin",
    },
  );
  assert.equal(blockedRes.ok, false);
  assert.ok(blockedRes.summary.startsWith("BLOCKED:"));

  const opAllowedExplicit = validateOperatorAddLead(
    { business: "Austin Smile", website: "https://austinsmile.com", email: "frontdesk@austinsmile.com" },
    { userTextCorpus: "Please add Austin Smile with frontdesk@austinsmile.com" },
  );
  assert.equal(opAllowedExplicit.allowed, true);
});

test("router enforces pre-flight context window safety, tool-calling exclusions, and isolated 413/400 cooldowns", () => {
  clearRouterStateForTests();
  clearAllInMemoryModelCooldowns();
  const now = Date.now();

  const settings: AdminAiSettings = makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" });

  const makeKey = (
    id: string,
    provider: AdminAiKeyRecord["provider"],
    models: { id: string; tools?: boolean; contextWindow?: number }[],
  ): AdminAiKeyRecord =>
    makeSampleAdminKey(id, provider, `key_${id}`, {
      models: models.map((m) => ({
        id: m.id,
        displayName: m.id,
        enabled: true,
        seats: ["fast", "balanced", "smart"],
        isFreeTier: true,
        contextWindow: m.contextWindow,
        capabilities: { json: true, tools: m.tools ?? true, vision: false, reasoning: false },
      })),
    });

  const cfKey = makeKey("k_cf", "cloudflare", [
    { id: "@cf/meta/llama-3.1-8b-instruct-fast", tools: false, contextWindow: 24_000 },
    { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", tools: false, contextWindow: 24_000 },
  ]);
  const groqKey = makeKey("k_groq", "groq", [
    { id: "llama-3.1-8b-instant", tools: true, contextWindow: 128_000 },
    { id: "llama-3.3-70b-versatile", tools: true, contextWindow: 128_000 },
    { id: "openai/gpt-oss-120b", tools: true, contextWindow: 128_000 },
  ]);
  const nvidiaKey = makeKey("k_nv", "nvidia", [
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", tools: true, contextWindow: 128_000 },
  ]);

  // 1. Pre-flight context window guard skips 24k Cloudflare models when prompt estimates 25k tokens
  const oversizedPool = rankPoolCandidates({
    keys: [cfKey, groqKey],
    settings,
    taskType: "balanced",
    estimatedTokens: 25_000,
    now,
  });
  assert.ok(oversizedPool.every((c) => c.key.provider !== "cloudflare"));
  assert.ok(oversizedPool.length > 0);

  // 2. Tool-calling guard excludes Cloudflare and tiny <= 8B models, and demotes 550B slow mega-models
  const toolPool = rankPoolCandidates({
    keys: [cfKey, groqKey, nvidiaKey],
    settings,
    taskType: "balanced",
    requiresTools: true,
    feature: "operator_chat",
    now,
  });
  assert.ok(toolPool.every((c) => c.key.provider !== "cloudflare"));
  assert.ok(toolPool.every((c) => !c.model.id.includes("llama-3.1-8b")));
  assert.equal(toolPool[0]?.key.provider, "groq");

  // 3. HTTP 413 isolates cooldown ONLY to (k_groq, openai/gpt-oss-120b) — NOT whole k_groq key
  recordCandidateFailure(
    groqKey,
    "openai/gpt-oss-120b",
    new GatewayProviderError("Request too large for TPM", {
      status: 413,
      modelUnsupported: true,
      retryable: true,
    }),
  );
  assert.equal(groqKey.healthStatus, "healthy");
  assert.equal(isCandidateCoolingDown(groqKey, "openai/gpt-oss-120b"), true);
  assert.equal(isCandidateCoolingDown(groqKey, "llama-3.3-70b-versatile"), false);

  clearAllInMemoryModelCooldowns();
  assert.equal(isCandidateCoolingDown(groqKey, "openai/gpt-oss-120b"), false);
});

test("Phase 2 sitemap discovery extracts contacts & proof URLs from /robots.txt + /sitemap.xml /staff and /connect", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input);
    if (u === "https://gracechurchaustin.org" || u === "https://gracechurchaustin.org/") {
      return new Response(
        `<html><head><title>Grace Community Austin</title></head><body><h1>Welcome Home</h1><p>Sundays at 10am in Austin, TX.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (u === "https://gracechurchaustin.org/robots.txt") {
      return new Response("User-agent: *\nSitemap: https://gracechurchaustin.org/custom-sitemap.xml\n", { status: 200 });
    }
    if (u === "https://gracechurchaustin.org/custom-sitemap.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://gracechurchaustin.org/sermons</loc></url><url><loc>https://gracechurchaustin.org/staff</loc></url><url><loc>https://gracechurchaustin.org/connect</loc></url></urlset>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (u === "https://gracechurchaustin.org/staff") {
      return new Response(
        `<html><body><h2>Leadership Team</h2><p>Pastor David Miller, Lead Pastor</p><a href="mailto:david.miller@gracechurchaustin.org">Email Pastor David</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (u === "https://gracechurchaustin.org/connect") {
      return new Response(
        `<html><body><a href="tel:+15125550888">Call Office</a><a href="https://instagram.com/gracechurchatx">Instagram</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const profile = await findDeepContactsForProspect({
      business: "Grace Community Austin",
      website: "https://gracechurchaustin.org",
      allowTargetedSearch: false,
      timeoutMs: 3_000,
    });
    assert.ok(profile.emails.includes("david.miller@gracechurchaustin.org"));
    assert.ok(profile.phones.includes("+15125550888"));
    assert.equal(profile.decisionMakers[0]?.name, "Pastor David Miller");
    assert.ok(profile.socials.some((s) => s.platform === "Instagram"));
    assert.ok(profile.contactSourceUrls.some((ev) => ev.sourceUrl.endsWith("/staff") && ev.channel === "email"));
    assert.ok(profile.contactSourceUrls.some((ev) => ev.sourceUrl.endsWith("/connect") && ev.channel === "phone"));
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("Phase 3 prompt token budgets stay <8000 tokens across all workflows & strip unresolved placeholders", async () => {
  const { buildOrchestratedSystemPrompt, findUnresolvedPlaceholders, stripUnresolvedPlaceholders } = await import(
    "./ai/orchestrator"
  );

  const workflows = [
    "research_and_qualify",
    "draft_outreach",
    "handle_reply",
    "plan_campaign",
    "growth_advisor",
    "assistant_chat",
  ] as const;

  for (const wf of workflows) {
    const built = await buildOrchestratedSystemPrompt({
      workflow: wf,
      settings: { sender_name: "Sam", sender_email: "sam@example.io" },
      knowledgeDigest: "X".repeat(12_000),
      taskInstructions: "Execute task concisely.",
    });
    const estTokens = Math.ceil(built.system.length / 4);
    assert.ok(estTokens < 6_000, `${wf} exceeded budget: ${estTokens} tokens`);
  }

  const rawDraft = "Hi [First Name],\n\nLoved seeing {{company}} grow [Your Name].";
  assert.ok(findUnresolvedPlaceholders(rawDraft).length >= 2);
  const cleaned = stripUnresolvedPlaceholders(rawDraft);
  assert.equal(findUnresolvedPlaceholders(cleaned).length, 0);
  assert.ok(!cleaned.includes("[First Name]"));
  assert.ok(!cleaned.includes("{{company}}"));
});

test("Phase 3 campaign gate & router hardening block placeholder emails, flag junk leads, and isolate HTTP 400", async () => {
  const { evaluateLeadSendEligibility } = await import("./guardrails");
  const { isLeadMissingVerifiedContact } = await import("./search/contactGate");

  const flagged = isLeadMissingVerifiedContact({
    business: "Ghost Clinic",
    email: "placeholder@example.com",
    phone: "",
    website: "https://ghostclinic.example.com",
  });
  assert.equal(flagged.needsVerification, true);

  const blockedPlaceholder = evaluateLeadSendEligibility({
    lead: {
      id: "l_bad",
      email: "placeholder@example.com",
      email_norm: "placeholder@example.com",
      score: 92,
      status: "qualified",
    },
    senderEmail: "founder@myagency.io",
  });
  assert.equal(blockedPlaceholder.eligible, false);
  assert.equal(blockedPlaceholder.code, "PLACEHOLDER_EMAIL");

  // HTTP 400 never bends key healthStatus; research feature excludes Cloudflare
  clearRouterStateForTests();
  clearAllInMemoryModelCooldowns();
  const settings = makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" });
  const cfKey = makeSampleAdminKey("k_cf_r", "cloudflare", "cf_tok", {
    models: [
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        displayName: "CF 70B",
        enabled: true,
        seats: ["fast", "balanced", "smart"],
        capabilities: { json: true, tools: false, vision: false, reasoning: false },
      },
    ],
  });
  const groqKey = makeSampleAdminKey("k_groq_r", "groq", "groq_tok", {
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

  const researchPool = rankPoolCandidates({
    keys: [cfKey, groqKey],
    settings,
    taskType: "balanced",
    feature: "research",
  });
  assert.ok(researchPool.every((c) => c.key.provider !== "cloudflare"));

  recordCandidateFailure(
    groqKey,
    "llama-3.3-70b-versatile",
    new GatewayProviderError("Unsupported parameter", { status: 400, modelUnsupported: true, retryable: true }),
  );
  assert.equal(groqKey.healthStatus, "healthy");
  assert.equal(isCandidateCoolingDown(groqKey, "llama-3.3-70b-versatile"), true);
  clearAllInMemoryModelCooldowns();
});

test("AI Rewrite: KB preflight gap detection, diff highlighting, deterministic self-check, and empty KB handling", async () => {
  const { diffEmailText, filterReviewableMessageIds, runDeterministicRewriteAudit } = await import("./email-rewrite");
  const { extractKnowledgeForRewrite } = await import("./email-rewrite-server");
  const { buildEmptyUserBusinessProfile } = await import("./global-knowledge/user-context");

  // 1. Word diff highlights additions & removals cleanly
  const tokens = diffEmailText("Hi there, want a website redesign?", "Hi Dr. Patel, want a faster mobile booking site?");
  assert.ok(tokens.some((t) => t.type === "remove" && t.text.includes("there")));
  assert.ok(tokens.some((t) => t.type === "add" && t.text.includes("Patel")));

  // 2. Scope filtering keeps unsent reviewable messages and honors selected/unapproved
  const msgs = [
    { id: "m1", kind: "initial" as const, status: "pending_approval" as const },
    { id: "m2", kind: "initial" as const, status: "approved" as const },
    { id: "m3", kind: "initial" as const, status: "sent" as const },
    { id: "m4", kind: "reply" as const, status: "draft" as const },
  ];
  assert.deepEqual(filterReviewableMessageIds(msgs, "all", []), ["m1", "m2"]);
  assert.deepEqual(filterReviewableMessageIds(msgs, "unapproved", []), ["m1"]);
  assert.deepEqual(filterReviewableMessageIds(msgs, "selected", ["m2", "m3"]), ["m2"]);

  // 3. Deterministic audit catches [First Name], missing compliance, fabricated greeting names, wrong company, and sample cloning
  const sampleText = "Noticed your clinic checkout takes four clicks on mobile. Worth sharing a 60-second walkthrough?";
  const badAudit = runDeterministicRewriteAudit({
    subject: "Quick note for [Company]",
    body: "Hi Jordan, hope this email finds you well! Mentioned SmileOther Clinic yesterday. Noticed your clinic checkout takes four clicks on mobile. Worth sharing a 60-second walkthrough?",
    kind: "initial",
    leadBusiness: "Bright Dental",
    leadContactName: "",
    senderName: "Alex",
    senderCompany: "Apex Web",
    otherLeadBusinesses: ["SmileOther Clinic"],
    sampleEmails: [sampleText],
  });
  assert.equal(badAudit.passed, false);
  assert.equal(badAudit.noPlaceholdersOrWrongNames, false);
  assert.equal(badAudit.compliancePresent, false);
  assert.equal(badAudit.clearCtaAndLengthFit, false);

  const goodAudit = runDeterministicRewriteAudit({
    subject: "mobile booking gap at bright dental",
    body: "Hi team at Bright Dental,\n\nI saw your booking form requires five extra taps on phones.\n\nWe help Austin clinics simplify mobile scheduling without redesigning the whole site. Would a 2-minute teardown video be helpful?\n\nBest,\nAlex · Apex Web\nReply stop to opt out.",
    kind: "initial",
    leadBusiness: "Bright Dental",
    leadContactName: "",
    senderName: "Alex",
    senderCompany: "Apex Web",
    otherLeadBusinesses: ["SmileOther Clinic"],
    sampleEmails: [sampleText],
  });
  assert.equal(goodAudit.passed, true);

  // 4. Empty KB detects missing sample emails, proof, offer, ICP, and voice cleanly without throwing
  const emptyKb = extractKnowledgeForRewrite({
    messages: [],
    leads: [],
    campaigns: [],
    replies: [],
    opens: [],
    userContext: {
      ownerId: "u_empty",
      profile: buildEmptyUserBusinessProfile("u_empty"),
      variables: {
        USER_NAME: "Not provided",
        USER_ROLE: "Not provided",
        USER_COMPANY: "Not provided",
        USER_OFFER: "Not provided",
        USER_MECHANISM: "Not provided",
        USER_LEAD_MAGNET: "Not provided",
        USER_PROOF: "Not provided",
        USER_ICP: "Not provided",
        USER_EXCLUSIONS: "Not provided",
        USER_SENDING_TIER: "free_gmail_starter",
        USER_TONE: "Not provided",
        USER_CUSTOM_RULES: "Not provided",
      },
      masterKnowledge: "",
      notes: [],
      sources: [],
      knowledgeDigest: "",
      settings: {},
    },
    onboarding: null,
    structuredKb: null,
    settings: { ...DEFAULT_SETTINGS },
  });
  assert.equal(emptyKb.kbEmpty, true);
  assert.ok(emptyKb.gaps.some((g) => g.key === "sample_emails"));
  assert.ok(emptyKb.gaps.some((g) => g.key === "proof_credibility"));
});

test("AI Rewrite E2E: multi-lead pipeline, sample style prompt, deterministic retry, Needs attention, Accept/Reject/History, job persistence & tenant isolation", async () => {
  const { clearBackgroundJobsForTests } = await import("./background-jobs");
  const {
    __configureEmailRewriteStoreForTests,
    applyRewriteItemAction,
    getRewriteJobAndWorkspace,
    getRewritePreflightAndWorkspace,
    runEmailRewriteJobPipeline,
    startEmailRewriteJob,
  } = await import("./email-rewrite-server");
  const { buildEmptyUserBusinessProfile } = await import("./global-knowledge/user-context");
  type EmailRewriteWorkspaceState = import("./email-rewrite").EmailRewriteWorkspaceState;
  type RewriteOwnerSnapshot = import("./email-rewrite-server").RewriteOwnerSnapshot;

  clearBackgroundJobsForTests();
  resetGatewayCachesForTests();
  clearRouterStateForTests();

  const prevFetch = globalThis.fetch;
  const capturedPrompts: string[] = [];
  const attemptByBusiness = new Map<string, number>();

  // Mock Groq Gateway responding deterministically per lead case
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.groq.com")) {
      return new Response("Not found", { status: 404 });
    }
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(rawBody) as { messages?: { role: string; content: string }[] };
    const sysAndUser = (parsed.messages ?? []).map((m) => m.content).join("\n");
    capturedPrompts.push(sysAndUser);

    // Self-check auditor call
    if (sysAndUser.includes("REWRITTEN SUBJECT:")) {
      const hasFakeClaim = sysAndUser.includes("500% guaranteed ROI");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kbGroundedOnly: !hasFakeClaim,
                  matchesBrandVoice: true,
                  issues: hasFakeClaim ? ["Invented '500% guaranteed ROI' not present in KB."] : [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Cross-lead pattern summary call
    if (sysAndUser.includes("ENGAGEMENT DATA AVAILABLE:")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  patterns: [
                    {
                      pattern: "Short observation-first emails fit local clinic decision makers",
                      segment: "Dental & Medical Founders",
                      explanation: "Informed recommendation based on verified mobile UX findings.",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Lead-by-lead writer:
    // Case A: Bright Dental (fails attempt 1 due to [First Name], passes on attempt 2 regeneration!)
    if (sysAndUser.includes("Company: Bright Dental")) {
      const n = (attemptByBusiness.get("Bright Dental") ?? 0) + 1;
      attemptByBusiness.set("Bright Dental", n);
      const isSecond = n >= 2;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  analysis: {
                    decisionMaker: "Dr. Maya Patel",
                    role: "Practice Owner",
                    seniority: "Founder / Owner",
                    company: "Bright Dental",
                    industry: "Dental Clinics",
                    size: "10-25",
                    location: "Austin, TX",
                    needsAndPainPoints: ["New patients drop off on mobile booking form"],
                    buyingIntentSignals: ["Missing mobile viewport meta tag"],
                    timingOrTriggers: ["Active Austin clinic expansion"],
                    verifiedHooks: [
                      {
                        hook: "Booking page lacks mobile viewport tag on brightdental.com",
                        source: "https://brightdental.com",
                      },
                    ],
                    chosenPattern: {
                      framework: "Problem-led",
                      frameworkReason: "Ties directly to verified mobile booking friction.",
                      toneAndFormality: "Warm conversational direct",
                      toneReason: "Matches Knowledge Base brand voice for clinic owners.",
                      lengthAndStructure: "Short 3-sentence scan",
                      lengthReason: "Inspired by KB Sample Email 1 rhythm without copying.",
                      subjectLineApproach: "2-4 word lowercase observation",
                      subjectReason: "Clean inbox feel",
                      ctaStyle: "Soft question",
                      ctaReason: "Asks for permission before pitching",
                      followUpTiming: "3 business days",
                      followUpReason: "Respects clinic schedule",
                      overallReason: "Grounded in brightdental.com viewport finding and KB sample cadence.",
                    },
                  },
                  subject: isSecond ? "quick mobile booking note" : "Hi [First Name] note",
                  subjectOptions: ["quick mobile booking note", "bright dental mobile scheduling", "2-min patient UX look"],
                  body: isSecond
                    ? "Hi Dr. Patel,\n\nI saw Bright Dental's booking page lacks a mobile viewport tag, which usually forces Austin patients to pinch-zoom on phones.\n\nWe recently helped an Austin clinic clean up mobile scheduling using our Speed Audit. Want me to send over a 90-second video showing what we found?\n\nBest,\nAlex · Apex Web\nReply stop to opt out."
                    : "Hi [First Name], wanted to share quick UX feedback for [Company]. Reply stop to opt out.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Case B: Persistent hallucinator ("Bad Claim Biz") -> fails self-check all 3 times -> flagged Needs attention
    if (sysAndUser.includes("Company: Bad Claim Biz")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  analysis: {
                    decisionMaker: "Not verified",
                    role: "Owner",
                    seniority: "Owner",
                    company: "Bad Claim Biz",
                    industry: "Consulting",
                    size: "Unknown",
                    location: "Dallas, TX",
                    needsAndPainPoints: ["Need more qualified calls"],
                    verifiedHooks: [],
                    chosenPattern: {
                      framework: "Direct",
                      frameworkReason: "Sparse lead record",
                      toneAndFormality: "Direct",
                      toneReason: "Simple",
                      lengthAndStructure: "Brief",
                      lengthReason: "Fast skim",
                      subjectLineApproach: "Short",
                      subjectReason: "Direct",
                      ctaStyle: "Soft",
                      ctaReason: "Low friction",
                      followUpTiming: "4 days",
                      followUpReason: "Standard",
                      overallReason: "Sparse record without site hook.",
                    },
                  },
                  subject: "quick question",
                  subjectOptions: ["quick question", "dallas consulting note"],
                  body: "Hi team at Bad Claim Biz,\n\nOur system delivers 500% guaranteed ROI in 48 hours for Texas consultants.\n\nOpen to chatting this week?\n\nAlex · Apex Web\nReply stop to opt out.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Case C: Sparse hookless lead ("Quiet Co") -> verifiedHooks stays [], no invented claims -> passes!
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                analysis: {
                  decisionMaker: "Not verified",
                  role: "Unknown",
                  seniority: "Unknown",
                  company: "Quiet Co",
                  industry: "Local Services",
                  size: "Unknown",
                  location: "Austin, TX",
                  needsAndPainPoints: ["Convert existing local inquiries cleanly"],
                  verifiedHooks: [],
                  chosenPattern: {
                    framework: "Consultative",
                    frameworkReason: "Lead had sparse research and no site hook, so avoided guessing.",
                    toneAndFormality: "Plain conversational",
                    toneReason: "Matches brand voice without hype.",
                    lengthAndStructure: "Short 3 lines",
                    lengthReason: "Respects sparse data.",
                    subjectLineApproach: "Plain observation",
                    subjectReason: "No clickbait.",
                    ctaStyle: "Soft question",
                    ctaReason: "Low pressure.",
                    followUpTiming: "4 business days",
                    followUpReason: "Respectful spacing.",
                    overallReason: "Sparse data handled honestly with zero invented hooks.",
                  },
                },
                subject: "quick question for quiet co",
                subjectOptions: ["quick question for quiet co", "austin outreach idea"],
                body: "Hi team at Quiet Co,\n\nWe help Austin service businesses streamline how new customer inquiries turn into booked calls via our Speed Audit.\n\nWould it be useful if I shared two simple adjustments tailored to local teams like yours?\n\nBest,\nAlex · Apex Web\nReply stop to opt out.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  // In-memory multi-tenant store simulating Supabase with strict owner scoping
  const ownerA = "owner_alice";
  const ownerB = "owner_bob";
  const now = new Date().toISOString();

  const messagesDb = new Map<string, import("./types").Message>([
    [
      "msg_a1",
      {
        id: "msg_a1",
        ownerId: ownerA,
        lead_id: "lead_a1",
        campaign_id: "camp_a",
        step: 1,
        kind: "initial",
        subject: "Original A1 Subject",
        body: "Original A1 Body.",
        angle: "Old Angle",
        rationale: "Old Rationale",
        service: "Speed Audit",
        status: "pending_approval",
        gmail_id: null,
        thread_id: null,
        rfc_message_id: null,
        sent_at: null,
        error: null,
        approved_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "msg_a2",
      {
        id: "msg_a2",
        ownerId: ownerA,
        lead_id: "lead_a2",
        campaign_id: "camp_a",
        step: 1,
        kind: "initial",
        subject: "Original A2 Subject",
        body: "Original A2 Body.",
        angle: null,
        rationale: null,
        service: "Speed Audit",
        status: "pending_approval",
        gmail_id: null,
        thread_id: null,
        rfc_message_id: null,
        sent_at: null,
        error: null,
        approved_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "msg_a3",
      {
        id: "msg_a3",
        ownerId: ownerA,
        lead_id: "lead_a3",
        campaign_id: "camp_a",
        step: 1,
        kind: "initial",
        subject: "Original A3 Subject",
        body: "Original A3 Body.",
        angle: null,
        rationale: null,
        service: "Speed Audit",
        status: "pending_approval",
        gmail_id: null,
        thread_id: null,
        rfc_message_id: null,
        sent_at: null,
        error: null,
        approved_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "msg_b1",
      {
        id: "msg_b1",
        ownerId: ownerB,
        lead_id: "lead_b1",
        campaign_id: null,
        step: 1,
        kind: "initial",
        subject: "Bob Private Subject",
        body: "Bob Private Body.",
        angle: null,
        rationale: null,
        service: null,
        status: "pending_approval",
        gmail_id: null,
        thread_id: null,
        rfc_message_id: null,
        sent_at: null,
        error: null,
        approved_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
  ]);

  const leadsDb = new Map<string, import("./types").Lead>([
    [
      "lead_a1",
      {
        id: "lead_a1",
        ownerId: ownerA,
        campaign_id: "camp_a",
        business: "Bright Dental",
        contact_name: "Dr. Maya Patel",
        role: "Practice Owner",
        email: "dr.patel@brightdental.com",
        email_norm: "dr.patel@brightdental.com",
        website: "https://brightdental.com",
        phone: "+15125550100",
        location: "Austin, TX",
        industry: "Dental Clinics",
        notes: null,
        extra: null,
        source: "web_discovery",
        source_ref: "https://brightdental.com",
        sheet_row: null,
        status: "qualified",
        score: 88,
        priority: "high",
        score_reason: {
          score: 88,
          category: "high",
          reasons: ["Missing mobile viewport tag"],
          opportunity: "Mobile scheduling audit",
          value_tier: "high",
          recommended_service: "Speed Audit",
        },
        research: {
          business_name_confirmed: true,
          industry: "Dental Clinics",
          summary: "Family dental clinic in Austin missing mobile viewport meta tag.",
          website_status: "reachable",
          website_facts: ["Booking page lacks mobile viewport tag"],
          verified_facts: [{ fact: "Missing mobile viewport meta tag", source: "https://brightdental.com" }],
          findings: [],
          inferences: [],
          opportunities: [],
          recommended_angle: "Mobile patient booking",
          confidence: 90,
          insufficient_data: false,
          notes: "",
        },
        research_at: now,
        research_ok: true,
        manual_research: null,
        last_contacted_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "lead_a2",
      {
        id: "lead_a2",
        ownerId: ownerA,
        campaign_id: "camp_a",
        business: "Quiet Co",
        contact_name: null,
        role: null,
        email: "hello@quietco.io",
        email_norm: "hello@quietco.io",
        website: null,
        phone: "+15125550199",
        location: "Austin, TX",
        industry: "Local Services",
        notes: null,
        extra: null,
        source: "manual",
        source_ref: null,
        sheet_row: null,
        status: "qualified",
        score: 68,
        priority: "medium",
        score_reason: null,
        research: null,
        research_at: null,
        research_ok: false,
        manual_research: null,
        last_contacted_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "lead_a3",
      {
        id: "lead_a3",
        ownerId: ownerA,
        campaign_id: "camp_a",
        business: "Bad Claim Biz",
        contact_name: null,
        role: "Owner",
        email: "team@badclaimbiz.io",
        email_norm: "team@badclaimbiz.io",
        website: "https://badclaimbiz.io",
        phone: null,
        location: "Dallas, TX",
        industry: "Consulting",
        notes: null,
        extra: null,
        source: "manual",
        source_ref: null,
        sheet_row: null,
        status: "qualified",
        score: 70,
        priority: "medium",
        score_reason: null,
        research: null,
        research_at: null,
        research_ok: false,
        manual_research: null,
        last_contacted_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
    [
      "lead_b1",
      {
        id: "lead_b1",
        ownerId: ownerB,
        campaign_id: null,
        business: "Bob Secret Client",
        contact_name: "Bob",
        role: "CEO",
        email: "bob@bobsecret.io",
        email_norm: "bob@bobsecret.io",
        website: null,
        phone: null,
        location: "Miami, FL",
        industry: "Finance",
        notes: null,
        extra: null,
        source: "manual",
        source_ref: null,
        sheet_row: null,
        status: "new",
        score: null,
        priority: null,
        score_reason: null,
        research: null,
        research_at: null,
        research_ok: false,
        manual_research: null,
        last_contacted_at: null,
        created_at: now,
        updated_at: now,
      },
    ],
  ]);

  const wsDb = new Map<string, EmailRewriteWorkspaceState>();

  const buildSnap = (ownerId: string): RewriteOwnerSnapshot => {
    const isAlice = ownerId === ownerA;
    const baseProfile = buildEmptyUserBusinessProfile(ownerId);
    return {
      messages: Array.from(messagesDb.values()).filter((m) => m.ownerId === ownerId),
      leads: Array.from(leadsDb.values()).filter((l) => l.ownerId === ownerId),
      campaigns: [],
      replies: [],
      opens: [],
      userContext: {
        ownerId,
        profile: {
          ...baseProfile,
          user_name: isAlice ? "Alex" : "BobUser",
          user_company: isAlice ? "Apex Web" : "Bob Agency",
          user_offer: isAlice ? "Speed Audit for local clinics" : "Bob Secret Offer",
          user_proof: isAlice ? "Helped an Austin clinic simplify mobile scheduling" : "",
          user_tone: "Warm conversational direct",
        },
        variables: {
          USER_NAME: isAlice ? "Alex" : "BobUser",
          USER_ROLE: "Founder",
          USER_COMPANY: isAlice ? "Apex Web" : "Bob Agency",
          USER_OFFER: isAlice ? "Speed Audit" : "Bob Secret Offer",
          USER_MECHANISM: "90-second video teardown",
          USER_LEAD_MAGNET: "Free Speed Audit",
          USER_PROOF: isAlice ? "Helped an Austin clinic simplify mobile scheduling" : "Not provided",
          USER_ICP: "Austin clinics",
          USER_EXCLUSIONS: "None",
          USER_SENDING_TIER: "free_gmail_starter",
          USER_TONE: "Warm conversational direct",
          USER_CUSTOM_RULES: "",
        },
        masterKnowledge: isAlice ? "## Business overview\nApex Web helps Austin clinics convert mobile bookings." : "",
        notes: isAlice
          ? [
              {
                id: "note_sample",
                ownerId: ownerA,
                category: "samples",
                title: "Sample Emails",
                content: "Hi Sarah, noticed one snag on mobile checkout — open to a quick 90-second clip? Reply stop to opt out.",
                sort: 1,
                is_master: false,
                created_at: now,
                updated_at: now,
              },
            ]
          : [],
        sources: [],
        knowledgeDigest: isAlice ? "Apex Web Speed Audit sample cadence" : "Bob secret KB",
        settings: { ...DEFAULT_SETTINGS, sender_name: isAlice ? "Alex" : "BobUser", sender_company: isAlice ? "Apex Web" : "Bob Agency" },
      },
      onboarding: isAlice
        ? {
            status: "completed",
            currentStep: 12,
            updatedAt: now,
            answers: {
              ...DEFAULT_ONBOARDING_ANSWERS,
              businessDescription: "Apex Web builds faster mobile booking flows for clinics.",
              sampleMessages: "Hi Sarah, noticed one snag on mobile checkout — open to a quick 90-second clip?",
            },
          }
        : null,
      structuredKb: null,
      settings: { ...DEFAULT_SETTINGS, sender_name: isAlice ? "Alex" : "BobUser", sender_company: isAlice ? "Apex Web" : "Bob Agency" },
    };
  };

  __configureEmailRewriteStoreForTests({
    loadOwnerSnapshot: async (ownerId) => buildSnap(ownerId),
    loadWorkspace: async (ownerId) => wsDb.get(ownerId) ?? null,
    saveWorkspace: async (ownerId, st) => {
      wsDb.set(ownerId, st);
    },
    updateMessageFields: async (ownerId, messageId, patch) => {
      const existing = messagesDb.get(messageId);
      assert.equal(existing?.ownerId, ownerId);
      if (existing) {
        messagesDb.set(messageId, { ...existing, ...patch });
      }
    },
  });

  seedGatewayCachesForTests({
    adminSettings: makeSampleAdminSettings({ masterMode: "auto", strategy: "balanced" }),
    adminKeys: [
      makeSampleAdminKey("adm_groq_rw", "groq", "gsk_rewrite", {
        models: [
          {
            id: "llama-3.3-70b-versatile",
            displayName: "Llama 3.3 70B",
            enabled: true,
            seats: ["fast", "balanced", "smart"],
            capabilities: { json: true, tools: true, vision: false, reasoning: false },
          },
        ],
      }),
    ],
    userSettings: {
      [ownerA]: { ownerId: ownerA, mode: "system_auto", fallbackToSystemAuto: false, updatedAt: now },
      [ownerB]: { ownerId: ownerB, mode: "system_auto", fallbackToSystemAuto: false, updatedAt: now },
    },
    userKeys: { [ownerA]: [], [ownerB]: [] },
  });

  try {
    // 1. Preflight summarizes exact counts, sample emails, and gaps for Alice
    const pre = await getRewritePreflightAndWorkspace({ ownerId: ownerA, scope: "all" });
    assert.equal(pre.preflight.inScopeEmails, 3);
    assert.equal(pre.preflight.uniqueLeadsCount, 3);
    assert.ok(pre.preflight.sampleEmailsFound >= 1);

    // 2. Start durable job + prevent duplicate concurrent jobs
    const s1 = await startEmailRewriteJob({ ownerId: ownerA, scope: "all" });
    assert.equal(s1.reused, false);
    assert.equal(s1.targetIds.length, 3);

    const dupStart = await startEmailRewriteJob({ ownerId: ownerA, scope: "all" });
    assert.equal(dupStart.reused, true);
    assert.equal(dupStart.job.id, s1.job.id);

    // 3. Execute background pipeline across all 3 emails
    const finishedWs = await runEmailRewriteJobPipeline({
      ownerId: ownerA,
      jobId: s1.job.id,
      targetIds: s1.targetIds,
    });

    // Originals in messagesDb are UNTOUCHED before acceptance
    assert.equal(messagesDb.get("msg_a1")?.body, "Original A1 Body.");

    // Prompt included Sample Emails style guidance
    assert.ok(capturedPrompts.some((p) => p.includes("Hi Sarah, noticed one snag on mobile checkout")));

    // Bright Dental failed attempt 1 ([First Name]), regenerated cleanly, passed attempt 2
    const itemA1 = finishedWs.itemsByMessageId["msg_a1"];
    assert.equal(itemA1.status, "rewritten");
    assert.equal(itemA1.check?.attempts, 2);
    assert.ok(itemA1.subjectOptions.length >= 2);
    assert.ok(!itemA1.rewrittenBody.includes("[First Name]"));

    // Sparse Quiet Co kept verifiedHooks = [] without guessing
    const itemA2 = finishedWs.itemsByMessageId["msg_a2"];
    assert.equal(itemA2.status, "rewritten");
    assert.equal(itemA2.analysis?.verifiedHooks.length, 0);

    // Bad Claim Biz hallucinated ROI -> deterministic gate catches it -> one
    // corrective retry -> flagged "needs_attention" (NEVER marked ready!)
    const itemA3 = finishedWs.itemsByMessageId["msg_a3"];
    assert.equal(itemA3.status, "needs_attention");
    assert.equal(itemA3.check?.attempts, 2);
    assert.equal(itemA3.check?.passed, false);
    assert.ok((itemA3.statusReason ?? "").includes("500% guaranteed ROI"));

    // Cross-lead patterns explicitly labeled as recommendations (no engagement events recorded)
    assert.equal(finishedWs.crossLeadSummary?.basedOnEngagementData, false);
    assert.match(finishedWs.crossLeadSummary?.label ?? "", /not proven results/i);

    // 4. Job state & workspace survive simulated reload; Bob cannot see Alice's job/items
    const reloadedAlice = await getRewriteJobAndWorkspace({ ownerId: ownerA });
    assert.equal(reloadedAlice.job?.status, "succeeded");
    assert.equal(Object.keys(reloadedAlice.workspace.itemsByMessageId).length, 3);

    const bobState = await getRewriteJobAndWorkspace({ ownerId: ownerB });
    assert.equal(bobState.job, null);
    assert.equal(Object.keys(bobState.workspace.itemsByMessageId).length, 0);

    // Bob cannot accept or mutate Alice's email
    await assert.rejects(
      () => applyRewriteItemAction({ ownerId: ownerB, action: "accept", messageId: "msg_a1" }),
      /not found/i,
    );

    // 5. Accept All Passed accepts msg_a1 & msg_a2 ONLY (leaves needs_attention msg_a3 unaccepted)
    const acceptAllRes = await applyRewriteItemAction({ ownerId: ownerA, action: "accept_all_passed" });
    assert.equal(acceptAllRes.updatedCount, 2);
    assert.equal(acceptAllRes.workspace.itemsByMessageId["msg_a1"].status, "accepted");
    assert.equal(acceptAllRes.workspace.itemsByMessageId["msg_a3"].status, "needs_attention");
    assert.equal(messagesDb.get("msg_a1")?.subject, "quick mobile booking note");

    // Version history preserves original & allows restoring it
    assert.ok(itemA1.versions.some((v) => v.source === "original" && v.body === "Original A1 Body."));
    await applyRewriteItemAction({
      ownerId: ownerA,
      action: "restore_version",
      messageId: "msg_a1",
      versionId: "v_orig",
    });
    assert.equal(messagesDb.get("msg_a1")?.body, "Original A1 Body.");

    // Edit & Reject preserve original intact on Reject
    await applyRewriteItemAction({
      ownerId: ownerA,
      action: "reject",
      messageId: "msg_a2",
    });
    assert.equal(wsDb.get(ownerA)?.itemsByMessageId["msg_a2"].status, "rejected");

    // Retry failed/flagged only skips already accepted/rejected good items
    const retryRes = await startEmailRewriteJob({
      ownerId: ownerA,
      scope: "all",
      retryFailedOnly: true,
    });
    assert.deepEqual(retryRes.targetIds, ["msg_a3"]);
  } finally {
    globalThis.fetch = prevFetch;
    __configureEmailRewriteStoreForTests(null);
    clearBackgroundJobsForTests();
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("Phase 1 10x: Forensic Website Auditor isolates hidden-DOM Lorem ipsum, catches broken nav links, captures Lighthouse screenshot & runs Vision", async () => {
  const { extractVisibleDom, runForensicWebsiteAudit } = await import("./search/forensicAudit");
  const { seedGatewayCachesForTests, resetGatewayCachesForTests } = await import("./llm/store");
  const { encryptSecret } = await import("./key-vault");
  const { clearSearchCacheAndQuotasForTests } = await import("./search/quotaAndCache");
  const { clearRouterStateForTests } = await import("./llm/router");

  const hiddenHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bright Smile Clinic</title></head>
    <body>
      <header><nav><a href="/book">Book Now</a><a href="/broken-page">Pricing</a><a href="/blocked-portal">Portal</a></nav></header>
      <div style="display:none">Lorem ipsum dolor sit amet template fragment</div>
      <main><h1>Modern Family Dentistry in Austin</h1><a href="tel:+15125550199">Call Us</a></main>
    </body></html>`;

  const dom = extractVisibleDom(hiddenHtml);
  assert.deepEqual(dom.visiblePlaceholders, []);
  assert.ok(dom.hiddenDomOnlyArtifacts.includes("hidden_dom_only:lorem ipsum"));
  assert.equal(dom.hasViewportMeta, true);
  assert.equal(dom.hasClickablePhone, true);

  clearSearchCacheAndQuotasForTests();
  resetGatewayCachesForTests();
  clearRouterStateForTests();

  const fakePngBase64 = Buffer.from("fake-mobile-screenshot-bytes").toString("base64");
  seedGatewayCachesForTests({
    adminSettings: makeSampleAdminSettings({
      masterMode: "auto",
      strategy: "balanced",
      fallbackChain: [{ provider: "google", model: "gemini-2.5-flash" }],
    }),
    adminKeys: [
      {
        id: "k_vis_1",
        provider: "google",
        label: "Google Vision Test",
        encryptedKey: encryptSecret("AIzaSy-test-key"),
        maskedKey: "AIza•••key",
        enabled: true,
        rpmLimit: 30,
        rpdLimit: 1000,
        healthStatus: "healthy",
        cooldownUntil: null,
        cooldownStep: 0,
        lastError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            enabled: true,
            seats: ["fast", "balanced", "smart"],
            capabilities: { json: true, tools: true, vision: true, reasoning: false },
            isFreeTier: true,
            contextWindow: 1_000_000,
          },
        ],
      },
    ],
    userSettings: {
      forensic_user: {
        ownerId: "forensic_user",
        mode: "system_auto",
        activeProvider: null,
        activeKeyId: null,
        activeModel: null,
        fallbackToSystemAuto: true,
        updatedAt: new Date().toISOString(),
      },
    },
  });

  const prevFetch = globalThis.fetch;
  let visionSawImage = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://brightsmile-audit.example/" || url === "https://brightsmile-audit.example") {
      return new Response(hiddenHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url === "https://brightsmile-audit.example/broken-page") {
      return new Response("Not Found", { status: 404 });
    }
    if (url === "https://brightsmile-audit.example/blocked-portal") {
      return new Response("Forbidden", { status: 403 });
    }
    if (url === "https://brightsmile-audit.example/book") {
      return new Response("OK", { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/pagespeedonline/v5/runPagespeed")) {
      return new Response(
        JSON.stringify({
          lighthouseResult: {
            categories: {
              performance: { score: 0.48 },
              accessibility: { score: 0.82 },
              seo: { score: 0.9 },
            },
            audits: {
              "largest-contentful-paint": { numericValue: 4800, title: "Largest Contentful Paint", displayValue: "4.8 s", score: 0.25 },
              "final-screenshot": { details: { data: `data:image/jpeg;base64,${fakePngBase64}` } },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        contents?: { parts?: { inlineData?: { data?: string } }[] }[];
      };
      visionSawImage = Boolean(payload.contents?.[0]?.parts?.some((p) => p.inlineData?.data === fakePngBase64));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      siteLooksSolid: false,
                      overallVerdict: "Slow mobile load (48/100, LCP 4.8s) and broken Pricing nav link",
                      issues: [
                        {
                          issue: 'Hero loads in 4.8s on mobile and the "Pricing" nav link returns HTTP 404.',
                          evidence_type: "broken_link",
                          proof: "Pricing -> 404; Mobile Lighthouse 48/100",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("OK", { status: 200 });
  }) as typeof fetch;

  try {
    const audit = await runForensicWebsiteAudit("https://brightsmile-audit.example", {
      ownerId: "forensic_user",
      runVision: true,
      checkLinks: true,
      bypassCache: true,
    });
    assert.ok(audit);
    assert.equal(audit.brokenLinks.length, 1);
    assert.equal(audit.brokenLinks[0]?.status, 404);
    assert.equal(audit.lighthouse?.mobileScore, 48);
    assert.equal(audit.lighthouse?.lcpSeconds, 4.8);
    assert.ok(audit.mobileScreenshotUrl?.startsWith("data:image/jpeg;base64,"));
    assert.equal(visionSawImage, true);
    assert.equal(audit.dom.visiblePlaceholders.length, 0);
    assert.ok(audit.auditEvidence.some((e) => e.evidence_type === "broken_link" && e.proof.includes("404")));
  } finally {
    globalThis.fetch = prevFetch;
    clearSearchCacheAndQuotasForTests();
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("Phase 2 & 3 10x: Default email_required firewall blocks phone-only leads, Exa People + Apollo resolve contacts, and 550B mega models are hard-excluded", async () => {
  const { validateContactableLead } = await import("./search/contactGate");
  const { findDeepContactsForProspect } = await import("./search/contactFinder");
  const { rankPoolCandidates, clearRouterStateForTests } = await import("./llm/router");
  const { seedGatewayCachesForTests, resetGatewayCachesForTests } = await import("./llm/store");
  const { clearSearchCacheAndQuotasForTests } = await import("./search/quotaAndCache");

  // Default requires verified email (prevents zero-email leads like Walton Family Dentistry)
  const phoneOnlyBlocked = validateContactableLead({
    business: "Walton Family Dentistry",
    website: "https://waltondentistry.example",
    location: "Austin, TX",
    phone: "+15125550111",
    email: "",
  });
  assert.equal(phoneOnlyBlocked.contactable, false);

  // Explicit opt-in mode allows phone/social-only
  const phoneOnlyAllowed = validateContactableLead({
    business: "Walton Family Dentistry",
    website: "https://waltondentistry.example",
    location: "Austin, TX",
    phone: "+15125550111",
    email: "",
    requireEmail: false,
  });
  assert.equal(phoneOnlyAllowed.contactable, true);

  // Layer 2 waterfall: Exa People + Apollo resolve decision-maker LinkedIn + verified email
  clearSearchCacheAndQuotasForTests();
  resetGatewayCachesForTests();
  seedGatewayCachesForTests({
    searchKeys: [
      {
        id: "srch_exa",
        provider: "exa",
        label: "Exa",
        apiKey: "exa-test",
        maskedKey: "exa",
        enabled: true,
        healthStatus: "healthy",
        lastError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "srch_apollo",
        provider: "apollo",
        label: "Apollo",
        apiKey: "apollo-test",
        maskedKey: "apollo",
        enabled: true,
        healthStatus: "healthy",
        lastError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://northstar-dental-test.example")) {
      return new Response(`<html><body><h1>Northstar Dental</h1></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url === "https://api.exa.ai/search") {
      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://www.linkedin.com/in/sarah-jenkins-dds",
              title: "Dr. Sarah Jenkins - Owner at Northstar Dental | LinkedIn",
              text: "Owner and Dentist at Northstar Dental.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.apollo.io/api/v1/mixed_people/search") {
      return new Response(
        JSON.stringify({
          people: [
            {
              name: "Dr. Sarah Jenkins",
              title: "Owner",
              email: "sarah@gmail.com",
              linkedin_url: "https://www.linkedin.com/in/sarah-jenkins-dds",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const deep = await findDeepContactsForProspect({
      business: "Northstar Dental",
      website: "https://northstar-dental-test.example",
      location: "Austin, TX",
      allowTargetedSearch: false,
      timeoutMs: 3_000,
    });
    assert.ok(deep.decisionMakers.some((d) => d.name.includes("Sarah Jenkins")));
    assert.ok(deep.socials.some((s) => s.platform === "LinkedIn" && s.url.includes("sarah-jenkins-dds")));
    assert.equal(deep.primaryEmail, "sarah@gmail.com");
  } finally {
    globalThis.fetch = prevFetch;
    clearSearchCacheAndQuotasForTests();
    resetGatewayCachesForTests();
  }

  // Router hard-excludes 550B slow mega models from compose, research, balanced, fast & agentTurn
  clearRouterStateForTests();
  const ranked = rankPoolCandidates({
    taskType: "balanced",
    feature: "compose_initial",
    settings: makeSampleAdminSettings({
      masterMode: "auto",
      strategy: "balanced",
      fallbackChain: [],
    }),
    keys: [
      {
        id: "k_mix",
        provider: "openrouter",
        label: "OpenRouter Mix",
        encryptedKey: "x",
        maskedKey: "or•••x",
        enabled: true,
        rpmLimit: 20,
        rpdLimit: 1000,
        healthStatus: "healthy",
        cooldownUntil: null,
        cooldownStep: 0,
        lastError: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        models: [
          {
            id: "nvidia/nemotron-3-ultra-550b-a55b:free",
            displayName: "Nemotron 550B",
            enabled: true,
            seats: ["fast", "balanced", "smart"],
            capabilities: { json: true, tools: true, vision: false, reasoning: true },
            isFreeTier: true,
            contextWindow: 128_000,
          },
          {
            id: "google/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            enabled: true,
            seats: ["fast", "balanced"],
            capabilities: { json: true, tools: true, vision: true, reasoning: false },
            isFreeTier: true,
            contextWindow: 128_000,
          },
        ],
      },
    ],
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.model.id, "google/gemini-2.5-flash");
});

test("Phase 5 10x: validateEmailQuality enforces zero AI slop, zero forced opt-out footer, personal voice, Words to AVOID & <= 115 words", async () => {
  const { validateEmailQuality, extractWordsToAvoid } = await import("./compose");
  const { buildOrchestratedSystemPrompt } = await import("./ai/orchestrator");

  const avoided = extractWordsToAvoid(
    "Master Knowledge:\nWrite in first-person I.\nWords to AVOID: conversion optimization, bespoke, synergy\nWords to USE: free look",
  );
  assert.deepEqual(avoided, ["conversion optimization", "bespoke", "synergy"]);

  const badDraft = validateEmailQuality({
    subject: "website improvements",
    body: "Hi there,\n\nWe help clinics with conversion optimization and improved mobile responsiveness using bespoke solutions. If you'd rather not hear from me again, just let me know.\n\nBest,\nGodswill",
    kind: "initial",
    leadBusiness: "Oakwood Dental",
    leadContactName: "Dr. Patel",
    wordsToAvoid: avoided,
    includeOptOutFooter: false,
    identity: "personal",
  });
  assert.equal(badDraft.passed, false);
  assert.ok(badDraft.issues.some((i) => /slop|clich/i.test(i)));
  assert.ok(badDraft.issues.some((i) => /opt-out/i.test(i)));
  assert.ok(badDraft.issues.some((i) => /solo\/personal/i.test(i)));
  assert.ok(badDraft.issues.some((i) => /Words to AVOID/i.test(i)));

  const goodBody =
    "Hi Dr. Patel,\n\nI pulled up Oakwood Dental's site on a phone and noticed the Pricing nav link hits a 404 error, and the page takes 4.8s to load your main header.\n\nI rebuild slow clinic pages so mobile visitors can tap straight through to book without bouncing.\n\nWant to get a free look at a live 2-screen mockup for Oakwood Dental?\n\nGodswill";
  const goodDraft = validateEmailQuality({
    subject: "oakwood pricing link",
    body: goodBody,
    kind: "initial",
    leadBusiness: "Oakwood Dental",
    leadContactName: "Dr. Patel",
    wordsToAvoid: avoided,
    includeOptOutFooter: false,
    identity: "personal",
  });
  assert.equal(goodDraft.passed, true, `Unexpected quality issues: ${goodDraft.issues.join("; ")}`);
  assert.ok(goodDraft.wordCount >= 50 && goodDraft.wordCount <= 115);

  const built = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    knowledgeDigest:
      "Master Knowledge:\nPosition as solo developer 'I'.\nWords to AVOID: digital landscape, leverage.\nSample Style Example: Want to get a free look?",
    taskInstructions: "Draft Touch 1.",
  });
  const tokens = Math.ceil(built.system.length / 4);
  assert.ok(tokens <= 4_500, `Expected <= 4500 tokens, got ${tokens}`);
  assert.ok(built.system.includes("Words to AVOID: digital landscape, leverage"));
  assert.ok(built.system.includes("Want to get a free look?"));
});

test("Password strength rules, bcrypt hashing, and non-exposure contract", async () => {
  const { evaluatePasswordStrength } = await import("./password-policy");
  const bcrypt = await import("bcryptjs");

  const weak = evaluatePasswordStrength("short");
  assert.equal(weak.valid, false);
  assert.ok(weak.error);

  const noUpper = evaluatePasswordStrength("alllower123!");
  assert.equal(noUpper.valid, false);

  const strong = evaluatePasswordStrength("Knowrevo#2026Safe");
  assert.equal(strong.valid, true);
  assert.ok(strong.score >= 3);

  const hash = await bcrypt.default.hash("Knowrevo#2026Safe", 10);
  assert.ok(hash.startsWith("$2"));
  assert.equal(await bcrypt.default.compare("Knowrevo#2026Safe", hash), true);
  assert.equal(await bcrypt.default.compare("WrongPass123!", hash), false);
});

test("Chatbot session duration & AI response time human formatting", async () => {
  const { formatSessionDuration, formatResponseTime } = await import("./format");
  assert.equal(formatSessionDuration(0), "0 s");
  assert.equal(formatSessionDuration(42), "42 s");
  assert.equal(formatSessionDuration(198), "3 min 18 s");
  assert.equal(formatSessionDuration(3900), "1 h 05 min");
  assert.equal(formatResponseTime(2400), "2.4 s");
  assert.equal(formatResponseTime(74000), "1 min 14 s");
});

test("BYOK personal model switching applies immediately on the very next gateway request", async () => {
  const { seedGatewayCachesForTests, resetGatewayCachesForTests } = await import("./llm/store");
  const { encryptSecret } = await import("./key-vault");
  const { clearRouterStateForTests } = await import("./llm/router");

  resetGatewayCachesForTests();
  clearRouterStateForTests();

  const makeKey = (id: string, modelA: string, modelB: string): UserAiKeyRecord => ({
    id,
    ownerId: "byok_switch_user",
    provider: "groq",
    label: "Personal Groq Key",
    encryptedKey: encryptSecret("gsk_test_personal_switch_key_12345"),
    maskedKey: "gsk_•••2345",
    accountId: null,
    baseUrl: "https://api.groq.com/openai/v1",
    models: [
      {
        id: modelA,
        displayName: modelA,
        enabled: true,
        seats: ["smart", "balanced", "fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
      {
        id: modelB,
        displayName: modelB,
        enabled: true,
        seats: ["smart", "balanced", "fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
    ],
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const key = makeKey("ukey_1", "llama-3.1-8b-instant", "llama-3.3-70b-versatile");
  const seenModels: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (parsed.model) seenModels.push(parsed.model);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // Switch to model 1
    seedGatewayCachesForTests({
      userSettings: {
        byok_switch_user: {
          ownerId: "byok_switch_user",
          mode: "byok",
          activeKeyId: "ukey_1",
          activeProvider: "groq",
          activeModel: "llama-3.3-70b-versatile",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { byok_switch_user: [key] },
    });
    const r1 = await LLMGateway.complete({
      ownerId: "byok_switch_user",
      taskType: "fast",
      feature: "chat",
      messages: [{ role: "user", content: "ping 1" }],
    });
    assert.equal(r1.receipt.actualModel, "llama-3.3-70b-versatile");

    // Switch immediately to custom/unlisted model on same key (select_key_and_model registers it in key.models)
    const keyWithCustom = makeKey("ukey_1", "llama-3.1-8b-instant", "mixtral-8x7b-custom");
    seedGatewayCachesForTests({
      userSettings: {
        byok_switch_user: {
          ownerId: "byok_switch_user",
          mode: "byok",
          activeKeyId: "ukey_1",
          activeProvider: "groq",
          activeModel: "mixtral-8x7b-custom",
          fallbackToSystemAuto: false,
          updatedAt: new Date().toISOString(),
        },
      },
      userKeys: { byok_switch_user: [keyWithCustom] },
    });
    const r2 = await LLMGateway.complete({
      ownerId: "byok_switch_user",
      taskType: "fast",
      feature: "chat",
      messages: [{ role: "user", content: "ping 2" }],
    });
    assert.equal(r2.receipt.actualModel, "mixtral-8x7b-custom");
    assert.deepEqual(seenModels, ["llama-3.3-70b-versatile", "mixtral-8x7b-custom"]);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("Background job progress advances cleanly across research stages and force restart", async () => {
  const {
    advanceBackgroundJobStep,
    completeBackgroundJob,
    createOrReuseBackgroundJob,
  } = await import("./background-jobs");

  const steps: BackgroundJobStep[] = [
    { key: "searching_businesses", label: "Search", status: "pending", weightSec: 6 },
    { key: "reading_sources", label: "Read", status: "pending", weightSec: 12 },
    { key: "checking_niche", label: "Check", status: "pending", weightSec: 9 },
    { key: "ranking_recommendations", label: "Rank", status: "pending", weightSec: 4 },
  ];

  const ownerId = `test_job_owner_${Date.now()}`;
  const first = await createOrReuseBackgroundJob({
    ownerId,
    jobType: "growth_advisor_research",
    steps,
  });
  assert.equal(first.reused, false);
  const pct0 = first.job.progressPct;

  const after1 = await advanceBackgroundJobStep(ownerId, first.job.id, "searching_businesses", "done");
  assert.ok(after1 && after1.progressPct > pct0);

  // Without force, calling again reuses running job
  const dup = await createOrReuseBackgroundJob({
    ownerId,
    jobType: "growth_advisor_research",
    steps,
  });
  assert.equal(dup.reused, true);
  assert.equal(dup.job.id, first.job.id);

  // With force=true, replaces running job with a fresh run
  const forced = await createOrReuseBackgroundJob({
    ownerId,
    jobType: "growth_advisor_research",
    steps,
    force: true,
  });
  assert.equal(forced.reused, false);
  assert.notEqual(forced.job.id, first.job.id);

  const done = await completeBackgroundJob(ownerId, forced.job.id, { ok: true });
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.progressPct, 100);
});

test("Admin 2FA session gating, challenge rejection, reauth enforcement, and backup codes", async () => {
  const { generateAdminBackupCodes } = await import("./platform/admin-credentials");
  const { ADMIN_SESSION_COOKIE } = await import("./platform/admin-session");

  const codes = generateAdminBackupCodes(10);
  assert.equal(codes.plaintextCodes.length, 10);
  assert.equal(codes.hashes.length, 10);
  assert.ok(codes.plaintextCodes.every((c) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)));
  assert.ok(codes.hashes.every((h) => h.startsWith("scrypt_bc:")));

  // Cookie signed without totpVerified=true must NEVER grant session access
  const unverified = signAdminCookieToken({
    kind: "session",
    adminId: "adm_censusokoi515_gmail_com",
    email: "censusokoi515@gmail.com",
    role: "super_admin",
    totpVerified: false,
    ttlSeconds: 3600,
  });
  assert.equal(verifyAdminCookieToken(unverified.token, "session"), null);

  // Verified 2FA session passes verifyAdminCookieToken, and requireAdmin enforces requireReauth
  const verified = signAdminCookieToken({
    kind: "session",
    adminId: "adm_censusokoi515_gmail_com",
    email: "censusokoi515@gmail.com",
    role: "super_admin",
    totpVerified: true,
    ttlSeconds: 3600,
  });
  assert.ok(verifyAdminCookieToken(verified.token, "session"));

  const reqWithoutReauth = new NextRequest("http://localhost/api/admin/audit-logs", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${verified.token}` },
  });
  await assert.rejects(
    () => requireAdmin(reqWithoutReauth, "super_admin", { requireReauth: true }),
    /Re-authentication required/,
  );

  // Support role must be blocked from super_admin operations
  const supportVerified = signAdminCookieToken({
    kind: "session",
    adminId: "adm_support_test",
    email: "support@knowrevo.com",
    role: "support",
    totpVerified: true,
    ttlSeconds: 3600,
  });
  const reqSupport = new NextRequest("http://localhost/api/admin/audit-logs", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${supportVerified.token}` },
  });
  await assert.rejects(() => requireAdmin(reqSupport, "super_admin"));
});

test("Admin AI Assistant secret/PII redaction and tool permission separation", async () => {
  const {
    ADMIN_CHAT_CONFIRM_TOOLS,
    ADMIN_CHAT_READ_ONLY_TOOLS,
    redactAdminChatText,
  } = await import("./platform/admin-chat");

  const leaky =
    "Key failed AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz, vault enc:v1:abc==:xyz, user alice.founder@example.com";
  const safe = redactAdminChatText(leaky, null);
  assert.equal(safe.includes("AIzaSy"), false);
  assert.equal(safe.includes("enc:v1:"), false);
  assert.equal(safe.includes("alice.founder@example.com"), false);
  assert.ok(safe.includes("[REDACTED_SECRET]"));

  // Ensure clear separation: read-only never overlaps confirm-required tools
  for (const t of ADMIN_CHAT_READ_ONLY_TOOLS) {
    assert.equal(ADMIN_CHAT_CONFIRM_TOOLS.has(t), false);
  }
  assert.equal(ADMIN_CHAT_CONFIRM_TOOLS.has("propose_code_or_config_fix"), true);
  assert.equal(ADMIN_CHAT_CONFIRM_TOOLS.has("rerun_module_check"), true);
  assert.equal(ADMIN_CHAT_CONFIRM_TOOLS.has("clear_stuck_job"), true);
});



// ---------------------------------------------------------------------------
// Admin API Command Center: provider status, routing hygiene, key analytics
// ---------------------------------------------------------------------------

function makeQuotaRecord(
  provider: SearchQuotaRecord["provider"],
  overrides: Partial<SearchQuotaRecord> = {},
): SearchQuotaRecord {
  const base = SEARCH_PROVIDER_CATALOG.find((p) => p.id === provider);
  const now = new Date().toISOString();
  return {
    provider,
    label: base?.label ?? String(provider),
    usedCount: 0,
    quotaLimit: base?.defaultQuotaLimit ?? 100,
    resetCycle: base?.resetCycle ?? "monthly",
    exhaustedUntil: null,
    lastResetAt: now,
    cacheHitsSaved: 0,
    status: "healthy",
    updatedAt: now,
    ...overrides,
  };
}

function makeSearchKeyPublic(
  provider: SearchQuotaRecord["provider"],
  enabled: boolean,
): AdminSearchKeyPublic {
  const now = new Date().toISOString();
  return {
    id: `srch_${String(provider)}_1`,
    provider: provider as AdminSearchKeyPublic["provider"],
    label: `${String(provider)} key`,
    maskedKey: "••••1234",
    enabled,
    healthStatus: "healthy",
    lastError: null,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

test("unconfigured providers report not_configured (never healthy/exhausted) and paused keys stay paused", () => {
  const quotas = SEARCH_PROVIDER_CATALOG.map((m) => makeQuotaRecord(m.id));

  const empty = buildSearchProviderStates({ keys: [], quotas });
  const keyed = empty.filter((s) => s.kind !== "keyless");
  assert.equal(keyed.length, SEARCH_PROVIDER_CATALOG.length);
  for (const state of keyed) {
    assert.equal(state.status, "not_configured", `${state.provider} must not claim a live quota state`);
    assert.equal(state.hasKey, false);
    assert.equal(isSearchProviderSelectable(state.status), false);
  }
  assert.ok(empty.filter((s) => s.kind === "keyless").every((s) => s.status === "keyless"));

  // Even an exhausted quota row cannot make an unconfigured provider look exhausted.
  const exhaustedUnconfigured = buildSearchProviderStates({
    keys: [],
    quotas: quotas.map((q) => (q.provider === "brave" ? { ...q, status: "exhausted" as const } : q)),
  });
  assert.equal(exhaustedUnconfigured.find((s) => s.provider === "brave")?.status, "not_configured");

  const paused = buildSearchProviderStates({
    keys: [makeSearchKeyPublic("tavily", false)],
    quotas,
  });
  assert.equal(paused.find((s) => s.provider === "tavily")?.status, "paused");
  assert.equal(isSearchProviderSelectable("paused"), false);

  const active = buildSearchProviderStates({
    keys: [makeSearchKeyPublic("pagespeed", true)],
    quotas,
  });
  assert.equal(active.find((s) => s.provider === "pagespeed")?.status, "active");

  const spent = buildSearchProviderStates({
    keys: [makeSearchKeyPublic("exa", true)],
    quotas: quotas.map((q) => (q.provider === "exa" ? { ...q, status: "exhausted" as const, usedCount: 1000 } : q)),
  });
  assert.equal(spent.find((s) => s.provider === "exa")?.status, "exhausted");

  // Status precedence: key presence > pause > health > quota.
  assert.equal(
    computeSearchProviderStatus({ hasKey: false, enabled: true, quotaStatus: "exhausted" }),
    "not_configured",
  );
  assert.equal(
    computeSearchProviderStatus({ hasKey: true, enabled: false, quotaStatus: "exhausted" }),
    "paused",
  );
  assert.equal(
    computeSearchProviderStatus({ hasKey: true, enabled: true, healthStatus: "invalid" }),
    "invalid",
  );
});

test("paused search/contact/audit keys are strictly skipped by the runtime key loader (env vars cannot resurrect them)", async () => {
  const key = (over: Partial<DecryptedAdminSearchKey>): DecryptedAdminSearchKey => ({
    id: "srch_x",
    provider: "tavily",
    label: "Key",
    apiKey: "tvly-secret",
    maskedKey: "tvly-...cret",
    enabled: true,
    healthStatus: "healthy",
    lastError: null,
    lastCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  });

  // A DB row owns its provider: an env key must never take over a paused row.
  const merged = mergeSearchKeySources(
    [key({ id: "db_tavily", provider: "tavily", enabled: false })],
    [key({ id: "env_tavily", provider: "tavily", apiKey: "env-secret" })],
    ["tavily"],
  );
  assert.deepEqual(merged, []);

  // An env key still fills a provider that has no DB row at all.
  const envOnly = mergeSearchKeySources([], [key({ id: "env_exa", provider: "exa" })]);
  assert.deepEqual(envOnly.map((k) => k.provider), ["exa"]);

  // The loader itself never returns a paused key, even from a seeded cache.
  resetGatewayCachesForTests();
  seedGatewayCachesForTests({
    searchKeys: [
      key({ id: "db_paused", provider: "exa", enabled: false }),
      key({ id: "db_live", provider: "hunter", enabled: true }),
    ],
  });
  try {
    const runtimeKeys = await listAdminSearchKeys();
    assert.deepEqual(runtimeKeys.map((k) => k.provider), ["hunter"]);
  } finally {
    resetGatewayCachesForTests();
  }
});

test("router excludes allam/audio/safety models, skips paused keys, and caps failover hops at 6", async () => {
  assert.equal(isChatCapableModelId("allam-2-7b"), false);
  assert.equal(isChatCapableModelId("whisper-large-v3"), false);
  assert.equal(isChatCapableModelId("llama-guard-3-8b"), false);
  assert.equal(isChatCapableModelId("playai-tts"), false);
  assert.equal(isChatCapableModelId("openai/gpt-oss-120b"), true);

  const groqKey = makeSampleAdminKey("adm_groq_special", "groq", "gsk_special", {
    models: [
      {
        id: "allam-2-7b",
        displayName: "Allam 2 7B",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
      },
      {
        id: "openai/gpt-oss-20b",
        displayName: "GPT-OSS 20B",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
      },
    ],
  });
  const ranked = rankPoolCandidates({
    keys: [groqKey],
    settings: makeSampleAdminSettings(),
    taskType: "fast",
    feature: "compose_review",
  });
  assert.deepEqual(ranked.map((c) => c.model.id), ["openai/gpt-oss-20b"]);

  const pausedRanked = rankPoolCandidates({
    keys: [{ ...groqKey, enabled: false }],
    settings: makeSampleAdminSettings(),
    taskType: "balanced",
  });
  assert.equal(pausedRanked.length, 0);

  // Real upstream attempts are capped, so a request can never log 38 hops.
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "rate limit exceeded, slow down" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();
    const denseModels = ["m1", "m2", "m3"].map((id) => ({
      id,
      displayName: id,
      enabled: true,
      seats: ["balanced" as const],
      capabilities: { json: true, tools: true, vision: false, reasoning: false },
    }));
    const owner = "owner-hop-cap";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [
        makeSampleAdminKey("adm_hop_nvidia", "nvidia", "nvapi-hop-a", { models: denseModels }),
        makeSampleAdminKey("adm_hop_openai", "openai", "sk-hop-b", { models: denseModels }),
        makeSampleAdminKey("adm_hop_cerebras", "cerebras", "csk-hop-c", { models: denseModels }),
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

    await assert.rejects(
      LLMGateway.complete({
        ownerId: owner,
        taskType: "balanced",
        feature: "compose_review",
        messages: [{ role: "user", content: "Draft an outreach email." }],
      }),
      (err: unknown) => err instanceof LLMGatewayError,
    );
    assert.ok(calls > 0);
    assert.equal(calls, MAX_AUTO_ATTEMPTS, "a request must stop at the hard attempt cap");
    assert.ok(MAX_AUTO_ATTEMPTS <= 6);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("key analytics aggregates real receipts per key (calls, success rate, latency, p95, hops, top features)", () => {
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const day = 24 * 60 * 60_000;
  const base = {
    ownerId: "o",
    requestedMode: "system_auto" as const,
    requestedModel: null,
    grounded: false,
  };
  const logs: AiExecutionLogRecord[] = [
    { id: "l1", ...base, taskType: "balanced", feature: "compose_initial", actualProvider: "google",
      actualKeyId: "k1", actualModel: "gemini-2.5-flash", fallbackHops: 0, fallbackUsed: false,
      latencyMs: 1000, status: "success", errorSummary: null, createdAt: at(60_000) },
    { id: "l2", ...base, taskType: "balanced", feature: "compose_initial", actualProvider: "google",
      actualKeyId: "k1", actualModel: "gemini-2.5-flash", fallbackHops: 1, fallbackUsed: true,
      latencyMs: 3000, status: "success", errorSummary: null, createdAt: at(2 * day) },
    { id: "l3", ...base, taskType: "fast", feature: "operator_chat", actualProvider: "google",
      actualKeyId: "k1", actualModel: "gemini-2.5-flash", fallbackHops: 2, fallbackUsed: true,
      latencyMs: 5000, status: "failed", errorSummary: "429: rate limit", createdAt: at(3 * 60_000) },
    { id: "l4", ...base, taskType: "balanced", feature: "compose_initial", actualProvider: "groq",
      actualKeyId: "k2", actualModel: "openai/gpt-oss-20b", fallbackHops: 0, fallbackUsed: false,
      latencyMs: 200, status: "success", errorSummary: null, createdAt: at(90_000) },
  ];

  const stats = summarizeKeyAnalytics({ logs, keyId: "k1", now });
  assert.equal(stats.totalCalls, 3);
  assert.equal(stats.calls24h, 2);
  assert.equal(stats.calls7d, 3);
  assert.equal(stats.successCount, 2);
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.successRate, 66.7);
  assert.equal(stats.avgLatencyMs, 2000);
  assert.equal(stats.p95LatencyMs, 3000);
  assert.equal(stats.avgFallbackHops, 0.5);
  assert.deepEqual(stats.topFeatures[0], { feature: "compose_initial", count: 2 });
  assert.equal(stats.recentLogs.every((l) => l.actualKeyId === "k1"), true);

  const byProvider = summarizeKeyAnalytics({ logs, provider: "groq", now });
  assert.equal(byProvider.totalCalls, 1);
  assert.equal(byProvider.avgLatencyMs, 200);
});

test("placeholder stripping can never leave an empty greeting in a draft", () => {
  assert.equal(normalizeEmailGreeting("Hi {{first_name}},\n\nBody here.", null, null), "Hi there,\n\nBody here.");
  assert.equal(normalizeEmailGreeting("Hi ,\n\nBody.", null, null).startsWith("Hi there,"), true);
  assert.equal(normalizeEmailGreeting("Hi N/A,\n\nBody.", null, null).startsWith("Hi there,"), true);
  assert.equal(normalizeEmailGreeting("Hi Church Office,\n\nBody.", null, "Church Office").startsWith("Hi there,"), true);
  assert.equal(normalizeEmailGreeting("Hi ,\n\nBody.", null, "Senior Pastor").startsWith("Hi Pastor,"), true);
  assert.equal(normalizeEmailGreeting("Hi ,\n\nBody.", "Dana Whitfield", "Pastor").startsWith("Hi Dana,"), true);
  assert.equal(normalizeEmailGreeting("Hi Dana,\n\nBody.", "Dana Whitfield", null), "Hi Dana,\n\nBody.");

  assert.equal(isUsableContactName("jbw2xmu5GVR"), false);
  assert.equal(isUsableContactName("Church Office"), false);
  assert.equal(isUsableContactName("Pastor/Church Office"), false);
  assert.equal(isUsableContactName("Dana"), true);

  const report = validateEmailQuality({
    subject: "quick mobile check",
    body: `Hi ,\n\n${"Worth a quick look at the booking flow? ".repeat(8)}`,
    kind: "initial",
  });
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.toLowerCase().includes("greeting")));
});

test("email drafting still runs exactly ONE LLM call when the deterministic gate passes", async () => {
  const prevFetch = globalThis.fetch;
  let llmCalls = 0;

  globalThis.fetch = (async () => {
    llmCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                template_id: "T1",
                subject: "quick mobile check",
                body: "Hi there,\n\nI pulled up Harbor Dental on my phone this morning and noticed the booking page takes six taps before a visitor can pick a time. On mobile that is usually where most appointment requests stop.\n\nI fix that exact drop-off for dental practices and can send over a short teardown of your booking flow, no strings attached.\n\nWorth a look?\n\nAlex",
                angle: "mobile booking friction",
                rationale: "Verified mobile observation from the site audit.",
                service: "site audit",
                evidence: ["booking page takes six taps"],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    resetGatewayCachesForTests();
    clearRouterStateForTests();
    const owner = "compose-single-pass-owner";
    seedGatewayCachesForTests({
      adminSettings: makeSampleAdminSettings(),
      adminKeys: [makeSampleAdminKey("adm_compose", "groq", "gsk_ComposeSinglePass")],
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

    const lead = {
      id: "compose-lead",
      ownerId: owner,
      campaign_id: "compose-campaign",
      business: "Harbor Dental",
      contact_name: null,
      role: "Office Manager",
      email: "office@harbordental.com",
      website: "https://harbordental.com",
      status: "qualified",
      score: 78,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as Lead;
    const research = {
      summary: "Dental practice with a slow mobile booking page.",
      website_status: "live",
      awareness_level: "problem_aware",
      recommended_template_id: "T1",
      personalized_hook_candidates: ["booking page takes six taps"],
      verified_facts: [{ fact: "Six taps to book on mobile", source: "site check" }],
      website_facts: ["No viewport meta tag"],
      verified_site_issues: ["missing viewport"],
      findings: [],
      missing_data: [],
      opportunities: [{ opportunity: "mobile booking friction", service: "site audit" }],
      recommended_angle: "mobile booking friction",
      confidence: 82,
      insufficient_data: false,
    } as unknown as ResearchResult;
    const campaign = {
      id: "compose-campaign",
      name: "Dental",
      objective: "Book site audits",
      services: ["site audit"],
      tone: "direct",
      extra_instructions: "",
      identity: "personal",
    } as unknown as CampaignConfig;
    const settings = {
      sender_name: "Alex Rivera",
      sender_role: "Founder",
      sender_company: "",
      include_opt_out_footer: false,
      physical_address: "",
    } as unknown as Settings;

    const composed = await composeInitialServer(
      lead,
      research,
      campaign,
      settings,
      "We fix mobile booking drop-off for dental practices.",
      undefined,
      { ownerId: owner },
    );

    assert.equal(llmCalls, 1, "a passing draft must not trigger a second review call");
    assert.equal(composed.check?.passed, true);
    assert.equal(composed.check?.regenerated, false);
    assert.equal(composed.body.startsWith("Hi there,"), true);
  } finally {
    globalThis.fetch = prevFetch;
    resetGatewayCachesForTests();
    clearRouterStateForTests();
  }
});

test("no per-email review LLM step remains in drafting or rewriting", () => {
  const composeSrc = readFileSync(new URL("./compose.ts", import.meta.url), "utf8");
  const rewriteSrc = readFileSync(new URL("./email-rewrite-server.ts", import.meta.url), "utf8");
  assert.equal(composeSrc.includes('feature: "compose_review"'), false);
  assert.equal(rewriteSrc.includes('feature: "email_rewrite_check"'), false);
  assert.equal(/MAX_SELF_CHECK_ATTEMPTS = 2/.test(rewriteSrc), true);
});

test("email review queue shows a real name and quarantines leads without an address", () => {
  assert.equal(
    prospectDisplayName({ business: "Uptown Dental", contactName: "N/A", email: null }),
    "Uptown Dental",
  );
  assert.equal(
    prospectDisplayName({
      business: "N/A",
      contactName: "Verified Google listing",
      email: "jbw2xmu5gvr@example.com",
      website: "https://harbordental.com",
    }),
    "harbordental.com",
  );
  assert.equal(
    prospectDisplayName({ business: null, contactName: "Info", email: "dana.whitfield@clinic.com" }),
    "Dana Whitfield",
  );
  assert.equal(hasSendableEmail("no email"), false);
  assert.equal(hasSendableEmail(null), false);
  assert.equal(hasSendableEmail("office@harbordental.com"), true);
  assert.ok(MAX_REWRITE_BATCH <= 20);
});

test("a saved PageSpeed key resolves as active even under legacy provider ids", () => {
  assert.equal(normalizeSearchProviderId("google_pagespeed"), "pagespeed");
  assert.equal(normalizeSearchProviderId("Google-PageSpeed"), "pagespeed");
  assert.equal(normalizeSearchProviderId("page_speed_insights"), "pagespeed");
  assert.equal(normalizeSearchProviderId("pagespeed"), "pagespeed");
  assert.equal(normalizeSearchProviderId("definitely-not-a-provider"), null);

  const states = buildSearchProviderStates({
    keys: [makeSearchKeyPublic("google_pagespeed" as never, true)],
    quotas: [],
  });
  const pagespeed = states.find((state) => state.provider === "pagespeed");
  assert.equal(pagespeed?.hasKey, true);
  assert.equal(pagespeed?.status, "active");
  assert.equal(isSearchProviderSelectable(pagespeed?.status ?? "not_configured"), true);
});
