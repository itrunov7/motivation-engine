// Session token = "<expiresAtMs>.<hexHmac>", hmac = HMAC-SHA256(SESSION_SECRET, expiresAtMs).
// Uses Web Crypto so the same code runs in Edge middleware and Node server actions.

export const SESSION_COOKIE = "me_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET env var is not set");
  }
  return secret;
}

async function hmacHex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function createSessionToken(): Promise<string> {
  const expiresAt = String(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  const signature = await hmacHex(expiresAt);
  return `${expiresAt}.${signature}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;
  const expiresAt = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!/^\d+$/.test(expiresAt) || signature.length === 0) return false;
  const expected = await hmacHex(expiresAt);
  if (!constantTimeEqual(signature, expected)) return false;
  return Number(expiresAt) > Date.now();
}
