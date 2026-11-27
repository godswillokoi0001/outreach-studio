import type { NextRequest } from "next/server";
import { supabaseServer } from "./supabase-server";

export class AuthError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 401, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AuthUser {
  /** Supabase Auth user id. */
  id: string;
  /** Id that owns every row for this person (strictly 1-to-1 per account). */
  ownerId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/** Short-lived cache so one page view does not re-resolve the owner on every request. */
const ownerCache = new Map<string, { ownerId: string; email: string; expires: number }>();
const OWNER_TTL_MS = 5 * 60 * 1000;

export function clearOwnerCache(supabaseUserId?: string): void {
  if (supabaseUserId) ownerCache.delete(supabaseUserId);
  else ownerCache.clear();
}

type AccountLinkRow = { email?: string; legacy_owner_id?: string; supabase_user_id?: string | null };

function bearerToken(req: NextRequest): string {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return "";
}

/**
 * Verifies the Supabase access token on the request and resolves the data owner
 * strictly from the authenticated server session (never from client payloads).
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

  // Enforce suspension immediately across every authenticated route.
  try {
    const metaRow = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", `system_user_meta_${ownerId}`)
      .eq("owner_id", ownerId)
      .maybeSingle();
    const content = (metaRow.data as { content?: string } | null)?.content;
    if (content) {
      const parsed = JSON.parse(content) as { status?: string };
      if (parsed.status === "suspended") {
        throw new AuthError("Your account has been suspended by an administrator. Contact support.", 403);
      }
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }

  return { id: data.user.id, ownerId, email, name, avatarUrl };
}

export async function resolveOwnerId(supabaseUserId: string, email: string): Promise<string> {
  if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);

  const normEmail = email.trim().toLowerCase();
  const cached = ownerCache.get(supabaseUserId);
  if (cached && cached.email === normEmail && cached.expires > Date.now()) {
    return cached.ownerId;
  }

  let ownerId: string | null = null;

  const byId = await supabaseServer
    .from("account_links")
    .select("email, legacy_owner_id")
    .eq("supabase_user_id", supabaseUserId)
    .maybeSingle();
  const idRow = byId.data as AccountLinkRow | null;
  if (idRow?.legacy_owner_id) {
    const claimedOwner = String(idRow.legacy_owner_id);
    // Double-check 1-to-1 isolation: if a legacy collision attached multiple accounts
    // to the same owner id, automatically split secondary accounts onto their own UUID.
    const { data: shared } = await supabaseServer
      .from("account_links")
      .select("email, supabase_user_id, created_at")
      .eq("legacy_owner_id", claimedOwner)
      .order("created_at", { ascending: true });
    const ownersList = (shared ?? []) as { email: string; supabase_user_id: string | null }[];
    if (ownersList.length > 1 && ownersList[0]?.supabase_user_id !== supabaseUserId) {
      ownerId = supabaseUserId;
      await supabaseServer
        .from("account_links")
        .update({ legacy_owner_id: supabaseUserId, updated_at: new Date().toISOString() } as never)
        .eq("supabase_user_id", supabaseUserId);
    } else {
      ownerId = claimedOwner;
    }
  }

  if (!ownerId) {
    const byEmail = await supabaseServer
      .from("account_links")
      .select("legacy_owner_id, supabase_user_id")
      .ilike("email", normEmail)
      .maybeSingle();
    const emailRow = byEmail.data as AccountLinkRow | null;

    if (emailRow && (!emailRow.supabase_user_id || emailRow.supabase_user_id === supabaseUserId)) {
      const candidateOwner = String(emailRow.legacy_owner_id ?? supabaseUserId);
      const { data: conflict } = await supabaseServer
        .from("account_links")
        .select("email")
        .eq("legacy_owner_id", candidateOwner)
        .neq("email", normEmail)
        .limit(1);

      ownerId = conflict && conflict.length > 0 ? supabaseUserId : candidateOwner;
      await supabaseServer
        .from("account_links")
        .update({
          supabase_user_id: supabaseUserId,
          legacy_owner_id: ownerId,
          updated_at: new Date().toISOString(),
        } as never)
        .ilike("email", normEmail);
    } else {
      // Brand-new account (or unclaimed collision): allocate isolated workspace keyed by supabaseUserId.
      const inserted = await supabaseServer
        .from("account_links")
        .insert({ email: normEmail, legacy_owner_id: supabaseUserId, supabase_user_id: supabaseUserId } as never)
        .select("legacy_owner_id")
        .maybeSingle();
      const insertedRow = inserted.data as AccountLinkRow | null;
      ownerId = insertedRow?.legacy_owner_id ? String(insertedRow.legacy_owner_id) : supabaseUserId;
    }
  }

  ownerCache.set(supabaseUserId, { ownerId, email: normEmail, expires: Date.now() + OWNER_TTL_MS });
  return ownerId;
}
