/**
 * Builds lib/geo-data.json from the dr5hn countries-states-cities dataset.
 *
 * Source: https://github.com/dr5hn/countries-states-cities-database (ODbL).
 * Every country and first-level region is kept; each region keeps up to
 * MAX_CITIES city names so the bundle stays small enough to ship to the
 * browser. Run with: node scripts/build-geo.mjs <path-to-countries+states+cities.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_CITIES = 8;
const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/build-geo.mjs <countries+states+cities.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(resolve(source), "utf8"));

const seenCity = new Set();
const countries = raw.map((country) => {
  const states = (country.states ?? []).map((state) => {
    const names = (state.cities ?? [])
      .map((city) => String(city.name ?? "").trim())
      .filter(Boolean);
    // Prefer the shortest distinct names: they are the recognisable city names
    // rather than "Aba North" style sub-divisions.
    const unique = Array.from(new Set(names)).sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { name: String(state.name ?? "").trim(), cities: unique.slice(0, MAX_CITIES) };
  });
  return {
    name: country.name,
    iso2: country.iso2,
    continent: country.region || "Other",
    states: states.filter((state) => state.name),
  };
});

for (const country of countries) {
  for (const state of country.states) {
    for (const city of state.cities) seenCity.add(`${country.iso2}:${city}`);
  }
}

const output = {
  source: "dr5hn/countries-states-cities-database",
  license: "ODbL-1.0",
  generated_at: new Date().toISOString().slice(0, 10),
  countries,
};

writeFileSync(resolve("lib/geo-data.json"), JSON.stringify(output), "utf8");
console.log(
  `Wrote lib/geo-data.json: ${countries.length} countries, ` +
    `${countries.reduce((sum, c) => sum + c.states.length, 0)} regions, ${seenCity.size} city names`,
);
