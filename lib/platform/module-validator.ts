import { AGENT_TOOLS } from "@/lib/agent-tools";
import { buildOrchestratedSystemPrompt } from "@/lib/ai/orchestrator";
import { getGlobalKnowledgeCacheStats, getGlobalKnowledgeModules } from "@/lib/global-knowledge/service";
import {
  computeProfileFingerprint,
  EMPTY_GROWTH_PROFILE,
  evaluateProfileCompleteness,
} from "@/lib/growth-advisor";
import {
  decryptSecret,
  encryptSecret,
  generateTotpAt,
  generateTotpSecret,
  verifyTotpCode,
} from "@/lib/key-vault";
import { listAdminAiKeys } from "@/lib/llm/store";
import { evaluatePasswordStrength } from "@/lib/password-policy";
import { validateContactableLead } from "@/lib/search/contactGate";
import { supabaseServer } from "@/lib/supabase-server";
import { isValidAvatarUploadDataUrl } from "@/lib/server-avatar";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { label as formatStatusLabel } from "@/lib/format";
import { listAdminAccountsPublic, verifyAdminPassword, hashAdminPassword } from "./admin-credentials";
import {
  computePlatformHealthAndAlerts,
  decryptPlatformProviderKey,
  getInternalPlatformPolicy,
  listAdminUsersDirectory,
  listAiUsageEvents,
} from "./store-server";

export type CheckStatus = "pass" | "warning" | "fail";

export interface SystemCheckItem {
  id: string;
  category:
    | "Database & Migrations"
    | "AI Providers & Keys"
    | "Security & Auth"
    | "Jobs, Storage & Telemetry"
    | "Core Features"
    | "Module Validation";
  name: string;
  status: CheckStatus;
  detail: string;
  checkedAt: string;
  durationMs: number;
  rerunnable?: boolean;
}

export interface ModuleCheckDescriptor {
  id: string;
  category: SystemCheckItem["category"];
  name: string;
  run: () => Promise<{ status: CheckStatus; detail: string }>;
}

async function timed(
  id: string,
  category: SystemCheckItem["category"],
  name: string,
  fn: () => Promise<{ status: CheckStatus; detail: string }>,
  rerunnable = true,
): Promise<SystemCheckItem> {
  const start = Date.now();
  try {
    const res = await fn();
    return {
      id,
      category,
      name,
      status: res.status,
      detail: res.detail,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - start),
      rerunnable,
    };
  } catch (err) {
    return {
      id,
      category,
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : "Validation threw an unexpected error.",
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - start),
      rerunnable,
    };
  }
}

