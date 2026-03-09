import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureSSEFReady } from "../bootstrap";
import { getSSEFConfig } from "../config";
import {
  buildSSEFCompositionPlanFromManifest,
  runSSEFCompositionPlan,
} from "../composition/runner";
import type { SSEFActiveSkillRuntimeRecord } from "./toolDefinitions";
import type { RunSSEFToolContext } from "./adapter";
import {
  createSSEFSkillPolicy,
  evaluateSSEFPolicyAction,
  type SSEFPolicyAction,
  type SSEFPolicyDecision,
  type SSEFPolicyProcessLimits,
  type SSEFSkillPolicy,
} from "./policyEngine";
import {
  getSSEFRuntimeErrorCode,
  getSSEFRuntimeErrorMessage,
  SSEFExecutionTimeoutError,
  SSEFPolicyViolationError,
  SSEFRuntimeError,
  type SSEFRuntimeErrorCode,
} from "./errors";
import { createSSEFTraceSession } from "./trace";
import { ensureSSEFSkillRuntimeDependencies } from "./dependencies";

type ScriptExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
};

type RuntimeExecutionLimits = {
  timeoutMs: number;
  maxOutputChars: number;
  maxMemoryMb: number | null;
  maxCpuSeconds: number | null;
  maxProcessSpawns: number;
};

type RuntimeExecutionOutcome = {
  toolResult: Record<string, unknown>;
  durationMs: number;
  outputType: "json" | "text";
  truncated: boolean;
  limits: RuntimeExecutionLimits;
  processCommand: string | null;
  dependencyInstall: Record<string, unknown> | null;
};

type SpawnBudget = {
  used: number;
  max: number;
};

export type ExecuteSSEFSkillRuntimeInput = {
  runId: string;
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
};

export type ExecuteSSEFSkillRuntimeResult = {
  ok: boolean;
  toolResult: Record<string, unknown> | null;
  error: unknown | null;
  errorMessage: string | null;
  errorCode: SSEFRuntimeErrorCode | null;
  policyViolation: SSEFPolicyViolationError["violation"] | null;
  traceLogPath: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  runResult: Record<string, unknown>;
  runMetadata: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(0, maxChars),
    truncated: true,
  };
}

