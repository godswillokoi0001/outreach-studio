/**
 * Operator-chat guardrails.
 *
 * Two production failures this prevents:
 * 1. A failed discovery call being retried with identical arguments round
 *    after round, turning a 15-second job into a seven-minute loop.
 * 2. Internal JSON (`{"model":...,"receipt":...}`) being shown to the user as
 *    if it were a chat reply.
 *
 * Kept pure so they are unit-tested without a browser.
 */

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

export function toolCallSignature(name: string, args: unknown): string {
  return `${name}${stableValue(args ?? {})}`;
}

const MODEL_TEST_TOOL = "test_gemini_connection";

export function shouldSkipToolCall(input: {
  name: string;
  args: unknown;
  failedSignatures: Set<string>;
  userText: string;
}): { skip: boolean; reason?: string } {
  const signature = toolCallSignature(input.name, input.args);
  if (input.failedSignatures.has(signature)) {
    return {
      skip: true,
      reason:
        "This exact call already failed with identical arguments. Do not retry it; report the blocker or choose a different approach.",
    };
  }
  if (input.name === MODEL_TEST_TOOL && !/\b(?:gemini|google|model|provider|api key|connection|test)\b/i.test(input.userText)) {
    return {
      skip: true,
      reason: "A model connection test is never run automatically mid-conversation; the user did not ask for one.",
    };
  }
  return { skip: false };
}

/**
 * True when a reply is really an internal payload (model + receipt JSON) that
 * leaked into the chat bubble.
 */
export function looksLikeInternalJson(text: string): boolean {
  const clean = (text ?? "").trim();
  if (!clean.startsWith("{") && !clean.startsWith("[")) return false;
  return /"(?:receipt|modelUsed|actualModel|fallbackHops|functionCalls|raw)"\s*:/.test(clean);
}

const INTERNAL_JSON_FALLBACK =
  "I finished the step but the model returned an internal payload instead of a readable answer. Everything it changed is saved — ask me to summarise the result and I'll report it plainly.";

/** Clean a final operator reply before it is shown to the user. */
export function sanitizeOperatorReply(text: string): string {
  const clean = (text ?? "").trim();
  if (!clean) return "";
  if (looksLikeInternalJson(clean)) return INTERNAL_JSON_FALLBACK;

  // Remove an embedded internal JSON blob appended to otherwise readable prose.
  const stripped = clean
    .replace(/\n*\{[\s\S]*?"(?:receipt|modelUsed|actualModel|fallbackHops)"[\s\S]*?\}\s*$/g, "")
    .trim();
  return stripped || INTERNAL_JSON_FALLBACK;
}
