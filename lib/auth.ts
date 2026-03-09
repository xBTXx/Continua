import { ensureSchema, query } from "./db";
import { issueSessionToken, verifySessionToken } from "./authSession";

const textEncoder = new TextEncoder();

const PASSWORD_HASH_SCHEME = "pbkdf2_sha256";
const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 32;
const PASSWORD_MIN_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
};

export type AuthUser = {
  id: string;
  username: string;
};

let authReadyPromise: Promise<void> | null = null;

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

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function assertValidUsername(username: string) {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      "Username must be 3-64 chars and use only letters, numbers, dot, underscore, or hyphen."
    );
  }
}

function assertValidPassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
}

function getBootstrapCredentials() {
  return {
    username: normalizeUsername(process.env.AUTH_BOOTSTRAP_USERNAME ?? ""),
    password: process.env.AUTH_BOOTSTRAP_PASSWORD ?? "",
  };
}

export function isBootstrapConfigured() {
  const creds = getBootstrapCredentials();
  return creds.username.length > 0 && creds.password.length > 0;
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number
) {
  const saltBuffer = Uint8Array.from(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBuffer,
      iterations,
    },
    keyMaterial,
    PASSWORD_KEY_BYTES * 8
  );
  return new Uint8Array(derived);
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const derivedKey = await derivePasswordKey(password, salt, PASSWORD_ITERATIONS);
  return [
    PASSWORD_HASH_SCHEME,
    String(PASSWORD_ITERATIONS),
    bytesToBase64Url(salt),
    bytesToBase64Url(derivedKey),
  ].join("$");
}

async function verifyPassword(password: string, storedHash: string) {
  const [scheme, iterationText, saltEncoded, hashEncoded] = storedHash.split("$");
  if (
    scheme !== PASSWORD_HASH_SCHEME ||
    !iterationText ||
    !saltEncoded ||
    !hashEncoded
  ) {
    return false;
  }
  const iterations = Number(iterationText);
  if (!Number.isFinite(iterations) || iterations < 10_000) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(saltEncoded);
    expected = base64UrlToBytes(hashEncoded);
  } catch {
    return false;
  }
  const actual = await derivePasswordKey(password, salt, Math.floor(iterations));
  return constantTimeEqual(actual, expected);
}

export function generateSecurePassword(length = 20) {
  const size = Math.min(64, Math.max(12, Math.floor(length)));
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_";
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function insertUser(username: string, password: string) {
  const passwordHash = await hashPassword(password);
  const userId = crypto.randomUUID();
  try {
    const result = await query<{ id: string; username: string; created_at: Date }>(
      `
        INSERT INTO users (id, username, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, username, created_at;
      `,
      [userId, username, passwordHash]
    );
    return {
      id: result.rows[0].id,
      username: result.rows[0].username,
      createdAt: result.rows[0].created_at.toISOString(),
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505") {
      throw new Error("User already exists.");
    }
    throw error;
  }
}

export async function getUserCount() {
  await ensureSchema();
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users;`
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function bootstrapFirstUserIfNeeded() {
  const userCount = await getUserCount();
  if (userCount > 0) {
    return;
  }

  const { username, password } = getBootstrapCredentials();
  if (!username || !password) {
    throw new Error(
      "No users exist. Set AUTH_BOOTSTRAP_USERNAME and AUTH_BOOTSTRAP_PASSWORD in .env."
    );
  }

  assertValidUsername(username);
  assertValidPassword(password);
  await insertUser(username, password);
}

export async function ensureAuthReady() {
  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      await ensureSchema();
      await bootstrapFirstUserIfNeeded();
    })();
  }
  return authReadyPromise;
}

export async function authenticateWithPassword(
  usernameRaw: string,
  password: string
): Promise<AuthUser | null> {
  await ensureAuthReady();

  const username = normalizeUsername(usernameRaw);
  if (!username || !password) {
    return null;
  }

  const result = await query<UserRow>(
    `
      SELECT id, username, password_hash
      FROM users
      WHERE username = $1
      LIMIT 1;
    `,
    [username]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
  };
}

export async function createSessionForUser(user: AuthUser) {
  return issueSessionToken({ userId: user.id, username: user.username });
}

export async function resolveUserFromSessionToken(token: string) {
  await ensureAuthReady();
  const payload = await verifySessionToken(token);
  if (!payload) {
    return null;
  }
  const result = await query<{ id: string; username: string }>(
    `
      SELECT id, username
      FROM users
      WHERE id = $1 AND username = $2
      LIMIT 1;
    `,
    [payload.userId, payload.username]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
  };
}

export async function createManagedUser(input: {
  username: string;
  password?: string;
}) {
  await ensureAuthReady();

  const username = normalizeUsername(input.username);
  assertValidUsername(username);

  const chosenPassword =
    typeof input.password === "string" && input.password.trim().length > 0
      ? input.password.trim()
      : generateSecurePassword();

  assertValidPassword(chosenPassword);

  const createdUser = await insertUser(username, chosenPassword);
  return {
    action: "create",
    username: createdUser.username,
    password: chosenPassword,
    generatedPassword:
      !(typeof input.password === "string" && input.password.trim().length > 0),
    createdAt: createdUser.createdAt,
  };
}

export async function setManagedUserPassword(input: {
  username: string;
  password?: string;
}) {
  await ensureAuthReady();

  const username = normalizeUsername(input.username);
  assertValidUsername(username);

  const nextPassword =
    typeof input.password === "string" && input.password.trim().length > 0
      ? input.password.trim()
      : generateSecurePassword();
  assertValidPassword(nextPassword);

  const nextHash = await hashPassword(nextPassword);
  const result = await query<{ id: string; username: string }>(
    `
      UPDATE users
      SET password_hash = $2, updated_at = NOW()
      WHERE username = $1
      RETURNING id, username;
    `,
    [username, nextHash]
  );

  if (result.rowCount === 0) {
    throw new Error("User not found.");
  }

  return {
    action: "set_password",
    username: result.rows[0].username,
    password: nextPassword,
    generatedPassword:
      !(typeof input.password === "string" && input.password.trim().length > 0),
    updatedAt: new Date().toISOString(),
  };
}

export async function deleteManagedUser(input: { username: string }) {
  await ensureAuthReady();

  const username = normalizeUsername(input.username);
  assertValidUsername(username);

  const result = await query<{ id: string }>(
    `
      DELETE FROM users
      WHERE username = $1
      RETURNING id;
    `,
    [username]
  );

  if (result.rowCount === 0) {
    throw new Error("User not found.");
  }

  const remainingUsers = await getUserCount();

  return {
    action: "delete",
    username,
    deleted: true,
    remainingUsers,
  };
}
