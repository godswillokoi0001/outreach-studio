import { getEnv, ConfigError } from "./env";
import { first, run, now } from "./db";
import { decryptSecret, encryptSecret, b64url } from "./crypto";
import { googleClient, tokenEncryptionKey, platformRedirectOverride } from "./config";

export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface AccountRow {
  owner_sub: string;
  email: string | null;
  name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: number | null;
  scopes: string | null;
  connected_at: string | null;
}

export async function googleConfigured(): Promise<{ ok: boolean; missing: string[] }> {
  const client = await googleClient();
  return client ? { ok: true, missing: [] } : { ok: false, missing: ["Google OAuth client (platform)"] };
}

async function clientCredentials() {
  const client = await googleClient();
  if (!client) {
    throw new ConfigError(
      "Google is not configured on this deployment yet. The platform owner needs to add an OAuth client once in Integrations.",
    );
  }
  return { ...client, encKey: await tokenEncryptionKey() };
}

export async function redirectUri(request: Request): Promise<string> {
  const override = await platformRedirectOverride();
  if (override) return override;
  const env = await getEnv();
  if (env.APP_ORIGIN) return `${env.APP_ORIGIN.replace(/\/$/, "")}/api/auth/google/callback`;
  return `${new URL(request.url).origin}/api/auth/google/callback`;
}

export async function buildAuthUrl(ownerSub: string, uri: string, state: string): Promise<string> {
  const { clientId } = await clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: uri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(
  ownerSub: string,
  code: string,
  uri: string,
): Promise<{ email: string; name: string }> {
  const { clientId, clientSecret, encKey } = await clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: uri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new ConfigError(`Google rejected the authorization code: ${String(data.error_description ?? data.error)}`);
  }
  const accessTokenValue = String(data.access_token ?? "");
  const refreshToken = data.refresh_token ? String(data.refresh_token) : "";
  const expiresIn = Number(data.expires_in ?? 3600);
  if (!accessTokenValue) throw new ConfigError("Google did not return an access token.");
  if (!refreshToken) {
    throw new ConfigError(
      "Google did not return a refresh token. Remove the app from your Google account permissions and connect again.",
    );
  }

  const profile = await fetchUserInfo(accessTokenValue);
  await run(
    `INSERT INTO google_account (owner_sub, email, name, access_token, refresh_token, token_expiry, scopes, connected_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(owner_sub) DO UPDATE SET email=excluded.email, name=excluded.name, access_token=excluded.access_token,
       refresh_token=excluded.refresh_token, token_expiry=excluded.token_expiry, scopes=excluded.scopes,
       connected_at=excluded.connected_at`,
    ownerSub,
    profile.email,
    profile.name,
    await encryptSecret(accessTokenValue, encKey),
    await encryptSecret(refreshToken, encKey),
    Date.now() + expiresIn * 1000,
    String(data.scope ?? GOOGLE_SCOPES.join(" ")),
    now(),
  );
  return profile;
}

