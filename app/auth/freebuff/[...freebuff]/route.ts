import { freebuff } from "@/lib/freebuff";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!freebuff) return new Response("Sign in with Freebuff is not configured.", { status: 404 });
  return freebuff.handlers.GET(request);
}

export async function POST(request: Request) {
  if (!freebuff) return new Response("Sign in with Freebuff is not configured.", { status: 404 });
  return freebuff.handlers.POST(request);
}
