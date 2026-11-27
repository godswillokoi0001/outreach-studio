import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { verifyRequest } from "../server-auth";

export interface OwnerAiContext {
  ownerId: string;
  feature?: string;
}

const storage = new AsyncLocalStorage<OwnerAiContext>();

export async function runWithOwnerAiContext<T>(
  ctx: OwnerAiContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getActiveOwnerAiContext(): OwnerAiContext | null {
  return storage.getStore() ?? null;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "::") return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  }
  return false;
}

export function isSafeProviderUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

export async function requireOwnerIdForAiRequest(req: NextRequest): Promise<string> {
  const user = await verifyRequest(req);
  return user.ownerId;
}
