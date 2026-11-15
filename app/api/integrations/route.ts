import { requireUser, isPlatformOwner } from "@/lib/auth";
import { getAccount, googleConfigured, redirectUri } from "@/lib/google";
import { route, ok } from "@/lib/http";
import { runtimeConfig } from "@/lib/config";
import { audit } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const [google, account, config, owner] = await Promise.all([
      googleConfigured(),
      getAccount(user.sub),
      runtimeConfig(user.sub),
      isPlatformOwner(user.sub),
    ]);
    return ok({
      google: {
        configured: google.ok,
        missing: google.missing,
        connected: Boolean(account),
        email: account?.email ?? null,
        connected_at: account?.connected_at ?? null,
        redirect_uri: await redirectUri(request),
        credential_source: config.google?.source ?? null,
      },
      gemini: {
        configured: Boolean(config.geminiKey),
        model: config.geminiModel,
        source: config.geminiSource,
      },
      is_platform_owner: owner,
    });
  });
}

export async function DELETE(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const { disconnectGoogle } = await import("@/lib/google");
    await disconnectGoogle(user.sub);
    await audit(user.sub, "google_disconnected", "google_account", user.sub);
    return ok({ ok: true });
  });
}
