"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Paperclip } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Field } from "@/components/ui";
import { BrandLoader } from "@/components/BrandLoader";
import { authedUpload, errorMessage } from "@/lib/client";
import {
  addKnowledgeSource,
  deleteKnowledgeEntry,
  deleteKnowledgeSource,
  getKnowledgeBundle,
  saveMasterKnowledge,
  upsertKnowledgeEntry,
} from "@/lib/store";
import type { KnowledgeEntry, KnowledgeSource } from "@/lib/types";

interface KnowledgePayload {
  master: string;
  entries: KnowledgeEntry[];
  sources: KnowledgeSource[];
}

export default function KnowledgePage() {
  const { user } = useAuth();
  const [data, setData] = useState<KnowledgePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [master, setMaster] = useState("");
  const [savedMaster, setSavedMaster] = useState("");
  const [savingMaster, setSavingMaster] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<KnowledgeSource["kind"]>("url");
  const [url, setUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [addingSource, setAddingSource] = useState(false);

  const [entryTitle, setEntryTitle] = useState("");
  const [entryBody, setEntryBody] = useState("");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);

  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bundle = await getKnowledgeBundle(user.uid);
      setData(bundle);
      setMaster(bundle.master ?? "");
      setSavedMaster(bundle.master ?? "");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    getKnowledgeBundle(user.uid).then(
      (bundle) => {
        if (!active) return;
        setData(bundle);
        setMaster(bundle.master ?? "");
        setSavedMaster(bundle.master ?? "");
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const saveMaster = async () => {
    setSavingMaster(true);
    setNote(null);
    try {
      await saveMasterKnowledge(user.uid, master);
      setSavedMaster(master);
      setNote({ tone: "ok", text: "Master knowledge saved. Every new email will use it." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setSavingMaster(false);
    }
  };

  const addSource = async () => {
    setAddingSource(true);
    setNote(null);
    try {
      await addKnowledgeSource(user.uid, {
        label,
        kind,
        url: kind === "url" ? url : null,
        content: kind !== "url" ? sourceText : null,
      });
      setLabel("");
      setUrl("");
      setSourceText("");
      await reload();
      setNote({ tone: "ok", text: "Source added. It is read when Gemini writes for you." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setAddingSource(false);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setNote(null);
    let added = 0;
    const failures: string[] = [];
    for (const file of list) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file);
        const extracted = await authedUpload<{
          label: string;
          kind: "pdf" | "text";
          text: string;
          characters: number;
          truncated: boolean;
        }>("/api/knowledge/extract", form);
        await addKnowledgeSource(user.uid, {
          label: extracted.label,
          kind: "document",
          content: extracted.text,
        });
        added += 1;
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setUploading(null);
    if (added) await reload();
    if (added && !failures.length) {
      setNote({
        tone: "ok",
        text: `${added} file${added === 1 ? "" : "s"} added to your knowledge. The AI reads them on every run.`,
      });
    } else if (failures.length) {
      setNote({ tone: "bad", text: failures.slice(0, 3).join(" · ") });
    }
  };

  const removeSource = async (id: string) => {
    try {
      await deleteKnowledgeSource(user.uid, id);
      await reload();
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    }
  };

  const saveEntry = async () => {
    setSavingEntry(true);
    setNote(null);
    try {
      await upsertKnowledgeEntry(user.uid, {
        id: entryId ?? undefined,
        title: entryTitle,
        content: entryBody,
      });
      setEntryTitle("");
      setEntryBody("");
      setEntryId(null);
      await reload();
      setNote({ tone: "ok", text: "Saved." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setSavingEntry(false);
    }
  };

  const removeEntry = async (id: string) => {
    try {
      await deleteKnowledgeEntry(user.uid, id);
      await reload();
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    }
  };

  const dirty = master !== savedMaster;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Knowledge base</h1>
          <p className="page-sub">
            This is the AI&apos;s only source of truth about your business. Everything it researches, qualifies and
            writes is grounded here: your offers, prices, proof, tone and rules.
          </p>
        </div>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}
      {loading && !data && <BrandLoader />}

      {data && (
        <div className="stack">
          {!savedMaster.trim() && (
            <Banner tone="warn">
              <strong>Start here.</strong> Paste everything the AI should know about your business into the master box
              below: what you sell, who for, prices, results, objections and how you write. The more concrete it is, the
              better the outreach.
            </Banner>
          )}

          <Card
            title="Master knowledge"
            sub="The main input. Used on every research, qualification and email run."
            actions={
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void saveMaster()}
                disabled={savingMaster || !dirty}
                type="button"
              >
                {savingMaster ? "Saving…" : dirty ? "Save knowledge" : "Saved"}
              </button>
            }
          >
            <textarea
              className="input"
              style={{ minHeight: 320, fontFamily: "var(--mono, ui-monospace), monospace", fontSize: 13 }}
              value={master}
              onChange={(event) => setMaster(event.target.value)}
              placeholder={`Example:

What we do: We build custom websites and referral automation for clinics and local service businesses.
Who we help: Owners of 1-10 location clinics with an outdated site and no follow-up system.
Offer: A 3-week build, fixed price from $2,400, includes booking, SEO basics and follow-up automations.
Proof: 34 clinics migrated, average 28% more booked appointments in 90 days.
Tone: Calm, direct, no hype, short sentences. Never use the word "revolutionary".
Rules: Never discount below $2,000. Always mention the 3-week timeline.`}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <span className="tiny">
                {master.length.toLocaleString()} characters · no practical limit (up to ~700k per entry)
              </span>
              <div className="row-end">
                {dirty ? <span className="tiny">Unsaved changes</span> : <span className="tiny">All changes saved</span>}
              </div>
            </div>
          </Card>

          <Card
            title="Sources & files"
            sub="Upload PDFs, text files and web pages, or paste any amount of text. Everything here is read alongside your master knowledge."
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.rtf,.log,text/*,application/pdf"
              style={{ display: "none" }}
              onChange={(event) => {
                if (event.target.files) void uploadFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div
              className="upload-zone"
              data-active={dragging ? "true" : undefined}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (event.dataTransfer.files) void uploadFiles(event.dataTransfer.files);
              }}
            >
              <span className="upload-icon">
                <FileUp size={18} />
              </span>
              <div className="upload-copy">
                <strong>{uploading ? `Reading ${uploading}…` : "Drop files here, or choose them"}</strong>
                <span>
                  PDF, TXT, MD, CSV, JSON, HTML, RTF · up to 12 MB each. Text is extracted and stored with this
                  workspace. Scanned PDFs need OCR, so paste those instead.
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={Boolean(uploading)}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={13} />
                {uploading ? "Working…" : "Choose files"}
              </button>
            </div>

            <div className="divider" />

            <div className="grid grid-2" style={{ alignItems: "start", marginBottom: 12 }}>
              <Field label="Label">
                <input
                  className="input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Pricing page"
                />
              </Field>
              <Field label="Type">
                <select
                  className="input"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as KnowledgeSource["kind"])}
                >
                  <option value="url">Web page (read automatically)</option>
                  <option value="text">Pasted text</option>
                </select>
              </Field>
            </div>
            {kind === "url" ? (
              <Field label="URL" hint="Public pages work best: pricing, services, case studies, about.">
                <input
                  className="input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://yourbusiness.com/services"
                />
              </Field>
            ) : (
              <Field label="Text">
                <textarea
                  className="input"
                  style={{ minHeight: 140, lineHeight: 1.55 }}
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="Paste a proposal, case study, FAQ or any document the AI should use. Long text is fine."
                />
              </Field>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <div className="row-end">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void addSource()}
                  disabled={addingSource || !label.trim() || (kind === "url" ? !url.trim() : !sourceText.trim())}
                  type="button"
                >
                  {addingSource ? "Adding…" : "Add source"}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              {data.sources.length === 0 ? (
                <Empty title="No sources yet">Add your website, pricing page or a past proposal.</Empty>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {data.sources.map((source) => (
                    <div key={source.id} className="row" style={{ gap: 10, alignItems: "center" }}>
                      <Badge tone={source.kind === "url" ? "info" : "neutral"}>
                        {source.kind === "url" ? "URL" : "Text"}
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="strong" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {source.label}
                        </div>
                        <div className="tiny" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {source.kind === "url"
                            ? source.url
                            : `${(source.content ?? "").length.toLocaleString()} characters`}
                        </div>
                      </div>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => void removeSource(source.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card
            title="Additional notes"
            sub="Smaller facts, objections, testimonials or policies. Each note is passed to the AI with your master knowledge."
          >
            <div className="stack">
              <Field label={entryId ? "Editing note" : "Title"}>
                <input
                  className="input"
                  value={entryTitle}
                  onChange={(e) => setEntryTitle(e.target.value)}
                  placeholder="Common objection: too expensive"
                />
              </Field>
              <Field label="Content">
                <textarea
                  className="input"
                  style={{ minHeight: 130 }}
                  value={entryBody}
                  onChange={(e) => setEntryBody(e.target.value)}
                  placeholder="What the AI should know or say about this."
                />
              </Field>
              <div className="row">
                <div className="row-end">
                  {entryId && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setEntryId(null);
                        setEntryTitle("");
                        setEntryBody("");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void saveEntry()}
                    disabled={savingEntry || !entryTitle.trim() || !entryBody.trim()}
                    type="button"
                  >
                    {savingEntry ? "Saving…" : entryId ? "Update note" : "Add note"}
                  </button>
                </div>
              </div>

              {data.entries.length === 0 ? (
                <Empty title="No notes yet">Optional, but useful for objections and proof points.</Empty>
              ) : (
                <div className="stack" style={{ gap: 8, marginTop: 6 }}>
                  {data.entries.map((entry) => (
                    <div key={entry.id} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="strong">{entry.title}</div>
                        <div className="tiny" style={{ whiteSpace: "pre-wrap" }}>
                          {entry.content.slice(0, 240)}
                          {entry.content.length > 240 ? "…" : ""}
                        </div>
                      </div>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setEntryId(entry.id);
                          setEntryTitle(entry.title);
                          setEntryBody(entry.content);
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => void removeEntry(entry.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