async function fetchUserInfo(accessTokenValue: string): Promise<{ email: string; name: string }> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessTokenValue}` },
  });
  if (!res.ok) return { email: "", name: "" };
  const data = (await res.json()) as { email?: string; name?: string };
  return { email: data.email ?? "", name: data.name ?? "" };
}

export async function getAccount(ownerSub: string): Promise<AccountRow | null> {
  return first<AccountRow>(`SELECT * FROM google_account WHERE owner_sub = ?`, ownerSub);
}

export async function disconnectGoogle(ownerSub: string): Promise<void> {
  const account = await getAccount(ownerSub);
  if (account?.refresh_token) {
    const refresh = await decryptSecret(account.refresh_token, await tokenEncryptionKey());
    if (refresh) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).catch(() => undefined);
    }
  }
  await run(`DELETE FROM google_account WHERE owner_sub = ?`, ownerSub);
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function accessToken(ownerSub: string): Promise<string> {
  const { clientId, clientSecret, encKey } = await clientCredentials();
  const account = await getAccount(ownerSub);
  if (!account) throw new ConfigError("Google account is not connected. Open Integrations and connect it.");

  const cached = tokenCache.get(ownerSub);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const stored = await decryptSecret(account.access_token, encKey);
  if (stored && (account.token_expiry ?? 0) > Date.now() + 60_000) {
    tokenCache.set(ownerSub, { token: stored, expiresAt: account.token_expiry ?? 0 });
    return stored;
  }

  const refresh = await decryptSecret(account.refresh_token, encKey);
  if (!refresh) {
    throw new ConfigError("Stored Google authorisation cannot be decrypted. Reconnect Google in Integrations.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    await run(`UPDATE google_account SET token_expiry = 0 WHERE owner_sub = ?`, ownerSub);
    tokenCache.delete(ownerSub);
    throw new ConfigError(
      `Google authorisation could not be refreshed (${String(data.error ?? res.status)}). Reconnect Google in Integrations.`,
    );
  }
  const token = String(data.access_token ?? "");
  const expiresIn = Number(data.expires_in ?? 3600);
  await run(
    `UPDATE google_account SET access_token = ?, token_expiry = ? WHERE owner_sub = ?`,
    await encryptSecret(token, encKey),
    Date.now() + expiresIn * 1000,
    ownerSub,
  );
  tokenCache.set(ownerSub, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function googleFetch(ownerSub: string, url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await accessToken(ownerSub);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && retry) {
    tokenCache.delete(ownerSub);
    return googleFetch(ownerSub, url, init, false);
  }
  return res;
}

async function googleJson<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      // ignore
    }
    throw new ConfigError(`${context} failed (${res.status}). ${detail}`.trim());
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function parseSheetUrl(input: string): { spreadsheetId: string; gid: string | null } {
  const value = input.trim();
  if (!value) throw new ConfigError("Paste a Google Sheets URL.");
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match && /^[a-zA-Z0-9-_]{30,}$/.test(value)) {
    return { spreadsheetId: value, gid: null };
  }
  if (!match) throw new ConfigError("That does not look like a Google Sheets URL.");
  const gidMatch = value.match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: match[1], gid: gidMatch ? gidMatch[1] : null };
}

export interface SheetTab {
  title: string;
  sheetId: number;
  rowCount: number;
  columnCount: number;
}

export async function getSpreadsheet(ownerSub: string, spreadsheetId: string): Promise<{ title: string; tabs: SheetTab[] }> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `?fields=properties.title,sheets.properties`;
  const res = await googleFetch(ownerSub, url);
  const data = await googleJson<{
    properties?: { title?: string };
    sheets?: {
      properties: { title: string; sheetId: number; gridProperties?: { rowCount?: number; columnCount?: number } };
    }[];
  }>(res, "Reading spreadsheet");
  return {
    title: data.properties?.title ?? "Untitled spreadsheet",
    tabs: (data.sheets ?? []).map((s) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      rowCount: s.properties.gridProperties?.rowCount ?? 0,
      columnCount: s.properties.gridProperties?.columnCount ?? 0,
    })),
  };
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export async function getSheetValues(
  ownerSub: string,
  spreadsheetId: string,
  tab: string,
  a1 = "A1:Z2000",
): Promise<string[][]> {
  const range = `${quoteTab(tab)}!${a1}`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/` +
    `${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await googleFetch(ownerSub, url);
  const data = await googleJson<{ values?: unknown[][] }>(res, "Reading worksheet");
  return (data.values ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
}

export async function appendSheetValues(
  ownerSub: string,
  spreadsheetId: string,
  tab: string,
  values: (string | number)[][],
): Promise<void> {
  const range = `${quoteTab(tab)}!A1`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/` +
    `${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await googleFetch(ownerSub, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  await googleJson(res, "Writing to worksheet");
}

export async function updateSheetValues(
  ownerSub: string,
  spreadsheetId: string,
  tab: string,
  a1: string,
  values: (string | number)[][],
): Promise<void> {
  const range = `${quoteTab(tab)}!${a1}`;
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await googleFetch(ownerSub, url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  await googleJson(res, "Updating worksheet");
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export interface SendResult {
  id: string;
  threadId: string;
}

export async function sendGmailMessage(ownerSub: string, raw: string): Promise<SendResult> {
  const res = await googleFetch(ownerSub, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  return googleJson<SendResult>(res, "Sending email");
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessage["payload"][];
  };
}

export async function listGmailMessages(
  ownerSub: string,
  query: string,
  maxResults = 25,
): Promise<{ id: string; threadId: string }[]> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}` +
    `&maxResults=${maxResults}`;
  const res = await googleFetch(ownerSub, url);
  const data = await googleJson<{ messages?: { id: string; threadId: string }[] }>(res, "Listing Gmail messages");
  return data.messages ?? [];
}

export async function getGmailMessage(
  ownerSub: string,
  id: string,
  format: "full" | "metadata" = "full",
): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=${format}`;
  const res = await googleFetch(ownerSub, url);
  return googleJson<GmailMessage>(res, "Reading Gmail message");
}

export function header(msg: GmailMessage, name: string): string {
  const found = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

export function messageText(msg: GmailMessage, maxChars = 8000): string {
  const decode = (data?: string) => {
    if (!data) return "";
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const binary = atob(normalized);
      const bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  };
  const walk = (payload?: GmailMessage["payload"]): { plain: string; html: string } => {
    if (!payload) return { plain: "", html: "" };
    let plain = "";
    let html = "";
    if (payload.mimeType === "text/plain") plain += decode(payload.body?.data);
    if (payload.mimeType === "text/html") html += decode(payload.body?.data);
    for (const part of payload.parts ?? []) {
      const nested = walk(part);
      plain += nested.plain;
      html += nested.html;
    }
    return { plain, html };
  };
  const { plain, html } = walk(msg.payload);
  const text = plain || html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return text.trim().slice(0, maxChars);
}

export function base64UrlFromString(value: string): string {
  return b64url(new TextEncoder().encode(value));
}
