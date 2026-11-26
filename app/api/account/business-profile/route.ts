import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  loadUserContextServer,
  saveUserBusinessProfileServer,
} from "@/lib/global-knowledge/user-context";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = [
  "user_name",
  "user_role",
  "user_company",
  "user_offer",
  "user_mechanism",
  "user_lead_magnet",
  "user_proof",
  "user_icp",
  "user_exclusions",
  "user_sending_tier",
  "user_tone",
  "user_custom_rules",
] as const;

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const ctx = await loadUserContextServer(user.ownerId);
    return NextResponse.json(
      { profile: ctx.profile, variables: ctx.variables },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const field of ALLOWED_FIELDS) {
      if (typeof raw[field] === "string") {
        patch[field] = raw[field].trim().slice(0, 2000);
      }
    }
    const saved = await saveUserBusinessProfileServer(user.ownerId, patch);
    const ctx = await loadUserContextServer(user.ownerId);
    return NextResponse.json({ profile: saved, variables: ctx.variables });
  } catch (err) {
    return handleApiError(err);
  }
}
