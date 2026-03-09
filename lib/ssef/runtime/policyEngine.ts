import path from "node:path";
import { getSSEFConfig } from "../config";
import type { SkillManifestV1 } from "../contracts/manifest";
import type {
  SkillFilesystemPermission,
  SkillNetworkPermission,
  SkillPermission,
  SkillProcessPermission,
  SkillToolPermission,
} from "../contracts/permissions";
import { SSEFPolicyViolationError, type SSEFPolicyViolationSeverity } from "./errors";

export type SSEFPolicyFilesystemScope = "read" | "write";

export type SSEFPolicyFilesystemAction = {
  kind: "filesystem";
  scope: SSEFPolicyFilesystemScope;
  path: string;
  allowManagedSSEFPaths?: boolean;
};

export type SSEFPolicyNetworkAction = {
  kind: "network";
  host: string;
};

export type SSEFPolicyProcessAction = {
  kind: "process";
  command: string;
};

export type SSEFPolicyToolAction = {
  kind: "tool";
  toolName: string;
};

export type SSEFPolicyAction =
  | SSEFPolicyFilesystemAction
  | SSEFPolicyNetworkAction
  | SSEFPolicyProcessAction
  | SSEFPolicyToolAction;

export type SSEFPolicyProcessLimits = {
  maxRuntimeMs?: number;
  maxMemoryMb?: number;
  maxCpuSeconds?: number;
};

export type SSEFPolicyDecision = {
  allowed: boolean;
  category: "filesystem" | "network" | "process" | "tool";
  action: string;
  target: string;
  reason: string;
  message: string;
  severity: SSEFPolicyViolationSeverity;
  details?: Record<string, unknown>;
  matchedPermission?: SkillPermission;
  processLimits?: SSEFPolicyProcessLimits;
};

export type SSEFSkillPolicy = {
  skillId: string;
  version: string;
  workspaceRoot: string;
  ssefRoot: string;
  filesystemPermissions: SkillFilesystemPermission[];
  networkPermissions: SkillNetworkPermission[];
  processPermissions: SkillProcessPermission[];
  toolPermissions: SkillToolPermission[];
};

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function toWorkspaceRelativePath(workspaceRoot: string, absPath: string) {
  const relative = path.relative(workspaceRoot, absPath);
  if (!relative || relative === ".") {
    return "/";
  }
  const normalized = relative.split(path.sep).join("/");
  return `/${normalized}`;
}

function pathWithin(rootPath: string, targetPath: string) {
  const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return targetPath === rootPath || targetPath.startsWith(rootWithSep);
}

function resolveWorkspaceAbsolutePath(workspaceRoot: string, inputPath: string) {
  const trimmed = asNonEmptyText(inputPath);
  const withoutLeadingSlash = trimmed.replace(/^[\\/]+/, "");
  const relative = withoutLeadingSlash.length > 0 ? withoutLeadingSlash : ".";
  return path.resolve(workspaceRoot, relative);
}

function filesystemScopeAllows(
  scope: SkillFilesystemPermission["scope"],
  requested: SSEFPolicyFilesystemScope
) {
  if (scope === "read_write") {
    return true;
  }
  if (requested === "read") {
    return scope === "read";
  }
  return scope === "write";
}

function hostMatchesPattern(host: string, pattern: string) {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern === "*") {
    return true;
  }
  if (normalizedHost === normalizedPattern) {
    return true;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return false;
}

function normalizeHost(value: string) {
  const text = asNonEmptyText(value).toLowerCase();
  if (!text) {
    return "";
  }
  if (text.includes("://")) {
    try {
      return new URL(text).host.toLowerCase();
    } catch {
      return "";
    }
  }
  return text;
}

