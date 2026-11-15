import { requireUser } from "@/lib/auth";
import { route, ok, readJson } from "@/lib/http";
import { getSettings, saveSettings } from "@/lib/settings";
import { audit } from "@/lib/db";
import type { Settings } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return ok(await getSettings(user.sub));
  });
}

export async function PUT(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<Partial<Settings>>(request);
    const next = await saveSettings(user.sub, body);
    await audit(user.sub, "settings_updated", "settings", user.sub, Object.keys(body));
    return ok(next);
  });
}
