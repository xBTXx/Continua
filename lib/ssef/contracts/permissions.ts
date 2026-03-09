import path from "node:path";

export const SKILL_PERMISSION_KINDS = [
  "filesystem",
  "network",
  "process",
  "tool",
] as const;

export type SkillPermissionKind = (typeof SKILL_PERMISSION_KINDS)[number];

export const FILESYSTEM_PERMISSION_SCOPES = [
  "read",
  "write",
  "read_write",
] as const;
export type FilesystemPermissionScope =
  (typeof FILESYSTEM_PERMISSION_SCOPES)[number];

export const NETWORK_PERMISSION_SCOPES = ["allowlist"] as const;
export type NetworkPermissionScope = (typeof NETWORK_PERMISSION_SCOPES)[number];

export const PROCESS_PERMISSION_SCOPES = ["spawn"] as const;
export type ProcessPermissionScope = (typeof PROCESS_PERMISSION_SCOPES)[number];

export const TOOL_PERMISSION_SCOPES = ["invoke"] as const;
export type ToolPermissionScope = (typeof TOOL_PERMISSION_SCOPES)[number];

export type SkillFilesystemPermission = {
  kind: "filesystem";
  scope: FilesystemPermissionScope;
  paths: string[];
};

export type SkillNetworkPermission = {
  kind: "network";
  scope: NetworkPermissionScope;
  hosts: string[];
};

export type SkillProcessPermission = {
  kind: "process";
  scope: ProcessPermissionScope;
  commands: string[];
  max_runtime_ms?: number;
  max_memory_mb?: number;
  max_cpu_seconds?: number;
};

export type SkillToolPermission = {
  kind: "tool";
  scope: ToolPermissionScope;
  tools: string[];
};

export type SkillPermission =
  | SkillFilesystemPermission
  | SkillNetworkPermission
  | SkillProcessPermission
  | SkillToolPermission;

const MAX_PERMISSION_LIST_SIZE = 64;
const MAX_PERMISSION_ITEM_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string, maxLength = 128) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be <= ${maxLength} characters.`);
  }
  return normalized;
}

function asInteger(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizePermissionPath(value: string, label: string) {
  if (value === "/") {
    return "/";
  }
  const normalizedSeparators = value.replace(/\\/g, "/");
  const withoutLeadingSlash = normalizedSeparators.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${label} contains an invalid workspace-relative path.`);
  }
  return `/${normalized}`;
}

