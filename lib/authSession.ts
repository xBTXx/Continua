const textEncoder = new TextEncoder();

export const AUTH_COOKIE_NAME = "assistant_auth";

export type SessionPayload = {
  userId: string;
  username: string;
  iat: number;
  exp: number;
};

let cachedSecret: string | null = null;
let signingKeyPromise: Promise<CryptoKey> | null = null;

function parseSessionTtlHours(raw: string | undefined) {
  const parsed = Number(raw ?? "168");
  if (!Number.isFinite(parsed)) {
    return 168;
  }
  return Math.min(24 * 30, Math.max(1, Math.floor(parsed)));
}

export function getSessionTtlSeconds() {
  return parseSessionTtlHours(process.env.AUTH_SESSION_TTL_HOURS) * 60 * 60;
}

function getSessionSecret() {
  if (cachedSecret) {
    return cachedSecret;
  }
  const raw = process.env.AUTH_SESSION_SECRET?.trim();
  if (!raw || raw.length < 24) {
    throw new Error(
      "AUTH_SESSION_SECRET must be set and at least 24 characters long."
    );
  }
  cachedSecret = raw;
  return cachedSecret;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = `${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function getSigningKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = crypto.subtle.importKey(
      "raw",
      textEncoder.encode(getSessionSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }
  return signingKeyPromise;
}

async function signPayload(encodedPayload: string) {
  const key = await getSigningKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(encodedPayload)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function issueSessionToken(args: {
  userId: string;
  username: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    userId: args.userId,
    username: args.username,
    iat: now,
    exp: now + getSessionTtlSeconds(),
  };
  const encodedPayload = bytesToBase64Url(
    textEncoder.encode(JSON.stringify(payload))
  );
  const signature = await signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseSessionPayload(encodedPayload: string): SessionPayload | null {
  try {
    const payloadText = new TextDecoder().decode(base64UrlToBytes(encodedPayload));
    const parsed = JSON.parse(payloadText) as Partial<SessionPayload>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (!Number.isFinite(parsed.iat) || !Number.isFinite(parsed.exp)) {
      return null;
    }
    return {
      userId: parsed.userId,
      username: parsed.username,
      iat: Math.floor(parsed.iat),
      exp: Math.floor(parsed.exp),
    };
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  if (!token || typeof token !== "string") {
    return null;
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = await signPayload(encodedPayload);
  let expectedBytes: Uint8Array;
  let actualBytes: Uint8Array;
  try {
    expectedBytes = base64UrlToBytes(expectedSignature);
    actualBytes = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expectedBytes, actualBytes)) {
    return null;
  }

  const payload = parseSessionPayload(encodedPayload);
  if (!payload) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now || payload.iat > now + 60) {
    return null;
  }

  return payload;
}
