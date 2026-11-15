import { requireUser, isPlatformOwner } from "@/lib/auth";
import { route, ok, readJson, HttpError, str } from "@/lib/http";
import { audit } from "@/lib/db";
import {
  configStatus,
  writeValue,
  readValue,
  runtimeConfig,
  parseClientBlob,
  saveGoogleClient,
  PLATFORM,
} from "@/lib/config";
import { geminiText } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return ok(await configStatus(user.sub, await isPlatformOwner(user.sub)));
  });
}

export async function PUT(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<Record<string, unknown>>(request);
    const saved: string[] = [];

    if ("gemini_api_key" in body) {
      await writeValue(user.sub, "gemini_api_key", str(body.gemini_api_key) || null);
      saved.push("gemini_api_key");
    }
    if ("gemini_model" in body) {
      const model = str(body.gemini_model);
      if (model && !/^[a-z0-9.\-]+$/i.test(model)) throw new HttpError(400, "That model name does not look right.");
      await writeValue(user.sub, "gemini_model", model || null);
      saved.push("gemini_model");
    }

    // Platform-level Google credentials: only the platform owner can change them.
    if ("google_client" in body) {
      if (!(await isPlatformOwner(user.sub))) {
        throw new HttpError(403, "Only the workspace owner can change the shared Google credentials.");
      }
      const raw = str(body.google_client);
      if (!raw) {
        await saveGoogleClient(null);
        saved.push("google_client:cleared");
      } else {
        const parsed = parseClientBlob(raw);
        if (!parsed) {
          throw new HttpError(
            400,
            "Could not read that OAuth client. Paste the full JSON downloaded from Google Cloud, or the client ID and secret on separate lines.",
          );
        }
        await saveGoogleClient(parsed);
        saved.push("google_client");
      }
    }

    if ("google_redirect_uri" in body) {
      if (!(await isPlatformOwner(user.sub))) {
        throw new HttpError(403, "Only the workspace owner can change the shared Google credentials.");
      }
      const uri = str(body.google_redirect_uri);
      if (uri && !/^https?:\/\/.+\/api\/auth\/google\/callback$/.test(uri)) {
        throw new HttpError(400, "The redirect URI must end with /api/auth/google/callback.");
      }
      await writeValue(PLATFORM, "google_redirect_uri", uri || null);
      saved.push("google_redirect_uri");
    }

    if (!saved.length) throw new HttpError(400, "Nothing to save.");
    await audit(user.sub, "config_updated", "config", user.sub, { keys: saved });
    return ok({ ok: true, saved, status: await configStatus(user.sub, await isPlatformOwner(user.sub)) });
  });
}

const ALLOWED_KEYS = ["gemini_api_key", "gemini_model", "google_client", "google_redirect_uri"];

export async function DELETE(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const key = str(new URL(request.url).searchParams.get("key"));
    if (!ALLOWED_KEYS.includes(key)) throw new HttpError(400, "Unknown setting.");
    if (key.startsWith("google_")) {
      if (!(await isPlatformOwner(user.sub))) {
        throw new HttpError(403, "Only the workspace owner can change the shared Google credentials.");
      }
      await writeValue(PLATFORM, key, null);
    } else {
      await writeValue(user.sub, key, null);
    }
    await audit(user.sub, "config_cleared", "config", key);
    return ok({ ok: true, status: await configStatus(user.sub, await isPlatformOwner(user.sub)) });
  });
}

/** One small live call so the operator can confirm the AI is actually working. */
export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const config = await runtimeConfig(user.sub);
    if (!config.geminiKey) throw new HttpError(400, "No Gemini API key is saved yet.");
    const started = Date.now();
    const reply = await geminiText({
      ownerSub: user.sub,
      system: "You are a connectivity check. Answer with exactly: OK",
      user: "Reply with the single word OK.",
      temperature: 0,
      maxTokens: 20,
    });
    const model = (await readValue(user.sub, "gemini_model")) ?? config.geminiModel;
    await audit(user.sub, "gemini_test", "config", "gemini", { model, ms: Date.now() - started });
    return ok({ ok: true, model, ms: Date.now() - started, reply: reply.slice(0, 80) });
  });
}
