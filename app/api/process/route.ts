import { requireUser } from "@/lib/auth";
import { route, ok, readJson, str, num, HttpError } from "@/lib/http";
import { runResearch, runQualify, runCompose, runSend, runSync, runFollowups } from "@/lib/pipeline";
import { audit } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{ type?: string; campaignId?: string; limit?: number }>(request);
    const type = str(body.type);
    const campaignId = str(body.campaignId);
    const limit = Math.max(1, Math.min(num(body.limit, 3), 8));
    const sub = user.sub;

    const needsCampaign = ["research", "qualify", "compose"];
    if (needsCampaign.includes(type) && !campaignId) throw new HttpError(400, "Select a campaign first.");

    let result;
    switch (type) {
      case "research":
        result = await runResearch(sub, campaignId, limit);
        break;
      case "qualify":
        result = await runQualify(sub, campaignId, limit);
        break;
      case "compose":
        result = await runCompose(sub, campaignId, limit);
        break;
      case "send":
        result = await runSend(sub, campaignId || null, limit);
        break;
      case "sync":
        result = await runSync(sub, limit);
        break;
      case "followup":
        result = await runFollowups(sub, campaignId || null, limit);
        break;
      default:
        throw new HttpError(400, "Unknown processing type.");
    }

    if (result.processed > 0) {
      await audit(sub, `process_${type}`, "campaign", campaignId || "all", { processed: result.processed });
    }
    return ok({ type, ...result });
  });
}
