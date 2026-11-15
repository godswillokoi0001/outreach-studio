import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppEnv } from "./d1";

let cached: AppEnv | null = null;

/**
 * Reads runtime configuration. On Cloudflare this comes from the Workers env
 * (vars + secrets); locally it falls back to process.env, which Next.js loads
 * from .env.
 */
export async function getEnv(): Promise<AppEnv> {
  if (cached && cached.DB) return cached;
  try {
    const ctx = await getCloudflareContext({ async: true });
    if (ctx?.env) {
      const merged = { ...(process.env as AppEnv), ...(ctx.env as AppEnv) };
      cached = merged;
      return merged;
    }
  } catch {
    // Not running inside a Workers context (plain node scripts, tests).
  }
  cached = process.env as AppEnv;
  return cached;
}

export function requireEnv(env: AppEnv, key: keyof AppEnv, hint: string): string {
  const value = env[key];
  if (!value) throw new ConfigError(`${key} is not configured. ${hint}`);
  return String(value);
}

export class ConfigError extends Error {}
