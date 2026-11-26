import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * Turns Supabase/Google's raw message into something a person can act on.
 *
 * "Unable to exchange external code" means the authorization code reached the
 * token endpoint twice, or after it expired: the callback was reloaded, opened
 * from history, or opened in a second tab. It is not a broken account.
 */
function friendlyAuthError(raw: string): string {
  if (/exchange external code|invalid_grant|code verifier|code challenge|already been used|already used/i.test(raw)) {
    return "That Google sign-in link had already been used or had expired. Click Continue with Google to start a new sign-in.";
  }
  if (/access_denied/i.test(raw)) {
    return "Google sign-in was cancelled before it finished. Click Continue with Google to try again.";
  }
  return raw;
}

/** Completes the Supabase Google sign-in and returns to the app. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorDescription = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const next = url.searchParams.get("next") ?? "/";

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

  const home = () => NextResponse.redirect(new URL("/", url.origin));
  const backWithError = (reason: string) => {
    const back = new URL("/", url.origin);
    back.searchParams.set("auth", "error");
    back.searchParams.set("reason", friendlyAuthError(reason));
    return NextResponse.redirect(back);
  };

  // A failed callback is harmless when this browser already has a session:
  // the code was spent by the first attempt, so continue instead of scaring
  // the user with an error they cannot act on.
  const hasSession = async () => {
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  };

  if (errorDescription) {
    if (await hasSession()) return home();
    return backWithError(errorDescription);
  }

  if (!code) {
    if (await hasSession()) return home();
    return backWithError("Google did not return an authorization code.");
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    if (await hasSession()) return home();
    return backWithError(error.message);
  }

  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/", url.origin));
}
