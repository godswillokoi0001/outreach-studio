export interface PasswordRuleResult {
  id: "length" | "upper" | "lower" | "number_or_symbol";
  label: string;
  passed: boolean;
}

export interface PasswordStrengthAssessment {
  valid: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too weak" | "Weak" | "Fair" | "Strong" | "Very strong";
  rules: PasswordRuleResult[];
  error?: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Pure client+server password validator and live strength estimator.
 * Never logs or mutates input passwords.
 */
export function evaluatePasswordStrength(password: string): PasswordStrengthAssessment {
  const pw = typeof password === "string" ? password : "";
  const rules: PasswordRuleResult[] = [
    {
      id: "length",
      label: `At least ${MIN_PASSWORD_LENGTH} characters`,
      passed: pw.length >= MIN_PASSWORD_LENGTH,
    },
    {
      id: "upper",
      label: "One uppercase letter (A-Z)",
      passed: /[A-Z]/.test(pw),
    },
    {
      id: "lower",
      label: "One lowercase letter (a-z)",
      passed: /[a-z]/.test(pw),
    },
    {
      id: "number_or_symbol",
      label: "One number (0-9) or symbol (!@#$...)",
      passed: /[0-9]|[^A-Za-z0-9\s]/.test(pw),
    },
  ];

  const passedCount = rules.filter((r) => r.passed).length;
  const bonusLength = pw.length >= 12 ? 1 : 0;
  const rawScore = pw.length === 0 ? 0 : Math.min(4, passedCount + bonusLength - (passedCount === 4 ? 0 : 1));
  const score = Math.max(0, Math.min(4, rawScore)) as 0 | 1 | 2 | 3 | 4;
  const valid = rules.every((r) => r.passed);

  const labelMap: Record<PasswordStrengthAssessment["score"], PasswordStrengthAssessment["label"]> = {
    0: "Too weak",
    1: "Weak",
    2: "Fair",
    3: "Strong",
    4: "Very strong",
  };

  const firstMissing = rules.find((r) => !r.passed)?.label;
  return {
    valid,
    score,
    label: labelMap[score],
    rules,
    error: valid ? undefined : `Password requirement missing: ${firstMissing}.`,
  };
}
