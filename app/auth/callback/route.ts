import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveOwnerId } from "@/lib/server-auth";
import { userHasPasswordServer } from "@/lib/server-password";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function friendlyAuthError(raw: string): string {
  if (/exchange external code|invalid_grant|code verifier|code challenge|already been used|already used/i.test(raw)) {
    return "That Google sign-in link had already been used or had expired. Click Continue with Google to start a new sign-in.";
  }
  if (/access_denied/i.test(raw)) {
    return "Google sign-in was cancelled before it finished. Click Continue with Google to try again.";
  }
  return raw;
}

/** Completes Supabase OAuth / recovery code exchange and routes new users straight to onboarding. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorDescription = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const next = url.searchParams.get("next") ?? "/";
  const type = url.searchParams.get("type") ?? "";

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });

  const backWithError = (reason: string) => {
    const back = new URL("/", url.origin);
    back.searchParams.set("auth", "error");
    back.searchParams.set("reason", friendlyAuthError(reason));
    return NextResponse.redirect(back);
  };

  if (errorDescription) {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return backWithError(errorDescription);
  } else if (!code) {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return backWithError("Google did not return an authorization code.");
  } else {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return backWithError(error.message);
    }
  }

  if (type === "recovery" || next === "/auth/reset-password") {
    return NextResponse.redirect(new URL("/auth/reset-password", url.origin));
  }

  // Determine right on the server whether user needs password setup or onboarding,
  // so brand-new sign-ups land directly on /onboarding and never flash the dashboard.
  let destination = next.startsWith("/") ? next : "/";
  try {
    const { data } = await supabase.auth.getUser();
    const email = (data.user?.email ?? "").trim().toLowerCase();
    if (data.user && email) {
      const ownerId = await resolveOwnerId(data.user.id, email);
      const hasPassword = await userHasPasswordServer(ownerId);
      let onboardingDone = false;
      if (supabaseServer) {
        const { data: onbRow } = await supabaseServer
          .from("knowledge")
          .select("content")
          .eq("id", `system_onboarding_${ownerId}`)
          .eq("owner_id", ownerId)
          .maybeSingle();
        const raw = (onbRow as { content?: string } | null)?.content;
        if (raw) {
          const parsed = JSON.parse(raw) as { status?: string };
          onboardingDone = parsed.status === "completed";
        }
      }
      if (!hasPassword || !onboardingDone) {
        destination = "/onboarding";
      }
    }
  } catch {
    /* fall through to Shell onboarding guard if check unavailable */
  }

  return NextResponse.redirect(new URL(destination, url.origin));
}
