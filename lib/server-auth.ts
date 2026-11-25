import type { NextRequest } from "next/server";
import { supabaseServer } from "./supabase-server";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export interface AuthUser {
  /** Supabase Auth user id. */
  id: string;
  /** Id that owns every row for this person (from account_links, else the user id). */
  ownerId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** Short-lived cache so one page view does not re-resolve the owner on every request. */
const ownerCache = new Map<string, { ownerId: string; expires: number }>();
const OWNER_TTL_MS = 5 * 60 * 1000;

type AccountLinkRow = { legacy_owner_id?: string; supabase_user_id?: string | null };

function bearerToken(req: NextRequest): string {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return "";
}

/**
 * Verifies the Supabase access token on the request and resolves the data owner.
 *
 * Rows imported from the previous database keep their original owner id, so this maps the
 * Supabase account to that legacy id through `account_links` (by email on first
 * sign-in) and otherwise starts a fresh workspace keyed by the Supabase user id.
 */
export async function verifyRequest(req: NextRequest): Promise<AuthUser> {
  if (!supabaseServer) {
    throw new AuthError("Supabase is not configured on this deployment.", 503);
  }

  const token = bearerToken(req);
  if (!token) {
    throw new AuthError("Authentication required. Sign in with Google to continue.", 401);
  }

  const { data, error } = await supabaseServer.auth.getUser(token);
  if (error || !data.user) {
    throw new AuthError("Invalid or expired session. Sign in again.", 401);
  }

  const email = (data.user.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new AuthError("A Google account with a verified email address is required.", 401);
  }

  const metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof metadata.full_name === "string" && metadata.full_name) ||
    (typeof metadata.name === "string" && metadata.name) ||
    email;
  const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;

  const ownerId = await resolveOwnerId(data.user.id, email);

  return { id: data.user.id, ownerId, email, name, avatarUrl };
}

export async function resolveOwnerId(supabaseUserId: string, email: string): Promise<string> {
  if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);

  const cached = ownerCache.get(supabaseUserId);
  if (cached && cached.expires > Date.now()) return cached.ownerId;

  let ownerId: string | null = null;

  const byId = await supabaseServer
    .from("account_links")
    .select("legacy_owner_id")
    .eq("supabase_user_id", supabaseUserId)
    .maybeSingle();
  const idRow = byId.data as AccountLinkRow | null;
  if (idRow?.legacy_owner_id) ownerId = String(idRow.legacy_owner_id);

  if (!ownerId) {
    const byEmail = await supabaseServer
      .from("account_links")
      .select("legacy_owner_id, supabase_user_id")
      .ilike("email", email)
      .maybeSingle();
    const emailRow = byEmail.data as AccountLinkRow | null;

    if (emailRow) {
      ownerId = String(emailRow.legacy_owner_id);
      if (!emailRow.supabase_user_id) {
        await supabaseServer
          .from("account_links")
          .update({ supabase_user_id: supabaseUserId, updated_at: new Date().toISOString() } as never)
          .ilike("email", email);
      }
    } else {
      // Brand-new account: it owns a fresh workspace keyed by its Supabase id.
      const inserted = await supabaseServer
        .from("account_links")
        .insert({ email, legacy_owner_id: supabaseUserId, supabase_user_id: supabaseUserId } as never)
        .select("legacy_owner_id")
        .maybeSingle();
      const insertedRow = inserted.data as AccountLinkRow | null;
      ownerId = insertedRow?.legacy_owner_id ? String(insertedRow.legacy_owner_id) : supabaseUserId;
    }
  }

  ownerCache.set(supabaseUserId, { ownerId, expires: Date.now() + OWNER_TTL_MS });
  return ownerId;
}
