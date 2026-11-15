import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError } from "@/lib/http";
import { q, run, now, audit } from "@/lib/db";
import { normalizeEmail } from "@/lib/columns";
import { addSuppression } from "@/lib/mail";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const rows = await q<{ email: string; reason: string; created_at: string }>(
      `SELECT email, reason, created_at FROM suppressions WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 500`,
      user.sub,
    );
    return ok({ entries: rows });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{ email?: string; reason?: string }>(request);
    const email = normalizeEmail(String(body.email ?? ""));
    if (!email) throw new HttpError(400, "Enter a valid email address.");
    await addSuppression(user.sub, email, body.reason?.trim() || "Added manually");
    await audit(user.sub, "suppression_added", "suppression", email);
    return ok({ ok: true });
  });
}

export async function DELETE(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const email = normalizeEmail(new URL(request.url).searchParams.get("email") ?? "");
    if (!email) throw new HttpError(400, "Missing email.");
    await run(`DELETE FROM suppressions WHERE owner_sub = ? AND email = ?`, user.sub, email);
    await run(
      `UPDATE leads SET status = 'sent', updated_at = ? WHERE owner_sub = ? AND email_norm = ? AND status = 'suppressed'`,
      now(),
      user.sub,
      email,
    );
    await audit(user.sub, "suppression_removed", "suppression", email);
    return ok({ ok: true });
  });
}
