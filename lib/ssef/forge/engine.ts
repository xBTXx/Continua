import fs from "node:fs/promises";
import path from "node:path";
import { appendSSEFAuditEvent } from "../audit";
import { ensureSSEFReady } from "../bootstrap";
import {
  getSSEFConfig,
  SSEF_FORGE_REASONING_EFFORTS,
  type SSEFForgeReasoningEffort,
} from "../config";
import {
  createSSEFRun,
  createSSEFSkillVersionFromManifest,
  getSSEFProposalById,
  getSSEFRunById,
  listSSEFRuns,
  updateSSEFProposalStatus,
  updateSSEFRunStatus,
  type SSEFProposal,
  type SSEFRun,
} from "../repository";
import { runSSEFForgeCritics } from "./critic";
import {
  generateSSEFForgeArtifacts,
  type SSEFForgeGeneratedArtifacts,
  type SSEFForgeGenerationFeedback,
  type SSEFForgeGenerationOptions,
  type SSEFForgeReuseSuggestion,
} from "./generator";
import {
  runSSEFForgeSandboxTests,
  type SSEFForgeSandboxResult,
} from "./sandboxRunner";
import {
  buildSSEFSecuritySummary,
  resolveSSEFFinalLifecycleFromSecuritySummary,
  type SSEFSecuritySummaryArtifact,
} from "./securitySummary";
import {
  buildSSEFReuseQueryFromSpark,
  recommendSSEFReuseStrategy,
  type SSEFReuseCandidate,
} from "../retrieval/search";
import { readSSEFProposalUpgradeTarget } from "../proposals/upgrade";

type SSEFForgeAttemptOutcome = {
  attempt: number;
  attemptRunId: string;
  artifacts: SSEFForgeGeneratedArtifacts;
  sandbox: SSEFForgeSandboxResult;
  critics: ReturnType<typeof runSSEFForgeCritics>;
  attemptDir: string;
};

type SSEFForgeAttemptSummary = {
  attempt: number;
  attemptRunId: string;
  status: "review_ready" | "sandbox_passed" | "failed";
  sandboxPassed: boolean | null;
  totalCases: number | null;
  passedCases: number | null;
  failedCases: number | null;
  functionalVerdict: "pass" | "fail" | null;
  safetyVerdict: "pass" | "fail" | null;
  safetyRiskLevel: "low" | "medium" | "high" | "critical" | null;
  diagnostics: string[];
  caseFailures: Array<{
    id: string;
    description: string;
    assertions: string[];
    parseError: string | null;
    timedOut: boolean;
    exitCode: number | null;
  }>;
  failureMessage: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  traceLogPath: string | null;
};

export type ProcessSSEFForgeRunInput = {
  runId: string;
  actor?: string;
  generationModel?: string;
  reasoningEffort?: SSEFForgeReasoningEffort;
};

export type ProcessSSEFForgeQueueInput = {
  maxJobs?: number;
  actor?: string;
  generationModel?: string;
  reasoningEffort?: SSEFForgeReasoningEffort;
};

export type SSEFForgeRunProcessResult = {
  runId: string;
  proposalId: string | null;
  status: "completed" | "failed" | "skipped";
  attemptsExecuted: number;
  selectedAttempt: number | null;
  lifecycleState: "sandbox_passed" | "review_pending" | null;
  skillId: string | null;
  version: string | null;
  message: string;
};

export type SSEFForgeQueueProcessResult = {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  items: SSEFForgeRunProcessResult[];
};

function asNonEmptyText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeRecords(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
) {
  return {
    ...(base ?? {}),
    ...patch,
  };
}

