"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { BrandLockup } from "@/components/BrandMark";
import { PasswordStrengthInput } from "@/components/PasswordStrengthInput";
import { Banner, Card } from "@/components/ui";
import { getAccessToken, supabaseBrowser } from "@/lib/auth";
import { evaluatePasswordStrength } from "@/lib/password-policy";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const assessment = evaluatePasswordStrength(password);
    if (!assessment.valid) {
      setError(assessment.error || "Please satisfy all password rules.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { error: updateErr } = await supabaseBrowser.auth.updateUser({ password });
      if (updateErr) throw new Error(updateErr.message);

      const token = await getAccessToken();
      if (token) {
        const res = await fetch("/api/account/password", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "recovery",
            newPassword: password,
            confirmPassword: confirm,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Could not sync new password.");
        }
      }

      setDone(true);
      window.setTimeout(() => router.replace("/"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-top">
        <BrandLockup />
      </div>
      <div style={{ maxWidth: 480, width: "100%", margin: "24px auto" }}>
        <Card title="Reset your password" sub="Choose a new password for email sign-in.">
          {done ? (
            <Banner tone="ok">
              <div className="row" style={{ gap: 8 }}>
                <CheckCircle2 size={16} />
                <span>Password updated. Taking you back into Knowrevo…</span>
              </div>
            </Banner>
          ) : (
            <form onSubmit={(e) => void handleSubmit(e)} className="stack" style={{ gap: 14 }}>
              {error && <Banner tone="bad">{error}</Banner>}
              <PasswordStrengthInput
                password={password}
                confirmPassword={confirm}
                onPasswordChange={setPassword}
                onConfirmPasswordChange={setConfirm}
                autoFocus
              />
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
                {busy ? "Saving new password…" : "Update password"}
              </button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
