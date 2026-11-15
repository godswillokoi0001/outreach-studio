import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str, num } from "@/lib/http";
import { discoverProspects } from "@/lib/intelligence";
import { createLead } from "@/lib/leads";
import { audit } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{
      action?: string;
      industry?: string;
      location?: string;
      count?: number;
      focus?: string;
      candidates?: { business?: string; website?: string; location?: string; industry?: string; notes?: string }[];
    }>(request);
    const action = str(body.action, "discover");

    if (action === "save") {
      const list = Array.isArray(body.candidates) ? body.candidates : [];
      if (!list.length) throw new HttpError(400, "No candidates to save.");
      let created = 0;
      let duplicates = 0;
      for (const candidate of list.slice(0, 40)) {
        const result = await createLead(user.sub, {
          business: str(candidate.business),
          website: str(candidate.website),
          location: str(candidate.location),
          industry: str(candidate.industry),
          notes: str(candidate.notes),
          source: "discovery",
        });
        if (result.duplicate) duplicates += 1;
        else created += 1;
      }
      await audit(user.sub, "discovery_saved", "lead", undefined, { created, duplicates });
      return ok({ created, duplicates });
    }

    const count = Math.max(3, Math.min(num(body.count, 8), 20));
    const result = await discoverProspects(user.sub, {
      industry: str(body.industry),
      location: str(body.location),
      count,
      focus: str(body.focus),
    });
    return ok(result);
  });
}
