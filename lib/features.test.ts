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
