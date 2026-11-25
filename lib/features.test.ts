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