function toSafeMaxJobs(value: number | undefined) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(20, Math.max(1, Math.floor(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: SSEFForgeReasoningEffort
): SSEFForgeReasoningEffort {
  const normalized = asNonEmptyText(typeof value === "string" ? value : null)?.toLowerCase();
  if (
    normalized &&
    SSEF_FORGE_REASONING_EFFORTS.includes(normalized as SSEFForgeReasoningEffort)
  ) {
    return normalized as SSEFForgeReasoningEffort;
  }
  return fallback;
}

function extractGenerationOptionsFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): Partial<SSEFForgeGenerationOptions> {
  const source = asRecord(metadata);
  const nested = asRecord(source.generation);
  const model =
    asNonEmptyText(typeof nested.model === "string" ? nested.model : null) ??
    asNonEmptyText(typeof source.generation_model === "string" ? source.generation_model : null);
  const reasoningEffort =
    asNonEmptyText(
      typeof nested.reasoning_effort === "string" ? nested.reasoning_effort : null
    ) ??
    asNonEmptyText(
      typeof source.generation_reasoning_effort === "string"
        ? source.generation_reasoning_effort
        : null
    );
  return {
    model: model ?? undefined,
    reasoningEffort: reasoningEffort as SSEFForgeReasoningEffort | undefined,
  };
}

function resolveForgeGenerationOptions(params: {
  input: Partial<SSEFForgeGenerationOptions> | null | undefined;
  forgeRun: SSEFRun;
  proposal: SSEFProposal;
}): SSEFForgeGenerationOptions {
  const config = getSSEFConfig();
  const fromRunMetadata = extractGenerationOptionsFromMetadata(params.forgeRun.metadata);
  const fromProposalMetadata = extractGenerationOptionsFromMetadata(
    params.proposal.metadata
  );
  const model =
    asNonEmptyText(params.input?.model) ??
    asNonEmptyText(fromRunMetadata.model) ??
    asNonEmptyText(fromProposalMetadata.model) ??
    config.forgeGeneration.defaultModel;

  if (!config.forgeGeneration.modelCatalog.includes(model)) {
    throw new Error(
      `Forge model '${model}' is not allowed. Allowed models: ${config.forgeGeneration.modelCatalog.join(", ")}.`
    );
  }

  const reasoningEffort = normalizeReasoningEffort(
    params.input?.reasoningEffort ??
      fromRunMetadata.reasoningEffort ??
      fromProposalMetadata.reasoningEffort,
    config.forgeGeneration.defaultReasoningEffort
  );

  return {
    model,
    reasoningEffort,
  };
}

function mapReuseCandidates(candidates: SSEFReuseCandidate[]) {
  return candidates.map((candidate) => ({
    skill_id: candidate.skillId,
    score: candidate.score,
    source: candidate.source,
    lifecycle_state: candidate.lifecycleState,
    active_version: candidate.activeVersion,
    latest_version: candidate.latestVersion,
    dependency_count: candidate.dependencyCount,
    has_invocation_graph: candidate.hasInvocationGraph,
  }));
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

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTextFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

async function persistAttemptArtifacts(params: {
  attemptDir: string;
  artifacts: SSEFForgeGeneratedArtifacts;
}) {
  const manifestPath = path.join(params.attemptDir, "manifest.json");
  const entrypointPath = path.join(
    params.attemptDir,
    params.artifacts.entrypointFileName
  );
  const testCasesPath = path.join(
    params.attemptDir,
    params.artifacts.testCasesFileName
  );
  const promptContractPath = path.join(params.attemptDir, "prompt_contract.txt");

  await writeJsonFile(manifestPath, params.artifacts.manifest);
  await writeTextFile(entrypointPath, params.artifacts.entrypointContent);
  await writeJsonFile(testCasesPath, params.artifacts.testCases);
  await writeTextFile(promptContractPath, params.artifacts.promptContractText);

  return {
    manifestPath,
    entrypointPath,
    testCasesPath,
    promptContractPath,
  };
}

async function persistCriticArtifacts(params: {
  criticDir: string;
  attempt: number;
  critics: ReturnType<typeof runSSEFForgeCritics>;
}) {
  const functionalPath = path.join(
    params.criticDir,
    `functional_attempt_${params.attempt}.json`
  );
  const safetyPath = path.join(
    params.criticDir,
    `safety_attempt_${params.attempt}.json`
  );
  await writeJsonFile(functionalPath, params.critics.functional);
  await writeJsonFile(safetyPath, params.critics.safety);
  return {
    functionalPath,
    safetyPath,
  };
}

function buildFeedbackFromAttempt(outcome: SSEFForgeAttemptOutcome): SSEFForgeGenerationFeedback {
  const failedChecks = outcome.critics.functional.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.id}: ${check.detail}`);
  const safetyFindings = outcome.critics.safety.findings.map(
    (finding) => `${finding.id}: ${finding.detail}`
  );

  return {
    reasons: [
      `functional_verdict=${outcome.critics.functional.verdict}`,
      `safety_verdict=${outcome.critics.safety.verdict}`,
      `sandbox_passed=${String(outcome.sandbox.passed)}`,
    ],
    sandboxDiagnostics: outcome.sandbox.diagnostics,
    criticFindings: [...failedChecks, ...safetyFindings],
  };
}

function isReviewReady(outcome: SSEFForgeAttemptOutcome) {
  return (
    outcome.sandbox.passed &&
    outcome.critics.functional.verdict === "pass" &&
    outcome.critics.safety.verdict === "pass"
  );
}

function hasSandboxPass(outcome: SSEFForgeAttemptOutcome) {
  return outcome.sandbox.passed;
}

function summarizeCaseFailures(outcome: SSEFForgeAttemptOutcome) {
  return outcome.sandbox.cases
    .filter((testCase) => !testCase.passed)
    .map((testCase) => ({
      id: testCase.id,
      description: testCase.description,
      assertions: testCase.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => assertion.message)
        .slice(0, 8),
      parseError: testCase.parseError,
      timedOut: testCase.timedOut,
      exitCode: testCase.exitCode,
    }))
    .slice(0, 12);
}

function buildAttemptSummary(params: {
  attempt: number;
  attemptRunId: string;
  attemptOutcome: SSEFForgeAttemptOutcome | null;
  attemptErrorMessage: string | null;
  fallbackFailureMessage: string;
}): SSEFForgeAttemptSummary {
  const outcome = params.attemptOutcome;
  const status: SSEFForgeAttemptSummary["status"] = outcome
    ? isReviewReady(outcome)
      ? "review_ready"
      : outcome.sandbox.passed
        ? "sandbox_passed"
        : "failed"
    : "failed";

  return {
    attempt: params.attempt,
    attemptRunId: params.attemptRunId,
    status,
    sandboxPassed: outcome ? outcome.sandbox.passed : null,
    totalCases: outcome ? outcome.sandbox.totalCases : null,
    passedCases: outcome ? outcome.sandbox.passedCases : null,
    failedCases: outcome ? outcome.sandbox.failedCases : null,
    functionalVerdict: outcome ? outcome.critics.functional.verdict : null,
    safetyVerdict: outcome ? outcome.critics.safety.verdict : null,
    safetyRiskLevel: outcome ? outcome.critics.safety.riskLevel : null,
    diagnostics: outcome ? outcome.sandbox.diagnostics.slice(0, 30) : [],
    caseFailures: outcome ? summarizeCaseFailures(outcome) : [],
    failureMessage:
      params.attemptErrorMessage ??
      (status === "failed" ? params.fallbackFailureMessage : null),
    stdoutLogPath: outcome?.sandbox.stdoutLogPath ?? null,
    stderrLogPath: outcome?.sandbox.stderrLogPath ?? null,
    traceLogPath: outcome?.sandbox.traceLogPath ?? null,
  };
}

async function persistToVault(params: {
  attemptOutcome: SSEFForgeAttemptOutcome;
  securitySummary: SSEFSecuritySummaryArtifact;
}) {
  const config = getSSEFConfig();
  const skillId = params.attemptOutcome.artifacts.manifest.id;
  const version = params.attemptOutcome.artifacts.manifest.version;
  const vaultVersionDir = path.join(config.vaultDir, skillId, version);
  await fs.mkdir(vaultVersionDir, { recursive: true });

  const manifestPath = path.join(vaultVersionDir, "manifest.json");
  const entrypointPath = path.join(
    vaultVersionDir,
    params.attemptOutcome.artifacts.entrypointFileName
  );
  const testCasesPath = path.join(
    vaultVersionDir,
    params.attemptOutcome.artifacts.testCasesFileName
  );
  const securitySummaryPath = path.join(vaultVersionDir, "security_summary.json");

  await writeJsonFile(manifestPath, params.attemptOutcome.artifacts.manifest);
  await writeTextFile(
    entrypointPath,
    params.attemptOutcome.artifacts.entrypointContent
  );
  await writeJsonFile(testCasesPath, params.attemptOutcome.artifacts.testCases);
  await writeJsonFile(securitySummaryPath, params.securitySummary);

  return {
    manifestPath: toWorkspaceRelativePath(config.workspaceRoot, manifestPath),
    entrypointPath: toWorkspaceRelativePath(config.workspaceRoot, entrypointPath),
    testCasesPath: toWorkspaceRelativePath(config.workspaceRoot, testCasesPath),
    securitySummaryPath: toWorkspaceRelativePath(
      config.workspaceRoot,
      securitySummaryPath
    ),
  };
}

async function markProposalInProgress(
  proposal: SSEFProposal,
  forgeRun: SSEFRun,
  actor: string,
  generation: SSEFForgeGenerationOptions
) {
  await updateSSEFProposalStatus({
    proposalId: proposal.id,
    status: "in_progress",
    metadata: mergeRecords(proposal.metadata, {
      forge_run_id: forgeRun.id,
      forge_status: "running",
      forge_started_at: new Date().toISOString(),
      forge_generation: {
        model: generation.model,
        reasoning_effort: generation.reasoningEffort,
      },
    }),
    actor,
  });
}

function assertForgeJobRun(run: SSEFRun) {
  if (run.runType !== "forge_job") {
    throw new Error(`Run '${run.id}' is not a forge job.`);
  }
  if (run.status !== "draft" && run.status !== "running") {
    throw new Error(
      `Forge run '${run.id}' is not processable from status '${run.status}'.`
    );
  }
}

async function processForgeRunInternal(
  forgeRun: SSEFRun,
  proposal: SSEFProposal,
  actor: string,
  generationInput?: Partial<SSEFForgeGenerationOptions> | null
): Promise<SSEFForgeRunProcessResult> {
  const config = getSSEFConfig();
  const maxAttempts = Math.max(1, Math.floor(config.limits.forgeMaxAttempts));
  const generationOptions = resolveForgeGenerationOptions({
    input: generationInput,
    forgeRun,
    proposal,
  });
  const jobRoot = path.join(config.forgeDir, "jobs", forgeRun.id);
  const iterationsDir = path.join(jobRoot, "iterations");
  const criticDir = path.join(jobRoot, "critic_reports");
  await fs.mkdir(iterationsDir, { recursive: true });
  await fs.mkdir(criticDir, { recursive: true });

  await writeJsonFile(path.join(jobRoot, "spark.json"), proposal.spark ?? {});
  await writeJsonFile(path.join(jobRoot, "proposal_snapshot.json"), proposal);

  await updateSSEFRunStatus({
    runId: forgeRun.id,
    status: "running",
    metadata: mergeRecords(forgeRun.metadata, {
      forge: {
        state: "running",
        started_at: new Date().toISOString(),
        phase: "reuse_analysis",
        max_attempts: maxAttempts,
        attempts_executed: 0,
        selected_attempt: null,
      },
      generation: {
        model: generationOptions.model,
        reasoning_effort: generationOptions.reasoningEffort,
      },
    }),
    result: {
      outcome: "running",
      attempts_executed: 0,
      selected_attempt: null,
      max_attempts: maxAttempts,
      attempt_summaries: [],
      phase: "reuse_analysis",
    },
    actor,
  });
  await markProposalInProgress(proposal, forgeRun, actor, generationOptions);

  await appendSSEFAuditEvent({
    eventType: "forge.job.started",
    actor,
    proposalId: proposal.id,
    runId: forgeRun.id,
    payload: {
      max_attempts: maxAttempts,
      job_root: toWorkspaceRelativePath(config.workspaceRoot, jobRoot),
      generation: {
        model: generationOptions.model,
        reasoning_effort: generationOptions.reasoningEffort,
      },
    },
  });

  const explicitUpgradeTarget = readSSEFProposalUpgradeTarget(proposal);
  const reuseQuery = buildSSEFReuseQueryFromSpark(asRecord(proposal.spark));
  const reuseRecommendation = reuseQuery
    ? await recommendSSEFReuseStrategy({
        query: reuseQuery,
        topK: 5,
        onlyActive: true,
      })
    : {
        strategy: "forge_new" as const,
        reason: "Spark payload did not produce a semantic query.",
        candidates: [] as SSEFReuseCandidate[],
        dependencies: [] as string[],
        invocationGraph: [] as Array<{ step: string; skill_id: string }>,
      };

  await writeJsonFile(path.join(jobRoot, "reuse_candidates.json"), {
    query: reuseQuery,
    recommendation: reuseRecommendation,
    explicit_upgrade_target: explicitUpgradeTarget,
    generated_at: new Date().toISOString(),
  });

  if (reuseRecommendation.strategy !== "forge_new") {
    const strategy =
      reuseRecommendation.strategy === "reuse_existing"
        ? "reuse_suggested"
        : "composition_suggested";
    const primarySkillId =
      reuseRecommendation.strategy === "reuse_existing"
        ? reuseRecommendation.primarySkillId
        : null;
    const suggestionMetadata = {
      strategy: reuseRecommendation.strategy,
      reason: reuseRecommendation.reason,
      candidates: mapReuseCandidates(reuseRecommendation.candidates),
      dependencies: reuseRecommendation.dependencies,
      invocation_graph: reuseRecommendation.invocationGraph,
    };

    if (explicitUpgradeTarget) {
      await appendSSEFAuditEvent({
        eventType: "forge.reuse.bypassed_for_upgrade",
        actor,
        proposalId: proposal.id,
        runId: forgeRun.id,
        payload: {
          strategy: reuseRecommendation.strategy,
          reason: reuseRecommendation.reason,
          target_skill_id: explicitUpgradeTarget.targetSkillId,
          version_bump: explicitUpgradeTarget.versionBump,
          candidate_count: reuseRecommendation.candidates.length,
        },
      });
    } else {
      await updateSSEFProposalStatus({
        proposalId: proposal.id,
        status: strategy,
        metadata: mergeRecords(proposal.metadata, {
          forge_run_id: forgeRun.id,
          forge_status: "completed",
          forge_finished_at: new Date().toISOString(),
          forge_generation: {
            model: generationOptions.model,
            reasoning_effort: generationOptions.reasoningEffort,
          },
          reuse: suggestionMetadata,
        }),
        actor,
      });

      await updateSSEFRunStatus({
        runId: forgeRun.id,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result: {
          attempts_executed: 0,
          selected_attempt: null,
          max_attempts: maxAttempts,
          outcome: strategy,
          phase: strategy,
          attempt_summaries: [],
          recommendation: suggestionMetadata,
        },
        metadata: mergeRecords(forgeRun.metadata, {
          forge: {
            state: "completed",
            phase: strategy,
            max_attempts: maxAttempts,
            attempts_executed: 0,
            selected_attempt: null,
            strategy,
          },
          generation: {
            model: generationOptions.model,
            reasoning_effort: generationOptions.reasoningEffort,
          },
          reuse: suggestionMetadata,
        }),
        actor,
      });

      await appendSSEFAuditEvent({
        eventType: "forge.reuse.suggested",
        actor,
        proposalId: proposal.id,
        runId: forgeRun.id,
        payload: {
          strategy: reuseRecommendation.strategy,
          reason: reuseRecommendation.reason,
          primary_skill_id: primarySkillId,
          dependencies: reuseRecommendation.dependencies,
          candidate_count: reuseRecommendation.candidates.length,
          generation: {
            model: generationOptions.model,
            reasoning_effort: generationOptions.reasoningEffort,
          },
        },
      });

      return {
        runId: forgeRun.id,
        proposalId: proposal.id,
        status: "completed",
        attemptsExecuted: 0,
        selectedAttempt: null,
        lifecycleState: null,
        skillId: primarySkillId,
        version: null,
        message:
          reuseRecommendation.strategy === "reuse_existing"
            ? `Skipped forge: existing skill '${primarySkillId}' is a strong match.`
            : "Skipped forge: composition recommendation is available from active skills.",
      };
    }
  }

  const reuseCandidatesForGeneration: SSEFForgeReuseSuggestion[] =
    reuseRecommendation.candidates.map((candidate) => ({
      skillId: candidate.skillId,
      score: candidate.score,
    }));

  const attemptOutcomes: SSEFForgeAttemptOutcome[] = [];
  const attemptSummaries: SSEFForgeAttemptSummary[] = [];
  let previousFeedback: SSEFForgeGenerationFeedback | null = null;
  let lastFailureMessage = "Forge run exhausted attempts.";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptRun = await createSSEFRun({
      proposalId: proposal.id,
      runType: "forge_attempt",
      status: "running",
      attempt,
      metadata: {
        parent_forge_run_id: forgeRun.id,
        generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      },
      actor,
    });

    await updateSSEFRunStatus({
      runId: forgeRun.id,
      status: "running",
      metadata: mergeRecords(forgeRun.metadata, {
        forge: {
          state: "running",
          phase: `attempt_${String(attempt)}_generation`,
          max_attempts: maxAttempts,
          attempts_executed: Math.max(0, attempt - 1),
          selected_attempt: null,
          current_attempt: attempt,
          current_attempt_run_id: attemptRun.id,
        },
        generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      }),
      result: {
        outcome: "running",
        phase: `attempt_${String(attempt)}_generation`,
        attempts_executed: Math.max(0, attempt - 1),
        selected_attempt: null,
        max_attempts: maxAttempts,
        attempt_summaries: attemptSummaries,
      },
      actor,
    });

    const attemptDir = path.join(iterationsDir, String(attempt));
    await fs.mkdir(attemptDir, { recursive: true });

    let attemptOutcome: SSEFForgeAttemptOutcome | null = null;
    let attemptErrorMessage: string | null = null;

    try {
      const artifacts = await generateSSEFForgeArtifacts({
        proposal,
        attempt,
        maxAttempts,
        previousFeedback,
        reuseCandidates: reuseCandidatesForGeneration,
        reuseReason: reuseRecommendation.reason,
        generationOptions,
      });

      await persistAttemptArtifacts({
        attemptDir,
        artifacts,
      });

      await updateSSEFRunStatus({
        runId: forgeRun.id,
        status: "running",
        metadata: mergeRecords(forgeRun.metadata, {
          forge: {
            state: "running",
            phase: `attempt_${String(attempt)}_sandbox`,
            max_attempts: maxAttempts,
            attempts_executed: Math.max(0, attempt - 1),
            selected_attempt: null,
            current_attempt: attempt,
            current_attempt_run_id: attemptRun.id,
          },
          generation: {
            model: generationOptions.model,
            reasoning_effort: generationOptions.reasoningEffort,
          },
        }),
        result: {
          outcome: "running",
          phase: `attempt_${String(attempt)}_sandbox`,
          attempts_executed: Math.max(0, attempt - 1),
          selected_attempt: null,
          max_attempts: maxAttempts,
          attempt_summaries: attemptSummaries,
        },
        actor,
      });

      const sandbox = await runSSEFForgeSandboxTests({
        runId: attemptRun.id,
        attempt,
        attemptDir,
        artifacts,
      });

      await updateSSEFRunStatus({
        runId: forgeRun.id,
        status: "running",
        metadata: mergeRecords(forgeRun.metadata, {
          forge: {
            state: "running",
            phase: `attempt_${String(attempt)}_critic`,
            max_attempts: maxAttempts,
            attempts_executed: Math.max(0, attempt - 1),
            selected_attempt: null,
            current_attempt: attempt,
            current_attempt_run_id: attemptRun.id,
          },
          generation: {
            model: generationOptions.model,
            reasoning_effort: generationOptions.reasoningEffort,
          },
        }),
        result: {
          outcome: "running",
          phase: `attempt_${String(attempt)}_critic`,
          attempts_executed: Math.max(0, attempt - 1),
          selected_attempt: null,
          max_attempts: maxAttempts,
          attempt_summaries: attemptSummaries,
        },
        actor,
      });

      const critics = runSSEFForgeCritics({
        proposal,
        artifacts,
        sandboxResult: sandbox,
      });
      await persistCriticArtifacts({
        criticDir,
        attempt,
        critics,
      });

      attemptOutcome = {
        attempt,
        attemptRunId: attemptRun.id,
        artifacts,
        sandbox,
        critics,
        attemptDir,
      };
      attemptOutcomes.push(attemptOutcome);
      previousFeedback = buildFeedbackFromAttempt(attemptOutcome);
      lastFailureMessage =
        previousFeedback.criticFindings[0] ??
        previousFeedback.sandboxDiagnostics[0] ??
        "Attempt failed validation.";
    } catch (error) {
      attemptErrorMessage =
        error instanceof Error ? error.message : "Unknown forge attempt failure.";
      lastFailureMessage = attemptErrorMessage;
    }

    await updateSSEFRunStatus({
      runId: attemptRun.id,
      status:
        attemptOutcome && attemptOutcome.sandbox.passed
          ? "completed"
          : "failed",
      finishedAt: new Date().toISOString(),
      stdoutLogPath: attemptOutcome?.sandbox.stdoutLogPath ?? null,
      stderrLogPath: attemptOutcome?.sandbox.stderrLogPath ?? null,
      traceLogPath: attemptOutcome?.sandbox.traceLogPath ?? null,
      error: attemptErrorMessage,
      result: attemptOutcome
        ? {
            attempt: attemptOutcome.attempt,
            sandbox_passed: attemptOutcome.sandbox.passed,
            total_cases: attemptOutcome.sandbox.totalCases,
            passed_cases: attemptOutcome.sandbox.passedCases,
            failed_cases: attemptOutcome.sandbox.failedCases,
            functional_verdict: attemptOutcome.critics.functional.verdict,
            safety_verdict: attemptOutcome.critics.safety.verdict,
            safety_risk_level: attemptOutcome.critics.safety.riskLevel,
          }
        : {
            attempt,
            sandbox_passed: false,
          },
      metadata: attemptOutcome
        ? {
            parent_forge_run_id: forgeRun.id,
            attempt_dir: toWorkspaceRelativePath(
              config.workspaceRoot,
              attemptOutcome.attemptDir
            ),
            generation: {
              model: generationOptions.model,
              reasoning_effort: generationOptions.reasoningEffort,
            },
            artifact_generation: attemptOutcome.artifacts.metadata,
          }
        : {
            parent_forge_run_id: forgeRun.id,
            attempt_dir: toWorkspaceRelativePath(config.workspaceRoot, attemptDir),
            generation: {
              model: generationOptions.model,
              reasoning_effort: generationOptions.reasoningEffort,
            },
          },
      actor,
    });

    const attemptSummary = buildAttemptSummary({
      attempt,
      attemptRunId: attemptRun.id,
      attemptOutcome,
      attemptErrorMessage,
      fallbackFailureMessage: lastFailureMessage,
    });
    attemptSummaries.push(attemptSummary);

    await updateSSEFRunStatus({
      runId: forgeRun.id,
      status: "running",
      metadata: mergeRecords(forgeRun.metadata, {
        forge: {
          state: "running",
          phase: `attempt_${String(attempt)}_completed`,
          max_attempts: maxAttempts,
          attempts_executed: attempt,
          selected_attempt: null,
          current_attempt: attempt,
          current_attempt_run_id: attemptRun.id,
          last_attempt_status: attemptSummary.status,
          last_attempt_run_id: attemptRun.id,
        },
        generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      }),
      result: {
        outcome: "running",
        phase: `attempt_${String(attempt)}_completed`,
        attempts_executed: attempt,
        selected_attempt: null,
        max_attempts: maxAttempts,
        attempt_summaries: attemptSummaries,
      },
      actor,
    });

    await appendSSEFAuditEvent({
      eventType: "forge.attempt.completed",
      actor,
      proposalId: proposal.id,
      runId: attemptRun.id,
      payload: attemptOutcome
        ? {
            parent_forge_run_id: forgeRun.id,
            attempt,
            sandbox_passed: attemptOutcome.sandbox.passed,
            functional_verdict: attemptOutcome.critics.functional.verdict,
            safety_verdict: attemptOutcome.critics.safety.verdict,
            safety_risk_level: attemptOutcome.critics.safety.riskLevel,
            generation: {
              model: generationOptions.model,
              reasoning_effort: generationOptions.reasoningEffort,
            },
          }
        : {
            parent_forge_run_id: forgeRun.id,
            attempt,
            error: attemptErrorMessage ?? "Attempt failed before artifacts were produced.",
            generation: {
              model: generationOptions.model,
              reasoning_effort: generationOptions.reasoningEffort,
            },
          },
    });

    if (attemptOutcome && isReviewReady(attemptOutcome)) {
      break;
    }
  }

  const selectedOutcome =
    attemptOutcomes.find((outcome) => isReviewReady(outcome)) ??
    attemptOutcomes.find((outcome) => hasSandboxPass(outcome)) ??
    null;

  if (!selectedOutcome) {
    await updateSSEFProposalStatus({
      proposalId: proposal.id,
      status: "failed",
      metadata: mergeRecords(proposal.metadata, {
        forge_run_id: forgeRun.id,
        forge_status: "failed",
        forge_finished_at: new Date().toISOString(),
        failure_reason: lastFailureMessage,
        forge_generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      }),
      actor,
    });

    await updateSSEFRunStatus({
      runId: forgeRun.id,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: lastFailureMessage,
      result: {
        max_attempts: maxAttempts,
        attempts_executed: attemptOutcomes.length,
        selected_attempt: null,
        outcome: "failed",
        phase: "failed",
        attempt_summaries: attemptSummaries,
        last_failure: lastFailureMessage,
      },
      metadata: mergeRecords(forgeRun.metadata, {
        forge: {
          state: "failed",
          phase: "failed",
          max_attempts: maxAttempts,
          attempts_executed: attemptOutcomes.length,
          selected_attempt: null,
          failure_reason: lastFailureMessage,
        },
        generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      }),
      actor,
    });

    await appendSSEFAuditEvent({
      eventType: "forge.job.failed",
      actor,
      proposalId: proposal.id,
      runId: forgeRun.id,
      payload: {
        attempts_executed: attemptOutcomes.length,
        failure_reason: lastFailureMessage,
        generation: {
          model: generationOptions.model,
          reasoning_effort: generationOptions.reasoningEffort,
        },
      },
    });

    return {
      runId: forgeRun.id,
      proposalId: proposal.id,
      status: "failed",
      attemptsExecuted: attemptOutcomes.length,
      selectedAttempt: null,
      lifecycleState: null,
      skillId: null,
      version: null,
      message: lastFailureMessage,
    };
  }

  const securitySummary = buildSSEFSecuritySummary({
    manifest: selectedOutcome.artifacts.manifest,
    sandboxResult: selectedOutcome.sandbox,
    functionalCritic: selectedOutcome.critics.functional,
    safetyCritic: selectedOutcome.critics.safety,
    selectedAttempt: selectedOutcome.attempt,
    maxAttempts,
  });
  const lifecycleState = resolveSSEFFinalLifecycleFromSecuritySummary(
    securitySummary
  );
  await writeJsonFile(path.join(jobRoot, "security_summary.json"), securitySummary);

  const vaultPaths = await persistToVault({
    attemptOutcome: selectedOutcome,
    securitySummary,
  });

  const versionRecord = await createSSEFSkillVersionFromManifest({
    manifest: selectedOutcome.artifacts.manifest,
    versionLifecycleState: lifecycleState,
    skillLifecycleState: lifecycleState,
    sourceProposalId: proposal.id,
    securitySummary: securitySummary as unknown as Record<string, unknown>,
    metadata: {
      forge_run_id: forgeRun.id,
      selected_attempt: selectedOutcome.attempt,
      job_root: toWorkspaceRelativePath(config.workspaceRoot, jobRoot),
      vault_paths: vaultPaths,
    },
    actor,
  });

  await updateSSEFProposalStatus({
    proposalId: proposal.id,
    status: lifecycleState,
    metadata: mergeRecords(proposal.metadata, {
      forge_run_id: forgeRun.id,
      forge_status: "completed",
      forge_finished_at: new Date().toISOString(),
      selected_attempt: selectedOutcome.attempt,
      skill_id: versionRecord.skill.skillId,
      version: versionRecord.version.version,
      lifecycle_state: lifecycleState,
      vault_paths: vaultPaths,
      forge_generation: {
        model: generationOptions.model,
        reasoning_effort: generationOptions.reasoningEffort,
      },
    }),
    actor,
  });

  await updateSSEFRunStatus({
    runId: forgeRun.id,
    status: "completed",
    finishedAt: new Date().toISOString(),
    stdoutLogPath: selectedOutcome.sandbox.stdoutLogPath,
    stderrLogPath: selectedOutcome.sandbox.stderrLogPath,
    traceLogPath: selectedOutcome.sandbox.traceLogPath,
    result: {
      max_attempts: maxAttempts,
      attempts_executed: attemptOutcomes.length,
      selected_attempt: selectedOutcome.attempt,
      outcome: "completed",
      phase: "completed",
      attempt_summaries: attemptSummaries,
      lifecycle_state: lifecycleState,
      skill_id: versionRecord.skill.skillId,
      version: versionRecord.version.version,
      sandbox_passed: selectedOutcome.sandbox.passed,
      functional_verdict: selectedOutcome.critics.functional.verdict,
      safety_verdict: selectedOutcome.critics.safety.verdict,
      safety_risk_level: selectedOutcome.critics.safety.riskLevel,
    },
    metadata: mergeRecords(forgeRun.metadata, {
      forge: {
        state: "completed",
        phase: "completed",
        max_attempts: maxAttempts,
        attempts_executed: attemptOutcomes.length,
        selected_attempt: selectedOutcome.attempt,
        lifecycle_state: lifecycleState,
      },
      generation: {
        model: generationOptions.model,
        reasoning_effort: generationOptions.reasoningEffort,
      },
      vault_paths: vaultPaths,
    }),
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "forge.job.completed",
    actor,
    proposalId: proposal.id,
    runId: forgeRun.id,
    skillDbId: versionRecord.skill.id,
    skillVersionId: versionRecord.version.id,
    payload: {
      attempts_executed: attemptOutcomes.length,
      selected_attempt: selectedOutcome.attempt,
      lifecycle_state: lifecycleState,
      skill_id: versionRecord.skill.skillId,
      version: versionRecord.version.version,
      vault_paths: vaultPaths,
      generation: {
        model: generationOptions.model,
        reasoning_effort: generationOptions.reasoningEffort,
      },
    },
  });

  return {
    runId: forgeRun.id,
    proposalId: proposal.id,
    status: "completed",
    attemptsExecuted: attemptOutcomes.length,
    selectedAttempt: selectedOutcome.attempt,
    lifecycleState,
    skillId: versionRecord.skill.skillId,
    version: versionRecord.version.version,
    message: `Forge completed with lifecycle '${lifecycleState}'.`,
  };
}

export async function processSSEFForgeRun(
  input: ProcessSSEFForgeRunInput
): Promise<SSEFForgeRunProcessResult> {
  await ensureSSEFReady();
  const actor = asNonEmptyText(input.actor) ?? "ssef-forge-engine";
  const generationOverrides: Partial<SSEFForgeGenerationOptions> = {};
  const requestedModel = asNonEmptyText(input.generationModel);
  if (requestedModel) {
    generationOverrides.model = requestedModel;
  }
  if (input.reasoningEffort) {
    generationOverrides.reasoningEffort = input.reasoningEffort;
  }
  const runId = asNonEmptyText(input.runId);
  if (!runId) {
    throw new Error("runId is required.");
  }

  const forgeRun = await getSSEFRunById(runId);
  if (!forgeRun) {
    throw new Error(`Forge run not found: ${runId}`);
  }
  if (forgeRun.runType !== "forge_job") {
    throw new Error(`Run '${runId}' is not a forge job.`);
  }

  if (
    forgeRun.status !== "draft" &&
    forgeRun.status !== "running" &&
    forgeRun.status !== "failed"
  ) {
    return {
      runId: forgeRun.id,
      proposalId: forgeRun.proposalId,
      status: "skipped",
      attemptsExecuted: 0,
      selectedAttempt: null,
      lifecycleState: null,
      skillId: null,
      version: null,
      message: `Forge run status '${forgeRun.status}' is not processable.`,
    };
  }

  const proposalId = asNonEmptyText(forgeRun.proposalId);
  if (!proposalId) {
    await updateSSEFRunStatus({
      runId: forgeRun.id,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: "Forge run is missing proposal_id.",
      actor,
    });
    return {
      runId: forgeRun.id,
      proposalId: null,
      status: "failed",
      attemptsExecuted: 0,
      selectedAttempt: null,
      lifecycleState: null,
      skillId: null,
      version: null,
      message: "Forge run is missing proposal_id.",
    };
  }

  const proposal = await getSSEFProposalById(proposalId);
  if (!proposal) {
    await updateSSEFRunStatus({
      runId: forgeRun.id,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `Proposal '${proposalId}' not found.`,
      actor,
    });
    return {
      runId: forgeRun.id,
      proposalId,
      status: "failed",
      attemptsExecuted: 0,
      selectedAttempt: null,
      lifecycleState: null,
      skillId: null,
      version: null,
      message: `Proposal '${proposalId}' not found.`,
    };
  }

  let targetForgeRun = forgeRun;
  if (forgeRun.status === "failed") {
    targetForgeRun = await createSSEFRun({
      proposalId: forgeRun.proposalId,
      runType: "forge_job",
      status: "draft",
      attempt: Math.max(1, Math.floor(forgeRun.attempt + 1)),
      metadata: mergeRecords(forgeRun.metadata, {
        retry_of_run_id: forgeRun.id,
        retry_requested_at: new Date().toISOString(),
        retry_generation_override: {
          model: generationOverrides.model ?? null,
          reasoning_effort: generationOverrides.reasoningEffort ?? null,
        },
      }),
      actor,
    });

    await appendSSEFAuditEvent({
      eventType: "forge.job.retry_queued",
      actor,
      proposalId: proposal.id,
      runId: targetForgeRun.id,
      payload: {
        retry_of_run_id: forgeRun.id,
        generation_override: {
          model: generationOverrides.model ?? null,
          reasoning_effort: generationOverrides.reasoningEffort ?? null,
        },
      },
    });
  }

  return processForgeRunInternal(
    targetForgeRun,
    proposal,
    actor,
    Object.keys(generationOverrides).length > 0 ? generationOverrides : null
  );
}

export async function processQueuedSSEFForgeJobs(
  input: ProcessSSEFForgeQueueInput = {}
): Promise<SSEFForgeQueueProcessResult> {
  await ensureSSEFReady();
  const actor = asNonEmptyText(input.actor) ?? "ssef-forge-engine";
  const generationOverrides: Partial<SSEFForgeGenerationOptions> = {};
  const requestedModel = asNonEmptyText(input.generationModel);
  if (requestedModel) {
    generationOverrides.model = requestedModel;
  }
  if (input.reasoningEffort) {
    generationOverrides.reasoningEffort = input.reasoningEffort;
  }
  const maxJobs = toSafeMaxJobs(input.maxJobs);

  const queue = await listSSEFRuns({
    runType: "forge_job",
    status: "draft",
    limit: maxJobs,
    offset: 0,
  });

  const items: SSEFForgeRunProcessResult[] = [];
  for (const run of queue.items) {
    try {
      assertForgeJobRun(run);
    } catch (error) {
      items.push({
        runId: run.id,
        proposalId: run.proposalId,
        status: "skipped",
        attemptsExecuted: 0,
        selectedAttempt: null,
        lifecycleState: null,
        skillId: null,
        version: null,
        message:
          error instanceof Error
            ? error.message
            : "Run is not processable by forge queue worker.",
      });
      continue;
    }

    const result = await processSSEFForgeRun({
      runId: run.id,
      actor,
      generationModel: generationOverrides.model,
      reasoningEffort: generationOverrides.reasoningEffort,
    });
    items.push(result);
  }

  return {
    processed: items.length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    items,
  };
}