function normalizeHost(value: string, label: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty.`);
  }

  let host = trimmed;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`${label} must be a valid host or URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label} URL protocol must be http or https.`);
    }
    host = parsed.host.toLowerCase();
  }

  if (!/^(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) {
    throw new Error(`${label} must be a valid host (optionally with port).`);
  }
  return host;
}

function normalizeToolName(value: string, label: string) {
  const tool = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{1,127}$/.test(tool)) {
    throw new Error(`${label} must be a valid tool identifier.`);
  }
  return tool;
}

function normalizeCommand(value: string, label: string) {
  const command = value.trim();
  if (!command) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (command.length > MAX_PERMISSION_ITEM_LENGTH) {
    throw new Error(
      `${label} must be <= ${MAX_PERMISSION_ITEM_LENGTH} characters.`
    );
  }
  if (/[\r\n\t]/.test(command)) {
    throw new Error(`${label} cannot include control characters.`);
  }
  return command;
}

function normalizeUniqueStringList(
  value: unknown,
  label: string,
  normalizer: (entry: string, itemLabel: string) => string
) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  if (value.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (value.length > MAX_PERMISSION_LIST_SIZE) {
    throw new Error(`${label} exceeds max size ${MAX_PERMISSION_LIST_SIZE}.`);
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  value.forEach((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const text = asString(entry, itemLabel, MAX_PERMISSION_ITEM_LENGTH);
    const next = normalizer(text, itemLabel);
    if (!seen.has(next)) {
      seen.add(next);
      normalized.push(next);
    }
  });
  return normalized;
}

function parseFilesystemPermission(
  value: Record<string, unknown>,
  label: string
): SkillFilesystemPermission {
  const scope = asString(value.scope, `${label}.scope`);
  if (!FILESYSTEM_PERMISSION_SCOPES.includes(scope as FilesystemPermissionScope)) {
    throw new Error(
      `${label}.scope must be one of: ${FILESYSTEM_PERMISSION_SCOPES.join(", ")}.`
    );
  }
  const paths = normalizeUniqueStringList(
    value.paths,
    `${label}.paths`,
    normalizePermissionPath
  );
  return {
    kind: "filesystem",
    scope: scope as FilesystemPermissionScope,
    paths,
  };
}

function parseNetworkPermission(
  value: Record<string, unknown>,
  label: string
): SkillNetworkPermission {
  const scope = asString(value.scope, `${label}.scope`);
  if (!NETWORK_PERMISSION_SCOPES.includes(scope as NetworkPermissionScope)) {
    throw new Error(
      `${label}.scope must be one of: ${NETWORK_PERMISSION_SCOPES.join(", ")}.`
    );
  }
  const hosts = normalizeUniqueStringList(
    value.hosts,
    `${label}.hosts`,
    normalizeHost
  );
  return {
    kind: "network",
    scope: scope as NetworkPermissionScope,
    hosts,
  };
}

function parseProcessPermission(
  value: Record<string, unknown>,
  label: string
): SkillProcessPermission {
  const scope = asString(value.scope, `${label}.scope`);
  if (!PROCESS_PERMISSION_SCOPES.includes(scope as ProcessPermissionScope)) {
    throw new Error(
      `${label}.scope must be one of: ${PROCESS_PERMISSION_SCOPES.join(", ")}.`
    );
  }
  const commands = normalizeUniqueStringList(
    value.commands,
    `${label}.commands`,
    normalizeCommand
  );
  const parsed: SkillProcessPermission = {
    kind: "process",
    scope: scope as ProcessPermissionScope,
    commands,
  };
  if (value.max_runtime_ms !== undefined) {
    parsed.max_runtime_ms = asInteger(
      value.max_runtime_ms,
      `${label}.max_runtime_ms`,
      100,
      600_000
    );
  }
  if (value.max_memory_mb !== undefined) {
    parsed.max_memory_mb = asInteger(
      value.max_memory_mb,
      `${label}.max_memory_mb`,
      16,
      16_384
    );
  }
  if (value.max_cpu_seconds !== undefined) {
    parsed.max_cpu_seconds = asInteger(
      value.max_cpu_seconds,
      `${label}.max_cpu_seconds`,
      1,
      86_400
    );
  }
  return parsed;
}

function parseToolPermission(
  value: Record<string, unknown>,
  label: string
): SkillToolPermission {
  const scope = asString(value.scope, `${label}.scope`);
  if (!TOOL_PERMISSION_SCOPES.includes(scope as ToolPermissionScope)) {
    throw new Error(
      `${label}.scope must be one of: ${TOOL_PERMISSION_SCOPES.join(", ")}.`
    );
  }
  const tools = normalizeUniqueStringList(
    value.tools,
    `${label}.tools`,
    normalizeToolName
  );
  return {
    kind: "tool",
    scope: scope as ToolPermissionScope,
    tools,
  };
}

export function validateSkillPermission(
  value: unknown,
  index = 0
): SkillPermission {
  if (!isRecord(value)) {
    throw new Error(`permissions[${index}] must be an object.`);
  }
  const label = `permissions[${index}]`;
  const kind = asString(value.kind, `${label}.kind`);
  if (!SKILL_PERMISSION_KINDS.includes(kind as SkillPermissionKind)) {
    throw new Error(
      `${label}.kind must be one of: ${SKILL_PERMISSION_KINDS.join(", ")}.`
    );
  }

  if (kind === "filesystem") {
    return parseFilesystemPermission(value, label);
  }
  if (kind === "network") {
    return parseNetworkPermission(value, label);
  }
  if (kind === "process") {
    return parseProcessPermission(value, label);
  }
  return parseToolPermission(value, label);
}

export function validateSkillPermissions(value: unknown): SkillPermission[] {
  if (!Array.isArray(value)) {
    throw new Error("permissions must be an array.");
  }
  if (value.length > MAX_PERMISSION_LIST_SIZE) {
    throw new Error(
      `permissions exceeds max size ${MAX_PERMISSION_LIST_SIZE}.`
    );
  }
  return value.map((permission, index) =>
    validateSkillPermission(permission, index)
  );
}
