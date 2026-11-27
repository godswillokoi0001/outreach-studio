import { resolveUserSendingTier } from "../guardrails";
import type { OnboardingState, StructuredKnowledgeBase } from "../onboarding";
import { getSupabaseSettingsServer, supabaseServer } from "../supabase-server";
import type { CampaignConfig, KnowledgeEntry, KnowledgeSource, Settings } from "../types";
import type { UserBusinessProfile, UserBusinessVariables } from "./types";

export const NOT_PROVIDED_TEXT = "Not provided — do not fabricate or mention";

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const v of values) {
    const cleaned = typeof v === "string" ? v.trim() : "";
    if (cleaned && !/^not provided\.?$/i.test(cleaned)) return cleaned;
  }
  return "";
}

function orNotProvided(value: string): string {
  return value.trim() || NOT_PROVIDED_TEXT;
}

export function buildEmptyUserBusinessProfile(ownerId: string): UserBusinessProfile {
  return {
    owner_id: ownerId,
    user_name: "",
    user_role: "",
    user_company: "",
    user_offer: "",
    user_mechanism: "",
    user_lead_magnet: "",
    user_proof: "",
    user_icp: "",
    user_exclusions: "",
    user_sending_tier: "free_gmail_starter",
    user_tone: "",
    user_custom_rules: "",
  };
}

export function resolveUserBusinessVariables(input: {
  ownerId?: string;
  profile?: Partial<UserBusinessProfile> | null;
  settings?: Partial<Settings> | null;
  onboarding?: OnboardingState | null;
  structuredKb?: StructuredKnowledgeBase | null;
  campaign?: Partial<CampaignConfig> | null;
  knowledgeDigest?: string;
}): UserBusinessVariables {
  const p = input.profile ?? {};
  const s = input.settings ?? {};
  const a = input.onboarding?.answers;
  const sections = input.structuredKb?.sections ?? [];
  const sec = (key: string) => sections.find((x) => x.key === key)?.content ?? "";

  const offerPieces = [
    firstNonEmpty(p.user_offer),
    firstNonEmpty(a?.businessDescription),
    a?.mainServices?.length ? `Services: ${a.mainServices.join(", ")}` : "",
    a?.mainProblemSolved ? `Solves: ${a.mainProblemSolved}` : "",
    a?.priceRange ? `Pricing: ${a.priceRange}` : "",
    firstNonEmpty(sec("products_services")),
    firstNonEmpty(sec("offer_pricing")),
  ].filter(Boolean);

  const icpPieces = [
    firstNonEmpty(p.user_icp),
    firstNonEmpty(a?.idealCustomerSummary),
    a?.icpIndustries?.length ? `Industries: ${a.icpIndustries.join(", ")}` : "",
    a?.icpRoles?.length ? `Decision makers: ${a.icpRoles.join(", ")}` : "",
    a?.icpCompanySize ? `Company size: ${a.icpCompanySize}` : "",
    a?.icpLocation || a?.currentMarkets ? `Geography: ${a.icpLocation || a.currentMarkets}` : "",
    a?.icpPainPoints ? `Pain points: ${a.icpPainPoints}` : "",
    firstNonEmpty(sec("ideal_customer")),
  ].filter(Boolean);

  const exclusionPieces = [
    firstNonEmpty(p.user_exclusions),
    firstNonEmpty(a?.icpExclusions),
    a?.wordsToAvoid ? `Words/claims to avoid: ${a.wordsToAvoid}` : "",
  ].filter(Boolean);

  const customRulePieces = [
    firstNonEmpty(p.user_custom_rules),
    firstNonEmpty(input.campaign?.extra_instructions),
    a?.guaranteeDetails && a?.hasGuarantee ? `Guarantee: ${a.guaranteeDetails}` : "",
    a?.sampleMessages ? `Reference voice samples: ${a.sampleMessages}` : "",
  ].filter(Boolean);

  const tonePieces = [
    firstNonEmpty(p.user_tone),
    firstNonEmpty(input.campaign?.tone),
    a?.brandTones?.length ? a.brandTones.join(", ") : "",
    firstNonEmpty(sec("brand_voice")),
  ].filter(Boolean);

  const sendingTier = resolveUserSendingTier(s.sender_email, p.user_sending_tier);

  return {
    USER_NAME: orNotProvided(firstNonEmpty(p.user_name, a?.fullName, s.sender_name)),
    USER_ROLE: orNotProvided(firstNonEmpty(p.user_role, a?.roleTitle, s.sender_role)),
    USER_COMPANY: orNotProvided(firstNonEmpty(p.user_company, a?.businessName, s.sender_company)),
    USER_OFFER: orNotProvided(
      offerPieces[0] ? Array.from(new Set(offerPieces)).join(" | ").slice(0, 1200) : "",
    ),
    USER_MECHANISM: orNotProvided(firstNonEmpty(p.user_mechanism, a?.differentiators)),
    USER_LEAD_MAGNET: orNotProvided(firstNonEmpty(p.user_lead_magnet, a?.bookingOrPortfolioUrl)),
    USER_PROOF: orNotProvided(firstNonEmpty(p.user_proof, a?.proof, sec("proof_credibility"))),
    USER_ICP: orNotProvided(
      icpPieces[0] ? Array.from(new Set(icpPieces)).join(" | ").slice(0, 1200) : "",
    ),
    USER_EXCLUSIONS: orNotProvided(
      exclusionPieces[0] ? Array.from(new Set(exclusionPieces)).join(" | ").slice(0, 800) : "",
    ),
    USER_SENDING_TIER: sendingTier,
    USER_TONE: orNotProvided(
      tonePieces[0] ? Array.from(new Set(tonePieces)).join(" | ").slice(0, 500) : "",
    ),
    USER_CUSTOM_RULES: orNotProvided(
      customRulePieces[0] ? Array.from(new Set(customRulePieces)).join(" | ").slice(0, 1000) : "",
    ),
  };
}

