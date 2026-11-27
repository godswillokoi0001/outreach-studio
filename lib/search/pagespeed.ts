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

export interface PageSpeedFailedAudit {
  id: string;
  title: string;
  displayValue?: string;
  score: number | null;
}

export interface PageSpeedMetrics {
  url: string;
  mobileScore: number; // 0-100 Performance
  accessibilityScore: number | null;
  seoScore: number | null;
  lcpSeconds: number | null;
  fcpSeconds: number | null;
  clsScore: number | null;
  failedAudits: PageSpeedFailedAudit[];
  screenshotDataUrl: string | null;
  screenshotSource: "pagespeed" | "cloudflare_browser" | "screenshotone" | null;
  checkedAt: string;
}

const KEY_AUDITS = [
  "largest-contentful-paint",
  "first-contentful-paint",
  "total-blocking-time",
  "render-blocking-resources",
  "uses-optimized-images",
  "modern-image-formats",
  "unused-javascript",
  "viewport",
  "color-contrast",
  "link-name",
  "meta-description",
  "tap-targets",
] as const;

function normalizeDataUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) {
    return trimmed.length <= 420_000 ? trimmed : null;
  }
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length >= 200 && trimmed.length <= 420_000) {
    return `data:image/jpeg;base64,${trimmed.replace(/\s+/g, "")}`;
  }
  return null;
}

/**
 * Optional fallback screenshot capture (Cloudflare Browser Rendering / ScreenshotOne)
 * used ONLY when PageSpeed Insights does not return a screenshot.
 */
export async function captureMobileScreenshotFallback(
  rawUrl: string,
  options?: { timeoutMs?: number },
): Promise<{ dataUrl: string; source: "cloudflare_browser" | "screenshotone" } | null> {
  const url = normalizeWebsite(rawUrl);
  if (!url || !isFetchableUrl(url)) return null;

  const keys = await listAdminSearchKeys();
  const cfKey = keys.find((k) => k.provider === "cloudflare_browser")?.apiKey;
  if (cfKey && (await isSearchProviderAvailable("cloudflare_browser"))) {
    const colon = cfKey.indexOf(":");
    if (colon > 0) {
      const accountId = cfKey.slice(0, colon).trim();
      const token = cfKey.slice(colon + 1).trim();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 9_000);
      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/screenshot`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url,
              viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
              screenshotOptions: { type: "jpeg", quality: 72 },
            }),
            signal: controller.signal,
            cache: "no-store",
          },
        );
        if (res.status === 429 || res.status === 402) {
          await markSearchProviderExhausted("cloudflare_browser");
        } else if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 500 && buf.length <= 320_000) {
            await recordSearchProviderUsage("cloudflare_browser", 1);
            return {
              dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
              source: "cloudflare_browser",
            };
          }
        }
      } catch {
        /* continue to ScreenshotOne */
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const soKey = keys.find((k) => k.provider === "screenshotone")?.apiKey;
  if (soKey && (await isSearchProviderAvailable("screenshotone"))) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 9_000);
    try {
      const endpoint = `https://api.screenshotone.com/take?access_key=${encodeURIComponent(
        soKey,
      )}&url=${encodeURIComponent(url)}&viewport_width=390&viewport_height=844&device_scale_factor=2&format=jpeg&image_quality=72`;
      const res = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
      if (res.status === 429 || res.status === 402) {
        await markSearchProviderExhausted("screenshotone");
      } else if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500 && buf.length <= 320_000) {
          await recordSearchProviderUsage("screenshotone", 1);
          return {
            dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`,
            source: "screenshotone",
          };
        }
      }
    } catch {
      /* ignore */
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

export async function checkMobilePageSpeed(
  rawUrl: string,
  options?: { timeoutMs?: number; bypassCache?: boolean; allowScreenshotFallback?: boolean },
): Promise<PageSpeedMetrics | null> {
  const url = normalizeWebsite(rawUrl);
  if (!url || !isFetchableUrl(url)) return null;

  const cacheKey = `pagespeed:v2:${url.toLowerCase().replace(/\/+$/, "")}`;
  if (!options?.bypassCache) {
    const cached = await getCachedSearchEnrichment<PageSpeedMetrics>(cacheKey);
    if (cached) return cached;
  }

  const available = await isSearchProviderAvailable("pagespeed");
  if (!available) return null;

  const keys = await listAdminSearchKeys();
  const key = keys.find((k) => k.provider === "pagespeed")?.apiKey;
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
    url,
  )}&strategy=mobile&category=performance&category=accessibility&category=seo${
    key ? `&key=${encodeURIComponent(key)}` : ""
  }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 12_000);

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
        categories?: {
          performance?: { score?: number };
          accessibility?: { score?: number };
          seo?: { score?: number };
        };
        audits?: Record<
          string,
          {
            title?: string;
            displayValue?: string;
            score?: number | null;
            numericValue?: number;
            details?: {
              data?: string;
              screenshot?: { data?: string };
            };
          }
        >;
      };
    };

    const categories = data.lighthouseResult?.categories;
    const audits = data.lighthouseResult?.audits ?? {};
    const scoreRaw = categories?.performance?.score;
    if (typeof scoreRaw !== "number") return null;

    const lcpMs = audits["largest-contentful-paint"]?.numericValue;
    const fcpMs = audits["first-contentful-paint"]?.numericValue;
    const clsVal = audits["cumulative-layout-shift"]?.numericValue;

    const failedAudits: PageSpeedFailedAudit[] = [];
    for (const auditId of KEY_AUDITS) {
      const a = audits[auditId];
      if (!a || typeof a.score !== "number" || a.score >= 0.85) continue;
      failedAudits.push({
        id: auditId,
        title: (a.title ?? auditId).trim(),
        ...(a.displayValue ? { displayValue: a.displayValue.trim() } : {}),
        score: Number(a.score.toFixed(2)),
      });
      if (failedAudits.length >= 4) break;
    }

    let screenshotDataUrl =
      normalizeDataUrl(audits["final-screenshot"]?.details?.data) ??
      normalizeDataUrl(audits["full-page-screenshot"]?.details?.screenshot?.data) ??
      null;
    let screenshotSource: PageSpeedMetrics["screenshotSource"] = screenshotDataUrl ? "pagespeed" : null;

    if (!screenshotDataUrl && options?.allowScreenshotFallback !== false) {
      const fallback = await captureMobileScreenshotFallback(url);
      if (fallback) {
        screenshotDataUrl = fallback.dataUrl;
        screenshotSource = fallback.source;
      }
    }

    const metrics: PageSpeedMetrics = {
      url,
      mobileScore: Math.round(scoreRaw * 100),
      accessibilityScore:
        typeof categories?.accessibility?.score === "number"
          ? Math.round(categories.accessibility.score * 100)
          : null,
      seoScore:
        typeof categories?.seo?.score === "number" ? Math.round(categories.seo.score * 100) : null,
      lcpSeconds: typeof lcpMs === "number" ? Number((lcpMs / 1000).toFixed(1)) : null,
      fcpSeconds: typeof fcpMs === "number" ? Number((fcpMs / 1000).toFixed(1)) : null,
      clsScore: typeof clsVal === "number" ? Number(clsVal.toFixed(2)) : null,
      failedAudits,
      screenshotDataUrl,
      screenshotSource,
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
