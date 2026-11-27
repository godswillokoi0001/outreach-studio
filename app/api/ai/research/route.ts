import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { researchLeadServer } from "@/lib/research";
import type { Lead } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      lead?: Lead;
      knowledge?: string;
    };
    if (!body.lead) {
      return NextResponse.json({ error: "Lead payload is required." }, { status: 400 });
    }
    const research = await researchLeadServer(body.lead!, body.knowledge ?? "", {
      ownerId: user.ownerId,
    });
    return NextResponse.json({ research });
  } catch (err) {
    return handleApiError(err);
  }
}
