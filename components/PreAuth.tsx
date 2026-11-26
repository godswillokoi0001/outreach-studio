"use client";

import { useState } from "react";
import { Landing } from "./Landing";
import { LoginGate } from "./LoginGate";

export function PreAuth({
  onGoogleAuth,
  busy,
  error,
}: {
  onGoogleAuth: () => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  // A sign-in that came back broken should explain itself instead of dropping
  // the user on the marketing page with no idea what happened.
  const [view, setView] = useState<"landing" | "auth">(error ? "auth" : "landing");
  const [mode, setMode] = useState<"signup" | "signin">("signup");

  if (view === "landing") {
    return (
      <Landing
        onSignIn={() => {
          setMode("signin");
          setView("auth");
        }}
        onSignUp={() => {
          setMode("signup");
          setView("auth");
        }}
      />
    );
  }

  return (
    <LoginGate
      onGoogleAuth={onGoogleAuth}
      busy={busy}
      error={error}
      initialMode={mode}
      onBack={() => setView("landing")}
    />
  );
}
