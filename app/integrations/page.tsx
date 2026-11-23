"use client";

import { useState } from "react";
import { CheckCircle2, Database, FileSpreadsheet, Mail, ShieldCheck, Sparkles } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
import { getSettings } from "@/lib/firestore-store";

export default function IntegrationsPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);

  const testGemini = async () => {
    setBusy("test");
    setNote(null);
    try {
      const settings = await getSettings(user.uid);
      const result = await authedPost<{ model: string; ms: number; reply: string }>("/api/ai/test", {
        model: settings.model,
      });
      setNote({
        tone: "ok",
        text: `Gemini AI connected: ${result.model} replied "${result.reply}" in ${result.ms} ms.`,
      });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const refreshWorkspace = async () => {
    setBusy("workspace");
    setNote(null);
    try {
      const ok = await reconnectWorkspace();
      if (ok) {
        setNote({
          tone: "ok",
          text: "Google Workspace permissions verified. Gmail and Google Sheets are ready.",
        });
      }
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">
            Your Google account powers Firebase cloud sync, Google Sheets, and Gmail — while Google AI runs securely
            on the server.
          </p>
        </div>
      </div>

      <div className="stack">
        {note && <Banner tone={note.tone}>{note.text}</Banner>}

        <Card
          title="Firebase Auth & Cloud Firestore"
          sub="Private, user-isolated workspace persistence across sessions and devices."
          actions={<Badge tone="ok">Connected</Badge>}
        >
          <div className="row" style={{ gap: 12, marginBottom: 10 }}>
            <Database size={18} style={{ color: "var(--accent)" }} />
            <div>
              <div className="strong">{user.displayName || user.email}</div>
              <div className="tiny">{user.email} · Verified Google account</div>
            </div>
          </div>
          <p className="tiny" style={{ margin: 0 }}>
            All campaigns, leads, research findings, drafts, replies, knowledge base entries, and suppression rules are
            stored strictly under your user record in Cloud Firestore.
          </p>
        </Card>

        <Card
          title="Google Workspace — Gmail & Google Sheets"
          sub="Granted automatically when you sign in with Google."
          actions={
            workspaceToken ? (
              <Badge tone="ok">Active in session</Badge>
            ) : (
              <Badge tone="warn">Reconnect needed</Badge>
            )
          }
        >
          <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
            <div className="row" style={{ gap: 10 }}>
              <FileSpreadsheet size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 13 }}>
                <strong>Google Sheets</strong> — Read prospect spreadsheets and write status updates back.
              </span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <Mail size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 13 }}>
                <strong>Gmail Send &amp; Read</strong> — Send approved outreach emails and sync prospect replies.
              </span>
            </div>
          </div>

          <div className="row">
            <button
              className={workspaceToken ? "btn btn-sm" : "btn btn-primary btn-sm"}
              onClick={() => void refreshWorkspace()}
              disabled={busy !== null}
              type="button"
            >
              {busy === "workspace"
                ? "Connecting…"
                : workspaceToken
                  ? "Refresh / switch Google account"
                  : "Grant / Reconnect Google Workspace"}
            </button>
            <span className="tiny">
              OAuth access tokens remain strictly in browser memory and are never written to storage or databases.
            </span>
          </div>
        </Card>

        <Card
          title="Google Gemini AI"
          sub="Powers prospect research, qualification scoring, outreach copywriting, reply analysis, and discovery."
          actions={<Badge tone="ok">Server-managed</Badge>}
        >
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <Sparkles size={17} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 13 }}>
              Server-side <code>@google/genai</code> integration with structured JSON schemas, Google Search grounding,
              and automatic fallback to <code>gemini-3.1-flash-lite</code> if rate limits occur.
            </span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void testGemini()}
              disabled={busy !== null}
              type="button"
            >
              {busy === "test" ? "Testing Gemini AI…" : "Test Gemini AI"}
            </button>
            <span className="tiny">
              Hitting 429 quota errors on a free-tier key? Select a billing-enabled key in{" "}
              <strong>Settings &gt; Secrets</strong> or switch to Flash Lite in Outreach Settings.
            </span>
          </div>
        </Card>

        <Card title="Security guarantees" sub="Built into the platform architecture">
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8, fontSize: 13 }}>
            <li className="row" style={{ gap: 8 }}>
              <ShieldCheck size={15} style={{ color: "var(--accent)" }} />
              <span>Every API route verifies your Firebase Auth session token before running AI or Workspace actions.</span>
            </li>
            <li className="row" style={{ gap: 8 }}>
              <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
              <span>Nothing is ever emailed from Gmail until you review and approve the message.</span>
            </li>
            <li className="row" style={{ gap: 8 }}>
              <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
              <span>Unsubscribes and bounces are added to your suppression list automatically to prevent future contact.</span>
            </li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
