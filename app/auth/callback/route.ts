import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Completes the Supabase Google sign-in and returns to the app. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorDescription = url.searchParams.get("error_description");
  const next = url.searchParams.get("next") ?? "/";

  if (errorDescription) {
    const back = new URL("/", url.origin);
    back.searchParams.set("auth", "error");
    back.searchParams.set("reason", errorDescription);
    return NextResponse.redirect(back);
  }

  if (!code) {
    const back = new URL("/", url.origin);
    back.searchParams.set("auth", "error");
    back.searchParams.set("reason", "Google did not return an authorization code.");
    return NextResponse.redirect(back);
  }

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const back = new URL("/", url.origin);
    back.searchParams.set("auth", "error");
    back.searchParams.set("reason", error.message);
    return NextResponse.redirect(back);
  }

  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/", url.origin));
}
