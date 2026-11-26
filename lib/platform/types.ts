import type { AiProviderId } from "../ai/types";

export type AdminRole = "super_admin" | "admin" | "support" | "user";
export type UserAccountStatus = "active" | "suspended";

export type AiFeatureKey =
  | "analytics"
  | "growth_advisor"
  | "research"
  | "ask_ai"
  | "knowledge_base"
  | "email_compose"
  | "operator_chat";

export const AI_FEATURE_LABELS: Record<AiFeatureKey, string> = {
  analytics: "Analyse & Performance Review",
  growth_advisor: "Growth Advisor & Execution",
  research: "Prospect Discovery & Research",
  ask_ai: "Ask AI Research Chat",
  knowledge_base: "Onboarding & Knowledge Base",
  email_compose: "Email Composer & Replies",
  operator_chat: "Dashboard AI Operator",
};

export interface PlatformModelOption {
  id: string;
  displayName: string;
  enabled: boolean;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

export interface PlatformProviderPublic {
  id: AiProviderId;
  label: string;
  enabled: boolean;
  hasKey: boolean;
  maskedKey: string;
  baseUrl?: string;
  models: PlatformModelOption[];
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestError?: string;
  updatedAt?: string;
}

export interface PlatformQuotaConfig {
  dailyRequestsPerUser: number;
  monthlyRequestsPerUser: number;
  dailyTokensPerUser: number;
  monthlyTokensPerUser: number;
  rateLimitPerMinute: number;
  monthlySpendCapUsd: number;
  alertThresholdPct: number;
}

export interface PlatformPolicyPublic {
  providers: PlatformProviderPublic[];
  featureDefaults: Record<AiFeatureKey, { provider: AiProviderId; model: string }>;
  fallbackChain: { provider: AiProviderId; model: string }[];
  quotas: PlatformQuotaConfig;
  updatedAt: string;
}

export interface PersonalProviderPublic {
  id: string;
  provider: AiProviderId;
  label: string;
  maskedKey: string;
  baseUrl?: string;
  model: string;
  models: { id: string; label: string }[];
  verifiedAt?: string;
  lastError?: string;
}

export interface UserByokPublicState {
  mode: "platform" | "personal";
  allowFallbackOnError: boolean;
  activePersonalProviderId?: string;
  activePersonalProvider?: PersonalProviderPublic | null;
  personalProviders: PersonalProviderPublic[];
  platformModels: {
    provider: AiProviderId;
    providerLabel: string;
    model: string;
    displayName: string;
  }[];
  selectedPlatformModel?: { provider: AiProviderId; model: string };
  usageStats: {
    platformRequestsToday: number;
    platformRequestsMonth: number;
    platformDailyLimit: number;
    platformMonthlyLimit: number;
    personalRequestsMonth: number;
    personalTokensMonth: number;
    personalCostMonthUsd: number;
  };
}

export interface AdminUserSummary {
  ownerId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: AdminRole;
  status: UserAccountStatus;
  plan: string;
  createdAt: string;
  lastActiveAt: string;
  onboardingCompleted: boolean;
  onboardingScore: number;
  campaignsCount: number;
  leadsCount: number;
  analysesCount: number;
  aiRequestsMonth: number;
  aiTokensMonth: number;
  aiCostMonthUsd: number;
  keySource: "platform" | "personal";
  personalProviderHint?: string;
}

export interface AdminAuditEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  actorRole: AdminRole;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export interface PlatformAnnouncement {
  id: string;
  title: string;
  message: string;
  tone: "info" | "warn" | "ok";
  targetGroup: "all" | "active" | "incomplete_onboarding" | "selected";
  targetUserIds?: string[];
  createdByEmail: string;
  createdAt: string;
  active: boolean;
}

export interface AiUsageEvent {
  id: string;
  ownerId: string;
  userEmail: string;
  feature: AiFeatureKey;
  provider: AiProviderId;
  model: string;
  source: "platform" | "personal";
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
  errorMsg?: string;
  createdAt: string;
}

export interface PlatformAlert {
  id: string;
  severity: "high" | "medium" | "low";
  kind: "usage_spike" | "repeated_failure" | "spend_threshold" | "provider_outage";
  title: string;
  detail: string;
  targetUserEmail?: string;
  detectedAt: string;
}

export const DEFAULT_PLATFORM_QUOTAS: PlatformQuotaConfig = {
  dailyRequestsPerUser: 100,
  monthlyRequestsPerUser: 1500,
  dailyTokensPerUser: 300_000,
  monthlyTokensPerUser: 4_000_000,
  rateLimitPerMinute: 25,
  monthlySpendCapUsd: 250,
  alertThresholdPct: 80,
};

export const ROLE_RANK: Record<AdminRole, number> = {
  user: 0,
  support: 1,
  admin: 2,
  super_admin: 3,
};
