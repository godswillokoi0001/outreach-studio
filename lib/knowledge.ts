import { first, q, run, now } from "./db";
import { randomId } from "./crypto";
import type { KnowledgeEntry, KnowledgeSource } from "./types";

export const MASTER_ID = "master";

/** The single authoritative document the AI treats as the source of truth. */
export async function getMasterKnowledge(ownerSub: string): Promise<string> {
  const row = await first<{ content: string }>(
    `SELECT content FROM knowledge WHERE owner_sub = ? AND id = ?`,
    ownerSub,
    MASTER_ID,
  );
  return row?.content ?? "";
}

export async function saveMasterKnowledge(ownerSub: string, content: string): Promise<void> {
  await run(
    `INSERT INTO knowledge (owner_sub, id, category, title, content, sort, is_master, updated_at)
     VALUES (?,?,'master','Master knowledge',?,0,1,?)
     ON CONFLICT(owner_sub, id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ownerSub,
    MASTER_ID,
    content,
    now(),
  );
}

export async function listKnowledge(ownerSub: string): Promise<KnowledgeEntry[]> {
  return q<KnowledgeEntry>(
    `SELECT * FROM knowledge WHERE owner_sub = ? AND is_master = 0 ORDER BY sort ASC, title ASC`,
    ownerSub,
  );
}

export async function upsertKnowledge(
  ownerSub: string,
  input: Partial<KnowledgeEntry> & { title: string; content: string },
): Promise<string> {
  const id = input.id || randomId("k");
  const existing = input.id
    ? await first<KnowledgeEntry>(`SELECT * FROM knowledge WHERE owner_sub = ? AND id = ?`, ownerSub, input.id)
    : null;
  if (existing) {
    await run(
      `UPDATE knowledge SET category = ?, title = ?, content = ?, sort = ?, updated_at = ?
       WHERE owner_sub = ? AND id = ?`,
      input.category ?? existing.category,
      input.title,
      input.content,
      input.sort ?? existing.sort,
      now(),
      ownerSub,
      id,
    );
  } else {
    await run(
      `INSERT INTO knowledge (owner_sub, id, category, title, content, sort, is_master, updated_at)
       VALUES (?,?,?,?,?,?,0,?)`,
      ownerSub,
      id,
      input.category ?? "custom",
      input.title,
      input.content,
      input.sort ?? 50,
      now(),
    );
  }
  return id;
}

export async function deleteKnowledge(ownerSub: string, id: string): Promise<void> {
  await run(`DELETE FROM knowledge WHERE owner_sub = ? AND id = ?`, ownerSub, id);
}

// ---------------------------------------------------------------------------
// Sources: the references the AI must draw from
// ---------------------------------------------------------------------------

export async function listSources(ownerSub: string): Promise<KnowledgeSource[]> {
  return q<KnowledgeSource>(
    `SELECT * FROM knowledge_sources WHERE owner_sub = ? ORDER BY created_at DESC`,
    ownerSub,
  );
}

export async function addSource(
  ownerSub: string,
  input: { label: string; kind: KnowledgeSource["kind"]; url?: string; content?: string },
): Promise<string> {
  const id = randomId("src");
  await run(
    `INSERT INTO knowledge_sources (owner_sub, id, label, kind, url, content, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    ownerSub,
    id,
    input.label,
    input.kind,
    input.url ?? null,
    input.content ?? null,
    now(),
  );
  return id;
}

export async function deleteSource(ownerSub: string, id: string): Promise<void> {
  await run(`DELETE FROM knowledge_sources WHERE owner_sub = ? AND id = ?`, ownerSub, id);
}

/** Fetches a URL added as a source so the AI can read its actual text. */
export async function readSourceContent(source: KnowledgeSource): Promise<string> {
  if (source.kind !== "url" || !source.url) return source.content ?? "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OutreachStudio/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return source.content ?? "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 4000);
  } catch {
    return source.content ?? "";
  }
}

/**
 * The knowledge digest passed to every AI call:
 * master knowledge first, then sources, then individual entries.
 */
export async function knowledgeDigest(ownerSub: string, maxChars = 14_000): Promise<string> {
  const [master, sources, entries] = await Promise.all([
    getMasterKnowledge(ownerSub),
    listSources(ownerSub),
    listKnowledge(ownerSub),
  ]);

  let out = "";
  const push = (block: string) => {
    if (!block.trim()) return;
    if (out.length + block.length > maxChars) {
      out += block.slice(0, Math.max(0, maxChars - out.length));
      return;
    }
    out += block + "\n\n";
  };

  if (master.trim()) push(`# MASTER KNOWLEDGE (authoritative)\n${master.trim()}`);

  if (sources.length) {
    const blocks: string[] = [];
    for (const source of sources.slice(0, 8)) {
      const body = await readSourceContent(source);
      blocks.push(`## Source: ${source.label}${source.url ? ` (${source.url})` : ""}\n${body.slice(0, 2500)}`);
    }
    push(`# REFERENCE SOURCES\n${blocks.join("\n\n")}`);
  }

  for (const entry of entries.slice(0, 20)) {
    push(`## ${entry.title}\n${entry.content.trim()}`);
  }

  return out.trim();
}

export async function knowledgeIsEmpty(ownerSub: string): Promise<boolean> {
  const master = await getMasterKnowledge(ownerSub);
  if (master.trim()) return false;
  const sources = await listSources(ownerSub);
  const entries = await listKnowledge(ownerSub);
  return sources.length === 0 && entries.length === 0;
}
