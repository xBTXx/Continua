import type { SkillManifestV1 } from "../contracts/manifest";
import type { SSEFForgeFunctionalCriticReport, SSEFForgeSafetyCriticReport } from "./critic";
import type { SSEFForgeSandboxResult } from "./sandboxRunner";

export type SSEFForgeLifecycleDecision = "sandbox_passed" | "review_pending";

export type BuildSSEFSecuritySummaryInput = {
  manifest: SkillManifestV1;
  sandboxResult: SSEFForgeSandboxResult;
  functionalCritic: SSEFForgeFunctionalCriticReport;
  safetyCritic: SSEFForgeSafetyCriticReport;
  selectedAttempt: number;
  maxAttempts: number;
};

export type SSEFSecuritySummaryArtifact = {
  generated_at: string;
  lifecycle_decision: SSEFForgeLifecycleDecision;
  selected_attempt: number;
  max_attempts: number;
  sandbox: {
    passed: boolean;
    total_cases: number;
    passed_cases: number;
    failed_cases: number;
    diagnostics: string[];
  };
  critics: {
    functional: {
      verdict: "pass" | "fail";
      score: number;
      summary: string;
      failed_checks: string[];
    };
    safety: {
      verdict: "pass" | "fail";
      risk_level: "low" | "medium" | "high" | "critical";
      summary: string;
      findings: Array<{
        id: string;
        severity: "low" | "medium" | "high" | "critical";
        detail: string;
      }>;
    };
  };
  permissions: {
    total: number;
    filesystem: number;
    network: number;
    process: number;
    tool: number;
  };
};

function decideLifecycleState(
  sandboxResult: SSEFForgeSandboxResult,
  functionalCritic: SSEFForgeFunctionalCriticReport,
  safetyCritic: SSEFForgeSafetyCriticReport
): SSEFForgeLifecycleDecision {
  const canProceedToReview =
    sandboxResult.passed &&
    functionalCritic.verdict === "pass" &&
    safetyCritic.verdict === "pass";
  return canProceedToReview ? "review_pending" : "sandbox_passed";
}

function countPermissionsByKind(manifest: SkillManifestV1) {
  let filesystem = 0;
  let network = 0;
  let process = 0;
  let tool = 0;
  manifest.permissions.forEach((permission) => {
    if (permission.kind === "filesystem") {
      filesystem += 1;
      return;
    }
    if (permission.kind === "network") {
      network += 1;
      return;
    }
    if (permission.kind === "process") {
      process += 1;
      return;
    }
    tool += 1;
  });
  return {
    total: manifest.permissions.length,
    filesystem,
    network,
    process,
    tool,
  };
}

export function buildSSEFSecuritySummary(
  input: BuildSSEFSecuritySummaryInput
): SSEFSecuritySummaryArtifact {
  const lifecycleDecision = decideLifecycleState(
    input.sandboxResult,
    input.functionalCritic,
    input.safetyCritic
  );
  const permissions = countPermissionsByKind(input.manifest);

  return {
    generated_at: new Date().toISOString(),
    lifecycle_decision: lifecycleDecision,
    selected_attempt: input.selectedAttempt,
    max_attempts: input.maxAttempts,
    sandbox: {
      passed: input.sandboxResult.passed,
      total_cases: input.sandboxResult.totalCases,
      passed_cases: input.sandboxResult.passedCases,
      failed_cases: input.sandboxResult.failedCases,
      diagnostics: input.sandboxResult.diagnostics.slice(0, 50),
    },
    critics: {
      functional: {
        verdict: input.functionalCritic.verdict,
        score: input.functionalCritic.score,
        summary: input.functionalCritic.summary,
        failed_checks: input.functionalCritic.checks
          .filter((check) => !check.passed)
          .map((check) => `${check.id}: ${check.detail}`)
          .slice(0, 20),
      },
      safety: {
        verdict: input.safetyCritic.verdict,
        risk_level: input.safetyCritic.riskLevel,
        summary: input.safetyCritic.summary,
        findings: input.safetyCritic.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          detail: finding.detail,
        })),
      },
    },
    permissions,
  };
}

export function resolveSSEFFinalLifecycleFromSecuritySummary(
  summary: SSEFSecuritySummaryArtifact
) {
  return summary.lifecycle_decision;
}
