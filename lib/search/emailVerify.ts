import { resolveMx } from "node:dns/promises";

export type EmailInboxType = "direct" | "role_inbox" | "invalid";

export interface EmailVerificationResult {
  email: string;
  syntaxValid: boolean;
  domain: string;
  disposable: boolean;
  mxVerified: boolean;
  mxRecords: string[];
  emailType: EmailInboxType;
  deliverable: boolean;
  reason?: string;
}

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

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "tempmail.com",
  "throwawaymail.com",
  "10minutemail.com",
  "yopmail.com",
  "trashmail.com",
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "invalid",
]);

const MX_CACHE_TTL_MS = 30 * 60_000;
const mxCache = new Map<string, { ok: boolean; hosts: string[]; exp: number }>();

async function lookupDomainMx(domain: string, timeoutMs = 3_000): Promise<{ ok: boolean; hosts: string[] }> {
  const cached = mxCache.get(domain);
  if (cached && cached.exp > Date.now()) {
    return { ok: cached.ok, hosts: cached.hosts };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS MX timeout")), timeoutMs);
      }),
    ]);
    const hosts = Array.isArray(records)
      ? records
          .slice()
          .sort((a, b) => a.priority - b.priority)
          .map((r) => r.exchange)
          .filter(Boolean)
      : [];
    const ok = hosts.length > 0;
    mxCache.set(domain, { ok, hosts, exp: Date.now() + MX_CACHE_TTL_MS });
    return { ok, hosts };
  } catch {
    mxCache.set(domain, { ok: false, hosts: [], exp: Date.now() + 5 * 60_000 });
    return { ok: false, hosts: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

export async function verifyEmailDeliverability(
  rawEmail: string,
  options?: { skipDnsLookup?: boolean; timeoutMs?: number },
): Promise<EmailVerificationResult> {
  const email = rawEmail.trim().toLowerCase();
  const emailType = classifyEmailType(email);
  const at = email.indexOf("@");
  const domain = at > 0 ? email.slice(at + 1) : "";

  if (emailType === "invalid" || !domain) {
    return {
      email,
      syntaxValid: false,
      domain,
      disposable: false,
      mxVerified: false,
      mxRecords: [],
      emailType: "invalid",
      deliverable: false,
      reason: "Invalid email syntax",
    };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      email,
      syntaxValid: true,
      domain,
      disposable: true,
      mxVerified: false,
      mxRecords: [],
      emailType,
      deliverable: false,
      reason: "Placeholder or disposable domain rejected",
    };
  }

  if (options?.skipDnsLookup) {
    return {
      email,
      syntaxValid: true,
      domain,
      disposable: false,
      mxVerified: true,
      mxRecords: [],
      emailType,
      deliverable: true,
    };
  }

  const mx = await lookupDomainMx(domain, options?.timeoutMs ?? 3_000);
  return {
    email,
    syntaxValid: true,
    domain,
    disposable: false,
    mxVerified: mx.ok,
    mxRecords: mx.hosts,
    emailType,
    deliverable: mx.ok,
    reason: mx.ok ? undefined : `Domain ${domain} has no live MX mail servers`,
  };
}

export function clearEmailMxCacheForTests(): void {
  mxCache.clear();
}
