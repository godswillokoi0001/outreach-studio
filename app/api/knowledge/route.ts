import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str } from "@/lib/http";
import {
  getMasterKnowledge,
  saveMasterKnowledge,
  listKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  listSources,
  addSource,
  deleteSource,
} from "@/lib/knowledge";
import { audit } from "@/lib/db";
import type { KnowledgeEntry, KnowledgeSource } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const [master, entries, sources] = await Promise.all([
      getMasterKnowledge(user.sub),
      listKnowledge(user.sub),
      listSources(user.sub),
    ]);
    return ok({ master, entries, sources });
  });
}

export async function PUT(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{
      master?: string;
      id?: string;
      title?: string;
      content?: string;
      category?: string;
      sort?: number;
    }>(request);

    if (typeof body.master === "string") {
      await saveMasterKnowledge(user.sub, body.master.slice(0, 40_000));
      await audit(user.sub, "master_knowledge_saved", "knowledge", "master", { chars: body.master.length });
      return ok({ ok: true });
    }

    if (!str(body.title) || !str(body.content)) throw new HttpError(400, "A title and content are required.");
    const id = await upsertKnowledge(user.sub, {
      id: body.id,
      title: str(body.title),
      content: str(body.content),
      category: body.category,
      sort: body.sort,
    });
    await audit(user.sub, "knowledge_saved", "knowledge", id);
    return ok({ id });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{ label?: string; kind?: string; url?: string; content?: string }>(request);
    const label = str(body.label);
    const kind = (str(body.kind) || "url") as KnowledgeSource["kind"];
    const url = str(body.url);
    const content = str(body.content);
    if (!label) throw new HttpError(400, "Give the source a short label.");
    if (kind === "url" && !/^https?:\/\//i.test(url)) throw new HttpError(400, "Enter a full URL starting with http.");
    if (kind !== "url" && !content) throw new HttpError(400, "Add the text for this source.");
    const id = await addSource(user.sub, { label, kind, url, content });
    await audit(user.sub, "knowledge_source_added", "knowledge_source", id, { kind });
    return ok({ id });
  });
}

export async function DELETE(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const sourceId = params.get("sourceId");
    if (sourceId) {
      await deleteSource(user.sub, sourceId);
      await audit(user.sub, "knowledge_source_deleted", "knowledge_source", sourceId);
      return ok({ ok: true });
    }
    if (!id) throw new HttpError(400, "Missing id.");
    await deleteKnowledge(user.sub, id);
    await audit(user.sub, "knowledge_deleted", "knowledge", id);
    return ok({ ok: true });
  });
}

export type KnowledgeResponse = { master: string; entries: KnowledgeEntry[]; sources: KnowledgeSource[] };
