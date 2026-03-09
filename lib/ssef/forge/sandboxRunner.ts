import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getSSEFConfig } from "../config";
import { ensureSSEFSkillRuntimeDependencies } from "../runtime/dependencies";
import type {
  SSEFForgeGeneratedArtifacts,
  SSEFForgeTestCase,
  SSEFForgeTestCaseAssertion,
} from "./generator";

type ScriptExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
};

export type SSEFForgeSandboxAssertionResult = {
  kind: SSEFForgeTestCaseAssertion["kind"];
  path: string;
  passed: boolean;
  message: string;
};

export type SSEFForgeSandboxCaseResult = {
  id: string;
  description: string;
  passed: boolean;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  parseError: string | null;
  assertions: SSEFForgeSandboxAssertionResult[];
  stdoutPreview: string;
  stderrPreview: string;
};

export type SSEFForgeSandboxResult = {
  passed: boolean;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  cases: SSEFForgeSandboxCaseResult[];
  diagnostics: string[];
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  traceLogPath: string | null;
};

export type RunSSEFForgeSandboxTestsInput = {
  runId: string;
  attempt: number;
  attemptDir: string;
  artifacts: SSEFForgeGeneratedArtifacts;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clipText(value: string, maxChars = 400) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string) {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative === ".") {
    return "/";
  }
  if (relative.startsWith(`..${path.sep}`) || relative === "..") {
    return absolutePath;
  }
  return `/${relative.split(path.sep).join("/")}`;
}

function parsePathParts(pathInput: string) {
  return pathInput
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolvePathValue(payload: unknown, pathInput: string) {
  const parts = parsePathParts(pathInput);
  let current: unknown = payload;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { exists: false as const, value: undefined as unknown };
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return { exists: false as const, value: undefined as unknown };
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false as const, value: undefined as unknown };
    }
    current = current[part];
  }

  return {
    exists: true as const,
    value: current,
  };
}

function evaluateAssertion(
  output: unknown,
  assertion: SSEFForgeTestCaseAssertion
): SSEFForgeSandboxAssertionResult {
  const resolved = resolvePathValue(output, assertion.path);
  if (assertion.kind === "path_exists") {
    return {
      kind: assertion.kind,
      path: assertion.path,
      passed: resolved.exists,
      message: resolved.exists
        ? `Path '${assertion.path}' exists.`
        : `Path '${assertion.path}' is missing.`,
    };
  }

  if (!resolved.exists) {
    return {
      kind: assertion.kind,
      path: assertion.path,
      passed: false,
      message: `Path '${assertion.path}' is missing.`,
    };
  }

  if (assertion.kind === "equals") {
    const passed = resolved.value === assertion.value;
    return {
      kind: assertion.kind,
      path: assertion.path,
      passed,
      message: passed
        ? `Path '${assertion.path}' equals expected value.`
        : `Path '${assertion.path}' mismatch. Expected '${String(assertion.value)}', got '${String(resolved.value)}'.`,
    };
  }

  if (assertion.kind === "contains") {
    const value = typeof resolved.value === "string" ? resolved.value : "";
    const passed = value.toLowerCase().includes(assertion.value.toLowerCase());
    return {
      kind: assertion.kind,
      path: assertion.path,
      passed,
      message: passed
        ? `Path '${assertion.path}' contains expected text.`
        : `Path '${assertion.path}' does not include '${assertion.value}'.`,
    };
  }

  const list = Array.isArray(resolved.value) ? resolved.value : [];
  const passed = list.some((entry) => entry === assertion.value);
  return {
    kind: assertion.kind,
    path: assertion.path,
    passed,
    message: passed
      ? `Path '${assertion.path}' includes expected value.`
      : `Path '${assertion.path}' does not include '${String(assertion.value)}'.`,
  };
}

async function runScript(params: {
  command: string;
  args: string[];
  cwd: string;
  stdinPayload: Record<string, unknown>;
  timeoutMs: number;
  maxOutputChars: number;
  env: NodeJS.ProcessEnv;
}): Promise<ScriptExecutionResult> {
  const startedAt = Date.now();

  return new Promise<ScriptExecutionResult>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;

    const appendChunk = (chunk: Buffer | string, target: "stdout" | "stderr") => {
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
      const clipped = text.length > remaining ? text.slice(0, remaining) : text;
      if (clipped.length < text.length) {
        truncated = true;
      }
      if (target === "stdout") {
        stdout += clipped;
      } else {
        stderr += clipped;
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
      child.stdin.write(JSON.stringify(params.stdinPayload));
      child.stdin.end();
    } catch (error) {
      clearTimeout(timeoutHandle);
      child.kill("SIGKILL");
      reject(error);
    }
  });
}

function parseStructuredOutput(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      value: null as unknown,
      parseError: "stdout was empty.",
    };
  }
  try {
    return {
      value: JSON.parse(trimmed) as unknown,
      parseError: null as string | null,
    };
  } catch {
    return {
      value: trimmed,
      parseError: "stdout is not valid JSON.",
    };
  }
}

