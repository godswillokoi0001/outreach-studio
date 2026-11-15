"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, errorMessage, useApi } from "@/lib/client";
import { Badge, Banner, Card, Field, Progress } from "@/components/ui";

interface ConfigStatus {
  gemini: {
    configured: boolean;
    source: "account" | "platform" | "env" | null;
    model: string;
    account_key_hint: string | null;
    account_model: string | null;
    account_override: boolean;
  };
  google: {
    credentials_ready: boolean;
    credential_source: string | null;
    client_hint: string | null;
    is_platform_owner: boolean;
  };
  encryption: { dedicated_key: boolean };
}

interface IntegrationStatus {
  google: {
    configured: boolean;
    missing: string[];
    connected: boolean;
    email: string | null;
    connected_at: string | null;
    redirect_uri: string;
    credential_source: string | null;
  };
  gemini: { configured: boolean; model: string; source: string | null };
  is_platform_owner: boolean;
}

export default function IntegrationsPage() {
  const params = useSearchParams();
  const config = useApi<ConfigStatus>("/api/config");
  const integrations = useApi<IntegrationStatus>("/api/integrations", [params.get("connected")]);

  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [clientBlob, setClientBlob] = useState("");
  const [redirect, setRedirect] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: string; text: string } | null>(null);

  const status = config.data;
  const google = integrations.data?.google;

  useEffect(() => {
    if (status) setModel(status.gemini.account_model ?? status.gemini.model);
  }, [status]);

  useEffect(() => {
    if (google?.redirect_uri) setRedirect(google.redirect_uri);
  }, [google?.redirect_uri]);

  useEffect(() => {
    const error = params.get("error");
    if (error) setNote({ tone: "bad", text: error });
    else if (params.get("connected")) setNote({ tone: "good", text: "Google connected. Sheets and Gmail are now available." });
  }, [params]);

  const refresh = async () => {
    await Promise.all([config.reload(), integrations.reload()]);
  };

  const saveKey = async (clear = false) => {
    setBusy("gemini");
    setNote(null);
    try {
      if (clear) await api.del("/api/config?key=gemini_api_key");
      else await api.put("/api/config", { gemini_api_key: key, gemini_model: model });
      setKey("");
      await refresh();
      setNote({ tone: "good", text: clear ? "API key removed." : "Saved. Your key is stored encrypted on the server." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const testGemini = async () => {
    setBusy("test");
    setNote(null);
    try {
      const result = await api.post<{ model: string; ms: number }>("/api/config");
      setNote({ tone: "good", text: `Working: ${result.model} replied in ${result.ms} ms.` });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const saveGoogleClient = async (clear = false) => {
    setBusy("google");
    setNote(null);
    try {
      if (clear) await api.put("/api/config", { google_client: "" });
      else await api.put("/api/config", { google_client: clientBlob, google_redirect_uri: redirect });
      setClientBlob("");
      await refresh();
      setNote({ tone: "good", text: clear ? "Shared Google client removed." : "Saved. Everyone can now connect Google in one click." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await api.del("/api/integrations");
      await refresh();
      setNote({ tone: "good", text: "Google disconnected. Stored tokens were deleted." });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const loading = (config.loading && !status) || (integrations.loading && !integrations.data);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">Two connections power everything: Google (Sheets + Gmail) and Gemini (the AI).</p>
        </div>
      </div>

      {note && <Banner tone={note.tone}>{note.text}</Banner>}
      {config.error && <Banner tone="bad">{config.error}</Banner>}
      {integrations.error && <Banner tone="bad">{integrations.error}</Banner>}
      {loading && <Progress label="Checking connections…" />}

      {google && (
        <div className="stack">
          <Card
            title="Google — Sheets and Gmail"
            sub="One click connects both. Sheets for prospect import and status write-back, Gmail for sending and reading replies."
            actions={
              google.connected ? (
                <Badge tone="good">Connected</Badge>
              ) : google.configured ? (
                <Badge tone="warn">Not connected</Badge>
              ) : (
                <Badge tone="bad">Setup needed</Badge>
              )
            }
          >
            {google.connected ? (
              <div className="stack">
                <div className="row" style={{ gap: 10 }}>
                  <span className="strong">{google.email}</span>
                  <div className="row-end">
                    <button className="btn btn-sm btn-ghost" onClick={disconnect} disabled={busy === "disconnect"} type="button">
                      Disconnect
                    </button>
                  </div>
                </div>
                <p className="tiny">
                  Connected {google.connected_at ? new Date(google.connected_at).toLocaleString() : ""}. Sheets you can
                  read are available in the Sheets page; approved emails send from this address.
                </p>
                <div className="row">
                  <a className="btn btn-sm" href="/api/auth/google">
                    Reconnect / use another account
                  </a>
                </div>
              </div>
            ) : google.configured ? (
              <div className="stack">
                <p className="small">
                  Press connect, choose the Google account that owns your sheet and mailbox, and approve the two
                  permissions. Nothing else to configure.
                </p>
                <div className="row">
                  <a className="btn btn-primary" href="/api/auth/google">
                    Connect Google
                  </a>
                </div>
                <p className="tiny">
                  Redirect URI this app uses: <code>{google.redirect_uri}</code>
                </p>
              </div>
            ) : (
              <div className="stack">
                <p className="small">
                  The shared Google OAuth client has not been added yet, so nobody can connect. Add it once here and
                  every account gets the one-click button.
                </p>
                {status?.google.is_platform_owner ? (
                  <div className="stack">
                    <Field
                      label="Google OAuth client"
                      hint="Google Cloud → APIs & Services → Credentials → Create OAuth client ID → Web application → download JSON, then paste it here."
                    >
                      <textarea
                        className="input"
                        style={{ minHeight: 110, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
                        value={clientBlob}
                        onChange={(e) => setClientBlob(e.target.value)}
                        placeholder={'{"web":{"client_id":"….apps.googleusercontent.com","client_secret":"…"}}'}
                      />
                    </Field>
                    <Field label="Redirect URI" hint="Add this exact URI to the OAuth client in Google Cloud.">
                      <input className="input" value={redirect} onChange={(e) => setRedirect(e.target.value)} />
                    </Field>
                    <div className="row">
                      <div className="row-end">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => saveGoogleClient(false)}
                          disabled={busy === "google" || !clientBlob.trim()}
                          type="button"
                        >
                          {busy === "google" ? "Saving…" : "Save Google client"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Banner tone="warn">
                    Ask the workspace owner to add the shared Google OAuth client in Integrations. After that this page
                    shows a single Connect Google button.
                  </Banner>
                )}
              </div>
            )}
            {google.credential_source === "env" && (
              <p className="tiny" style={{ marginTop: 10 }}>
                Credentials are coming from server environment variables.
              </p>
            )}
          </Card>

          <Card
            title="Gemini — the AI"
            sub="Used for research, qualification, email writing, reply classification and analytics."
            actions={status?.gemini.configured ? <Badge tone="good">Ready</Badge> : <Badge tone="bad">Key needed</Badge>}
          >
            <div className="stack">
              {status?.gemini.configured && (
                <p className="small">
                  Active model: <strong>{status.gemini.model}</strong>
                  {status.gemini.source === "account" && status.gemini.account_key_hint
                    ? ` · your key ${status.gemini.account_key_hint}`
                    : status.gemini.source === "env"
                      ? " · key from server environment"
                      : " · using the workspace key"}
                </p>
              )}
              <Field label="Google AI Studio API key" hint="Create one at aistudio.google.com → Get API key. Stored encrypted; never sent to the browser again.">
                <input
                  className="input"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={status?.gemini.account_override ? "•••• saved — paste a new key to replace" : "AIza…"}
                  autoComplete="off"
                />
              </Field>
              <Field label="Model" hint="Leave as gemini-3.5-flash unless you need a different one.">
                <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-3.5-flash" />
              </Field>
              <div className="row">
                <div className="row-end">
                  {status?.gemini.account_override && (
                    <button className="btn btn-sm btn-ghost" onClick={() => saveKey(true)} disabled={busy === "gemini"} type="button">
                      Remove my key
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={testGemini} disabled={busy === "test" || !status?.gemini.configured} type="button">
                    {busy === "test" ? "Testing…" : "Test connection"}
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => saveKey(false)}
                    disabled={busy === "gemini" || (!key.trim() && !model.trim())}
                    type="button"
                  >
                    {busy === "gemini" ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          </Card>

          <Card title="What this app never does" sub="Security notes">
            <ul className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.7 }}>
              <li>API keys and Google tokens are encrypted at rest and never returned to the browser.</li>
              <li>Every account only sees its own leads, emails, replies and settings.</li>
              <li>Nothing is sent from your Gmail until you approve the specific email.</li>
              <li>Unsubscribes and bounces are recorded automatically and stop all future contact.</li>
            </ul>
          </Card>
        </div>
      )}
    </main>
  );
}
