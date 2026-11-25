import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { isFetchableUrl } from "@/lib/outreach-utils";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const body = (await req.json()) as { urls?: { id: string; url: string }[] };
    const urls = Array.isArray(body.urls) ? body.urls.slice(0, 8) : [];
    const results: Record<string, string> = {};

    await Promise.all(
      urls.map(async (item) => {
        if (!item?.id || !item?.url || !isFetchableUrl(item.url)) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        try {
          const res = await fetch(item.url, {
            signal: controller.signal,
            headers: { "User-Agent": "Knowrevo/1.0" },
          });
          if (!res.ok) return;
          const text = stripHtml((await res.text()).slice(0, 200_000)).slice(0, 4000);
          if (text) results[item.id] = text;
        } catch {
          // Non-fatal: skip unreachable knowledge URLs
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    return NextResponse.json({ results });
  } catch (err) {
    return handleApiError(err);
  }
}
