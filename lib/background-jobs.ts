import { randomBytes } from "node:crypto";
import { supabaseServer } from "./supabase-server";

export type BackgroundJobType =
  | "onboarding_kb_compile"
  | "growth_advisor_research"
  | "email_review_rewrite";
export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed";
export type BackgroundJobStepStatus = "pending" | "in_progress" | "done" | "failed";

export interface BackgroundJobStep {
  key: string;
  label: string;
  status: BackgroundJobStepStatus;
  weightSec: number;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface BackgroundJobRecord {
  id: string;
  ownerId: string;
  jobType: BackgroundJobType;
  status: BackgroundJobStatus;
  currentStep: string;
  totalSteps: number;
  progressPct: number;
  estimatedSecondsRemaining: number;
  steps: BackgroundJobStep[];
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const FALLBACK_CATEGORY = "system_background_jobs";
const memJobs = new Map<string, BackgroundJobRecord>();

export function clearBackgroundJobsForTests(): void {
  memJobs.clear();
}
const STALE_JOB_MS = 20 * 60 * 1000;
// A running job writes progress (or a heartbeat) at least this often. If it goes
// quiet for longer than JOB_STALL_MS the server that owned it is gone - on
// serverless platforms a function is frozen as soon as its response is sent, so
// silence is the only reliable signal that the run died.
export const JOB_HEARTBEAT_MS = 10_000;
export const JOB_STALL_MS = 90_000;
export const STALLED_JOB_MESSAGE =
  "Market research stopped before it finished because the server ran out of time. Tap Retry research to run it again — nothing already saved is lost.";

export function isJobStalled(
  job: Pick<BackgroundJobRecord, "status" | "updatedAt">,
  nowMs: number = Date.now(),
  stallMs: number = JOB_STALL_MS,
): boolean {
  if (job.status !== "running" && job.status !== "queued") return false;
  const updated = new Date(job.updatedAt).getTime();
  if (!Number.isFinite(updated)) return true;
  return nowMs - updated > stallMs;
}

function mapSqlRow(row: Record<string, unknown>): BackgroundJobRecord {
  return {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    jobType: String(row.job_type ?? "onboarding_kb_compile") as BackgroundJobType,
    status: String(row.status ?? "queued") as BackgroundJobStatus,
    currentStep: String(row.current_step ?? ""),
    totalSteps: Number(row.total_steps ?? 0),
    progressPct: Number(row.progress_pct ?? 0),
    estimatedSecondsRemaining: Number(row.estimated_seconds_remaining ?? 0),
    steps: Array.isArray(row.steps_json) ? (row.steps_json as BackgroundJobStep[]) : [],
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
    result:
      row.result && typeof row.result === "object"
        ? (row.result as Record<string, unknown>)
        : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: String(row.started_at ?? new Date().toISOString()),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

export function computeJobProgressAndEta(
  steps: BackgroundJobStep[],
  startedAtIso: string,
  status: BackgroundJobStatus,
): { progressPct: number; estimatedSecondsRemaining: number; currentStep: string } {
  if (steps.length === 0) {
    return {
      progressPct: status === "succeeded" ? 100 : 0,
      estimatedSecondsRemaining: 0,
      currentStep: "",
    };
  }

  const totalWeight = Math.max(
    1,
    steps.reduce((sum, s) => sum + Math.max(1, s.weightSec), 0),
  );

  let completedWeight = 0;
  let remainingNominal = 0;
  let activeLabel = steps[0].label;

  for (const s of steps) {
    const w = Math.max(1, s.weightSec);
    if (s.status === "done") {
      completedWeight += w;
    } else if (s.status === "in_progress") {
      completedWeight += w * 0.45;
      remainingNominal += w * 0.55;
      activeLabel = s.label;
    } else if (s.status === "failed") {
      activeLabel = s.label;
    } else {
      remainingNominal += w;
    }
  }

  if (status === "succeeded") {
    return {
      progressPct: 100,
      estimatedSecondsRemaining: 0,
      currentStep: steps[steps.length - 1].label,
    };
  }

  const doneCount = steps.filter((s) => s.status === "done").length;
  let paceFactor = 1;
  if (doneCount > 0 && completedWeight > 0) {
    const elapsedSec = Math.max(1, (Date.now() - new Date(startedAtIso).getTime()) / 1000);
    const ratio = elapsedSec / completedWeight;
    paceFactor = Math.min(2.4, Math.max(0.45, ratio));
  }

  const progressPct = Math.min(99, Math.max(doneCount === 0 ? 4 : 8, Math.round((completedWeight / totalWeight) * 100)));
  const estimatedSecondsRemaining =
    status === "failed" ? 0 : Math.max(1, Math.round(remainingNominal * paceFactor));

  return { progressPct, estimatedSecondsRemaining, currentStep: activeLabel };
}

async function saveJobFallback(job: BackgroundJobRecord): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("knowledge").upsert(
    {
      id: `system_job_${job.id}`,
      owner_id: job.ownerId,
      category: FALLBACK_CATEGORY,
      title: `${job.jobType}:${job.status}`,
      content: JSON.stringify(job),
      sort: 999,
      is_master: false,
      updated_at: job.updatedAt,
    } as never,
    { onConflict: "id" },
  );
}

async function saveJobRecord(job: BackgroundJobRecord): Promise<void> {
  memJobs.set(`${job.ownerId}:${job.id}`, job);
  if (!supabaseServer) return;
  const { error } = await supabaseServer.from("background_jobs").upsert(
    {
      id: job.id,
      owner_id: job.ownerId,
      job_type: job.jobType,
      status: job.status,
      current_step: job.currentStep,
      total_steps: job.totalSteps,
      progress_pct: job.progressPct,
      estimated_seconds_remaining: job.estimatedSecondsRemaining,
      steps_json: job.steps,
      payload: job.payload,
      result: job.result,
      error_message: job.errorMessage,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    } as never,
    { onConflict: "id" },
  );
  if (error) {
    await saveJobFallback(job);
  }
}

export async function listBackgroundJobsForOwner(
  ownerId: string,
  jobType?: BackgroundJobType,
  limit = 10,
): Promise<BackgroundJobRecord[]> {
  if (!ownerId) return [];
  if (!supabaseServer) {
    return Array.from(memJobs.values())
      .filter((j) => j.ownerId === ownerId && (!jobType || j.jobType === jobType))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  let q = supabaseServer
    .from("background_jobs")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (jobType) q = q.eq("job_type", jobType);

  const { data, error } = await q;
  if (!error && Array.isArray(data)) {
    return data.map((r) => mapSqlRow(r as Record<string, unknown>));
  }

  // Fallback to owner-isolated knowledge rows
  const { data: kbRows } = await supabaseServer
    .from("knowledge")
    .select("content, updated_at")
    .eq("owner_id", ownerId)
    .eq("category", FALLBACK_CATEGORY)
    .order("updated_at", { ascending: false })
    .limit(limit * 2);

  const jobs: BackgroundJobRecord[] = [];
  for (const row of kbRows ?? []) {
    try {
      const parsed = JSON.parse(String((row as { content?: string }).content ?? "{}")) as BackgroundJobRecord;
      if (parsed.ownerId !== ownerId) continue;
      if (jobType && parsed.jobType !== jobType) continue;
      jobs.push(parsed);
    } catch {
      /* skip corrupt */
    }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function getBackgroundJobForOwner(
  ownerId: string,
  jobId: string,
): Promise<BackgroundJobRecord | null> {
  if (!ownerId || !jobId) return null;
  if (!supabaseServer) {
    const found = memJobs.get(`${ownerId}:${jobId}`) ?? null;
    return found && found.ownerId === ownerId ? found : null;
  }

  const { data, error } = await supabaseServer
    .from("background_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (!error && data) {
    return mapSqlRow(data as Record<string, unknown>);
  }

  const { data: kb } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", `system_job_${jobId}`)
    .eq("owner_id", ownerId)
    .maybeSingle();

  const raw = (kb as { content?: string } | null)?.content;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BackgroundJobRecord;
    return parsed.ownerId === ownerId ? parsed : null;
  } catch {
    return null;
  }
}

export async function getLatestBackgroundJobForOwner(
  ownerId: string,
  jobType: BackgroundJobType,
): Promise<BackgroundJobRecord | null> {
  const list = await listBackgroundJobsForOwner(ownerId, jobType, 5);
  return list[0] ?? null;
}

/**
 * Creates a persistent background job or returns an active in-progress job for the same
 * owner and jobType so refreshes/double-clicks never trigger duplicate runs.
 */
export async function createOrReuseBackgroundJob(input: {
  ownerId: string;
  jobType: BackgroundJobType;
  steps: BackgroundJobStep[];
  payload?: Record<string, unknown>;
  forceRestartIfFailed?: boolean;
  staleAfterMs?: number;
}): Promise<{ job: BackgroundJobRecord; reused: boolean }> {
  const existingList = await listBackgroundJobsForOwner(input.ownerId, input.jobType, 3);
  const active = existingList.find((j) => j.status === "queued" || j.status === "running");
  const staleMs = input.staleAfterMs ?? STALE_JOB_MS;

  if (active) {
    const ageMs = Date.now() - new Date(active.updatedAt).getTime();
    if (ageMs < staleMs) {
      return { job: active, reused: true };
    }
    // Mark stale zombie job failed cleanly before starting a fresh one
    await failBackgroundJob(input.ownerId, active.id, "Previous job timed out before finishing.");
  }

  const nowIso = new Date().toISOString();
  const initialSteps: BackgroundJobStep[] = input.steps.map((s, idx) => ({
    ...s,
    status: idx === 0 ? "in_progress" : "pending",
    startedAt: idx === 0 ? nowIso : undefined,
  }));
  const metrics = computeJobProgressAndEta(initialSteps, nowIso, "running");

  const job: BackgroundJobRecord = {
    id: `job_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
    ownerId: input.ownerId,
    jobType: input.jobType,
    status: "running",
    currentStep: metrics.currentStep,
    totalSteps: initialSteps.length,
    progressPct: metrics.progressPct,
    estimatedSecondsRemaining: metrics.estimatedSecondsRemaining,
    steps: initialSteps,
    payload: input.payload ?? {},
    result: null,
    errorMessage: null,
    startedAt: nowIso,
    finishedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await saveJobRecord(job);
  return { job, reused: false };
}

export async function advanceBackgroundJobStep(
  ownerId: string,
  jobId: string,
  stepKey: string,
  status: BackgroundJobStepStatus,
  detail?: string,
): Promise<BackgroundJobRecord | null> {
  const job = await getBackgroundJobForOwner(ownerId, jobId);
  if (!job) return null;

  const nowIso = new Date().toISOString();
  const steps = job.steps.map((s) => {
    if (s.key !== stepKey) return s;
    return {
      ...s,
      status,
      startedAt: s.startedAt ?? (status === "in_progress" || status === "done" ? nowIso : undefined),
      finishedAt: status === "done" || status === "failed" ? nowIso : s.finishedAt,
      detail: detail ?? s.detail,
    };
  });

  const nextStatus: BackgroundJobStatus = status === "failed" ? "failed" : "running";
  const metrics = computeJobProgressAndEta(steps, job.startedAt, nextStatus);

  const updated: BackgroundJobRecord = {
    ...job,
    status: nextStatus,
    steps,
    currentStep: metrics.currentStep,
    progressPct: metrics.progressPct,
    estimatedSecondsRemaining: metrics.estimatedSecondsRemaining,
    updatedAt: nowIso,
  };
  await saveJobRecord(updated);
  return updated;
}

export async function touchBackgroundJob(
  ownerId: string,
  jobId: string,
): Promise<BackgroundJobRecord | null> {
  const job = await getBackgroundJobForOwner(ownerId, jobId);
  if (!job) return null;
  if (job.status !== "running" && job.status !== "queued") return job;

  const nowIso = new Date().toISOString();
  const metrics = computeJobProgressAndEta(job.steps, job.startedAt, job.status);
  const updated: BackgroundJobRecord = {
    ...job,
    currentStep: metrics.currentStep,
    progressPct: metrics.progressPct,
    estimatedSecondsRemaining: metrics.estimatedSecondsRemaining,
    updatedAt: nowIso,
  };
  await saveJobRecord(updated);
  return updated;
}

/**
 * Fail a job whose owner process died mid-run so the UI stops showing a frozen
 * percentage forever and the user can retry.
 */
export async function failStalledBackgroundJob(
  ownerId: string,
  job: BackgroundJobRecord,
  stallMs: number = JOB_STALL_MS,
): Promise<BackgroundJobRecord> {
  if (!isJobStalled(job, Date.now(), stallMs)) return job;
  const activeStep = job.steps.find((s) => s.status === "in_progress");
  const failed = await failBackgroundJob(ownerId, job.id, STALLED_JOB_MESSAGE, activeStep?.key);
  return failed ?? job;
}

export async function completeBackgroundJob(
  ownerId: string,
  jobId: string,
  result: Record<string, unknown>,
): Promise<BackgroundJobRecord | null> {
  const job = await getBackgroundJobForOwner(ownerId, jobId);
  if (!job) return null;

  const nowIso = new Date().toISOString();
  const steps: BackgroundJobStep[] = job.steps.map((s) => ({
    ...s,
    status: "done",
    startedAt: s.startedAt ?? nowIso,
    finishedAt: s.finishedAt ?? nowIso,
  }));

  const updated: BackgroundJobRecord = {
    ...job,
    status: "succeeded",
    steps,
    currentStep: steps[steps.length - 1]?.label ?? "Completed",
    progressPct: 100,
    estimatedSecondsRemaining: 0,
    result,
    errorMessage: null,
    finishedAt: nowIso,
    updatedAt: nowIso,
  };
  await saveJobRecord(updated);
  return updated;
}

export async function failBackgroundJob(
  ownerId: string,
  jobId: string,
  errorMessage: string,
  failedStepKey?: string,
): Promise<BackgroundJobRecord | null> {
  const job = await getBackgroundJobForOwner(ownerId, jobId);
  if (!job) return null;

  const nowIso = new Date().toISOString();
  const steps: BackgroundJobStep[] = job.steps.map((s) => {
    const isFailedTarget = failedStepKey ? s.key === failedStepKey : s.status === "in_progress";
    if (!isFailedTarget) return s;
    return {
      ...s,
      status: "failed",
      finishedAt: nowIso,
      detail: errorMessage,
    };
  });

  const failedStep = steps.find((s) => s.status === "failed");
  const updated: BackgroundJobRecord = {
    ...job,
    status: "failed",
    steps,
    currentStep: failedStep?.label ?? job.currentStep,
    estimatedSecondsRemaining: 0,
    errorMessage,
    finishedAt: nowIso,
    updatedAt: nowIso,
  };
  await saveJobRecord(updated);
  return updated;
}
