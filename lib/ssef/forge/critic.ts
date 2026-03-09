import type { SkillManifestV1 } from "../contracts/manifest";
import type { SSEFProposal } from "../repository";
import type { SSEFForgeGeneratedArtifacts } from "./generator";
import type { SSEFForgeSandboxResult } from "./sandboxRunner";
import { readSSEFProposalUpgradeTarget } from "../proposals/upgrade";

type CriticCheckSeverity = "info" | "warning" | "error";
type SafetySeverity = "low" | "medium" | "high" | "critical";

export type SSEFForgeFunctionalCheck = {
  id: string;
  passed: boolean;
  required: boolean;
  severity: CriticCheckSeverity;
  detail: string;
};

export type SSEFForgeFunctionalCriticReport = {
  critic: "functional";
  verdict: "pass" | "fail";
  score: number;
  summary: string;
  checks: SSEFForgeFunctionalCheck[];
};

export type SSEFForgeSafetyFinding = {
  id: string;
  severity: SafetySeverity;
  detail: string;
  snippet?: string;
};

export type SSEFForgeSafetyCriticReport = {
  critic: "safety";
  verdict: "pass" | "fail";
  riskLevel: SafetySeverity;
  summary: string;
  findings: SSEFForgeSafetyFinding[];
};

export type RunSSEFForgeCriticsInput = {
  proposal: SSEFProposal;
  artifacts: SSEFForgeGeneratedArtifacts;
  sandboxResult: SSEFForgeSandboxResult;
};

export type SSEFForgeCriticResult = {
  functional: SSEFForgeFunctionalCriticReport;
  safety: SSEFForgeSafetyCriticReport;
};