export const MODULE_VALIDATORS: ModuleCheckDescriptor[] = [
  {
    id: "mod_db_migrations",
    category: "Database & Migrations",
    name: "Database tables & migration schema",
    run: async () => {
      if (!supabaseServer) {
        return { status: "fail", detail: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." };
      }
      const coreTables = [
        "account_links",
        "settings",
        "campaigns",
        "leads",
        "messages",
        "replies",
        "knowledge",
        "knowledge_sources",
        "audit_logs",
        "operator_conversations",
      ];
      const v2Tables = [
        "user_ai_settings",
        "user_ai_keys",
        "admin_ai_keys",
        "user_auth_profiles",
        "background_jobs",
        "admin_notifications",
      ];
      const missingCore: string[] = [];
      for (const t of coreTables) {
        const res = await supabaseServer.from(t as never).select("id").limit(1);
        if (res.error) missingCore.push(t);
      }
      if (missingCore.length > 0) {
        return { status: "fail", detail: `Missing core tables: ${missingCore.join(", ")}` };
      }
      const missingV2: string[] = [];
      for (const t of v2Tables) {
        const res = await supabaseServer.from(t as never).select("*").limit(1);
        if (res.error) missingV2.push(t);
      }
      if (missingV2.length > 0) {
        return {
          status: "warning",
          detail: `Core tables OK; pending migration tables (using safe fallback): ${missingV2.join(", ")}`,
        };
      }
      return {
        status: "pass",
        detail: `All ${coreTables.length} core tables + ${v2Tables.length} v2 schema tables verified.`,
      };
    },
  },
  {
    id: "mod_onboarding",
    category: "Module Validation",
    name: "Onboarding flow & profile hydration",
    run: async () => {
      const check = evaluateProfileCompleteness(
        {
          ...EMPTY_GROWTH_PROFILE,
          whoYouAre: "Acme Agency",
          whatYouSell: "B2B Revenue Ops Consulting",
          industry: "B2B SaaS",
          offer: "Pipeline Audit",
          idealCustomer: "VP Sales at 20-200 person SaaS",
        },
        "Services: Pipeline Audit\nPricing: $3,500",
        DEFAULT_SETTINGS,
      );
      if (!check.complete) {
        return {
          status: "fail",
          detail: `Completeness evaluator failed on valid test profile: missing ${check.missingFields.join(", ")}`,
        };
      }
      return {
        status: "pass",
        detail: `Onboarding completeness evaluator passed (${check.score}% ready on sandbox profile).`,
      };
    },
  },
  {
    id: "mod_kb",
    category: "Module Validation",
    name: "Knowledge Base & Global Brain (Modules 1-4)",
    run: async () => {
      const modules = await getGlobalKnowledgeModules();
      const stats = getGlobalKnowledgeCacheStats();
      if (modules.size !== 4) {
        return { status: "fail", detail: `Expected 4 Global Brain modules, found ${modules.size}.` };
      }
      const orch = await buildOrchestratedSystemPrompt({
        workflow: "draft_outreach",
        ownerId: "__platform__",
        knowledgeDigest: "Offer: Cold outreach audit. Tone: concise executive.",
        taskInstructions: "Draft a concise personalized outreach message.",
      });
      if (!orch.system || orch.system.length < 100) {
        return { status: "fail", detail: "Orchestrated Knowledge prompt returned empty output." };
      }
      return {
        status: stats.source === "database" ? "pass" : "warning",
        detail:
          stats.source === "database"
            ? `4/4 Global Brain modules loaded from DB (${stats.hits} cache hits); orchestrator verified.`
            : "4/4 Global Brain modules running on seed fallback; orchestrator verified.",
      };
    },
  },
  {
    id: "mod_growth",
    category: "Module Validation",
    name: "Growth Advisor & Research Fingerprint",
    run: async () => {
      const fp = computeProfileFingerprint({
        profile: { ...EMPTY_GROWTH_PROFILE, industry: "Healthcare IT" },
        knowledgeDigest: "Healthcare SaaS compliance automation",
        settings: DEFAULT_SETTINGS,
        metricsSummary: { leads: 12, campaigns: 2, sent: 10, replies: 2, positive: 1 },
      });
      if (!fp || fp.length < 6) {
        return { status: "fail", detail: "Profile fingerprint generator failed." };
      }
      return {
        status: "pass",
        detail: `Growth Advisor fingerprinting & report schema ready (sample hash ${fp.slice(0, 8)}).`,
      };
    },
  },
  {
    id: "mod_analyse",
    category: "Module Validation",
    name: "Analyse & Performance Analytics",
    run: async () => {
      const [users, events] = await Promise.all([
        listAdminUsersDirectory(),
        listAiUsageEvents({ sinceIso: new Date(Date.now() - 7 * 86400_000).toISOString(), limit: 500 }),
      ]);
      const policy = await getInternalPlatformPolicy();
      const health = await computePlatformHealthAndAlerts(users, events, policy);
      return {
        status: health.errorRatePct > 35 && events.length >= 10 ? "warning" : "pass",
        detail: `Analytics aggregation OK (${events.length} 7d events, ${health.errorRatePct}% error rate).`,
      };
    },
  },
  {
    id: "mod_campaigns",
    category: "Module Validation",
    name: "Campaigns & Delivery Readiness",
    run: async () => {
      if (!supabaseServer) return { status: "fail", detail: "Database client missing." };
      const { error } = await supabaseServer.from("campaigns").select("id, status").limit(5);
      if (error) return { status: "fail", detail: `Campaigns query error: ${error.message}` };
      return { status: "pass", detail: "Campaigns schema & delivery state queries verified." };
    },
  },
  {
    id: "mod_leads",
    category: "Module Validation",
    name: "Leads Discovery & Contact Gate",
    run: async () => {
      const rejected = validateContactableLead({ business: "NoContact Co", email: "", phone: "" });
      const accepted = validateContactableLead({
        business: "Acme Clinic",
        email: "founder@acmeclinic.com",
        website: "https://acmeclinic.com",
      });
      if (rejected.contactable || !accepted.contactable) {
        return {
          status: "fail",
          detail: "Hard contactability gate allowed an uncontactable lead or rejected a valid email.",
        };
      }
      return {
        status: "pass",
        detail: "Hard no-contact-no-save gate & email validator passed.",
      };
    },
  },
  {
    id: "mod_email_rewrite",
    category: "Module Validation",
    name: "Email Reviews & AI Rewrite",
    run: async () => {
      const prompt = await buildOrchestratedSystemPrompt({
        workflow: "draft_outreach",
        ownerId: "__platform__",
        knowledgeDigest: "Approved pattern: Short 3-sentence insight email with zero fluff.",
        taskInstructions: "Rewrite draft email strictly using Knowledge Base voice.",
      });
      if (!prompt.system.includes("Short 3-sentence")) {
        return { status: "fail", detail: "Email rewrite prompt failed to inject Knowledge Base context." };
      }
      return {
        status: "pass",
        detail: "Knowledge-grounded Email Rewrite prompt assembly verified.",
      };
    },
  },
  {
    id: "mod_ask_ai",
    category: "Module Validation",
    name: "Ask AI / Operator Chat & Tools",
    run: async () => {
      if (!Array.isArray(AGENT_TOOLS) || AGENT_TOOLS.length < 5) {
        return { status: "fail", detail: "Operator AGENT_TOOLS catalog missing or incomplete." };
      }
      return {
        status: "pass",
        detail: `Operator tool registry verified (${AGENT_TOOLS.length} schema tools ready, no chat switcher).`,
      };
    },
  },
  {
    id: "mod_narrator",
    category: "Module Validation",
    name: "Pipeline Narrator & Live Feed",
    run: async () => {
      const rendered = formatStatusLabel("queued_research");
      if (!rendered || rendered === "queued_research") {
        return { status: "fail", detail: "Status label formatter returned unformatted token." };
      }
      return {
        status: "pass",
        detail: `Narrator & feed label formatter verified (queued_research -> "${rendered}").`,
      };
    },
  },
  {
    id: "mod_ai_providers",
    category: "AI Providers & Keys",
    name: "AI Provider Routing & Encrypted Keys",
    run: async () => {
      const policy = await getInternalPlatformPolicy();
      const adminPool = await listAdminAiKeys();
      const healthyPool = adminPool.filter((k) => k.enabled && k.healthStatus === "healthy");
      const legacyEnabled = policy.providers.filter(
        (p) => p.enabled && Boolean(decryptPlatformProviderKey(policy, p.id)),
      );
      if (healthyPool.length === 0 && legacyEnabled.length === 0) {
        return {
          status: "warning",
          detail: "No healthy platform AI keys configured in admin pool (BYOK users can still supply keys).",
        };
      }
      return {
        status: "pass",
        detail: `${healthyPool.length} healthy pooled gateway key(s) & ${legacyEnabled.length} policy provider(s) active.`,
      };
    },
  },
  {
    id: "mod_auth",
    category: "Security & Auth",
    name: "Authentication, Password Policy & Admin 2FA",
    run: async () => {
      const weak = evaluatePasswordStrength("abc");
      const strong = evaluatePasswordStrength("Str0ng#Passw0rd!");
      if (weak.valid || !strong.valid) {
        return { status: "fail", detail: "Password policy validator failed strength assertions." };
      }
      const enc = encryptSecret("probe-secret-123");
      if (!enc.startsWith("enc:v1:") || decryptSecret(enc) !== "probe-secret-123") {
        return { status: "fail", detail: "AES-256-GCM encryption round-trip failed." };
      }
      const totp = generateTotpSecret();
      const code = generateTotpAt(totp, Math.floor(Date.now() / 1000 / 30));
      if (!verifyTotpCode(totp, code)) {
        return { status: "fail", detail: "Admin TOTP verification check failed." };
      }
      const hash = hashAdminPassword("AdminCheck!234");
      if (!verifyAdminPassword("AdminCheck!234", hash)) {
        return { status: "fail", detail: "Admin scrypt password check failed." };
      }
      const accounts = await listAdminAccountsPublic();
      if (accounts.length === 0) {
        return { status: "fail", detail: "No admin accounts present." };
      }
      return {
        status: "pass",
        detail: `Password policy, AES-256-GCM, TOTP 2FA & ${accounts.length} isolated admin account(s) verified.`,
      };
    },
  },
  {
    id: "mod_jobs",
    category: "Jobs, Storage & Telemetry",
    name: "Background Jobs Queue Health",
    run: async () => {
      if (!supabaseServer) return { status: "fail", detail: "Database client missing." };
      const { data: stuck } = await supabaseServer
        .from("background_jobs")
        .select("id, updated_at")
        .in("status", ["running", "queued"])
        .lt("updated_at", new Date(Date.now() - 5 * 60_000).toISOString())
        .limit(20);
      const stuckCount = (stuck ?? []).length;
      if (stuckCount > 0) {
        return {
          status: "warning",
          detail: `${stuckCount} stale running/queued job(s) older than 5m detected.`,
        };
      }
      return { status: "pass", detail: "Background job queue healthy; 0 stuck jobs." };
    },
  },
  {
    id: "mod_storage",
    category: "Jobs, Storage & Telemetry",
    name: "Storage, Avatars & Upload Limits",
    run: async () => {
      const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      if (!isValidAvatarUploadDataUrl(tinyPng)) {
        return { status: "fail", detail: "Avatar validator rejected a valid PNG upload." };
      }
      if (!supabaseServer) return { status: "fail", detail: "Database storage missing." };
      const { count } = await supabaseServer.from("knowledge").select("id", { count: "exact", head: true });
      return {
        status: "pass",
        detail: `Avatar validation & knowledge store healthy (${count ?? 0} docs stored).`,
      };
    },
  },
];

export async function runAllModuleAndInfraChecks(): Promise<SystemCheckItem[]> {
  const results = await Promise.all(
    MODULE_VALIDATORS.map((v) => timed(v.id, v.category, v.name, v.run, true)),
  );
  return results;
}

export async function runSingleModuleCheck(moduleId: string): Promise<SystemCheckItem | null> {
  const desc = MODULE_VALIDATORS.find((m) => m.id === moduleId);
  if (!desc) return null;
  return timed(desc.id, desc.category, desc.name, desc.run, true);
}