async function runSingleCase(params: {
  attemptDir: string;
  testCase: SSEFForgeTestCase;
  command: string;
  commandArgs: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
}): Promise<SSEFForgeSandboxCaseResult> {
  const execution = await runScript({
    command: params.command,
    args: params.commandArgs,
    cwd: params.attemptDir,
    stdinPayload: {
      args: params.testCase.input,
      _context: {
        source: "forge_sandbox",
        executed_at: new Date().toISOString(),
      },
    },
    timeoutMs: params.timeoutMs,
    maxOutputChars: params.maxOutputChars,
    env: params.env,
  });

  const parsed = parseStructuredOutput(execution.stdout);
  const assertions =
    execution.timedOut || execution.exitCode !== 0 || parsed.parseError
      ? [
          {
            kind: "path_exists" as const,
            path: "status",
            passed: false,
            message: execution.timedOut
              ? "Execution timed out."
              : execution.exitCode !== 0
                ? `Execution exited with non-zero code ${String(execution.exitCode)}.`
                : parsed.parseError ?? "Execution did not return valid JSON output.",
          },
        ]
      : params.testCase.assertions.map((assertion) =>
          evaluateAssertion(parsed.value, assertion)
        );

  const passed = assertions.every((assertion) => assertion.passed);
  const stderrSuffix = execution.truncated ? "\n[output truncated]" : "";

  return {
    id: params.testCase.id,
    description: params.testCase.description,
    passed,
    durationMs: execution.durationMs,
    timedOut: execution.timedOut,
    exitCode: execution.exitCode,
    signal: execution.signal,
    parseError: parsed.parseError,
    assertions,
    stdoutPreview: clipText(execution.stdout, 500),
    stderrPreview: clipText(`${execution.stderr}${stderrSuffix}`, 500),
  };
}

async function writeOptionalLog(pathname: string, content: string) {
  const text = asNonEmptyText(content);
  if (!text) {
    return false;
  }
  await fs.writeFile(pathname, `${text}\n`, "utf8");
  return true;
}

function resolveSandboxCommand(params: {
  runtime: string;
  runtimeEnv: NodeJS.ProcessEnv;
}) {
  if (params.runtime === "node") {
    return "node";
  }
  if (params.runtime === "python") {
    const candidates = [
      typeof params.runtimeEnv.SSEF_PYTHON_BIN === "string"
        ? params.runtimeEnv.SSEF_PYTHON_BIN
        : "",
      typeof process.env.SSEF_PYTHON_BIN === "string"
        ? process.env.SSEF_PYTHON_BIN
        : "",
      "python3",
      "python",
    ]
      .map((entry) => entry.trim())
      .filter(Boolean);
    return candidates[0] ?? "python3";
  }
  return null;
}

