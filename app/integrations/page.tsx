"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Database,
  FileSpreadsheet,
  KeyRound,
  Mail,
  Plug,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { useToast } from "@/components/Feedback";
import { Badge, Banner, Card } from "@/components/ui";
import { getAccessToken } from "@/lib/auth";
import { getProviderMeta, type UserAiKeyPublic, type UserAiSettings } from "@/lib/llm/types";
import { authedPost, errorMessage } from "@/lib/client";
import { workspaceStatus, type WorkspaceStatus } from "@/lib/workspace";

export default function IntegrationsPage() {
  const params = useSearchParams();
  const { user, workspaceToken, reconnectWorkspace, disconnectWorkspace } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [aiGatewayState, setAiGatewayState] = useState<{ settings: UserAiSettings; keys: UserAiKeyPublic[] } | null>(null);

  // Read the OAuth result from the URL on render instead of mirroring it into
  // state from an effect.
  const redirectNote = useMemo<{ tone: "ok" | "bad"; text: string } | null>(() => {
    if (params.get("google") === "connected") {
      return { tone: "ok", text: "Google connected. Sheets and Gmail are now available and will stay connected." };
    }
    if (params.get("google") === "error") {
      return { tone: "bad", text: params.get("reason") || "Google connection failed." };
    }
    return null;
  }, [params]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (token) {
          const res = await fetch("/api/account/ai-provider", {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            cache: "no-store",
          });
          if (res.ok && active) {
            const text = await res.text();
            try {
              const payload = (text ? JSON.parse(text) : null) as {
                settings: UserAiSettings;
                keys: UserAiKeyPublic[];
              } | null;
              if (payload) setAiGatewayState(payload);
            } catch {
              /* ignore non-JSON fallback */
            }
          }
        }
      } catch {
        if (active) setAiGatewayState(null);
      }
    })();
    workspaceStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      () => {
        if (active) setStatus({ configured: false, connected: false, email: null });
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid, workspaceToken]);

  const loadStatus = async () => {
    setStatus(await workspaceStatus());
  };

  const testGemini = async () => {
    setBusy("test");
    setNote(null);
    try {
      const result = await authedPost<{
        model: string;
        ms: number;
        reply: string;
        provider?: string;
        providerLabel?: string;
      }>("/api/ai/test", {});
      const label = result.providerLabel || getProviderMeta(result.provider ?? "google").label;
      setNote({
        tone: "ok",
        text: `${label} is live: ${result.model} replied "${result.reply}" in ${result.ms} ms.`,
      });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const connectGoogle = async () => {
    setBusy("workspace");
    setNote(null);
    try {
      const ok = await reconnectWorkspace();
      if (ok) {
        await loadStatus();
        setNote({ tone: "ok", text: "Google access verified. Gmail and Google Sheets are ready." });
      }
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setNote(null);
    try {
      await disconnectWorkspace();
      await loadStatus();
      setNote({ tone: "ok", text: "Google disconnected. Stored access has been removed from this browser." });
      toast.success("Google disconnected", "Gmail and Sheets access was removed. Connect again any time.");
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const persistent = Boolean(status?.configured && status.connected);
  const connected = Boolean(workspaceToken);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">
            Three connections run this app: Supabase (your private data), Google Workspace (Sheets and Gmail) and
            the AI provider you connect (Gemini, OpenAI, Claude or any compatible API).
          </p>
        </div>
      </div>

      <div className="stack">
        {(note || redirectNote) && (
          <Banner tone={(note ?? redirectNote)!.tone}>{(note ?? redirectNote)!.text}</Banner>
        )}

        <Card
          title="Supabase — accounts and workspace data"
          sub="Every campaign, lead, research finding, draft, reply and knowledge note is stored in your workspace."
          actions={<Badge tone="ok">Connected</Badge>}
        >
          <div className="row" style={{ gap: 12, marginBottom: 10 }}>
            <Database size={18} style={{ color: "var(--accent)" }} />
            <div>
              <div className="strong">{user.displayName || user.email}</div>
              <div className="tiny">{user.email} · verified Google account</div>
            </div>
          </div>
          <p className="tiny" style={{ margin: 0 }}>
            Access is enforced on the server: every request is authenticated, and a signed-in user can only read
            and write their own rows.
          </p>
        </Card>

        <Card
          title="Google Workspace — Gmail and Sheets"
          sub="Send approved outreach from your own inbox, read replies, import spreadsheets and write statuses back."
          actions={
            connected ? (
              <Badge tone="ok">{persistent ? "Connected · persistent" : "Connected · session"}</Badge>
            ) : (
              <Badge tone="warn">Not connected</Badge>
            )
          }
        >
          <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
            <div className="row" style={{ gap: 10 }}>
              <FileSpreadsheet size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 13 }}>
                <strong>Google Sheets</strong> — read prospect spreadsheets and write campaign statuses back.
              </span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <Mail size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 13 }}>
                <strong>Gmail</strong> — send approved emails and sync prospect replies and bounces.
              </span>
            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <button
              className={connected ? "btn btn-sm" : "btn btn-primary btn-sm"}
              onClick={() => void connectGoogle()}
              disabled={busy !== null}
              type="button"
            >
              <Plug size={13} />
              <span>
                {busy === "workspace"
                  ? "Opening Google…"
                  : connected
                    ? "Reconnect or switch account"
                    : "Connect Google"}
              </span>
            </button>
            {connected && (
              <button className="btn btn-sm btn-ghost" onClick={() => void disconnect()} disabled={busy !== null} type="button">
                <Unplug size={13} />
                <span>{busy === "disconnect" ? "Removing…" : "Disconnect"}</span>
              </button>
            )}
            <span className="tiny">
              {persistent
                ? "Your refresh token is stored encrypted, so Gmail and Sheets stay connected across reloads."
                : "Temporary access: you will be asked again after a reload."}
            </span>
          </div>

          {!status?.configured && (
            <div style={{ marginTop: 14 }}>
              <Banner tone="info">
                <strong>Make the connection permanent (one-time setup).</strong>
                <ol className="setup-steps">
                  <li>
                    Google Cloud Console → <strong>APIs &amp; Services</strong> → <strong>Credentials</strong> → create
                    an <strong>OAuth client ID</strong> of type <strong>Web application</strong>.
                  </li>
                  <li>
                    Add authorised redirect URI{" "}
                    <code>{typeof window !== "undefined" ? `${window.location.origin}/api/google/callback` : "/api/google/callback"}</code>
                  </li>
                  <li>
                    Put the client id and secret in <code>.env.local</code> as <code>GOOGLE_CLIENT_ID</code> and{" "}
                    <code>GOOGLE_CLIENT_SECRET</code>, then restart the dev server.
                  </li>
                  <li>Come back here and press Connect Google once. It will stay connected.</li>
                </ol>
              </Banner>
            </div>
          )}
        </Card>

        <Card
          title="AI engine — unified multi-provider gateway"
          sub="Research, qualification scoring, email writing, reply classification, operator chat, and growth analysis."
          actions={
            aiGatewayState?.settings.mode === "byok" && aiGatewayState.settings.activeProvider ? (
              <Badge tone="ok">
                BYOK · {getProviderMeta(aiGatewayState.settings.activeProvider).label}
              </Badge>
            ) : (
              <Badge tone="info">Managed Free Engine (Auto)</Badge>
            )
          }
        >
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 13 }}>
              {aiGatewayState?.settings.mode === "byok" && aiGatewayState.settings.activeProvider
                ? `Strict BYOK active: every AI call uses ${getProviderMeta(aiGatewayState.settings.activeProvider).label} · ${aiGatewayState.settings.activeModel || "default model"}.`
                : "Managed Free Engine (Auto) is active with automatic multi-key headroom steering and silent failover across admin-configured providers."}
            </span>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm" onClick={() => void testGemini()} disabled={busy !== null} type="button">
              <KeyRound size={13} />
              <span>{busy === "test" ? "Testing AI…" : "Test connection"}</span>
            </button>
            <Link className="btn btn-sm" href="/settings#ai-engine">
              Manage keys &amp; models
            </Link>
            <span className="tiny">
              Keys are stored in your private Firebase record and sent only to the provider you pick.
            </span>
          </div>
        </Card>

        <Card title="Security guarantees" sub="How the pieces protect you">
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8, fontSize: 13 }}>
            <li className="row" style={{ gap: 8 }}>
              <ShieldCheck size={15} style={{ color: "var(--accent)" }} />
              <span>Every API route verifies your Firebase session token before running AI or Workspace actions.</span>
            </li>
            <li className="row" style={{ gap: 8 }}>
              <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
              <span>Nothing is emailed until you approve that specific message.</span>
            </li>
            <li className="row" style={{ gap: 8 }}>
              <CheckCircle2 size={15} style={{ color: "var(--accent)" }} />
              <span>Opt-outs and bounces are suppressed automatically and stop all future contact.</span>
            </li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
