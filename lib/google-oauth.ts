import { encryptSecret, decryptSecret } from "./crypto";

/**
 * Server-side Google OAuth for the Workspace scopes (Sheets + Gmail).
 *
 * Firebase's popup gives the browser a one-hour access token and no refresh
 * token, so Gmail/Sheets fall offline on every reload. This module keeps the
 * connection alive: the refresh token is stored in an encrypted, httpOnly
 * cookie bound to the signed-in Firebase user, and exchanged for short-lived
 * access tokens on demand.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const STATE_COOKIE = "os_oauth_state";
export const TOKEN_COOKIE = "os_ws_token";
export const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface RefreshRecord {
  uid: string;
  email: string;
  refreshToken: string;
}

export function oauthClient(): OAuthClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function oauthConfigured(): boolean {
  return Boolean(oauthClient());
}

export function encryptionKey(): string | undefined {
  return process.env.TOKEN_ENCRYPTION_KEY?.trim() || undefined;
}

/** The encryption key must never silently be a per-process value, or every
 * server restart would log the user out. Fail loudly instead. */
export function requireEncryptionKey(): string {
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is missing. Add a random 32+ character value to .env.local to enable the persistent Google connection.",
    );
  }
  return key;
}

export function redirectUriFor(request: Request): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;
  return new URL("/api/google/callback", request.url).toString();
}

export function consentUrl(client: OAuthClient, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const detail = json.error_description || json.error || `Google token request failed (${res.status}).`;
    throw new Error(
      /invalid_grant/i.test(detail)
        ? "The Google connection expired or was revoked. Reconnect Gmail and Sheets."
        : detail,
    );
  }
  return json;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const client = oauthClient();
  if (!client) throw new Error("Google OAuth client is not configured on the server.");
  const json = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!json.access_token || !json.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at myaccount.google.com/permissions and connect again.",
    );
  }
  const email = await emailForToken(json.access_token);
  return { refreshToken: json.refresh_token, accessToken: json.access_token, expiresIn: json.expires_in ?? 3600, email };
}

export async function emailForToken(accessToken: string): Promise<string> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { email?: string; email_verified?: boolean };
    return json.email ?? "";
  } catch {
    return "";
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const client = oauthClient();
  if (!client) throw new Error("Google OAuth client is not configured on the server.");
  const json = await tokenRequest({
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
  });
  if (!json.access_token) throw new Error("Google did not return an access token.");
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

export async function sealRecord(record: object): Promise<string> {
  const sealed = await encryptSecret(JSON.stringify(record), requireEncryptionKey());
  if (!sealed) throw new Error("Could not encrypt the Google session.");
  return sealed;
}

export async function openRecord<T>(value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const key = encryptionKey();
  if (!key) return null;
  try {
    const plain = await decryptSecret(value, key);
    return plain ? (JSON.parse(plain) as T) : null;
  } catch {
    return null;
  }
}