const SAFETY_PATTERN_RULES: Array<{
  id: string;
  pattern: RegExp;
  severity: SafetySeverity;
  detail: string;
}> = [
  {
    id: "dangerous_shell_delete",
    pattern: /\brm\s+-rf\b|\bdel\s+\/f\b|\bformat\b/i,
    severity: "critical",
    detail: "Detected destructive shell command pattern.",
  },
  {
    id: "explicit_spawn_usage",
    pattern: /\bchild_process\b|\bexecSync?\s*\(|\bspawnSync?\s*\(/i,
    severity: "high",
    detail: "Detected explicit process spawning logic.",
  },
  {
    id: "network_literal",
    pattern: /\bhttps?:\/\/[^\s"'`]+/i,
    severity: "medium",
    detail: "Detected hard-coded network endpoint.",
  },
  {
    id: "secrets_env_access",
    pattern: /\bprocess\.env\b/i,
    severity: "medium",
    detail: "Detected environment variable access.",
  },
  {
    id: "direct_fs_write",
    pattern: /\bfs\.(writeFile|appendFile|rm|unlink|rename|copyFile)\b/i,
    severity: "medium",
    detail: "Detected direct filesystem write/modify APIs.",
  },
];

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  return value
    .map((entry) => asNonEmptyText(entry))
    .filter(Boolean);
}

function clipText(value: string, maxChars = 300) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeDesiredOutcome(proposal: SSEFProposal) {
  const spark = proposal.spark ?? {};
  return (
    asNonEmptyText(spark.desired_outcome) ||
    asNonEmptyText(spark.desiredOutcome) ||
    asNonEmptyText(spark.outcome) ||
    asNonEmptyText(spark.goal) ||
    "requested outcome"
  );
}

function buildFunctionalCriticReport(input: RunSSEFForgeCriticsInput) {
  const upgradeTarget = readSSEFProposalUpgradeTarget(input.proposal);
  const baselineInputKeys = asStringList(input.artifacts.metadata.baseline_input_keys);
  const manifestInputKeys = Object.keys(
    asRecord(asRecord(input.artifacts.manifest.inputs_schema).properties)
  );
  const missingBaselineInputKeys = baselineInputKeys.filter(
    (key) => !manifestInputKeys.includes(key)
  );
  const desiredOutcome = normalizeDesiredOutcome(input.proposal);
  const keywordTokens = desiredOutcome
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 4);
  const textualSurface = [
    input.artifacts.manifest.description,
    input.artifacts.entrypointContent,
  ]
    .join(" ")
    .toLowerCase();
  const foundKeywords = keywordTokens.filter((token) =>
    textualSurface.includes(token)
  );

  const checks: SSEFForgeFunctionalCheck[] = [
    {
      id: "sandbox_tests_passed",
      passed: input.sandboxResult.passed,
      required: true,
      severity: "error",
      detail: input.sandboxResult.passed
        ? "Sandbox test suite passed."
        : `Sandbox tests failed (${input.sandboxResult.failedCases}/${input.sandboxResult.totalCases} failed).`,
    },
    {
      id: "deterministic_test_count",
      passed: input.artifacts.testCases.length >= 2,
      required: true,
      severity: "error",
      detail:
        input.artifacts.testCases.length >= 2
          ? `Test coverage includes ${input.artifacts.testCases.length} deterministic cases.`
          : "At least 2 deterministic test cases are required.",
    },
    {
      id: "upgrade_input_schema_compatibility",
      passed: missingBaselineInputKeys.length === 0,
      required: Boolean(upgradeTarget),
      severity: upgradeTarget ? "error" : "info",
      detail: upgradeTarget
        ? missingBaselineInputKeys.length === 0
          ? "Upgrade preserved baseline input-schema keys."
          : `Upgrade dropped baseline input keys: ${missingBaselineInputKeys.join(", ")}.`
        : "Not an upgrade proposal; compatibility check informational only.",
    },
    {
      id: "desired_outcome_alignment",
      passed: foundKeywords.length > 0,
      required: false,
      severity: "warning",
      detail:
        foundKeywords.length > 0
          ? `Generated artifacts align with requested outcome keywords: ${foundKeywords.join(", ")}.`
          : "Generated artifacts do not clearly reference requested outcome keywords.",
    },
  ];

  const passedCount = checks.filter((check) => check.passed).length;
  const score = Number((passedCount / checks.length).toFixed(3));
  const requiredChecksPassed = checks
    .filter((check) => check.required)
    .every((check) => check.passed);
  const verdict: "pass" | "fail" = requiredChecksPassed ? "pass" : "fail";

  return {
    critic: "functional" as const,
    verdict,
    score,
    summary:
      verdict === "pass"
        ? "Functional critic passed: deterministic behavior validated in sandbox."
        : "Functional critic failed: required deterministic checks did not pass.",
    checks,
  };
}

function safetySeverityRank(value: SafetySeverity) {
  if (value === "critical") {
    return 4;
  }
  if (value === "high") {
    return 3;
  }
  if (value === "medium") {
    return 2;
  }
  return 1;
}

function maxSafetySeverity(values: SafetySeverity[]): SafetySeverity {
  if (values.length === 0) {
    return "low";
  }
  return values.reduce((highest, current) =>
    safetySeverityRank(current) > safetySeverityRank(highest)
      ? current
      : highest
  );
}

function collectPermissionFindings(manifest: SkillManifestV1) {
  const findings: SSEFForgeSafetyFinding[] = [];

  manifest.permissions.forEach((permission, index) => {
    if (permission.kind === "filesystem") {
      const hasBroadWrite = permission.paths.some((entry) => entry === "/");
      if (hasBroadWrite && (permission.scope === "write" || permission.scope === "read_write")) {
        findings.push({
          id: `permission_filesystem_broad_write_${index}`,
          severity: "high",
          detail:
            "Filesystem permission allows broad write access ('/'). Review least-privilege policy.",
        });
      }
      return;
    }

    if (permission.kind === "network") {
      if (permission.hosts.some((host) => host === "*")) {
        findings.push({
          id: `permission_network_wildcard_${index}`,
          severity: "high",
          detail: "Network permission includes wildcard host '*'.",
        });
      }
      return;
    }

    if (permission.kind === "process") {
      if (permission.commands.some((command) => command.trim() === "*")) {
        findings.push({
          id: `permission_process_wildcard_${index}`,
          severity: "high",
          detail: "Process permission includes wildcard command '*'.",
        });
      }
      if (permission.max_runtime_ms && permission.max_runtime_ms > 60_000) {
        findings.push({
          id: `permission_process_runtime_high_${index}`,
          severity: "medium",
          detail:
            "Process max_runtime_ms is high; consider tighter runtime envelope for sandboxed skills.",
        });
      }
    }
  });

  return findings;
}

function collectPatternFindings(entrypoint: string) {
  const findings: SSEFForgeSafetyFinding[] = [];

  SAFETY_PATTERN_RULES.forEach((rule) => {
    const match = entrypoint.match(rule.pattern);
    if (!match) {
      return;
    }
    findings.push({
      id: rule.id,
      severity: rule.severity,
      detail: rule.detail,
      snippet: clipText(match[0], 120),
    });
  });

  return findings;
}

function buildSafetyCriticReport(input: RunSSEFForgeCriticsInput) {
  const patternFindings = collectPatternFindings(input.artifacts.entrypointContent);
  const permissionFindings = collectPermissionFindings(input.artifacts.manifest);
  const findings = [...patternFindings, ...permissionFindings];
  const riskLevel = maxSafetySeverity(findings.map((finding) => finding.severity));
  const hasBlockingRisk =
    riskLevel === "high" || riskLevel === "critical";
  const verdict: "pass" | "fail" = hasBlockingRisk ? "fail" : "pass";

  return {
    critic: "safety" as const,
    verdict,
    riskLevel,
    summary:
      findings.length === 0
        ? "Safety critic passed: no suspicious patterns or broad permissions found."
        : verdict === "pass"
          ? `Safety critic passed with ${findings.length} advisory finding(s).`
          : `Safety critic failed with ${findings.length} elevated risk finding(s).`,
    findings,
  };
}

export function runSSEFForgeCritics(
  input: RunSSEFForgeCriticsInput
): SSEFForgeCriticResult {
  const functional = buildFunctionalCriticReport(input);
  const safety = buildSafetyCriticReport(input);

  return {
    functional,
    safety,
  };
}
