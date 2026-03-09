export type SSEFPolicyViolationCategory =
  | "filesystem"
  | "network"
  | "process"
  | "tool";

export type SSEFPolicyViolationSeverity = "low" | "medium" | "high" | "critical";

export type SSEFRuntimeErrorCode =
  | "policy_denied"
  | "runtime_timeout"
  | "runtime_failed"
  | "runtime_unavailable"
  | "invalid_context"
  | "spawn_limit_exceeded"
  | "unsupported_runtime";

export type SSEFPolicyViolation = {
  category: SSEFPolicyViolationCategory;
  severity: SSEFPolicyViolationSeverity;
  action: string;
  target: string;
  reason: string;
  details?: Record<string, unknown> | null;
};

export class SSEFRuntimeError extends Error {
  readonly code: SSEFRuntimeErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    code: SSEFRuntimeErrorCode,
    details?: Record<string, unknown> | null
  ) {
    super(message);
    this.name = "SSEFRuntimeError";
    this.code = code;
    this.details = details ?? null;
  }
}

export class SSEFPolicyViolationError extends SSEFRuntimeError {
  readonly violation: SSEFPolicyViolation;

  constructor(message: string, violation: SSEFPolicyViolation) {
    super(message, "policy_denied", {
      category: violation.category,
      severity: violation.severity,
      action: violation.action,
      target: violation.target,
      reason: violation.reason,
      ...(violation.details ?? {}),
    });
    this.name = "SSEFPolicyViolationError";
    this.violation = violation;
  }
}

export class SSEFExecutionTimeoutError extends SSEFRuntimeError {
  constructor(message: string, details?: Record<string, unknown> | null) {
    super(message, "runtime_timeout", details);
    this.name = "SSEFExecutionTimeoutError";
  }
}

export function getSSEFRuntimeErrorCode(error: unknown): SSEFRuntimeErrorCode | null {
  if (error instanceof SSEFRuntimeError) {
    return error.code;
  }
  return null;
}

export function getSSEFRuntimeErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error) {
    const text = error.message.trim();
    return text.length > 0 ? text : fallback;
  }
  return fallback;
}