function processCommandMatchesPattern(command: string, pattern: string) {
  const normalizedCommand = command.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern === "*") {
    return true;
  }

  const commandBase = path.basename(normalizedCommand);
  const patternBase = path.basename(normalizedPattern);
  if (normalizedPattern === normalizedCommand || patternBase === commandBase) {
    return true;
  }

  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    if (prefix && normalizedCommand.startsWith(prefix)) {
      return true;
    }
    if (prefix && commandBase.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function collectProcessLimits(
  matchedPermissions: SkillProcessPermission[]
): SSEFPolicyProcessLimits {
  const runtimeCandidates = matchedPermissions
    .map((permission) => permission.max_runtime_ms)
    .filter((value): value is number => typeof value === "number");
  const memoryCandidates = matchedPermissions
    .map((permission) => permission.max_memory_mb)
    .filter((value): value is number => typeof value === "number");
  const cpuCandidates = matchedPermissions
    .map((permission) => permission.max_cpu_seconds)
    .filter((value): value is number => typeof value === "number");

  const limits: SSEFPolicyProcessLimits = {};
  if (runtimeCandidates.length > 0) {
    limits.maxRuntimeMs = Math.min(...runtimeCandidates);
  }
  if (memoryCandidates.length > 0) {
    limits.maxMemoryMb = Math.min(...memoryCandidates);
  }
  if (cpuCandidates.length > 0) {
    limits.maxCpuSeconds = Math.min(...cpuCandidates);
  }
  return limits;
}

function buildPolicyDecision(params: {
  allowed: boolean;
  category: SSEFPolicyDecision["category"];
  action: string;
  target: string;
  reason: string;
  message: string;
  severity: SSEFPolicyViolationSeverity;
  details?: Record<string, unknown>;
  matchedPermission?: SkillPermission;
  processLimits?: SSEFPolicyProcessLimits;
}): SSEFPolicyDecision {
  return {
    allowed: params.allowed,
    category: params.category,
    action: params.action,
    target: params.target,
    reason: params.reason,
    message: params.message,
    severity: params.severity,
    details: params.details,
    matchedPermission: params.matchedPermission,
    processLimits: params.processLimits,
  };
}

function splitPermissions(manifest: SkillManifestV1) {
  const filesystemPermissions: SkillFilesystemPermission[] = [];
  const networkPermissions: SkillNetworkPermission[] = [];
  const processPermissions: SkillProcessPermission[] = [];
  const toolPermissions: SkillToolPermission[] = [];

  manifest.permissions.forEach((permission) => {
    if (permission.kind === "filesystem") {
      filesystemPermissions.push(permission);
      return;
    }
    if (permission.kind === "network") {
      networkPermissions.push(permission);
      return;
    }
    if (permission.kind === "process") {
      processPermissions.push(permission);
      return;
    }
    toolPermissions.push(permission);
  });

  return {
    filesystemPermissions,
    networkPermissions,
    processPermissions,
    toolPermissions,
  };
}

export function createSSEFSkillPolicy(manifest: SkillManifestV1): SSEFSkillPolicy {
  const config = getSSEFConfig();
  const split = splitPermissions(manifest);
  return {
    skillId: manifest.id,
    version: manifest.version,
    workspaceRoot: config.workspaceRoot,
    ssefRoot: config.rootDir,
    ...split,
  };
}

function evaluateFilesystemAction(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyFilesystemAction
): SSEFPolicyDecision {
  const normalizedPath = asNonEmptyText(action.path);
  if (!normalizedPath) {
    return buildPolicyDecision({
      allowed: false,
      category: "filesystem",
      action: `filesystem.${action.scope}`,
      target: action.path,
      reason: "missing_target",
      message: "Filesystem policy denied: target path is missing.",
      severity: "medium",
    });
  }

  const absoluteTarget = path.isAbsolute(normalizedPath)
    ? path.resolve(normalizedPath)
    : resolveWorkspaceAbsolutePath(policy.workspaceRoot, normalizedPath);

  if (!pathWithin(policy.workspaceRoot, absoluteTarget)) {
    return buildPolicyDecision({
      allowed: false,
      category: "filesystem",
      action: `filesystem.${action.scope}`,
      target: normalizedPath,
      reason: "outside_workspace",
      message: "Filesystem policy denied: path escapes workspace root.",
      severity: "high",
      details: {
        attempted_path: normalizedPath,
        resolved_path: absoluteTarget,
      },
    });
  }

  if (action.allowManagedSSEFPaths && pathWithin(policy.ssefRoot, absoluteTarget)) {
    return buildPolicyDecision({
      allowed: true,
      category: "filesystem",
      action: `filesystem.${action.scope}`,
      target: toWorkspaceRelativePath(policy.workspaceRoot, absoluteTarget),
      reason: "managed_ssef_path",
      message: "Filesystem policy allowed managed SSEF artifact access.",
      severity: "low",
      details: {
        managed_path: toWorkspaceRelativePath(policy.workspaceRoot, absoluteTarget),
      },
    });
  }

  for (const permission of policy.filesystemPermissions) {
    if (!filesystemScopeAllows(permission.scope, action.scope)) {
      continue;
    }
    const matched = permission.paths.some((allowedPath) => {
      if (allowedPath === "/") {
        return true;
      }
      const permissionRelative = allowedPath.replace(/^\/+/, "");
      const permissionAbsolute = path.resolve(policy.workspaceRoot, permissionRelative);
      return pathWithin(permissionAbsolute, absoluteTarget);
    });
    if (!matched) {
      continue;
    }

    return buildPolicyDecision({
      allowed: true,
      category: "filesystem",
      action: `filesystem.${action.scope}`,
      target: toWorkspaceRelativePath(policy.workspaceRoot, absoluteTarget),
      reason: "manifest_match",
      message: "Filesystem policy allowed by manifest permission.",
      severity: "low",
      matchedPermission: permission,
      details: {
        scope: permission.scope,
      },
    });
  }

  return buildPolicyDecision({
    allowed: false,
    category: "filesystem",
    action: `filesystem.${action.scope}`,
    target: toWorkspaceRelativePath(policy.workspaceRoot, absoluteTarget),
    reason: "undeclared_path",
    message: "Filesystem policy denied: path is not declared in manifest permissions.",
    severity: "medium",
  });
}

function evaluateNetworkAction(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyNetworkAction
): SSEFPolicyDecision {
  const host = normalizeHost(action.host);
  if (!host) {
    return buildPolicyDecision({
      allowed: false,
      category: "network",
      action: "network.connect",
      target: action.host,
      reason: "invalid_host",
      message: "Network policy denied: host is invalid.",
      severity: "medium",
    });
  }

  for (const permission of policy.networkPermissions) {
    const matched = permission.hosts.some((pattern) => hostMatchesPattern(host, pattern));
    if (!matched) {
      continue;
    }

    return buildPolicyDecision({
      allowed: true,
      category: "network",
      action: "network.connect",
      target: host,
      reason: "manifest_match",
      message: "Network policy allowed by manifest allowlist.",
      severity: "low",
      matchedPermission: permission,
    });
  }

  return buildPolicyDecision({
    allowed: false,
    category: "network",
    action: "network.connect",
    target: host,
    reason: "undeclared_host",
    message: "Network policy denied: host is not in manifest allowlist.",
    severity: "high",
  });
}

function evaluateProcessAction(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyProcessAction
): SSEFPolicyDecision {
  const normalizedCommand = asNonEmptyText(action.command);
  if (!normalizedCommand) {
    return buildPolicyDecision({
      allowed: false,
      category: "process",
      action: "process.spawn",
      target: action.command,
      reason: "missing_command",
      message: "Process policy denied: command is missing.",
      severity: "medium",
    });
  }

  const matchedPermissions = policy.processPermissions.filter((permission) =>
    permission.commands.some((pattern) =>
      processCommandMatchesPattern(normalizedCommand, pattern)
    )
  );

  if (matchedPermissions.length === 0) {
    return buildPolicyDecision({
      allowed: false,
      category: "process",
      action: "process.spawn",
      target: normalizedCommand,
      reason: "undeclared_command",
      message: "Process policy denied: command is not declared in manifest permissions.",
      severity: "high",
    });
  }

  const limits = collectProcessLimits(matchedPermissions);
  return buildPolicyDecision({
    allowed: true,
    category: "process",
    action: "process.spawn",
    target: normalizedCommand,
    reason: "manifest_match",
    message: "Process policy allowed by manifest permission.",
    severity: "low",
    matchedPermission: matchedPermissions[0],
    processLimits: limits,
    details: {
      matched_permissions: matchedPermissions.length,
    },
  });
}

function evaluateToolAction(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyToolAction
): SSEFPolicyDecision {
  const toolName = asNonEmptyText(action.toolName);
  if (!toolName) {
    return buildPolicyDecision({
      allowed: false,
      category: "tool",
      action: "tool.invoke",
      target: action.toolName,
      reason: "missing_tool_name",
      message: "Tool policy denied: tool name is missing.",
      severity: "medium",
    });
  }

  for (const permission of policy.toolPermissions) {
    const matched = permission.tools.some(
      (allowedTool) => allowedTool === "*" || allowedTool === toolName
    );
    if (!matched) {
      continue;
    }

    return buildPolicyDecision({
      allowed: true,
      category: "tool",
      action: "tool.invoke",
      target: toolName,
      reason: "manifest_match",
      message: "Tool policy allowed by manifest permission.",
      severity: "low",
      matchedPermission: permission,
    });
  }

  return buildPolicyDecision({
    allowed: false,
    category: "tool",
    action: "tool.invoke",
    target: toolName,
    reason: "undeclared_tool",
    message: "Tool policy denied: tool is not declared in manifest permissions.",
    severity: "high",
  });
}

export function evaluateSSEFPolicyAction(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyAction
): SSEFPolicyDecision {
  if (action.kind === "filesystem") {
    return evaluateFilesystemAction(policy, action);
  }
  if (action.kind === "network") {
    return evaluateNetworkAction(policy, action);
  }
  if (action.kind === "process") {
    return evaluateProcessAction(policy, action);
  }
  return evaluateToolAction(policy, action);
}

export function assertSSEFPolicyActionAllowed(
  policy: SSEFSkillPolicy,
  action: SSEFPolicyAction
): SSEFPolicyDecision {
  const decision = evaluateSSEFPolicyAction(policy, action);
  if (decision.allowed) {
    return decision;
  }

  throw new SSEFPolicyViolationError(decision.message, {
    category: decision.category,
    severity: decision.severity,
    action: decision.action,
    target: decision.target,
    reason: decision.reason,
    details: decision.details ?? null,
  });
}
