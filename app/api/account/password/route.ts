import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { evaluatePasswordStrength } from "@/lib/password-policy";
import { verifyRequest } from "@/lib/server-auth";
import {
  readUserPasswordRecordServer,
  saveUserPasswordServer,
  userHasPasswordServer,
  verifyUserPasswordHash,
} from "@/lib/server-password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attemptTracker = new Map<string, { count: number; resetAt: number }>();

function checkPasswordAttemptLimit(ownerId: string): boolean {
  const now = Date.now();
  const prev = attemptTracker.get(ownerId);
  if (!prev || now > prev.resetAt) {
    attemptTracker.set(ownerId, { count: 1, resetAt: now + 10 * 60_000 });
    return true;
  }
  if (prev.count >= 12) return false;
  prev.count += 1;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    if (!checkPasswordAttemptLimit(user.ownerId)) {
      return NextResponse.json(
        { error: "Too many password attempts. Wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: "create_initial" | "change" | "recovery";
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };

    const action = body.action ?? "change";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

    if (!newPassword || newPassword !== confirmPassword) {
      return NextResponse.json({ error: "Passwords do not match." }, { status: 400 });
    }

    const strength = evaluatePasswordStrength(newPassword);
    if (!strength.valid) {
      return NextResponse.json(
        { error: strength.error || "Password does not meet security requirements." },
        { status: 400 },
      );
    }

    const alreadyHas = await userHasPasswordServer(user.ownerId);

    if (action === "create_initial" && alreadyHas) {
      return NextResponse.json(
        { error: "A password is already set for this account. Change it in Settings." },
        { status: 409 },
      );
    }

    if (action === "change" && alreadyHas) {
      if (!currentPassword) {
        return NextResponse.json({ error: "Enter your current password to set a new one." }, { status: 400 });
      }
      const existing = await readUserPasswordRecordServer(user.ownerId);
      const valid = existing ? await verifyUserPasswordHash(currentPassword, existing.passwordHash) : false;
      if (!valid) {
        return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
      }
    }

    await saveUserPasswordServer({
      ownerId: user.ownerId,
      supabaseUserId: user.id,
      email: user.email,
      newPassword,
    });

    return NextResponse.json(
      { ok: true, hasPassword: true },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
