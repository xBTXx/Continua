import fs from "node:fs/promises";
import path from "node:path";
import { getSSEFConfig } from "../config";

const DEFAULT_TRACE_MAX_EVENTS = 500;
const DEFAULT_TRACE_PREVIEW_EVENTS = 25;
const MAX_TRACE_STRING_CHARS = 2_000;

export type SSEFTraceLevel = "info" | "warn" | "error";

export type SSEFTraceEvent = {
  timestamp: string;
  level: SSEFTraceLevel;
  event: string;
  data?: Record<string, unknown>;
};

export type SSEFTracePersistResult = {
  traceLogPath: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  eventCount: number;
  eventsTruncated: boolean;
  preview: SSEFTraceEvent[];
};

type RuntimeTraceInit = {
  runId: string;
  skillId: string;
  version: string;
  runtime: string;
  maxEvents?: number;
};

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[depth-limited]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_TRACE_STRING_CHARS
      ? `${value.slice(0, MAX_TRACE_STRING_CHARS)}...[truncated]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeTraceValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, 50);
    entries.forEach(([key, entry]) => {
      output[key] = sanitizeTraceValue(entry, depth + 1);
    });
    return output;
  }
  return String(value);
}

function sanitizeTraceData(value: Record<string, unknown> | undefined) {
  if (!value) {
    return undefined;
  }
  const sanitized = sanitizeTraceValue(value);
  return isRecord(sanitized) ? sanitized : undefined;
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

export class SSEFTraceSession {
  private readonly runId: string;
  private readonly skillId: string;
  private readonly version: string;
  private readonly runtime: string;
  private readonly maxEvents: number;
  private readonly config = getSSEFConfig();
  private readonly runDir: string;
  private readonly traceLogFile: string;
  private readonly stdoutLogFile: string;
  private readonly stderrLogFile: string;
  private readonly events: SSEFTraceEvent[] = [];
  private eventsTruncated = false;
  private stdout = "";
  private stderr = "";

  constructor(input: RuntimeTraceInit) {
    this.runId = input.runId;
    this.skillId = input.skillId;
    this.version = input.version;
    this.runtime = input.runtime;
    this.maxEvents = Math.max(20, Math.floor(input.maxEvents ?? DEFAULT_TRACE_MAX_EVENTS));
    this.runDir = path.join(this.config.sandboxDir, "runs", this.runId);
    this.traceLogFile = path.join(this.runDir, "trace.log");
    this.stdoutLogFile = path.join(this.runDir, "stdout.log");
    this.stderrLogFile = path.join(this.runDir, "stderr.log");

    this.info("run.trace.session_created", {
      skill_id: this.skillId,
      version: this.version,
      runtime: this.runtime,
      run_id: this.runId,
    });
  }

  info(event: string, data?: Record<string, unknown>) {
    this.add("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>) {
    this.add("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>) {
    this.add("error", event, data);
  }

  recordPolicyDecision(input: {
    allowed: boolean;
    category: string;
    action: string;
    target: string;
    reason: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    this.add(input.allowed ? "info" : "warn", "policy.decision", {
      allowed: input.allowed,
      category: input.category,
      action: input.action,
      target: input.target,
      reason: input.reason,
      message: input.message,
      ...(input.details ?? {}),
    });
  }

  setProcessLogs(stdout: string, stderr: string) {
    this.stdout = stdout;
    this.stderr = stderr;
  }

  private add(level: SSEFTraceLevel, event: string, data?: Record<string, unknown>) {
    if (this.events.length >= this.maxEvents) {
      this.eventsTruncated = true;
      return;
    }
    const normalizedEvent = asNonEmptyText(event) ?? "runtime.event";
    this.events.push({
      timestamp: new Date().toISOString(),
      level,
      event: normalizedEvent,
      data: sanitizeTraceData(data),
    });
  }

  async persist(): Promise<SSEFTracePersistResult> {
    await fs.mkdir(this.runDir, { recursive: true });

    if (this.eventsTruncated) {
      this.events.push({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "run.trace.events_truncated",
        data: {
          max_events: this.maxEvents,
        },
      });
    }

    const traceContent = this.events.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(this.traceLogFile, traceContent ? `${traceContent}\n` : "", "utf8");

    const stdoutText = asNonEmptyText(this.stdout);
    const stderrText = asNonEmptyText(this.stderr);

    if (stdoutText) {
      await fs.writeFile(this.stdoutLogFile, `${stdoutText}\n`, "utf8");
    }
    if (stderrText) {
      await fs.writeFile(this.stderrLogFile, `${stderrText}\n`, "utf8");
    }

    const preview = this.events.slice(-DEFAULT_TRACE_PREVIEW_EVENTS);

    return {
      traceLogPath: toWorkspaceRelativePath(this.config.workspaceRoot, this.traceLogFile),
      stdoutLogPath: stdoutText
        ? toWorkspaceRelativePath(this.config.workspaceRoot, this.stdoutLogFile)
        : null,
      stderrLogPath: stderrText
        ? toWorkspaceRelativePath(this.config.workspaceRoot, this.stderrLogFile)
        : null,
      eventCount: this.events.length,
      eventsTruncated: this.eventsTruncated,
      preview,
    };
  }
}

export function createSSEFTraceSession(input: RuntimeTraceInit) {
  return new SSEFTraceSession(input);
}