export interface LoadedUserContext {
  ownerId: string;
  profile: UserBusinessProfile;
  variables: UserBusinessVariables;
  masterKnowledge: string;
  notes: KnowledgeEntry[];
  sources: KnowledgeSource[];
  knowledgeDigest: string;
  settings: Partial<Settings> | null;
}

const BUSINESS_PROFILE_KNOWLEDGE_PREFIX = "system_business_profile_";

export async function getUserBusinessProfileServer(ownerId: string): Promise<UserBusinessProfile> {
  const empty = buildEmptyUserBusinessProfile(ownerId);
  if (!supabaseServer || !ownerId) return empty;

  // 1. Primary store: dedicated `user_business_profiles` table scoped strictly by owner_id.
  try {
    const { data, error } = await supabaseServer
      .from("user_business_profiles" as never)
      .select("*")
      .eq("owner_id", ownerId)
      .maybeSingle();

    if (!error && data) {
      const row = data as Record<string, unknown>;
      return {
        owner_id: ownerId,
        user_name: String(row.user_name ?? ""),
        user_role: String(row.user_role ?? ""),
        user_company: String(row.user_company ?? ""),
        user_offer: String(row.user_offer ?? ""),
        user_mechanism: String(row.user_mechanism ?? ""),
        user_lead_magnet: String(row.user_lead_magnet ?? ""),
        user_proof: String(row.user_proof ?? ""),
        user_icp: String(row.user_icp ?? ""),
        user_exclusions: String(row.user_exclusions ?? ""),
        user_sending_tier:
          row.user_sending_tier === "authenticated_custom_domain"
            ? "authenticated_custom_domain"
            : "free_gmail_starter",
        user_tone: String(row.user_tone ?? ""),
        user_custom_rules: String(row.user_custom_rules ?? ""),
        created_at: row.created_at ? String(row.created_at) : undefined,
        updated_at: row.updated_at ? String(row.updated_at) : undefined,
      };
    }
  } catch {
    // Table may not be migrated yet; fall back cleanly below.
  }

  // 2. Fallback mirror in owner-scoped knowledge row if SQL migration hasn't run yet.
  try {
    const { data } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", `${BUSINESS_PROFILE_KNOWLEDGE_PREFIX}${ownerId}`)
      .eq("owner_id", ownerId)
      .maybeSingle();
    const raw = (data as { content?: string } | null)?.content;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserBusinessProfile>;
      return { ...empty, ...parsed, owner_id: ownerId };
    }
  } catch {
    // Ignore parse error
  }

  return empty;
}

export async function saveUserBusinessProfileServer(
  ownerId: string,
  patch: Partial<UserBusinessProfile>,
): Promise<UserBusinessProfile> {
  const current = await getUserBusinessProfileServer(ownerId);
  const next: UserBusinessProfile = {
    ...current,
    ...patch,
    owner_id: ownerId,
    user_sending_tier:
      patch.user_sending_tier === "authenticated_custom_domain" ||
      (patch.user_sending_tier === undefined && current.user_sending_tier === "authenticated_custom_domain")
        ? "authenticated_custom_domain"
        : "free_gmail_starter",
    updated_at: new Date().toISOString(),
  };

  if (!supabaseServer) return next;

  try {
    const { error } = await supabaseServer
      .from("user_business_profiles" as never)
      .upsert(next as never, { onConflict: "owner_id" });
    if (!error) return next;
  } catch {
    // Fallback to knowledge mirror below
  }

  await supabaseServer.from("knowledge").upsert(
    {
      id: `${BUSINESS_PROFILE_KNOWLEDGE_PREFIX}${ownerId}`,
      owner_id: ownerId,
      category: "system_business_profile",
      title: "Dynamic Business Context Profile",
      content: JSON.stringify(next),
      sort: 998,
      is_master: false,
      updated_at: next.updated_at,
    } as never,
    { onConflict: "id" },
  );

  return next;
}

/**
 * Loads ONLY the active tenant's own profile, master knowledge, sources,
 * additional notes, onboarding state, and structured KB — never any other tenant's data.
 */
