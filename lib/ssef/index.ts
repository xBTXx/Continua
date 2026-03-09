import { ensureSSEFReady } from "./bootstrap";
import { getSSEFConfig, ssefEnabled } from "./config";
import { getSSEFSkillEmbeddingCollectionName } from "./retrieval/embeddings";
import {
  ensureProtectedAssetsReady,
  getProtectedAssetPolicy,
} from "./registry/protectedAssets";
import { listSSEFProposals, listSSEFRuns } from "./repository";
import {
  ssefProposalToolEnabled,
  ssefProposalToolIdleEnabled,
} from "./proposals/triggerTool";

export { ensureSSEFReady, getSSEFConfig, ssefEnabled };
export type { SSEFBootstrapResult } from "./bootstrap";
export {
  SSEF_FORGE_REASONING_EFFORTS,
} from "./config";
export type { SSEFConfig, SSEFForgeReasoningEffort } from "./config";
export {
  SKILL_PERMISSION_KINDS,
  validateSkillPermission,
  validateSkillPermissions,
} from "./contracts/permissions";
export {
  SKILL_RUNTIMES,
  isSkillManifestV1,
  validateSkillManifestV1,
} from "./contracts/manifest";
export {
  SKILL_LIFECYCLE_STATES,
  canTransitionSkillLifecycle,
  createInitialSkillLifecycleState,
  assertValidSkillLifecycleTransition,
  getAllowedSkillLifecycleTransitions,
  transitionSkillLifecycle,
} from "./contracts/lifecycle";
export {
  getProtectedAssetPolicy,
  ensureProtectedAssetsReady,
  readProtectedSkillsIndex,
  writeProtectedSkillsIndex,
  mutateProtectedSkillsIndex,
  readProtectedIntegrityHashes,
} from "./registry/protectedAssets";
export {
  listSkillsForIndexMirror,
  syncSkillsIndexFromRepository,
  readSkillsIndexMirrorSnapshot,
} from "./registry/indexFile";
export type { SSEFSkillsIndexMirrorRecord } from "./registry/indexFile";
export { appendSSEFAuditEvent, listSSEFAuditEvents } from "./audit";
export type {
  SSEFAuditEvent,
  AppendSSEFAuditEventInput,
  ListSSEFAuditEventsOptions,
} from "./audit";
export {
  upsertSSEFSkill,
  getSSEFSkillBySkillId,
  listSSEFSkills,
  searchSSEFSkills,
  createSSEFSkillVersionFromManifest,
  listSSEFSkillVersions,
  listSSEFActiveSkillVersions,
  getSSEFActiveSkillVersionBySkillId,
  getSSEFSkillVersionById,
  getSSEFSkillVersionBySkillAndVersion,
  getLatestSSEFSkillVersionBySourceProposal,
  updateSSEFSkillVersionLifecycle,
  updateSSEFSkillLifecycle,
  setSSEFSkillActiveVersion,
  createSSEFProposal,
  getSSEFProposalById,
  updateSSEFProposalStatus,
  listSSEFProposals,
  createSSEFRun,
  getSSEFRunById,
  updateSSEFRunStatus,
  listSSEFRuns,
  recordSSEFPolicyIncident,
} from "./repository";
export type {
  SSEFSkill,
  SSEFSkillVersion,
  SSEFProposal,
  SSEFRun,
  SSEFPolicyIncident,
  ListSSEFSkillsOptions,
  ListSSEFSkillsResult,
  ListSSEFSkillVersionsOptions,
  ListSSEFSkillVersionsResult,
  ListSSEFActiveSkillVersionsOptions,
  ListSSEFActiveSkillVersionsResult,
  UpsertSSEFSkillInput,
  CreateSSEFSkillVersionFromManifestInput,
  CreateSSEFSkillVersionFromManifestResult,
  UpdateSSEFSkillVersionLifecycleInput,
  UpdateSSEFSkillLifecycleInput,
  SetSSEFSkillActiveVersionInput,
  CreateSSEFProposalInput,
  UpdateSSEFProposalStatusInput,
  ListSSEFProposalsOptions,
  ListSSEFProposalsResult,
  CreateSSEFRunInput,
  UpdateSSEFRunStatusInput,
  ListSSEFRunsOptions,
  ListSSEFRunsResult,
  RecordSSEFPolicyIncidentInput,
} from "./repository";
export {
  getSSEFSkillEmbeddingCollectionName,
  getSSEFSkillEmbeddingNamespace,
  buildSSEFSkillEmbeddingId,
  upsertSSEFSkillEmbeddings,
  syncSSEFSkillEmbeddings,
} from "./retrieval/embeddings";
export type {
  SSEFSkillEmbeddingSource,
  UpsertSSEFSkillEmbeddingsOptions,
  SyncSSEFSkillEmbeddingsResult,
} from "./retrieval/embeddings";
export {
  buildSSEFReuseQueryFromSpark,
  searchSSEFReuseCandidates,
  recommendSSEFReuseStrategy,
} from "./retrieval/search";
export type {
  SSEFReuseCandidate,
  SearchSSEFReuseCandidatesInput,
  SSEFReuseRecommendation,
} from "./retrieval/search";
export {
  buildSSEFCompositionPlanFromManifest,
  runSSEFCompositionPlan,
} from "./composition/runner";
export type {
  SSEFCompositionExecutionContext,
  SSEFCompositionPlanStep,
  SSEFCompositionPlan,
  SSEFCompositionStepResult,
  RunSSEFCompositionPlanInput,
  SSEFCompositionRunResult,
} from "./composition/runner";
export {
  getActiveSkillToolDefinitions,
  getActiveSSEFSkillRuntimeRecords,
  getActiveSSEFSkillRuntimeRecordByToolName,
} from "./runtime/toolDefinitions";
export type { SSEFActiveSkillRuntimeRecord } from "./runtime/toolDefinitions";
export { runSSEFToolByName } from "./runtime/adapter";
export type { RunSSEFToolContext, SSEFToolExecutionSource } from "./runtime/adapter";
export {
  createSSEFSkillPolicy,
  evaluateSSEFPolicyAction,
  assertSSEFPolicyActionAllowed,
} from "./runtime/policyEngine";
export type {
  SSEFPolicyAction,
  SSEFPolicyDecision,
  SSEFPolicyProcessLimits,
  SSEFSkillPolicy,
} from "./runtime/policyEngine";
export {
  executeSSEFSkillRuntime,
  type ExecuteSSEFSkillRuntimeInput,
  type ExecuteSSEFSkillRuntimeResult,
} from "./runtime/executor";
export {
  SSEFRuntimeError,
  SSEFPolicyViolationError,
  SSEFExecutionTimeoutError,
  getSSEFRuntimeErrorCode,
  getSSEFRuntimeErrorMessage,
} from "./runtime/errors";
export type {
  SSEFRuntimeErrorCode,
  SSEFPolicyViolation,
  SSEFPolicyViolationCategory,
  SSEFPolicyViolationSeverity,
} from "./runtime/errors";
export {
  createSSEFTraceSession,
  SSEFTraceSession,
} from "./runtime/trace";
export type { SSEFTraceEvent, SSEFTracePersistResult } from "./runtime/trace";
export {
  submitSSEFSparkProposal,
} from "./proposals/service";
export type {
  SSEFSparkPriority,
  SSEFStructuredSpark,
  SSEFSparkDedupeCandidate,
  SSEFSparkDedupeResult,
  SubmitSSEFSparkProposalInput,
  SubmitSSEFSparkProposalResult,
} from "./proposals/service";
export {
  SSEF_PROPOSAL_TRIGGER_TOOL_NAME,
  SSEF_PROPOSAL_TOOL_NAMES,
  ssefProposalToolEnabled,
  ssefProposalToolIdleEnabled,
  isSSEFProposalTriggerToolName,
  getSSEFProposalTriggerToolDefinitions,
  runSSEFProposalTriggerTool,
} from "./proposals/triggerTool";
export type { RunSSEFProposalTriggerToolContext } from "./proposals/triggerTool";
export {
  generateSSEFForgeArtifacts,
} from "./forge/generator";
export type {
  SSEFForgeTestCaseAssertion,
  SSEFForgeTestCase,
  SSEFForgeGenerationFeedback,
  SSEFForgeReuseSuggestion,
  GenerateSSEFForgeArtifactsInput,
  SSEFForgeGeneratedArtifacts,
} from "./forge/generator";
export {
  runSSEFForgeSandboxTests,
} from "./forge/sandboxRunner";
export type {
  RunSSEFForgeSandboxTestsInput,
  SSEFForgeSandboxAssertionResult,
  SSEFForgeSandboxCaseResult,
  SSEFForgeSandboxResult,
} from "./forge/sandboxRunner";
export {
  runSSEFForgeCritics,
} from "./forge/critic";
export type {
  SSEFForgeFunctionalCheck,
  SSEFForgeFunctionalCriticReport,
  SSEFForgeSafetyFinding,
  SSEFForgeSafetyCriticReport,
  RunSSEFForgeCriticsInput,
  SSEFForgeCriticResult,
} from "./forge/critic";
export {
  buildSSEFSecuritySummary,
  resolveSSEFFinalLifecycleFromSecuritySummary,
} from "./forge/securitySummary";
export type {
  SSEFForgeLifecycleDecision,
  BuildSSEFSecuritySummaryInput,
  SSEFSecuritySummaryArtifact,
} from "./forge/securitySummary";
export {
  processSSEFForgeRun,
  processQueuedSSEFForgeJobs,
} from "./forge/engine";
export type {
  ProcessSSEFForgeRunInput,
  ProcessSSEFForgeQueueInput,
  SSEFForgeRunProcessResult,
  SSEFForgeQueueProcessResult,
} from "./forge/engine";
export {
  listSSEFReviewQueue,
  approveSSEFProposalPromotion,
  rejectSSEFProposalPromotion,
} from "./promotion/service";
export type {
  SSEFReviewQueueOptions,
  SSEFPermissionDiff,
  SSEFReviewRiskLevel,
  SSEFReviewVerdict,
  SSEFReviewRiskSummary,
  SSEFReviewQueueTests,
  SSEFReviewQueueCritics,
  SSEFReviewQueueArtifactPaths,
  SSEFReviewQueueItem,
  SSEFReviewQueueResult,
  ApproveSSEFProposalInput,
  ApproveSSEFProposalResult,
  RejectSSEFProposalInput,
  RejectSSEFProposalResult,
} from "./promotion/service";
export {
  rollbackSSEFProposalPromotion,
} from "./promotion/rollback";
export type {
  RollbackSSEFPromotionInput,
  RollbackSSEFPromotionResult,
} from "./promotion/rollback";
export {
  deleteSSEFProposalCascade,
  deleteSSEFSkillCascade,
  resetSSEFState,
} from "./admin/service";
export type {
  DeleteSSEFProposalResult,
  DeleteSSEFSkillResult,
  ResetSSEFStateResult,
} from "./admin/service";

