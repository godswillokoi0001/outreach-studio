import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { analysePerformanceServer } from "@/lib/intelligence";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as { metrics?: unknown };
    if (!body.metrics) {
      return NextResponse.json({ error: "Analytics metrics payload is required." }, { status: 400 });
    }
    const insight = await analysePerformanceServer(body.metrics, undefined, user.ownerId);
    return NextResponse.json({ insight });
  } catch (err) {
    return handleApiError(err);
  }
}
