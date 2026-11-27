import { listAdminSearchKeys } from "@/lib/llm/store";
import { normalizeWebsite } from "@/lib/columns";
import { isFetchableUrl } from "@/lib/outreach-utils";
import {
  getCachedSearchEnrichment,
  isSearchProviderAvailable,
  markSearchProviderExhausted,
  recordSearchProviderUsage,
  setCachedSearchEnrichment,
} from "./quotaAndCache";

export interface PageSpeedMetrics {
  url: string;
  mobileScore: number; // 0-100
  lcpSeconds: number | null;
  checkedAt: string;
}

export async function checkMobilePageSpeed(
  rawUrl: string,
  options?: { timeoutMs?: number },
): Promise<PageSpeedMetrics | null> {
  const url = normalizeWebsite(rawUrl);
  if (!url || !isFetchableUrl(url)) return null;

  const cacheKey = `pagespeed:${url.toLowerCase()}`;
  const cached = await getCachedSearchEnrichment<PageSpeedMetrics>(cacheKey);
  if (cached) return cached;

  const available = await isSearchProviderAvailable("pagespeed");
  if (!available) return null;

  const keys = await listAdminSearchKeys();
  const key = keys.find((k) => k.provider === "pagespeed")?.apiKey;
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
    url,
  )}&strategy=mobile&category=performance${key ? `&key=${encodeURIComponent(key)}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 6_000);

  try {
    const res = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
    if (res.status === 429 || res.status === 402) {
      await markSearchProviderExhausted("pagespeed");
      return null;
    }
    if (!res.ok) return null;

    await recordSearchProviderUsage("pagespeed", 1);

    const data = (await res.json()) as {
      lighthouseResult?: {
        categories?: { performance?: { score?: number } };
        audits?: { "largest-contentful-paint"?: { numericValue?: number } };
      };
    };

    const scoreRaw = data.lighthouseResult?.categories?.performance?.score;
    const lcpMs = data.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue;
    if (typeof scoreRaw !== "number") return null;

    const metrics: PageSpeedMetrics = {
      url,
      mobileScore: Math.round(scoreRaw * 100),
      lcpSeconds: typeof lcpMs === "number" ? Number((lcpMs / 1000).toFixed(1)) : null,
      checkedAt: new Date().toISOString(),
    };
    await setCachedSearchEnrichment(cacheKey, "pagespeed", metrics);
    return metrics;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