export type SSEFToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

export async function getSSEFToolStatus(): Promise<SSEFToolStatus[]> {
  if (!ssefEnabled()) {
    return [
      {
        id: "ssef",
        label: "SSEF",
        status: "error",
        details: ["Disabled (SSEF_ENABLED=false)."],
      },
    ];
  }

  try {
    const bootstrap = await ensureSSEFReady();
    const protectedStatus = await ensureProtectedAssetsReady();
    const [forgeDraftQueue, forgeRunningQueue, reviewPendingQueue, sandboxPassedQueue] =
      await Promise.all([
      listSSEFRuns({
        runType: "forge_job",
        status: "draft",
        limit: 1,
        offset: 0,
      }),
      listSSEFRuns({
        runType: "forge_job",
        status: "running",
        limit: 1,
        offset: 0,
      }),
      listSSEFProposals({
        status: "review_pending",
        limit: 1,
        offset: 0,
      }),
      listSSEFProposals({
        status: "sandbox_passed",
        limit: 1,
        offset: 0,
      }),
      ]);
    const { config } = bootstrap;
    const policy = getProtectedAssetPolicy(config);
    const details = [
      `Workspace root: ${config.workspaceRoot}`,
      `SSEF root: ${config.rootDir}`,
      `Registry index: ${config.skillsIndexPath}`,
      `Integrity hashes: ${config.integrityHashesPath}`,
      `Protected write paths: ${policy.writeAllowedPaths.join(", ")}`,
      `Skill embedding collection: ${getSSEFSkillEmbeddingCollectionName()}`,
      `Forge max attempts: ${config.limits.forgeMaxAttempts}`,
      `Forge generation models: ${config.forgeGeneration.modelCatalog.join(", ")}`,
      `Forge default model: ${config.forgeGeneration.defaultModel}`,
      `Forge default reasoning effort: ${config.forgeGeneration.defaultReasoningEffort}`,
      `Sandbox timeout: ${config.limits.sandboxTimeoutMs} ms`,
      `Sandbox max output: ${config.limits.sandboxMaxOutputChars} chars`,
      `Sandbox max memory: ${config.limits.sandboxMaxMemoryMb} MB`,
      `Sandbox max CPU time: ${config.limits.sandboxMaxCpuSeconds} s`,
      `Sandbox max process spawns: ${config.limits.sandboxMaxProcessSpawns}`,
      `Runtime chat SSEF max tools: ${config.runtimeSelection.chatMaxTools}`,
      `Runtime idle SSEF max tools: ${config.runtimeSelection.idleMaxTools}`,
      `Runtime SSEF min relevance score: ${config.runtimeSelection.minScore}`,
      `Runtime SSEF max query tokens: ${config.runtimeSelection.maxQueryTokens}`,
      `Dependency install timeout: ${config.dependencyManagement.installTimeoutMs} ms`,
      `Runtime auto-install dependencies: ${config.dependencyManagement.runtimeAutoInstall ? "yes" : "no"}`,
      `Forge queue draft jobs: ${forgeDraftQueue.total}`,
      `Forge queue running jobs: ${forgeRunningQueue.total}`,
      `Review queue pending proposals: ${reviewPendingQueue.total}`,
      `Review queue sandbox-passed proposals: ${sandboxPassedQueue.total}`,
      `Spark trigger tool enabled: ${ssefProposalToolEnabled() ? "yes" : "no"}`,
      `Spark trigger tool idle-enabled: ${ssefProposalToolIdleEnabled() ? "yes" : "no"}`,
      bootstrap.indexInitialized
        ? "Created empty skills_index.json."
        : "skills_index.json already present.",
      bootstrap.createdPaths.length > 0
        ? `Created paths: ${bootstrap.createdPaths.join(", ")}`
        : "All managed paths already existed.",
      protectedStatus.ready
        ? "Protected assets verified."
        : "Protected assets are not ready.",
    ];

    return [
      {
        id: "ssef",
        label: "SSEF",
        status: bootstrap.ready && protectedStatus.ready ? "ok" : "error",
        details,
      },
    ];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to initialize SSEF.";
    const details = [message];
    try {
      const config = getSSEFConfig();
      details.unshift(`Workspace root: ${config.workspaceRoot}`);
    } catch {
      // Keep the original initialization error if config resolution itself fails.
    }
    return [
      {
        id: "ssef",
        label: "SSEF",
        status: "error",
        details,
      },
    ];
  }
}
