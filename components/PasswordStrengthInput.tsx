"use client";

import { useState } from "react";
import { Check, Eye, EyeOff, Lock } from "lucide-react";
import { evaluatePasswordStrength } from "@/lib/password-policy";
import { Field } from "./ui";

export function PasswordStrengthInput({
  emailReadOnly,
  password,
  confirmPassword,
  onPasswordChange,
  onConfirmPasswordChange,
  passwordLabel = "Password",
  confirmLabel = "Confirm password",
  autoFocus = false,
}: {
  emailReadOnly?: string;
  password: string;
  confirmPassword: string;
  onPasswordChange: (val: string) => void;
  onConfirmPasswordChange: (val: string) => void;
  passwordLabel?: string;
  confirmLabel?: string;
  autoFocus?: boolean;
}) {
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const assessment = evaluatePasswordStrength(password);
  const matches = Boolean(password) && password === confirmPassword;

  const barColors = ["#d1d5db", "#dc2626", "#d97706", "#0d9488", "#15803d"];
  const activeColor = barColors[assessment.score] ?? "#d1d5db";

  return (
    <div className="stack" style={{ gap: 12 }}>
      {emailReadOnly !== undefined && (
        <Field label="Google account email" hint="Your password works alongside Google Sign-In for this email.">
          <input
            className="input"
            type="email"
            value={emailReadOnly}
            readOnly
            disabled
            aria-label="Account email"
            style={{ opacity: 0.85, cursor: "not-allowed" }}
          />
        </Field>
      )}

      <Field label={passwordLabel}>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            autoFocus={autoFocus}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Create a strong password"
            style={{ paddingRight: 42 }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? "Hide password" : "Show password"}
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              minWidth: 32,
              minHeight: 32,
              padding: "4px 6px",
            }}
          >
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>

        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 4 }}>
            {[1, 2, 3, 4].map((idx) => (
              <div
                key={idx}
                style={{
                  flex: 1,
                  height: 5,
                  borderRadius: 999,
                  background: assessment.score >= idx ? activeColor : "var(--line)",
                  transition: "background 0.2s ease",
                }}
              />
            ))}
            <span className="tiny strong" style={{ color: assessment.score > 0 ? activeColor : "var(--muted)", minWidth: 74, textAlign: "right" }}>
              {password ? assessment.label : "Enter password"}
            </span>
          </div>

          <div className="grid grid-2" style={{ gap: 6, marginTop: 6 }}>
            {assessment.rules.map((r) => (
              <div
                key={r.id}
                className="row tiny"
                style={{
                  gap: 6,
                  color: r.passed ? "var(--ok, #15803d)" : "var(--muted)",
                  fontWeight: r.passed ? 600 : 400,
                }}
              >
                {r.passed ? <Check size={12} /> : <Lock size={11} style={{ opacity: 0.6 }} />}
                <span>{r.label}</span>
              </div>
            ))}
          </div>
        </div>
      </Field>

      <Field label={confirmLabel}>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            type={showConfirm ? "text" : "password"}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            placeholder="Re-enter your password"
            style={{ paddingRight: 42 }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? "Hide confirmation password" : "Show confirmation password"}
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              minWidth: 32,
              minHeight: 32,
              padding: "4px 6px",
            }}
          >
            {showConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {confirmPassword && (
          <div className="tiny" style={{ marginTop: 4, color: matches ? "var(--ok, #15803d)" : "var(--bad, #dc2626)" }}>
            {matches ? "Passwords match" : "Passwords do not match yet"}
          </div>
        )}
      </Field>
    </div>
  );
}
