import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { discoverProspectsServer } from "@/lib/intelligence";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      industry?: string;
      location?: string;
      count?: number;
      focus?: string;
      knowledge?: string;
    };
    const count = Math.max(3, Math.min(20, Number(body.count) || 8));
    const result = await discoverProspectsServer({
      ownerId: user.ownerId,
      industry: String(body.industry ?? ""),
      location: String(body.location ?? ""),
      count,
      focus: String(body.focus ?? ""),
      knowledge: String(body.knowledge ?? ""),
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
