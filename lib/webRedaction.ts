const REDACTED_VALUE = "[REDACTED]";
const MAX_REDACTION_DEPTH = 8;

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /^pass$/i,
  /token/i,
  /secret/i,
  /authorization/i,
  /cookie/i,
  /api[_-]?key/i,
  /session/i,
];

const TOKEN_LIKE_VALUE_PATTERNS = [
  /bearer\s+[a-z0-9._~+\/-]+=*/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:^|\b)(?:sk|pk|rk|xoxb|xoxp|ghp|gho|ghu|github_pat)_[A-Za-z0-9_\-]{10,}(?:\b|$)/,
  /(?:^|\b)[A-Fa-f0-9]{32,}(?:\b|$)/,
];

function redactionEnabled() {
  return process.env.WEB_LOG_REDACTION_ENABLED !== "false";
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function looksSensitiveString(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (/^(password|pass|token|secret|authorization|cookie|api[_-]?key|session)\s*[:=]/i.test(normalized)) {
    return true;
  }
  return TOKEN_LIKE_VALUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function redactString(value: string, forceRedact: boolean) {
  if (forceRedact || looksSensitiveString(value)) {
    return REDACTED_VALUE;
  }
  return value;
}

function redactInternal(
  input: unknown,
  options: { parentKeySensitive: boolean; depth: number }
): unknown {
  if (input === null || typeof input === "undefined") {
    return input;
  }

  if (typeof input === "string") {
    return redactString(input, options.parentKeySensitive);
  }

  if (typeof input !== "object") {
    return options.parentKeySensitive ? REDACTED_VALUE : input;
  }

  if (options.depth >= MAX_REDACTION_DEPTH) {
    return "[REDACTION_DEPTH_LIMIT]";
  }

  if (Array.isArray(input)) {
    return input.map((entry) =>
      redactInternal(entry, {
        parentKeySensitive: options.parentKeySensitive,
        depth: options.depth + 1,
      })
    );
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const keySensitive = options.parentKeySensitive || isSensitiveKey(key);
    result[key] = redactInternal(value, {
      parentKeySensitive: keySensitive,
      depth: options.depth + 1,
    });
  }

  return result;
}

export function redactSensitivePayload(input: unknown) {
  if (!redactionEnabled()) {
    return input;
  }
  return redactInternal(input, { parentKeySensitive: false, depth: 0 });
}

export function redactToolLogPayload({
  args,
  result,
  metadata,
}: {
  args?: unknown;
  result?: unknown;
  metadata?: unknown;
}) {
  if (!redactionEnabled()) {
    return {
      args,
      result,
      metadata,
    };
  }

  return {
    args: redactSensitivePayload(args),
    result: redactSensitivePayload(result),
    metadata: redactSensitivePayload(metadata),
  };
}