export async function loadUserContextServer(
  ownerId: string,
  overrides?: {
    settings?: Partial<Settings> | null;
    campaign?: Partial<CampaignConfig> | null;
    knowledgeDigest?: string;
  },
): Promise<LoadedUserContext> {
  const profile = await getUserBusinessProfileServer(ownerId);
  let masterKnowledge = "";
  let onboarding: OnboardingState | null = null;
  let structuredKb: StructuredKnowledgeBase | null = null;
  const notes: KnowledgeEntry[] = [];
  let sources: KnowledgeSource[] = [];

  if (supabaseServer && ownerId) {
    const [kRes, sRes] = await Promise.all([
      supabaseServer
        .from("knowledge")
        .select("id, owner_id, category, title, content, sort, is_master, created_at, updated_at")
        .eq("owner_id", ownerId)
        .order("sort", { ascending: true }),
      supabaseServer
        .from("knowledge_sources")
        .select("id, owner_id, label, kind, url, content, created_at, updated_at")
        .eq("owner_id", ownerId)
        .order("created_at", { ascending: false })
        .limit(12),
    ]);

    const kRows = (kRes.data ?? []) as Record<string, unknown>[];
    for (const row of kRows) {
      const id = String(row.id ?? "");
      const category = String(row.category ?? "custom");
      const content = String(row.content ?? "");

      if (id === `system_onboarding_${ownerId}` || category === "system_onboarding_state") {
        try {
          onboarding = JSON.parse(content) as OnboardingState;
        } catch {
          /* ignore */
        }
        continue;
      }
      if (id === `system_kb_structured_${ownerId}` || category === "system_kb_structured") {
        try {
          structuredKb = JSON.parse(content) as StructuredKnowledgeBase;
        } catch {
          /* ignore */
        }
        continue;
      }
      if (
        category.startsWith("system_") ||
        category.startsWith("growth_advisor_")
      ) {
        continue;
      }

      if (id === "master" || id === `master_${ownerId}` || row.is_master === true || category === "master") {
        if (content.trim() || !masterKnowledge) {
          masterKnowledge = content;
        }
      } else {
        notes.push({
          id,
          ownerId,
          category,
          title: String(row.title ?? "Note"),
          content,
          sort: Number(row.sort ?? 50),
          is_master: false,
          created_at: String(row.created_at ?? ""),
          updated_at: String(row.updated_at ?? ""),
        });
      }
    }

    sources = ((sRes.data ?? []) as Record<string, unknown>[]).map((s) => ({
      id: String(s.id ?? ""),
      ownerId,
      label: String(s.label ?? "Source"),
      kind: (s.kind as KnowledgeSource["kind"]) ?? "url",
      url: s.url ? String(s.url) : null,
      content: s.content ? String(s.content) : null,
      created_at: String(s.created_at ?? ""),
      updated_at: String(s.updated_at ?? ""),
    }));
  }

  const digestParts: string[] = [];
  if (overrides?.knowledgeDigest?.trim()) {
    digestParts.push(overrides.knowledgeDigest.trim());
  } else {
    if (masterKnowledge.trim()) {
      digestParts.push(`### Master Knowledge (Priority Voice & Rules)\n${masterKnowledge.trim()}`);
    }
    // Prioritize notes/sources explicitly containing Words to USE / AVOID or Sample Style Examples first
    const priorityNoteRe = /\b(words to use|words to avoid|sample|style|voice|template|tone|directive|cta)\b/i;
    const priorityNotes = notes.filter((n) => priorityNoteRe.test(`${n.title}\n${n.content}`));
    const standardNotes = notes.filter((n) => !priorityNoteRe.test(`${n.title}\n${n.content}`));

    if (priorityNotes.length > 0) {
      digestParts.push(
        `### Priority Voice Rules & Examples\n${priorityNotes
          .slice(0, 8)
          .map((n) => `- **${n.title}**: ${n.content.slice(0, 1400)}`)
          .join("\n")}`,
      );
    }
    if (sources.length > 0) {
      digestParts.push(
        `### Reference Sources\n${sources
          .slice(0, 8)
          .map((src) => `- **${src.label}**${src.url ? ` (${src.url})` : ""}: ${(src.content ?? "").slice(0, 1200)}`)
          .join("\n")}`,
      );
    }
    if (standardNotes.length > 0) {
      digestParts.push(
        `### Additional Notes\n${standardNotes
          .slice(0, 12)
          .map((n) => `- **${n.title}**: ${n.content.slice(0, 1000)}`)
          .join("\n")}`,
      );
    }
  }

  const loadedSettings =
    overrides?.settings ?? (ownerId ? await getSupabaseSettingsServer(ownerId) : null);

  const knowledgeDigest = digestParts.join("\n\n").slice(0, 32_000);
  const variables = resolveUserBusinessVariables({
    ownerId,
    profile,
    settings: loadedSettings,
    onboarding,
    structuredKb,
    campaign: overrides?.campaign ?? null,
    knowledgeDigest,
  });

  return {
    ownerId,
    profile,
    variables,
    masterKnowledge,
    notes,
    sources,
    knowledgeDigest,
    settings: loadedSettings,
  };
}
