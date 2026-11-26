import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAgentContents } from "./agent-meta";
import {
  DEFAULT_CRITERIA,
  INDUSTRY_OPTIONS,
  SERVICE_OPTIONS,
  criteriaSummary,
  criteriaToFocus,
  sanitizeCriteria,
} from "./criteria";
import { GEO_COUNTRIES, citiesIn, geoLabel, geoSummary, statesIn } from "./geo";

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