function parseStructuredOutput(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function resolveContextValue(
  input: Record<string, unknown>,
  keyPath: string
): unknown {
  const parts = keyPath.split(".").filter(Boolean);
  let current: unknown = input;
  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function toTemplateText(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderTemplate(
  template: string,
  payload: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token) => {
    const value = resolveContextValue(payload, token);
    return toTemplateText(value);
  });
}

function resolveEntrypoint(record: SSEFActiveSkillRuntimeRecord) {
  const config = getSSEFConfig();
  const versionRoot = path.resolve(config.vaultDir, record.skillId, record.version);
  const normalizedEntrypoint = record.entrypoint.trim();
  if (!normalizedEntrypoint) {
    throw new SSEFRuntimeError(
      "Skill entrypoint path is empty.",
      "runtime_failed",
      {
        skill_id: record.skillId,
        version: record.version,
      }
    );
  }
  const entrypointPath = path.resolve(versionRoot, normalizedEntrypoint);
  const rootWithSep = versionRoot.endsWith(path.sep)
    ? versionRoot
    : `${versionRoot}${path.sep}`;

  if (entrypointPath !== versionRoot && !entrypointPath.startsWith(rootWithSep)) {
    throw new SSEFRuntimeError(
      "Skill entrypoint escapes vault version root.",
      "runtime_failed",
      {
        skill_id: record.skillId,
        version: record.version,
        entrypoint: normalizedEntrypoint,
      }
    );
  }

  return {
    versionRoot,
    entrypointPath,
  };
}

async function ensureEntrypointExists(entrypointPath: string) {
  try {
    const stats = await fs.stat(entrypointPath);
    if (!stats.isFile()) {
      throw new SSEFRuntimeError(
        `Skill entrypoint is not a file: ${entrypointPath}`,
        "runtime_failed"
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new SSEFRuntimeError(
        `Skill entrypoint not found: ${entrypointPath}`,
        "runtime_failed"
      );
    }
    throw error;
  }
}

function buildExecutionPayload(
  args: Record<string, unknown>,
  record: SSEFActiveSkillRuntimeRecord,
  context: RunSSEFToolContext
) {
  return {
    args,
    _context: {
      source: context.source,
      conversation_id: context.conversationId ?? null,
      session_scope_id: context.sessionScopeId ?? null,
      user_intent: context.userIntent ?? null,
      executed_at: new Date().toISOString(),
      skill_id: record.skillId,
      skill_version: record.version,
    },
  };
}

function assertContextRequirements(
  record: SSEFActiveSkillRuntimeRecord,
  payload: Record<string, unknown>
) {
  if (!record.manifest.requires_context) {
    return;
  }

  const missingKeys = record.manifest.context_keys.filter((keyPath) => {
    const contextValue = resolveContextValue(payload._context as Record<string, unknown>, keyPath);
    if (contextValue === undefined || contextValue === null) {
      return true;
    }
    if (typeof contextValue === "string" && contextValue.trim().length === 0) {
      return true;
    }
    return false;
  });

  if (missingKeys.length > 0) {
    throw new SSEFRuntimeError(
      `SSEF skill '${record.skillId}' requires missing context keys: ${missingKeys.join(", ")}.`,
      "invalid_context",
      {
        missing_context_keys: missingKeys,
      }
    );
  }
}

function resolvePythonCommands() {
  const envBinary = process.env.SSEF_PYTHON_BIN?.trim();
  const candidates = [envBinary, "python3", "python"].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return Array.from(new Set(candidates));
}

function resolveRuntimeLimits(processLimits?: SSEFPolicyProcessLimits): RuntimeExecutionLimits {
  const config = getSSEFConfig();
  const timeoutCap = config.limits.sandboxTimeoutMs;
  const timeoutMs = processLimits?.maxRuntimeMs
    ? Math.max(100, Math.min(timeoutCap, Math.floor(processLimits.maxRuntimeMs)))
    : timeoutCap;

  const memoryCap = processLimits?.maxMemoryMb
    ? Math.max(16, Math.floor(processLimits.maxMemoryMb))
    : Math.max(16, config.limits.sandboxMaxMemoryMb);

  const cpuCap = processLimits?.maxCpuSeconds
    ? Math.max(1, Math.floor(processLimits.maxCpuSeconds))
    : Math.max(1, config.limits.sandboxMaxCpuSeconds);

  return {
    timeoutMs,
    maxOutputChars: config.limits.sandboxMaxOutputChars,
    maxMemoryMb: Number.isFinite(memoryCap) ? memoryCap : null,
    maxCpuSeconds: Number.isFinite(cpuCap) ? cpuCap : null,
    maxProcessSpawns: Math.max(1, config.limits.sandboxMaxProcessSpawns),
  };
}

function buildSpawnPlan(params: {
  command: string;
  commandArgs: string[];
  limits: RuntimeExecutionLimits;
}) {
  const command = params.command;
  let commandArgs = [...params.commandArgs];

  if (command === "node" && params.limits.maxMemoryMb) {
    commandArgs = [
      `--max-old-space-size=${params.limits.maxMemoryMb}`,
      ...commandArgs,
    ];
  }

  const needsShellLimitWrapper =
    process.platform !== "win32" &&
    (Boolean(params.limits.maxCpuSeconds) ||
      (Boolean(params.limits.maxMemoryMb) && command !== "node"));

  if (!needsShellLimitWrapper) {
    return {
      command,
      commandArgs,
      displayCommand: [command, ...commandArgs].join(" "),
      wrappedWithShell: false,
    };
  }

  const shellParts: string[] = [];
  if (params.limits.maxMemoryMb && command !== "node") {
    shellParts.push(`ulimit -v ${Math.floor(params.limits.maxMemoryMb * 1024)}`);
  }
  if (params.limits.maxCpuSeconds) {
    shellParts.push(`ulimit -t ${Math.floor(params.limits.maxCpuSeconds)}`);
  }
  shellParts.push('exec "$@"');

  return {
    command: "bash",
    commandArgs: [
      "-lc",
      shellParts.join("; "),
      "ssef-runtime-envelope",
      command,
      ...commandArgs,
    ],
    displayCommand: [command, ...commandArgs].join(" "),
    wrappedWithShell: true,
  };
}

async function runScriptRuntime(params: {
  command: string;
  commandArgs: string[];
  cwd: string;
  stdinPayload: Record<string, unknown>;
  timeoutMs: number;
  maxOutputChars: number;
  env: NodeJS.ProcessEnv;
}): Promise<ScriptExecutionResult> {
  const startedAt = Date.now();

  return new Promise<ScriptExecutionResult>((resolve, reject) => {
    const child = spawn(params.command, params.commandArgs, {
      cwd: params.cwd,
      env: params.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const appendChunk = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }

      const consumed = stdout.length + stderr.length;
      const remaining = params.maxOutputChars - consumed;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      const nextText = text.length > remaining ? text.slice(0, remaining) : text;
      if (nextText.length < text.length) {
        truncated = true;
      }

      if (stream === "stdout") {
        stdout += nextText;
      } else {
        stderr += nextText;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => appendChunk(chunk, "stderr"));

    child.once("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, params.timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      const input = JSON.stringify(params.stdinPayload);
      child.stdin.write(input);
      child.stdin.end();
    } catch (error) {
      clearTimeout(timeoutHandle);
      child.kill("SIGKILL");
      reject(error);
    }
  });
}

function consumeSpawnBudget(spawnBudget: SpawnBudget) {
  if (spawnBudget.used >= spawnBudget.max) {
    throw new SSEFRuntimeError(
      "SSEF process spawn limit exceeded for this run.",
      "spawn_limit_exceeded",
      {
        used: spawnBudget.used,
        max: spawnBudget.max,
      }
    );
  }
  spawnBudget.used += 1;
}

function buildPolicyError(decision: SSEFPolicyDecision) {
  return new SSEFPolicyViolationError(decision.message, {
    category: decision.category,
    severity: decision.severity,
    action: decision.action,
    target: decision.target,
    reason: decision.reason,
    details: decision.details ?? null,
  });
}

function evaluateAndEnforcePolicy(params: {
  policy: SSEFSkillPolicy;
  action: SSEFPolicyAction;
  trace: ReturnType<typeof createSSEFTraceSession>;
}): SSEFPolicyDecision {
  const decision = evaluateSSEFPolicyAction(params.policy, params.action);
  params.trace.recordPolicyDecision({
    allowed: decision.allowed,
    category: decision.category,
    action: decision.action,
    target: decision.target,
    reason: decision.reason,
    message: decision.message,
    details: decision.details,
  });

  if (!decision.allowed) {
    throw buildPolicyError(decision);
  }

  return decision;
}

function buildRuntimeFailureError(
  record: SSEFActiveSkillRuntimeRecord,
  processResult: ScriptExecutionResult,
  attemptedCommand: string
) {
  if (processResult.timedOut) {
    return new SSEFExecutionTimeoutError(
      `SSEF skill '${record.skillId}' timed out after ${processResult.durationMs}ms.`,
      {
        command: attemptedCommand,
        timeout_ms: processResult.durationMs,
      }
    );
  }

  const stderr = processResult.stderr.trim();
  const stdout = processResult.stdout.trim();
  const detail = stderr || stdout;

  if (processResult.exitCode === 127 && /not found|no such file/i.test(detail)) {
    return new SSEFRuntimeError(
      `Runtime command is unavailable: ${attemptedCommand}.`,
      "runtime_unavailable",
      {
        command: attemptedCommand,
      }
    );
  }

  if (detail) {
    const bounded = truncateText(detail, 600);
    return new SSEFRuntimeError(
      `SSEF skill '${record.skillId}' failed: ${bounded.text}`,
      "runtime_failed",
      {
        command: attemptedCommand,
      }
    );
  }

  const signalPart = processResult.signal ? ` (signal ${processResult.signal})` : "";
  return new SSEFRuntimeError(
    `SSEF skill '${record.skillId}' exited with code ${
      processResult.exitCode ?? "unknown"
    }${signalPart}.`,
    "runtime_failed",
    {
      command: attemptedCommand,
      exit_code: processResult.exitCode,
      signal: processResult.signal,
    }
  );
}

async function executeTemplateRuntime(params: {
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
  trace: ReturnType<typeof createSSEFTraceSession>;
  policy: SSEFSkillPolicy;
}): Promise<RuntimeExecutionOutcome> {
  const config = getSSEFConfig();
  const startedAt = Date.now();
  const { versionRoot, entrypointPath } = resolveEntrypoint(params.record);
  await ensureEntrypointExists(entrypointPath);

  evaluateAndEnforcePolicy({
    policy: params.policy,
    action: {
      kind: "filesystem",
      scope: "read",
      path: entrypointPath,
      allowManagedSSEFPaths: true,
    },
    trace: params.trace,
  });

  const template = await fs.readFile(entrypointPath, "utf8");
  const payload = buildExecutionPayload(params.args, params.record, params.context);
  const rendered = renderTemplate(template, payload);
  const bounded = truncateText(rendered, config.limits.sandboxMaxOutputChars);
  const output = parseStructuredOutput(bounded.text);

  params.trace.info("runtime.template.rendered", {
    output_truncated: bounded.truncated,
    output_chars: bounded.text.length,
  });

  const durationMs = Date.now() - startedAt;
  const limits = resolveRuntimeLimits(undefined);

  return {
    toolResult: {
      status: "ok",
      skill_id: params.record.skillId,
      version: params.record.version,
      runtime: params.record.runtime,
      output,
      output_type: typeof output === "string" ? "text" : "json",
      truncated: bounded.truncated,
      duration_ms: durationMs,
      entrypoint: path.relative(versionRoot, entrypointPath).split(path.sep).join("/"),
    },
    durationMs,
    outputType: typeof output === "string" ? "text" : "json",
    truncated: bounded.truncated,
    limits,
    processCommand: null,
    dependencyInstall: null,
  };
}

async function executeScriptRuntime(params: {
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
  command: string;
  processPolicyDecision: SSEFPolicyDecision;
  trace: ReturnType<typeof createSSEFTraceSession>;
  policy: SSEFSkillPolicy;
  spawnBudget: SpawnBudget;
}): Promise<RuntimeExecutionOutcome> {
  const { versionRoot, entrypointPath } = resolveEntrypoint(params.record);
  await ensureEntrypointExists(entrypointPath);

  evaluateAndEnforcePolicy({
    policy: params.policy,
    action: {
      kind: "filesystem",
      scope: "read",
      path: entrypointPath,
      allowManagedSSEFPaths: true,
    },
    trace: params.trace,
  });

  consumeSpawnBudget(params.spawnBudget);

  const limits = resolveRuntimeLimits(params.processPolicyDecision.processLimits);
  const dependencyInstall = await ensureSSEFSkillRuntimeDependencies({
    versionRoot,
    manifest: params.record.manifest,
    mode: "runtime",
    allowInstall: getSSEFConfig().dependencyManagement.runtimeAutoInstall,
  });
  params.trace.info("runtime.dependencies", {
    status: dependencyInstall.status,
    attempted: dependencyInstall.attempted,
    npm_count: dependencyInstall.dependencies.npm.length,
    pip_count: dependencyInstall.dependencies.pip.length,
    npm_installed: dependencyInstall.npmInstalled,
    pip_installed: dependencyInstall.pipInstalled,
    marker_path: dependencyInstall.markerPath,
    error: dependencyInstall.error,
  });
  if (dependencyInstall.status === "failed") {
    throw new SSEFRuntimeError(
      `Runtime dependencies are unavailable for skill '${params.record.skillId}': ${
        dependencyInstall.error ?? "dependency setup failed"
      }`,
      "runtime_failed",
      {
        dependency_mode: dependencyInstall.mode,
        dependency_error: dependencyInstall.error,
        dependency_attempted: dependencyInstall.attempted,
        dependency_marker_path: dependencyInstall.markerPath,
      }
    );
  }

  const spawnPlan = buildSpawnPlan({
    command: params.command,
    commandArgs: [entrypointPath],
    limits,
  });

  params.trace.info("runtime.process.spawn", {
    command: spawnPlan.displayCommand,
    wrapped_with_shell: spawnPlan.wrappedWithShell,
    timeout_ms: limits.timeoutMs,
    max_memory_mb: limits.maxMemoryMb,
    max_cpu_seconds: limits.maxCpuSeconds,
    spawn_count_used: params.spawnBudget.used,
    spawn_count_limit: params.spawnBudget.max,
  });

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...dependencyInstall.runtimeEnv,
    SSEF_RUNTIME_MODE: "tool",
    SSEF_SKILL_ID: params.record.skillId,
    SSEF_SKILL_VERSION: params.record.version,
  };

  const processResult = await runScriptRuntime({
    command: spawnPlan.command,
    commandArgs: spawnPlan.commandArgs,
    cwd: versionRoot,
    stdinPayload: buildExecutionPayload(params.args, params.record, params.context),
    timeoutMs: limits.timeoutMs,
    maxOutputChars: limits.maxOutputChars,
    env: runtimeEnv,
  });

  params.trace.setProcessLogs(processResult.stdout, processResult.stderr);
  params.trace.info("runtime.process.completed", {
    command: spawnPlan.displayCommand,
    exit_code: processResult.exitCode,
    signal: processResult.signal,
    timed_out: processResult.timedOut,
    duration_ms: processResult.durationMs,
    output_truncated: processResult.truncated,
  });

  const succeeded = !processResult.timedOut && processResult.exitCode === 0;
  if (!succeeded) {
    throw buildRuntimeFailureError(
      params.record,
      processResult,
      spawnPlan.displayCommand
    );
  }

  const parsedOutput = parseStructuredOutput(processResult.stdout);
  const stderrSummary = processResult.stderr.trim();

  return {
    toolResult: {
      status: "ok",
      skill_id: params.record.skillId,
      version: params.record.version,
      runtime: params.record.runtime,
      output: parsedOutput,
      output_type: typeof parsedOutput === "string" ? "text" : "json",
      truncated: processResult.truncated,
      duration_ms: processResult.durationMs,
      stderr: stderrSummary
        ? truncateText(stderrSummary, 600).text
        : undefined,
      entrypoint: path.relative(versionRoot, entrypointPath).split(path.sep).join("/"),
      dependency_install: {
        status: dependencyInstall.status,
        attempted: dependencyInstall.attempted,
        npm_installed: dependencyInstall.npmInstalled,
        pip_installed: dependencyInstall.pipInstalled,
      },
    },
    durationMs: processResult.durationMs,
    outputType: typeof parsedOutput === "string" ? "text" : "json",
    truncated: processResult.truncated,
    limits,
    processCommand: spawnPlan.displayCommand,
    dependencyInstall: {
      status: dependencyInstall.status,
      attempted: dependencyInstall.attempted,
      npm_installed: dependencyInstall.npmInstalled,
      pip_installed: dependencyInstall.pipInstalled,
      marker_path: dependencyInstall.markerPath,
      python_bin: dependencyInstall.pythonBin,
    },
  };
}

async function executePythonRuntime(params: {
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
  trace: ReturnType<typeof createSSEFTraceSession>;
  policy: SSEFSkillPolicy;
  spawnBudget: SpawnBudget;
}) {
  const candidates = resolvePythonCommands();
  let firstPolicyViolation: SSEFPolicyViolationError | null = null;
  let foundAllowedCandidate = false;

  for (const command of candidates) {
    const decision = evaluateSSEFPolicyAction(params.policy, {
      kind: "process",
      command,
    });
    params.trace.recordPolicyDecision({
      allowed: decision.allowed,
      category: decision.category,
      action: decision.action,
      target: decision.target,
      reason: decision.reason,
      message: decision.message,
      details: decision.details,
    });

    if (!decision.allowed) {
      if (!firstPolicyViolation) {
        firstPolicyViolation = buildPolicyError(decision);
      }
      continue;
    }

    foundAllowedCandidate = true;
    try {
      return await executeScriptRuntime({
        record: params.record,
        args: params.args,
        context: params.context,
        command,
        processPolicyDecision: decision,
        trace: params.trace,
        policy: params.policy,
        spawnBudget: params.spawnBudget,
      });
    } catch (error) {
      const code = getSSEFRuntimeErrorCode(error);
      if (code === "runtime_unavailable") {
        params.trace.warn("runtime.process.command_unavailable", {
          command,
        });
        continue;
      }

      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        params.trace.warn("runtime.process.command_missing", {
          command,
        });
        continue;
      }
      throw error;
    }
  }

  if (foundAllowedCandidate) {
    throw new SSEFRuntimeError(
      "Python runtime is unavailable. Set SSEF_PYTHON_BIN or install python3/python.",
      "runtime_unavailable"
    );
  }

  if (firstPolicyViolation) {
    throw firstPolicyViolation;
  }

  throw new SSEFRuntimeError(
    "Python runtime is unavailable.",
    "runtime_unavailable"
  );
}

async function executeCompositeRuntime(params: {
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
  trace: ReturnType<typeof createSSEFTraceSession>;
  policy: SSEFSkillPolicy;
}): Promise<RuntimeExecutionOutcome> {
  const startedAt = Date.now();
  const plan = buildSSEFCompositionPlanFromManifest(params.record.manifest);
  const { runSSEFToolByName } = await import("./adapter");
  const compositionResult = await runSSEFCompositionPlan({
    plan,
    args: params.args,
    context: {
      source: params.context.source,
      conversationId: params.context.conversationId,
      sessionScopeId: params.context.sessionScopeId,
      userIntent: params.context.userIntent,
    },
    assertToolAllowed: (toolName) => {
      evaluateAndEnforcePolicy({
        policy: params.policy,
        action: {
          kind: "tool",
          toolName,
        },
        trace: params.trace,
      });
    },
    onStepStart: (step, stepInput) => {
      params.trace.info("runtime.composition.step.started", {
        step: step.step,
        skill_id: step.skillId,
        input_keys: Object.keys(stepInput),
      });
    },
    onStepComplete: (step, _stepInput, stepOutput) => {
      params.trace.info("runtime.composition.step.completed", {
        step: step.step,
        skill_id: step.skillId,
        output_keys: Object.keys(stepOutput),
      });
    },
    invokeSkill: async (skillId, args, context) => {
      return runSSEFToolByName(skillId, args, {
        source: context.source === "idle" ? "idle" : "chat",
        conversationId: context.conversationId,
        sessionScopeId: context.sessionScopeId,
        userIntent: context.userIntent,
      });
    },
  });

  const durationMs = Date.now() - startedAt;
  const limits = resolveRuntimeLimits(undefined);
  return {
    toolResult: {
      status: "ok",
      skill_id: params.record.skillId,
      version: params.record.version,
      mode: compositionResult.mode,
      dependencies: compositionResult.dependencies,
      invocation_order: compositionResult.invocationOrder,
      steps: compositionResult.steps.map((step) => ({
        step: step.step,
        skill_id: step.skillId,
        output: step.output,
      })),
      final_output: compositionResult.finalOutput,
    },
    durationMs,
    outputType: "json",
    truncated: false,
    limits,
    processCommand: null,
    dependencyInstall: null,
  };
}

async function executeRuntimeSkill(params: {
  record: SSEFActiveSkillRuntimeRecord;
  args: Record<string, unknown>;
  context: RunSSEFToolContext;
  trace: ReturnType<typeof createSSEFTraceSession>;
  policy: SSEFSkillPolicy;
  spawnBudget: SpawnBudget;
}): Promise<RuntimeExecutionOutcome> {
  if (params.record.runtime === "template") {
    return executeTemplateRuntime(params);
  }

  if (params.record.runtime === "node") {
    const decision = evaluateAndEnforcePolicy({
      policy: params.policy,
      action: {
        kind: "process",
        command: "node",
      },
      trace: params.trace,
    });

    return executeScriptRuntime({
      ...params,
      command: "node",
      processPolicyDecision: decision,
    });
  }

  if (params.record.runtime === "python") {
    return executePythonRuntime(params);
  }

  if (params.record.runtime === "composite") {
    return executeCompositeRuntime(params);
  }

  throw new SSEFRuntimeError(
    `Unsupported SSEF runtime: ${params.record.runtime}`,
    "unsupported_runtime"
  );
}

export async function executeSSEFSkillRuntime(
  input: ExecuteSSEFSkillRuntimeInput
): Promise<ExecuteSSEFSkillRuntimeResult> {
  await ensureSSEFReady();
  const args = asRecord(input.args);
  const trace = createSSEFTraceSession({
    runId: input.runId,
    skillId: input.record.skillId,
    version: input.record.version,
    runtime: input.record.runtime,
  });
  const policy = createSSEFSkillPolicy(input.record.manifest);
  const spawnBudget: SpawnBudget = {
    used: 0,
    max: Math.max(1, getSSEFConfig().limits.sandboxMaxProcessSpawns),
  };

  let outcome: RuntimeExecutionOutcome | null = null;
  let failure: unknown = null;

  trace.info("run.execution.started", {
    source: input.context.source,
    conversation_id: input.context.conversationId ?? null,
    session_scope_id: input.context.sessionScopeId ?? null,
  });

  try {
    const payload = buildExecutionPayload(args, input.record, input.context);
    assertContextRequirements(input.record, payload);
    outcome = await executeRuntimeSkill({
      record: input.record,
      args,
      context: input.context,
      trace,
      policy,
      spawnBudget,
    });
    trace.info("run.execution.completed", {
      duration_ms: outcome.durationMs,
      output_type: outcome.outputType,
      output_truncated: outcome.truncated,
    });
  } catch (error) {
    failure = error;
    trace.error("run.execution.failed", {
      error_code: getSSEFRuntimeErrorCode(error) ?? "runtime_failed",
      message: getSSEFRuntimeErrorMessage(error, "SSEF skill execution failed."),
    });
  }

  const persisted = await trace.persist();
  const baseRunResult: Record<string, unknown> = {
    skill_id: input.record.skillId,
    version: input.record.version,
    runtime: input.record.runtime,
    source: input.context.source,
    process_spawns_used: spawnBudget.used,
    process_spawns_limit: spawnBudget.max,
  };

  const baseRunMetadata: Record<string, unknown> = {
    trace: {
      event_count: persisted.eventCount,
      events_truncated: persisted.eventsTruncated,
      preview: persisted.preview,
    },
    execution: {
      source: input.context.source,
      conversation_id: input.context.conversationId ?? null,
      session_scope_id: input.context.sessionScopeId ?? null,
      user_intent: input.context.userIntent ?? null,
      process_spawns_used: spawnBudget.used,
      process_spawns_limit: spawnBudget.max,
    },
  };

  if (outcome && !failure) {
    return {
      ok: true,
      toolResult: outcome.toolResult,
      error: null,
      errorMessage: null,
      errorCode: null,
      policyViolation: null,
      traceLogPath: persisted.traceLogPath,
      stdoutLogPath: persisted.stdoutLogPath,
      stderrLogPath: persisted.stderrLogPath,
      runResult: {
        ...baseRunResult,
        status: "completed",
        duration_ms: outcome.durationMs,
        output_type: outcome.outputType,
        output_truncated: outcome.truncated,
      },
      runMetadata: {
        ...baseRunMetadata,
        execution: {
          ...(baseRunMetadata.execution as Record<string, unknown>),
          limits: {
            timeout_ms: outcome.limits.timeoutMs,
            max_output_chars: outcome.limits.maxOutputChars,
            max_memory_mb: outcome.limits.maxMemoryMb,
            max_cpu_seconds: outcome.limits.maxCpuSeconds,
            max_process_spawns: outcome.limits.maxProcessSpawns,
          },
          command: outcome.processCommand,
          dependency_install: outcome.dependencyInstall,
        },
      },
    };
  }

  const errorMessage = getSSEFRuntimeErrorMessage(
    failure,
    "SSEF skill execution failed."
  );
  const errorCode = getSSEFRuntimeErrorCode(failure) ?? "runtime_failed";

  return {
    ok: false,
    toolResult: null,
    error: failure,
    errorMessage,
    errorCode,
    policyViolation:
      failure instanceof SSEFPolicyViolationError ? failure.violation : null,
    traceLogPath: persisted.traceLogPath,
    stdoutLogPath: persisted.stdoutLogPath,
    stderrLogPath: persisted.stderrLogPath,
    runResult: {
      ...baseRunResult,
      status: "failed",
      error_code: errorCode,
      message: errorMessage,
    },
    runMetadata: {
      ...baseRunMetadata,
      failure: {
        code: errorCode,
        message: errorMessage,
        details:
          failure instanceof SSEFRuntimeError
            ? failure.details
            : null,
      },
    },
  };
}
