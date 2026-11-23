import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { researchLeadServer } from "@/lib/research";
import type { Lead } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const body = (await req.json()) as {
      lead?: Lead;
      knowledge?: string;
      model?: string;
    };
    if (!body.lead) {
      return NextResponse.json({ error: "Lead payload is required." }, { status: 400 });
    }
    const research = await researchLeadServer(body.lead, body.knowledge ?? "", {
      model: body.model,
    });
    return NextResponse.json({ research });
  } catch (err) {
    return handleApiError(err);
  }
}
