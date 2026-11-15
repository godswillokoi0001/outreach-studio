const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Normalises a byte array into a BufferSource for WebCrypto. */
function bytesSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

export function b64url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-GCM encrypt. Returns `v1.<iv>.<ciphertext>` or null when no key is set. */
export async function encryptSecret(plain: string, secret: string | undefined): Promise<string | null> {
  if (!secret) return null;
  const key = await keyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytesSource(iv) }, key, enc.encode(plain));
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(payload: string | null, secret: string | undefined): Promise<string | null> {
  if (!payload || !secret) return null;
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const key = await keyFrom(secret);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesSource(fromB64(parts[1])) },
      key,
      bytesSource(fromB64(parts[2])),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

export function randomId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
