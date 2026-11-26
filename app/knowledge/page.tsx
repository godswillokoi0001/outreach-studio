"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Edit3,
  FileUp,
  History,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Field, Modal } from "@/components/ui";
import { BrandLoader } from "@/components/BrandLoader";
import { useConfirm, useToast } from "@/components/Feedback";
import { authedPost, authedUpload, errorMessage } from "@/lib/client";
import {
  addKnowledgeSource,
  deleteAllUserProfileAndKnowledgeData,
  deleteKnowledgeEntry,
  deleteKnowledgeSource,
  getKnowledgeBundle,
  getOnboardingState,
  getStructuredKnowledgeBase,
  saveMasterKnowledge,
  saveStructuredKnowledgeBase,
  upsertKnowledgeEntry,
} from "@/lib/store";
import type {
  KnowledgeSection,
  KnowledgeVersion,
  OnboardingAnswers,
  StructuredKnowledgeBase,
} from "@/lib/onboarding";
import type { KnowledgeEntry, KnowledgeSource } from "@/lib/types";

interface KnowledgePayload {
  master: string;
  entries: KnowledgeEntry[];
  sources: KnowledgeSource[];
}

export default function KnowledgePage() {
  const { user } = useAuth();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<KnowledgePayload | null>(null);
  const [structuredKb, setStructuredKb] = useState<StructuredKnowledgeBase | null>(null);
  const [onboardingAnswers, setOnboardingAnswers] = useState<OnboardingAnswers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Structured section editor & AI side-by-side rewrite states
  const [editingSecId, setEditingSecId] = useState<string | null>(null);
  const [editingSecContent, setEditingSecContent] = useState("");
  const [savingSection, setSavingSection] = useState(false);
  const [regeneratingSecId, setRegeneratingSecId] = useState<string | null>(null);
  const [rewriteProposal, setRewriteProposal] = useState<{
    sectionId: string;
    current: string;
    suggested: string;
  } | null>(null);
  const [addingSecOpen, setAddingSecOpen] = useState(false);
  const [newSecTitle, setNewSecTitle] = useState("");
  const [newSecContent, setNewSecContent] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

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
      const [bundle, skb, onb] = await Promise.all([
        getKnowledgeBundle(user.uid),
        getStructuredKnowledgeBase(user.uid),
        getOnboardingState(user.uid, user),
      ]);
      setData(bundle);
      setStructuredKb(skb);
      setOnboardingAnswers(onb.answers);
      setMaster(bundle.master ?? "");
      setSavedMaster(bundle.master ?? "");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    let active = true;
    Promise.all([
      getKnowledgeBundle(user.uid),
      getStructuredKnowledgeBase(user.uid),
      getOnboardingState(user.uid, user),
    ]).then(
      ([bundle, skb, onb]) => {
        if (!active) return;
        setData(bundle);
        setStructuredKb(skb);
        setOnboardingAnswers(onb.answers);
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
  }, [user]);

  const persistKbSections = async (
    nextSections: KnowledgeSection[],
    authorNote: string,
  ) => {
    const nowIso = new Date().toISOString();
    const gaps = nextSections
      .filter((s) => /not provided/i.test(s.content))
      .map((s) => `${s.title} contains incomplete details`);
    const nextKb: StructuredKnowledgeBase = {
      sections: nextSections,
      missingGaps: gaps,
      versions: structuredKb?.versions ?? [],
      generatedAt: structuredKb?.generatedAt || nowIso,
      updatedAt: nowIso,
    };
    const saved = await saveStructuredKnowledgeBase(user.uid, nextKb, authorNote);
    setStructuredKb(saved);
    await reload();
  };

  const handleSaveSectionEdit = async (sectionId: string) => {
    if (!structuredKb) return;
    setSavingSection(true);
    try {
      const nowIso = new Date().toISOString();
      const nextSections = structuredKb.sections.map((s) =>
        s.id === sectionId
          ? { ...s, content: editingSecContent, provenance: "user_edited" as const, updatedAt: nowIso }
          : s,
      );
      await persistKbSections(nextSections, `Edited "${nextSections.find((s) => s.id === sectionId)?.title}"`);
      setEditingSecId(null);
      toast.success("Section saved", "All AI features now use your updated Knowledge Base.");
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setSavingSection(false);
    }
  };

  const handleRegenerateSection = async (sec: KnowledgeSection) => {
    setRegeneratingSecId(sec.id);
    setNote(null);
    try {
      const res = await authedPost<{ suggestedContent: string }>("/api/ai/onboarding-assist", {
        action: "regenerate_section",
        sectionTitle: sec.title,
        currentContent: sec.content,
        answers: onboardingAnswers,
        knowledgeDigest: master,
      });
      setRewriteProposal({
        sectionId: sec.id,
        current: sec.content,
        suggested: res.suggestedContent,
      });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setRegeneratingSecId(null);
    }
  };

  const handleAcceptRewrite = async (sec: KnowledgeSection) => {
    if (!rewriteProposal || !structuredKb) return;
    if (sec.provenance === "user_edited") {
      const ok = await confirmDialog({
        title: `Replace your edited "${sec.title}" text?`,
        message: "You previously edited this section manually. Accepting the AI suggestion will overwrite it cleanly (and save the old version to history).",
        confirmLabel: "Accept AI rewrite",
        tone: "info",
      });
      if (!ok) return;
    }
    setSavingSection(true);
    try {
      const nowIso = new Date().toISOString();
      const nextSections = structuredKb.sections.map((s) =>
        s.id === sec.id
          ? { ...s, content: rewriteProposal.suggested, provenance: "ai_generated" as const, updatedAt: nowIso }
          : s,
      );
      await persistKbSections(nextSections, `AI-regenerated "${sec.title}"`);
      setRewriteProposal(null);
      toast.success("Section updated", "Previous text saved in Version history.");
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setSavingSection(false);
    }
  };

  const handleAddCustomSection = async () => {
    if (!newSecTitle.trim() || !newSecContent.trim()) return;
    setSavingSection(true);
    try {
      const nowIso = new Date().toISOString();
      const customSec: KnowledgeSection = {
        id: `sec_custom_${Date.now()}`,
        key: `custom_${Date.now()}`,
        title: newSecTitle.trim(),
        content: newSecContent.trim(),
        provenance: "user_edited",
        updatedAt: nowIso,
      };
      const existingSections = structuredKb?.sections ?? [];
      await persistKbSections([...existingSections, customSec], `Added section "${customSec.title}"`);
      setNewSecTitle("");
      setNewSecContent("");
      setAddingSecOpen(false);
      toast.success("Section added", "Updated Knowledge Base synced across all features.");
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setSavingSection(false);
    }
  };

  const handleDeleteSection = async (sec: KnowledgeSection) => {
    if (!structuredKb) return;
    const ok = await confirmDialog({
      title: `Remove "${sec.title}"?`,
      message: "You can restore it anytime from Version history.",
      confirmLabel: "Remove section",
      tone: "bad",
    });
    if (!ok) return;
    const nextSections = structuredKb.sections.filter((s) => s.id !== sec.id);
    await persistKbSections(nextSections, `Removed section "${sec.title}"`);
  };

  const handleRestoreVersion = async (version: KnowledgeVersion) => {
    const ok = await confirmDialog({
      title: `Restore version from ${new Date(version.timestamp).toLocaleString()}?`,
      message: `Current edits will not be lost — a snapshot of your current version is kept in history before restoring "${version.authorNote}".`,
      confirmLabel: "Restore version",
      tone: "info",
    });
    if (!ok) return;
    await persistKbSections(version.sections, `Restored snapshot: ${version.authorNote}`);
    setHistoryOpen(false);
    toast.success("Version restored", "Your Knowledge Base has been rolled back cleanly.");
  };

  const handleDeleteAllData = async () => {
    const ok = await confirmDialog({
      title: "Delete all profile & Knowledge Base data?",
      message:
        "This permanently removes your onboarding answers, structured sections, master knowledge, uploaded documents, custom notes, and Growth Advisor profile. This cannot be undone.",
      confirmLabel: "Delete all data",
      tone: "bad",
    });
    if (!ok) return;
    await deleteAllUserProfileAndKnowledgeData(user.uid);
    setStructuredKb(null);
    await reload();
    toast.success("All profile & Knowledge Base data deleted", "You can re-run onboarding whenever you like.");
  };

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
        <div className="row-end" style={{ gap: 8, flexWrap: "wrap" }}>
          {structuredKb && structuredKb.versions.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => setHistoryOpen(true)}>
              <History size={13} />
              Version history ({structuredKb.versions.length})
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setAddingSecOpen((v) => !v)}>
            <Plus size={13} />
            Add section
          </button>
          <Link href="/onboarding" className="btn btn-sm btn-primary">
            <RotateCcw size={13} />
            Re-run onboarding
          </Link>
        </div>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}
      {loading && !data && <BrandLoader />}

      {data && (
        <div className="stack">
          {/* Missing Gaps Reminder Banner */}
          {structuredKb && structuredKb.missingGaps.length > 0 && (
            <Banner tone="warn">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div className="tiny">
                  <AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
                  <strong>Incomplete details marked &ldquo;Not provided&rdquo;:</strong>{" "}
                  {structuredKb.missingGaps.slice(0, 4).join(" · ")}. Fill them in below for sharper AI outputs.
                </div>
                <Link href="/onboarding" className="btn btn-sm">
                  Complete onboarding questions
                </Link>
              </div>
            </Banner>
          )}

          {/* Add New Section Form */}
          {addingSecOpen && (
            <Card title="Add Knowledge Base section" sub="Custom sections are automatically synced into your AI prompt.">
              <div className="stack" style={{ gap: 10 }}>
                <Field label="Section title">
                  <input
                    className="input"
                    value={newSecTitle}
                    onChange={(e) => setNewSecTitle(e.target.value)}
                    placeholder="e.g. Case Studies, Pricing Tiers, Frequently Asked Questions"
                  />
                </Field>
                <Field label="Content">
                  <textarea
                    className="input"
                    rows={4}
                    value={newSecContent}
                    onChange={(e) => setNewSecContent(e.target.value)}
                    placeholder="Write factual details the AI should follow..."
                  />
                </Field>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={savingSection || !newSecTitle.trim() || !newSecContent.trim()}
                    onClick={() => void handleAddCustomSection()}
                  >
                    {savingSection ? "Saving…" : "Save section"}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingSecOpen(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </Card>
          )}

          {/* Structured Knowledge Base Sections */}
          {structuredKb && structuredKb.sections.length > 0 && (
            <Card
              title="Structured Knowledge Base"
              sub="Edit any section directly or click Regenerate with AI to review a side-by-side rewrite without losing your text."
              actions={
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void handleDeleteAllData()}>
                  <Trash2 size={12} />
                  Delete all data
                </button>
              }
            >
              <div className="stack" style={{ gap: 12 }}>
                {structuredKb.sections.map((sec) => {
                  const isEditing = editingSecId === sec.id;
                  const proposal = rewriteProposal?.sectionId === sec.id ? rewriteProposal : null;
                  const hasMissing = /not provided/i.test(sec.content);

                  return (
                    <div
                      key={sec.id}
                      style={{
                        border: `1px solid ${hasMissing ? "var(--warn, #d97706)" : "var(--line)"}`,
                        borderRadius: 10,
                        padding: 14,
                        background: "var(--surface)",
                      }}
                    >
                      <div
                        className="row"
                        style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}
                      >
                        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="strong" style={{ fontSize: 14 }}>{sec.title}</span>
                          <Badge tone={sec.provenance === "user_edited" ? "ok" : "info"}>
                            {sec.provenance === "user_edited" ? "Edited by you" : "AI-generated"}
                          </Badge>
                          {hasMissing && <Badge tone="warn">Needs details</Badge>}
                        </div>

                        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                          {!isEditing && (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => {
                                  setEditingSecId(sec.id);
                                  setEditingSecContent(sec.content);
                                }}
                              >
                                <Edit3 size={12} />
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={regeneratingSecId === sec.id}
                                onClick={() => void handleRegenerateSection(sec)}
                              >
                                {regeneratingSecId === sec.id ? (
                                  <Loader2 size={12} className="spin" />
                                ) : (
                                  <Sparkles size={12} style={{ color: "var(--teal-deep)" }} />
                                )}
                                {regeneratingSecId === sec.id ? "Drafting…" : "Regenerate with AI"}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => void handleDeleteSection(sec)}
                                title="Remove section"
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isEditing ? (
                        <div className="stack" style={{ gap: 8 }}>
                          <textarea
                            className="input"
                            rows={5}
                            value={editingSecContent}
                            onChange={(e) => setEditingSecContent(e.target.value)}
                          />
                          <div className="row" style={{ gap: 8 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={savingSection}
                              onClick={() => void handleSaveSectionEdit(sec.id)}
                            >
                              {savingSection ? "Saving…" : "Save changes"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setEditingSecId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : proposal ? (
                        <div className="stack" style={{ gap: 10 }}>
                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <div
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid var(--line)",
                                background: "var(--surface-2)",
                              }}
                            >
                              <div className="tiny strong muted" style={{ marginBottom: 4 }}>Current text</div>
                              <div className="tiny" style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{proposal.current}</div>
                            </div>
                            <div
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid var(--teal-deep)",
                                background: "var(--surface)",
                              }}
                            >
                              <div className="tiny strong" style={{ color: "var(--teal-deep)", marginBottom: 4 }}>
                                Suggested AI rewrite
                              </div>
                              <div className="tiny" style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{proposal.suggested}</div>
                            </div>
                          </div>
                          <div className="row" style={{ gap: 8 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={savingSection}
                              onClick={() => void handleAcceptRewrite(sec)}
                            >
                              <Check size={12} />
                              Accept rewrite
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setRewriteProposal(null)}
                            >
                              <X size={12} />
                              Reject &amp; keep mine
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="tiny" style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, color: "var(--ink)" }}>
                          {sec.content}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {!savedMaster.trim() && !structuredKb && (
            <Banner tone="warn">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span>
                  <strong>Start here.</strong> Complete the guided onboarding questions or paste everything the AI should
                  know about your business into the master box below.
                </span>
                <Link href="/onboarding" className="btn btn-primary btn-sm">
                  Start onboarding wizard
                </Link>
              </div>
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

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Knowledge Base Version History"
        large
      >
        <div className="stack" style={{ gap: 10 }}>
          {!structuredKb || structuredKb.versions.length === 0 ? (
            <Empty title="No saved history yet" />
          ) : (
            structuredKb.versions.map((ver, idx) => (
              <div
                key={ver.id}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: idx === 0 ? "var(--surface-2)" : "var(--surface)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <div className="strong" style={{ fontSize: 13 }}>
                      {ver.authorNote} {idx === 0 && <Badge tone="ok">Current</Badge>}
                    </div>
                    <div className="tiny muted">
                      {new Date(ver.timestamp).toLocaleString()} · {ver.summary}
                    </div>
                  </div>
                  {idx > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void handleRestoreVersion(ver)}
                    >
                      <RotateCcw size={12} />
                      Restore this version
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
    </main>
  );
}
