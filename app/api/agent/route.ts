import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str } from "@/lib/http";
import { q } from "@/lib/db";
import { planCampaign } from "@/lib/intelligence";
import { getSettings } from "@/lib/settings";
import { knowledgeForCampaign } from "@/lib/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{ instruction?: string }>(request);
    const instruction = str(body.instruction);
    if (instruction.length < 8) throw new HttpError(400, "Describe what you want the campaign to do.");
    if (instruction.length > 2000) throw new HttpError(400, "Instruction is too long. Keep it under 2000 characters.");

    const sub = user.sub;
    const settings = await getSettings(sub);
    const [statusRows, industryRows, campaigns, knowledge] = await Promise.all([
      q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM leads WHERE owner_sub = ? GROUP BY status`, sub),
      q<{ industry: string }>(
        `SELECT DISTINCT industry FROM leads WHERE owner_sub = ? AND industry IS NOT NULL AND industry <> '' LIMIT 50`,
        sub,
      ),
      q<{ name: string; status: string }>(
        `SELECT name, status FROM campaigns WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 5`,
        sub,
      ),
      knowledgeForCampaign(sub),
    ]);

    const plan = await planCampaign(
      sub,
      instruction,
      {
        settings,
        knowledge,
        availableLeads: {
          total: statusRows.reduce((sum, r) => sum + r.c, 0),
          byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.c])),
          industries: industryRows.map((r) => r.industry),
        },
        recentCampaigns: campaigns,
      },
      settings.model,
    );

    return ok({ plan });
  });
}