export async function runSSEFForgeSandboxTests(
  input: RunSSEFForgeSandboxTestsInput
): Promise<SSEFForgeSandboxResult> {
  const config = getSSEFConfig();
  await fs.mkdir(input.attemptDir, { recursive: true });
  const entrypointPath = path.resolve(input.attemptDir, input.artifacts.entrypointFileName);
  const timeoutMs = Math.max(1_000, Math.floor(config.limits.sandboxTimeoutMs));
  const maxOutputChars = Math.max(2_000, Math.floor(config.limits.sandboxMaxOutputChars));
  const dependencyInstall = await ensureSSEFSkillRuntimeDependencies({
    versionRoot: input.attemptDir,
    manifest: input.artifacts.manifest,
    mode: "forge_sandbox",
    allowInstall: true,
  });

  const startedAt = Date.now();
  const caseResults: SSEFForgeSandboxCaseResult[] = [];
  const dependencyDiagnostics = dependencyInstall.logs.slice(0, 12);

  if (dependencyInstall.status === "failed") {
    const failureMessage =
      dependencyInstall.error ??
      "Runtime dependency installation failed in forge sandbox.";
    const failedCase: SSEFForgeSandboxCaseResult = {
      id: "dependency_installation",
      description: "Runtime dependency provisioning before sandbox tests.",
      passed: false,
      durationMs: 0,
      timedOut: false,
      exitCode: null,
      signal: null,
      parseError: failureMessage,
      assertions: [
        {
          kind: "path_exists",
          path: "status",
          passed: false,
          message: failureMessage,
        },
      ],
      stdoutPreview: dependencyDiagnostics.join("\n"),
      stderrPreview: failureMessage,
    };

    const stdoutCombined = [
      "--- dependency_installation ---",
      failedCase.stdoutPreview || "(no stdout)",
    ].join("\n");
    const stderrCombined = [
      "--- dependency_installation ---",
      failedCase.stderrPreview || "(no stderr)",
    ].join("\n");
    const traceCombined = JSON.stringify({
      timestamp: new Date().toISOString(),
      run_id: input.runId,
      attempt: input.attempt,
      test_case_id: failedCase.id,
      passed: false,
      dependency_failure: true,
      message: failureMessage,
    });

    const stdoutLogFile = path.join(input.attemptDir, "sandbox_stdout.log");
    const stderrLogFile = path.join(input.attemptDir, "sandbox_stderr.log");
    const traceLogFile = path.join(input.attemptDir, "sandbox_trace.log");

    const hasStdout = await writeOptionalLog(stdoutLogFile, stdoutCombined);
    const hasStderr = await writeOptionalLog(stderrLogFile, stderrCombined);
    const hasTrace = await writeOptionalLog(traceLogFile, traceCombined);

    return {
      passed: false,
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      durationMs: Date.now() - startedAt,
      cases: [failedCase],
      diagnostics: [
        `[dependency_installation] ${failureMessage} (dependency_preflight @ runtime_dependencies)`,
        ...dependencyDiagnostics.map((line) => `[dependency_installation] ${line}`),
      ],
      stdoutLogPath: hasStdout
        ? toWorkspaceRelativePath(config.workspaceRoot, stdoutLogFile)
        : null,
      stderrLogPath: hasStderr
        ? toWorkspaceRelativePath(config.workspaceRoot, stderrLogFile)
        : null,
      traceLogPath: hasTrace
        ? toWorkspaceRelativePath(config.workspaceRoot, traceLogFile)
        : null,
    };
  }

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SSEF_RUNTIME_MODE: "forge_sandbox",
    SSEF_SKILL_ID: input.artifacts.skillId,
    SSEF_SKILL_VERSION: input.artifacts.version,
    ...dependencyInstall.runtimeEnv,
  };
  const sandboxCommand = resolveSandboxCommand({
    runtime: input.artifacts.manifest.runtime,
    runtimeEnv,
  });
  if (!sandboxCommand) {
    const message = `Unsupported forge sandbox runtime: ${input.artifacts.manifest.runtime}`;
    return {
      passed: false,
      totalCases: 1,
      passedCases: 0,
      failedCases: 1,
      durationMs: Date.now() - startedAt,
      cases: [
        {
          id: "unsupported_runtime",
          description: "Forge sandbox runtime compatibility check.",
          passed: false,
          durationMs: 0,
          timedOut: false,
          exitCode: null,
          signal: null,
          parseError: message,
          assertions: [
            {
              kind: "path_exists",
              path: "status",
              passed: false,
              message,
            },
          ],
          stdoutPreview: "",
          stderrPreview: message,
        },
      ],
      diagnostics: [`[unsupported_runtime] ${message} (runtime_check @ runtime)`],
      stdoutLogPath: null,
      stderrLogPath: null,
      traceLogPath: null,
    };
  }

  for (const testCase of input.artifacts.testCases) {
    const result = await runSingleCase({
      attemptDir: input.attemptDir,
      testCase,
      command: sandboxCommand,
      commandArgs: [entrypointPath],
      env: runtimeEnv,
      timeoutMs,
      maxOutputChars,
    });
    caseResults.push(result);
  }

  const passedCases = caseResults.filter((result) => result.passed).length;
  const failedCases = caseResults.length - passedCases;
  const passed = failedCases === 0 && caseResults.length > 0;

  const diagnostics = caseResults
    .filter((result) => !result.passed)
    .flatMap((result) =>
      result.assertions
        .filter((assertion) => !assertion.passed)
        .map(
          (assertion) =>
            `[${result.id}] ${assertion.message} (${assertion.kind} @ ${assertion.path})`
        )
    );

  const stdoutCombined = caseResults
    .map((result) =>
      [
        `--- ${result.id} ---`,
        result.stdoutPreview || "(no stdout)",
      ].join("\n")
    )
    .join("\n\n");
  const stderrCombined = caseResults
    .map((result) =>
      [
        `--- ${result.id} ---`,
        result.stderrPreview || "(no stderr)",
      ].join("\n")
    )
    .join("\n\n");
  const traceCombined = caseResults
    .map((result) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        run_id: input.runId,
        attempt: input.attempt,
        test_case_id: result.id,
        passed: result.passed,
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        exit_code: result.exitCode,
        assertions: result.assertions,
      })
    )
    .join("\n");

  const stdoutLogFile = path.join(input.attemptDir, "sandbox_stdout.log");
  const stderrLogFile = path.join(input.attemptDir, "sandbox_stderr.log");
  const traceLogFile = path.join(input.attemptDir, "sandbox_trace.log");

  const hasStdout = await writeOptionalLog(stdoutLogFile, stdoutCombined);
  const hasStderr = await writeOptionalLog(stderrLogFile, stderrCombined);
  const hasTrace = await writeOptionalLog(traceLogFile, traceCombined);

  return {
    passed,
    totalCases: caseResults.length,
    passedCases,
    failedCases,
    durationMs: Date.now() - startedAt,
    cases: caseResults,
    diagnostics,
    stdoutLogPath: hasStdout
      ? toWorkspaceRelativePath(config.workspaceRoot, stdoutLogFile)
      : null,
    stderrLogPath: hasStderr
      ? toWorkspaceRelativePath(config.workspaceRoot, stderrLogFile)
      : null,
    traceLogPath: hasTrace
      ? toWorkspaceRelativePath(config.workspaceRoot, traceLogFile)
      : null,
  };
}
