import { getEnv } from "./env";
import { first, run, now, ensureSchema } from "./db";
import { encryptSecret, decryptSecret, randomId } from "./crypto";

/**
 * Two levels of configuration:
 *  - per account (owner_sub = user.sub): their own Gemini key and model
 *  - platform (owner_sub = "__platform__"): the shared Google OAuth client, so
 *    every user can connect Google with a single click
 * Environment variables are the last fallback, so a deployment can be set up
 * once and work for everyone.
 */
export const PLATFORM = "__platform__";
export const DEFAULT_MODEL = "gemini-3.5-flash";

/** Models tried in order when the primary one is unavailable. */
export const MODEL_FALLBACKS = [
  DEFAULT_MODEL,
  "gemini-flash-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-2.5-flash",
];

const SECRET_KEYS = new Set(["gemini_api_key", "google_client"]);

async function encryptionKey(): Promise<string> {
  const env = await getEnv();
  if (env.TOKEN_ENCRYPTION_KEY) return env.TOKEN_ENCRYPTION_KEY;
  const { getMeta, setMeta } = await import("./db");
  const existing = await getMeta("config_encryption_key");
  if (existing) return existing;
  const generated = randomId("cfg") + randomId("cfg");
  await setMeta("config_encryption_key", generated);
  return generated;
}

export async function readValue(ownerSub: string, key: string): Promise<string | null> {
  await ensureSchema();
  const row = await first<{ v: string }>(
    `SELECT v FROM app_config WHERE owner_sub = ? AND k = ?`,
    ownerSub,
    key,
  );
  if (!row?.v) return null;
  if (row.v.startsWith("v1.")) return decryptSecret(row.v, await encryptionKey());
  return row.v;
}

export async function hasValue(ownerSub: string, key: string): Promise<boolean> {
  const row = await first<{ v: string }>(`SELECT v FROM app_config WHERE owner_sub = ? AND k = ?`, ownerSub, key);
  return Boolean(row?.v);
}

export async function writeValue(ownerSub: string, key: string, value: string | null): Promise<void> {
  await ensureSchema();
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    await run(`DELETE FROM app_config WHERE owner_sub = ? AND k = ?`, ownerSub, key);
    return;
  }
  const stored = SECRET_KEYS.has(key)
    ? (await encryptSecret(trimmed, await encryptionKey())) ?? trimmed
    : trimmed;
  await run(
    `INSERT INTO app_config (owner_sub, k, v, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(owner_sub, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    ownerSub,
    key,
    stored,
    now(),
  );
}

export async function tokenEncryptionKey(): Promise<string> {
  return encryptionKey();
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  source: "platform" | "env";
}

/** Parses a pasted OAuth client: full JSON from Google Cloud, or two lines. */
export function parseClientBlob(text: string): { clientId: string; clientSecret: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, { client_id?: string; client_secret?: string }>;
      const node = parsed.web ?? parsed.installed ?? (parsed as { client_id?: string });
      const clientId = node?.client_id;
      const clientSecret = node?.client_secret;
      if (clientId && clientSecret) return { clientId, clientSecret };
      return null;
    } catch {
      return null;
    }
  }
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length >= 2 && parts[0].includes(".apps.googleusercontent.com")) {
    return { clientId: parts[0], clientSecret: parts[1] };
  }
  return null;
}

export async function googleClient(): Promise<GoogleClient | null> {
  const env = await getEnv();
  const stored = await readValue(PLATFORM, "google_client");
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { clientId?: string; clientSecret?: string };
      if (parsed.clientId && parsed.clientSecret) {
        return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, source: "platform" };
      }
    } catch {
      // fall through to env
    }
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, source: "env" };
  }
  return null;
}

export async function saveGoogleClient(client: { clientId: string; clientSecret: string } | null): Promise<void> {
  await writeValue(PLATFORM, "google_client", client ? JSON.stringify(client) : null);
}

export async function platformRedirectOverride(): Promise<string | null> {
  const env = await getEnv();
  return (await readValue(PLATFORM, "google_redirect_uri")) ?? env.GOOGLE_REDIRECT_URI ?? null;
}

export interface RuntimeConfig {
  geminiKey: string | null;
  geminiModel: string;
  geminiSource: "account" | "platform" | "env" | null;
  google: GoogleClient | null;
}

export async function runtimeConfig(ownerSub: string): Promise<RuntimeConfig> {
  const env = await getEnv();
  const [userKey, userModel, platformKey, platformModel] = await Promise.all([
    readValue(ownerSub, "gemini_api_key"),
    readValue(ownerSub, "gemini_model"),
    readValue(PLATFORM, "gemini_api_key"),
    readValue(PLATFORM, "gemini_model"),
  ]);

  const geminiKey = userKey || platformKey || env.GEMINI_API_KEY || null;
  const geminiSource = userKey ? "account" : platformKey ? "platform" : env.GEMINI_API_KEY ? "env" : null;
  const geminiModel = userModel || platformModel || env.GEMINI_MODEL || DEFAULT_MODEL;

  return {
    geminiKey,
    geminiModel,
    geminiSource,
    google: await googleClient(),
  };
}

export async function configStatus(ownerSub: string, isPlatformOwner: boolean) {
  const config = await runtimeConfig(ownerSub);
  const [userKey, userModel] = await Promise.all([
    readValue(ownerSub, "gemini_api_key"),
    readValue(ownerSub, "gemini_model"),
  ]);
  const storedClient = await readValue(PLATFORM, "google_client");
  const mask = (value: string | null) => (value ? `${value.slice(0, 4)}…${value.slice(-4)}` : null);

  let clientHint: string | null = null;
  if (storedClient) {
    try {
      const parsed = JSON.parse(storedClient) as { clientId?: string };
      clientHint = parsed.clientId ? mask(parsed.clientId) : "stored";
    } catch {
      clientHint = "stored";
    }
  }

  return {
    gemini: {
      configured: Boolean(config.geminiKey),
      source: config.geminiSource,
      model: config.geminiModel,
      account_key_hint: mask(await readValue(ownerSub, "gemini_api_key")),
      account_model: userModel,
      account_override: Boolean(userKey),
    },
    google: {
      credentials_ready: Boolean(config.google),
      credential_source: config.google?.source ?? null,
      client_hint: clientHint,
      is_platform_owner: isPlatformOwner,
    },
    encryption: {
      dedicated_key: Boolean((await getEnv()).TOKEN_ENCRYPTION_KEY),
    },
  };
}
