import bcrypt from "bcryptjs";
import { evaluatePasswordStrength } from "./password-policy";
import { supabaseServer } from "./supabase-server";

const BCRYPT_COST = 12;

export interface UserPasswordRecord {
  ownerId: string;
  passwordHash: string;
  setAt: string;
  updatedAt: string;
}

export async function hashUserPassword(password: string): Promise<string> {
  const assessment = evaluatePasswordStrength(password);
  if (!assessment.valid) {
    throw new Error(assessment.error || "Password does not meet security rules.");
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyUserPasswordHash(password: string, hash: string): Promise<boolean> {
  if (!password || !hash || !hash.startsWith("$2")) return false;
  return bcrypt.compare(password, hash);
}

function docId(ownerId: string): string {
  return `system_user_password_${ownerId}`;
}

/**
 * Returns ONLY whether the user already created an account password.
 * Never returns the password hash to any caller outside verification.
 */
export async function userHasPasswordServer(ownerId: string): Promise<boolean> {
  if (!supabaseServer || !ownerId) return false;
  const rec = await readUserPasswordRecordServer(ownerId);
  return Boolean(rec?.passwordHash);
}

export async function readUserPasswordRecordServer(ownerId: string): Promise<UserPasswordRecord | null> {
  if (!supabaseServer || !ownerId) return null;
  try {
    const { data, error } = await supabaseServer
      .from("user_auth_profiles")
      .select("owner_id, password_hash, password_set_at, updated_at")
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (!error && data) {
      const r = data as {
        owner_id?: string;
        password_hash?: string | null;
        password_set_at?: string | null;
        updated_at?: string | null;
      };
      if (r.password_hash) {
        return {
          ownerId: String(r.owner_id ?? ownerId),
          passwordHash: String(r.password_hash),
          setAt: String(r.password_set_at ?? r.updated_at ?? new Date().toISOString()),
          updatedAt: String(r.updated_at ?? new Date().toISOString()),
        };
      }
    }
  } catch {
    /* fallback cleanly */
  }

  try {
    const { data } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", docId(ownerId))
      .eq("owner_id", ownerId)
      .maybeSingle();
    const raw = (data as { content?: string } | null)?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserPasswordRecord;
    return parsed?.passwordHash ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveUserPasswordServer(input: {
  ownerId: string;
  supabaseUserId: string;
  email: string;
  newPassword: string;
}): Promise<void> {
  const hash = await hashUserPassword(input.newPassword);
  const nowIso = new Date().toISOString();

  if (!supabaseServer) {
    throw new Error("Database not configured.");
  }

  // Sync bcrypt credential into Supabase Auth so email+password login and reset flows work seamlessly
  if (input.supabaseUserId && /^[0-9a-f-]{36}$/i.test(input.supabaseUserId)) {
    const { error: authErr } = await supabaseServer.auth.admin.updateUserById(input.supabaseUserId, {
      password: input.newPassword,
    });
    if (authErr) {
      throw new Error(`Could not activate email sign-in password: ${authErr.message}`);
    }
  }

  // Persist bcrypt hash strictly in server-only store (RLS revoked from anon/authenticated)
  const { error: tableErr } = await supabaseServer.from("user_auth_profiles").upsert(
    {
      owner_id: input.ownerId,
      email: input.email.trim().toLowerCase(),
      password_hash: hash,
      password_set_at: nowIso,
      updated_at: nowIso,
    } as never,
    { onConflict: "owner_id" },
  );

  if (tableErr) {
    const record: UserPasswordRecord = {
      ownerId: input.ownerId,
      passwordHash: hash,
      setAt: nowIso,
      updatedAt: nowIso,
    };
    const { error: kbErr } = await supabaseServer.from("knowledge").upsert(
      {
        id: docId(input.ownerId),
        owner_id: input.ownerId,
        category: "system_user_password",
        title: "Account Password Hash",
        content: JSON.stringify(record),
        sort: 999,
        is_master: false,
        updated_at: nowIso,
      } as never,
      { onConflict: "id" },
    );
    if (kbErr) {
      throw new Error("Could not store password hash securely.");
    }
  }
}
