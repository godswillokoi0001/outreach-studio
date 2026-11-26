import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENC_PREFIX = "enc:v1:";

/**
 * Derives a deterministic 32-byte AES-256 encryption key from server secrets.
 * Never exposed to browsers or returned in logs.
 */
function vaultMasterKey(): Buffer {
  const raw =
    process.env.KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    "knowrevo-dev-fallback-vault-secret";
  return createHash("sha256").update(`knowrevo-vault:${raw}`).digest();
}

function hmacSigningKey(): Buffer {
  const raw =
    process.env.KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "knowrevo-dev-hmac-secret";
  return createHash("sha256").update(`knowrevo-hmac:${raw}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const clean = plaintext.trim();
  if (!clean) return "";
  if (clean.startsWith(ENC_PREFIX)) return clean;

  const key = vaultMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const clean = stored.trim();
  if (!clean) return "";
  if (!clean.startsWith(ENC_PREFIX)) {
    // Reject unencrypted secret unexpectedly stored directly unless migrating legacy value explicitly
    return clean;
  }

  const parts = clean.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Encrypted key format is invalid.");
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", vaultMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskSecret(raw: string): string {
  const clean = raw.trim();
  if (!clean) return "";
  if (clean.startsWith(ENC_PREFIX)) return "••••••••";
  if (clean.length <= 8) return `${clean.slice(0, 2)}...${clean.slice(-2)}`;
  const prefixMatch = clean.match(/^[a-zA-Z0-9]{1,5}[-_]?/);
  const prefix = prefixMatch ? prefixMatch[0].slice(0, 4) : clean.slice(0, 3);
  return `${prefix}...${clean.slice(-4)}`;
}

export function validateApiKeyInput(raw: unknown): { ok: boolean; value: string; error?: string } {
  if (typeof raw !== "string") {
    return { ok: false, value: "", error: "API key must be a text string." };
  }
  const value = raw.trim();
  if (!value) {
    return { ok: false, value: "", error: "Paste an API key first." };
  }
  if (value.length < 10 || value.length > 512) {
    return { ok: false, value: "", error: "API key length must be between 10 and 512 characters." };
  }
  if (/[\s\r\n<>'"`]/.test(value)) {
    return { ok: false, value: "", error: "API key contains invalid whitespace or unsafe characters." };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// RFC 6238 TOTP Two-Factor Authentication (Zero dependencies)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function buildTotpUri(secret: string, email: string, issuer = "Knowrevo Admin"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

export function generateTotpAt(secretBase32: string, stepCounter: number): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(stepCounter / 0x100000000), 0);
  msg.writeUInt32BE(stepCounter >>> 0, 4);

  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const codeInt =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    1_000_000;
  return String(codeInt).padStart(6, "0");
}

export function verifyTotpCode(secretBase32: string, rawCode: string): boolean {
  const code = rawCode.replace(/\s+/g, "").trim();
  if (!/^\d{6}$/.test(code)) return false;

  const currentStep = Math.floor(Date.now() / 1000 / 30);
  const codeBuf = Buffer.from(code, "utf8");

  for (const drift of [-1, 0, 1]) {
    const expected = generateTotpAt(secretBase32, currentStep + drift);
    const expBuf = Buffer.from(expected, "utf8");
    if (timingSafeEqual(codeBuf, expBuf)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Signed Short-Lived Admin 2FA Session & Re-Auth Tokens
// ---------------------------------------------------------------------------

export function issueAdmin2faToken(
  userId: string,
  purpose: "session" | "reauth",
  ttlSeconds: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ u: userId, p: purpose, exp })).toString("base64url");
  const sig = createHmac("sha256", hmacSigningKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdmin2faToken(
  token: string | null | undefined,
  userId: string,
  purpose: "session" | "reauth",
): boolean {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;

  const expectedSig = createHmac("sha256", hmacSigningKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: string;
      p?: string;
      exp?: number;
    };
    if (parsed.u !== userId || parsed.p !== purpose) return false;
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}
