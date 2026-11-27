import { supabaseServer } from "./supabase-server";

export interface UserAvatarState {
  avatarSource: "google" | "custom";
  googleAvatarUrl: string | null;
  customAvatarData: string | null;
  effectivePhotoUrl: string | null;
}

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i;
const MAX_CUSTOM_AVATAR_LEN = 750_000;

export function isValidAvatarUploadDataUrl(dataUrl: string): boolean {
  const clean = (dataUrl ?? "").trim();
  return Boolean(clean && DATA_IMAGE_RE.test(clean) && clean.length <= MAX_CUSTOM_AVATAR_LEN);
}

function docId(ownerId: string): string {
  return `system_user_avatar_${ownerId}`;
}

export async function getUserAvatarStateServer(
  ownerId: string,
  freshGoogleAvatarUrl?: string | null,
): Promise<UserAvatarState> {
  let state: UserAvatarState = {
    avatarSource: "google",
    googleAvatarUrl: freshGoogleAvatarUrl?.trim() || null,
    customAvatarData: null,
    effectivePhotoUrl: freshGoogleAvatarUrl?.trim() || null,
  };

  if (!supabaseServer || !ownerId) return state;

  let foundInTable = false;
  try {
    const { data, error } = await supabaseServer
      .from("user_auth_profiles")
      .select("avatar_source, google_avatar_url, custom_avatar_data")
      .eq("owner_id", ownerId)
      .maybeSingle();

    if (!error && data) {
      foundInTable = true;
      const r = data as {
        avatar_source?: string;
        google_avatar_url?: string | null;
        custom_avatar_data?: string | null;
      };
      state = {
        avatarSource: r.avatar_source === "custom" ? "custom" : "google",
        googleAvatarUrl: freshGoogleAvatarUrl?.trim() || r.google_avatar_url || null,
        customAvatarData: r.custom_avatar_data || null,
        effectivePhotoUrl: null,
      };
    }
  } catch {
    /* fallback cleanly */
  }

  if (!foundInTable) {
    try {
      const { data } = await supabaseServer
        .from("knowledge")
        .select("content")
        .eq("id", docId(ownerId))
        .eq("owner_id", ownerId)
        .maybeSingle();
      const raw = (data as { content?: string } | null)?.content;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<UserAvatarState>;
        state = {
          avatarSource: parsed.avatarSource === "custom" ? "custom" : "google",
          googleAvatarUrl: freshGoogleAvatarUrl?.trim() || parsed.googleAvatarUrl || null,
          customAvatarData: parsed.customAvatarData || null,
          effectivePhotoUrl: null,
        };
      }
    } catch {
      /* ignore */
    }
  }

  // Always save / refresh latest Google profile URL when available on sign-in
  if (freshGoogleAvatarUrl?.trim()) {
    void syncGoogleAvatarUrlServer(ownerId, freshGoogleAvatarUrl.trim()).catch(() => {});
  }

  const chosen =
    state.avatarSource === "custom" && state.customAvatarData
      ? state.customAvatarData
      : state.googleAvatarUrl || state.customAvatarData || null;

  return {
    ...state,
    // Proxy remote URLs via same-origin endpoint to avoid third-party referrer/CORS blocks
    effectivePhotoUrl: chosen
      ? chosen.startsWith("data:image/")
        ? chosen
        : `/api/account/avatar?ownerId=${encodeURIComponent(ownerId)}&v=${encodeURIComponent(chosen.slice(-16))}`
      : null,
  };
}

async function syncGoogleAvatarUrlServer(ownerId: string, googleUrl: string): Promise<void> {
  if (!supabaseServer || !ownerId || !googleUrl) return;
  const nowIso = new Date().toISOString();
  const { error } = await supabaseServer.from("user_auth_profiles").upsert(
    {
      owner_id: ownerId,
      google_avatar_url: googleUrl,
      updated_at: nowIso,
    } as never,
    { onConflict: "owner_id" },
  );
  if (error) {
    const existing = await getUserAvatarStateServer(ownerId, null).catch(() => null);
    await supabaseServer.from("knowledge").upsert(
      {
        id: docId(ownerId),
        owner_id: ownerId,
        category: "system_user_avatar",
        title: "User Avatar Profile",
        content: JSON.stringify({
          avatarSource: existing?.avatarSource ?? "google",
          googleAvatarUrl: googleUrl,
          customAvatarData: existing?.customAvatarData ?? null,
        }),
        sort: 999,
        is_master: false,
        updated_at: nowIso,
      } as never,
      { onConflict: "id" },
    );
  }
}

export async function updateCustomAvatarServer(input: {
  ownerId: string;
  email: string;
  action: "upload" | "reset_google";
  dataUrl?: string;
}): Promise<UserAvatarState> {
  if (!supabaseServer) throw new Error("Database not configured.");
  const nowIso = new Date().toISOString();

  if (input.action === "upload") {
    const clean = (input.dataUrl ?? "").trim();
    if (!DATA_IMAGE_RE.test(clean) || clean.length > MAX_CUSTOM_AVATAR_LEN) {
      throw new Error("Please upload a valid PNG, JPG, or WebP image under 500 KB.");
    }

    const { error } = await supabaseServer.from("user_auth_profiles").upsert(
      {
        owner_id: input.ownerId,
        email: input.email.trim().toLowerCase(),
        avatar_source: "custom",
        custom_avatar_data: clean,
        updated_at: nowIso,
      } as never,
      { onConflict: "owner_id" },
    );
    if (error) {
      const existing = await getUserAvatarStateServer(input.ownerId, null);
      await supabaseServer.from("knowledge").upsert(
        {
          id: docId(input.ownerId),
          owner_id: input.ownerId,
          category: "system_user_avatar",
          title: "User Avatar Profile",
          content: JSON.stringify({
            avatarSource: "custom",
            googleAvatarUrl: existing.googleAvatarUrl,
            customAvatarData: clean,
          }),
          sort: 999,
          is_master: false,
          updated_at: nowIso,
        } as never,
        { onConflict: "id" },
      );
    }
    return getUserAvatarStateServer(input.ownerId, null);
  }

  // reset_google
  const { error } = await supabaseServer.from("user_auth_profiles").upsert(
    {
      owner_id: input.ownerId,
      email: input.email.trim().toLowerCase(),
      avatar_source: "google",
      updated_at: nowIso,
    } as never,
    { onConflict: "owner_id" },
  );
  if (error) {
    const existing = await getUserAvatarStateServer(input.ownerId, null);
    await supabaseServer.from("knowledge").upsert(
      {
        id: docId(input.ownerId),
        owner_id: input.ownerId,
        category: "system_user_avatar",
        title: "User Avatar Profile",
        content: JSON.stringify({
          avatarSource: "google",
          googleAvatarUrl: existing.googleAvatarUrl,
          customAvatarData: existing.customAvatarData,
        }),
        sort: 999,
        is_master: false,
        updated_at: nowIso,
      } as never,
      { onConflict: "id" },
    );
  }
  return getUserAvatarStateServer(input.ownerId, null);
}
