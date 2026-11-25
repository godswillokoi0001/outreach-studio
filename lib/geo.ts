"use client";

import { useMemo, useSyncExternalStore } from "react";
import geoData from "./geo-data.json";

export interface GeoCountry {
  name: string;
  iso2: string;
  continent: string;
  states: { name: string; cities: string[] }[];
}

export interface GeoData {
  source: string;
  license: string;
  generated_at: string;
  countries: GeoCountry[];
}

export interface GeoSelection {
  continent: string;
  country: string;
  state: string;
  cities: string[];
  /** Free-text neighbourhood, estate or landmark. */
  area: string;
}

export const EMPTY_GEO: GeoSelection = {
  continent: "",
  country: "",
  state: "",
  cities: [],
  area: "",
};

const data = geoData as GeoData;

export const GEO_COUNTRIES: GeoCountry[] = data.countries;

export const GEO_CONTINENTS: string[] = Array.from(
  new Set(GEO_COUNTRIES.map((country) => country.continent)),
).sort((a, b) => a.localeCompare(b));

export function countriesIn(continent: string): GeoCountry[] {
  if (!continent) return GEO_COUNTRIES;
  return GEO_COUNTRIES.filter((country) => country.continent === continent);
}

export function findCountry(name: string): GeoCountry | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  return GEO_COUNTRIES.find((country) => country.name.toLowerCase() === key || country.iso2.toLowerCase() === key);
}

export function statesIn(countryName: string): string[] {
  return findCountry(countryName)?.states.map((state) => state.name) ?? [];
}

export function citiesIn(countryName: string, stateName: string): string[] {
  const country = findCountry(countryName);
  if (!country) return [];
  if (!stateName) return country.states.flatMap((state) => state.cities).slice(0, 400);
  return country.states.find((state) => state.name === stateName)?.cities ?? [];
}

/** Human label used on buttons, chips and saved leads. */
export function geoLabel(selection: GeoSelection): string {
  const parts = [...selection.cities, selection.area.trim(), selection.state, selection.country].filter(Boolean);
  return Array.from(new Set(parts)).join(", ");
}

/** The location string sent to research/discovery prompts. */
export function geoSummary(selection: GeoSelection): string {
  return geoLabel(selection) || selection.continent || "";
}

export function isGeoEmpty(selection: GeoSelection): boolean {
  return !selection.country && !selection.state && !selection.cities.length && !selection.area.trim();
}

const RECENT_KEY = "knowrevo:geo-recent";
const RECENT_LIMIT = 6;

export function readRecentLocations(): GeoSelection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is GeoSelection => Boolean(item) && typeof item === "object")
      .map((item) => ({
        continent: String(item.continent ?? ""),
        country: String(item.country ?? ""),
        state: String(item.state ?? ""),
        cities: Array.isArray(item.cities) ? item.cities.map(String) : [],
        area: String(item.area ?? ""),
      }))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

const RECENT_EVENT = "knowrevo:geo-recent-changed";

export function rememberLocation(selection: GeoSelection): void {
  if (typeof window === "undefined" || isGeoEmpty(selection)) return;
  try {
    const key = geoLabel(selection);
    const next = [selection, ...readRecentLocations().filter((item) => geoLabel(item) !== key)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_EVENT));
  } catch {
    /* storage full or blocked: recents are a convenience only */
  }
}

function subscribeRecent(onChange: () => void): () => void {
  window.addEventListener(RECENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(RECENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readRecentRaw(): string {
  try {
    return window.localStorage.getItem(RECENT_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Recent locations, kept in sync without setting state from an effect. */
export function useRecentLocations(): GeoSelection[] {
  const raw = useSyncExternalStore(subscribeRecent, readRecentRaw, () => "[]");
  return useMemo(() => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is GeoSelection => Boolean(item) && typeof item === "object")
        .map((item) => ({
          continent: String(item.continent ?? ""),
          country: String(item.country ?? ""),
          state: String(item.state ?? ""),
          cities: Array.isArray(item.cities) ? item.cities.map(String) : [],
          area: String(item.area ?? ""),
        }))
        .slice(0, RECENT_LIMIT);
    } catch {
      return [];
    }
  }, [raw]);
}
