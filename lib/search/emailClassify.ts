export type EmailInboxType = "direct" | "role_inbox" | "invalid";

const ROLE_LOCAL_PARTS = new Set([
  "info",
  "hello",
  "sales",
  "office",
  "contact",
  "admin",
  "support",
  "team",
  "enquiries",
  "inquiries",
  "billing",
  "jobs",
  "careers",
  "help",
  "marketing",
  "mail",
  "reception",
  "general",
]);

/** Pure client-safe classifier distinguishing personal/direct vs generic role inboxes. */
export function classifyEmailType(rawEmail: string): EmailInboxType {
  const clean = rawEmail.trim().toLowerCase();
  const at = clean.indexOf("@");
  if (at <= 0) return "invalid";
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (!/^[a-z0-9._%+-]+$/.test(local) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return "invalid";
  }
  const baseLocal = local.split("+")[0];
  return ROLE_LOCAL_PARTS.has(baseLocal) ? "role_inbox" : "direct";
}
