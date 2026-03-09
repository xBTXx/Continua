import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendSSEFAuditEvent } from "../audit";
import { ensureSSEFReady } from "../bootstrap";
import { getSSEFConfig } from "../config";
import {
  transitionSkillLifecycle,
  type SkillLifecycleState,
} from "../contracts/lifecycle";
import type { SkillPermission } from "../contracts/permissions";
import {
  getLatestSSEFSkillVersionBySourceProposal,
  getSSEFProposalById,
  getSSEFRunById,
  getSSEFSkillBySkillId,
  getSSEFSkillVersionBySkillAndVersion,
  listSSEFProposals,
  listSSEFRuns,
  updateSSEFProposalStatus,
  updateSSEFSkillLifecycle,
  updateSSEFSkillVersionLifecycle,
  type SSEFProposal,
  type SSEFSkill,
  type SSEFSkillVersion,
  type SSEFRun,
} from "../repository";
import { ensureSSEFSkillRuntimeDependencies } from "../runtime/dependencies";

const DEFAULT_QUEUE_LIMIT = 50;
const MAX_QUEUE_LIMIT = 200;
const MAX_QUEUE_OFFSET = 1_000_000;
const MAX_MULTI_STATUS_SCAN = 1_000;
const MAX_FORGE_ATTEMPT_SCAN = 200;
const REVIEW_QUEUE_DEFAULT_STATUSES = ["review_pending", "sandbox_passed"];

const APPROVAL_LIFECYCLE_PATH: Partial<
  Record<SkillLifecycleState, SkillLifecycleState>
> = {
  sandbox_passed: "review_pending",
  review_pending: "approved",
  approved: "active",
  disabled: "active",
};

const APPROVAL_ALLOWED_PROPOSAL_STATUSES = new Set<string>([
  "sandbox_passed",
  "review_pending",
  "approved",
]);

type PromotionArtifactSnapshot = {
  vaultVersionDir: string;
  manifestPath: string;
  entrypointPath: string;
  testCasesPath: string;
  securitySummaryPath: string | null;
  fileHashes: Record<string, string>;
  artifactBundleHash: string;
  artifactSignature: string;
};

export type SSEFReviewQueueOptions = {
  limit?: number;
  offset?: number;
  status?: string;
};

export type SSEFPermissionDiff = {
  baselineVersion: string | null;
  baselinePermissionCount: number;
  candidatePermissionCount: number;
  added: string[];
  removed: string[];
};

export type SSEFReviewRiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
export type SSEFReviewVerdict = "pass" | "fail" | "unknown";

export type SSEFReviewRiskSummary = {
  riskLevel: SSEFReviewRiskLevel;
  safetyVerdict: SSEFReviewVerdict;
  functionalVerdict: SSEFReviewVerdict;
  sandboxPassed: boolean | null;
  reviewReady: boolean;
  flags: string[];
};

export type SSEFReviewQueueTests = {
  forgeRunId: string | null;
  forgeRunStatus: string | null;
  selectedAttempt: number | null;
  sandboxPassed: boolean | null;
  totalCases: number | null;
  passedCases: number | null;
  failedCases: number | null;
  diagnostics: string[];
};

export type SSEFReviewQueueCritics = {
  functional: Record<string, unknown> | null;
  safety: Record<string, unknown> | null;
  functionalReportPath: string | null;
  safetyReportPath: string | null;
};

export type SSEFReviewQueueArtifactPaths = {
  vaultVersionDir: string | null;
  manifestPath: string | null;
  entrypointPath: string | null;
  testCasesPath: string | null;
  securitySummaryPath: string | null;
  artifactBundleHash: string | null;
  artifactSignature: string | null;
};

export type SSEFReviewQueueItem = {
  proposal: SSEFProposal;
  skill: SSEFSkill | null;
  candidateVersion: SSEFSkillVersion | null;
  manifest: Record<string, unknown> | null;
  tests: SSEFReviewQueueTests | null;
  critics: SSEFReviewQueueCritics | null;
  permissionDiff: SSEFPermissionDiff | null;
  riskSummary: SSEFReviewRiskSummary | null;
  artifacts: SSEFReviewQueueArtifactPaths | null;
  issues: string[];
};

export type SSEFReviewQueueResult = {
  items: SSEFReviewQueueItem[];
  total: number;
  limit: number;
  offset: number;
  statuses: string[];
};

export type ApproveSSEFProposalInput = {
  proposalId: string;
  actor?: string;
  reason?: string;
  note?: string;
};

export type ApproveSSEFProposalResult = {
  proposal: SSEFProposal;
  skill: SSEFSkill;
  version: SSEFSkillVersion;
  approvalEventId: string;
  previousActiveVersion: string | null;
  artifacts: SSEFReviewQueueArtifactPaths;
  dependencyInstall: {
    status: "ok" | "skipped";
    attempted: boolean;
    npmInstalled: boolean;
    pipInstalled: boolean;
    markerPath: string | null;
    error: string | null;
  } | null;
};

export type RejectSSEFProposalInput = {
  proposalId: string;
  actor?: string;
  reason?: string;
  note?: string;
};

export type RejectSSEFProposalResult = {
  proposal: SSEFProposal;
  candidateVersion: SSEFSkillVersion | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asRecordOrNull(value: unknown) {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalText(value: unknown, fallback: string) {
  return asNonEmptyText(value) ?? fallback;
}

function asBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return null;
}

function asInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function toSafeLimit(value: number | undefined) {
  const parsed = Number(value ?? DEFAULT_QUEUE_LIMIT);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_QUEUE_LIMIT;
  }
  return Math.min(MAX_QUEUE_LIMIT, Math.max(1, Math.floor(parsed)));
}

function toSafeOffset(value: number | undefined) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(MAX_QUEUE_OFFSET, Math.max(0, Math.floor(parsed)));
}

function normalizeQueueStatuses(value: string | undefined) {
  const normalized =
    asNonEmptyText(value)
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  const source = normalized.length > 0 ? normalized : REVIEW_QUEUE_DEFAULT_STATUSES;
  return source.filter((item, index, all) => all.indexOf(item) === index);
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

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableSortValue(entry));
    if (normalized.every((entry) => typeof entry === "string")) {
      return [...(normalized as string[])].sort();
    }
    return normalized;
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = stableSortValue(value[key]);
      });
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown) {
  return JSON.stringify(stableSortValue(value));
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string) {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function ensureInsideRoot(root: string, target: string, label: string) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(rootWithSep)
  ) {
    throw new Error(`${label} must resolve inside workspace root.`);
  }
}

function pathInsideRoot(root: string, target: string) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(rootWithSep)
  );
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

function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath: unknown
): string | null {
  const text = asNonEmptyText(rawPath);
  if (!text) {
    return null;
  }
  const normalizedRoot = path.resolve(workspaceRoot);

  if (path.isAbsolute(text)) {
    const absoluteCandidate = path.resolve(text);
    if (pathInsideRoot(normalizedRoot, absoluteCandidate)) {
      return absoluteCandidate;
    }

    // Backward compatibility: older metadata stores workspace-relative paths
    // with a leading slash (for example "/.ssef/...").
    if (/^[\\/]+\./.test(text)) {
      const rebasedCandidate = path.resolve(
        normalizedRoot,
        text.replace(/^[\\/]+/, "")
      );
      ensureInsideRoot(normalizedRoot, rebasedCandidate, "artifact path");
      return rebasedCandidate;
    }

    ensureInsideRoot(normalizedRoot, absoluteCandidate, "artifact path");
  }

  const candidate = path.resolve(normalizedRoot, text.replace(/^[\\/]+/, ""));
  ensureInsideRoot(normalizedRoot, candidate, "artifact path");
  return candidate;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string) {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function buildPermissionFingerprint(permission: SkillPermission) {
  return `${permission.kind}:${stableStringify(permission)}`;
}

function buildPermissionDiff(
  baseline: SSEFSkillVersion | null,
  candidate: SSEFSkillVersion
): SSEFPermissionDiff {
  const baselineFingerprints = baseline
    ? baseline.permissions.map((permission) => buildPermissionFingerprint(permission))
    : [];
  const candidateFingerprints = candidate.permissions.map((permission) =>
    buildPermissionFingerprint(permission)
  );

  const baselineSet = new Set(baselineFingerprints);
  const candidateSet = new Set(candidateFingerprints);
  const added = candidateFingerprints
    .filter((entry) => !baselineSet.has(entry))
    .sort();
  const removed = baselineFingerprints
    .filter((entry) => !candidateSet.has(entry))
    .sort();

  return {
    baselineVersion: baseline?.version ?? null,
    baselinePermissionCount: baselineFingerprints.length,
    candidatePermissionCount: candidateFingerprints.length,
    added,
    removed,
  };
}

function asRiskLevel(value: unknown): SSEFReviewRiskLevel {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  ) {
    return value;
  }
  return "unknown";
}

function asVerdict(value: unknown): SSEFReviewVerdict {
  if (value === "pass" || value === "fail") {
    return value;
  }
  return "unknown";
}

function buildRiskSummary(params: {
  securitySummary: Record<string, unknown> | null;
  tests: SSEFReviewQueueTests;
  permissionDiff: SSEFPermissionDiff;
}) {
  const critics = asRecord(params.securitySummary?.critics);
  const safety = asRecord(critics.safety);
  const functional = asRecord(critics.functional);
  const sandbox = asRecord(params.securitySummary?.sandbox);

  const safetyVerdict = asVerdict(safety.verdict);
  const functionalVerdict = asVerdict(functional.verdict);
  const riskLevel = asRiskLevel(safety.risk_level);
  const sandboxPassed =
    params.tests.sandboxPassed ?? asBoolean(sandbox.passed) ?? null;
  const reviewReady =
    safetyVerdict === "pass" &&
    functionalVerdict === "pass" &&
    sandboxPassed === true;

  const flags: string[] = [];
  if (riskLevel === "high" || riskLevel === "critical") {
    flags.push(`Risk level ${riskLevel}.`);
  }
  if (params.permissionDiff.added.length > 0) {
    flags.push(
      `${params.permissionDiff.added.length} permission additions compared to active baseline.`
    );
  }
  if (safetyVerdict !== "pass") {
    flags.push(`Safety critic verdict is ${safetyVerdict}.`);
  }
  if (functionalVerdict !== "pass") {
    flags.push(`Functional critic verdict is ${functionalVerdict}.`);
  }
  if (sandboxPassed === false) {
    flags.push("Sandbox tests did not fully pass.");
  }

  return {
    riskLevel,
    safetyVerdict,
    functionalVerdict,
    sandboxPassed,
    reviewReady,
    flags,
  } satisfies SSEFReviewRiskSummary;
}

function readMetadataPaths(
  candidateVersion: SSEFSkillVersion
): SSEFReviewQueueArtifactPaths {
  const metadata = asRecord(candidateVersion.metadata);
  const vaultPaths = asRecord(metadata.vault_paths);
  const promotion = asRecord(metadata.promotion);
  const artifactIntegrity = asRecord(metadata.artifact_integrity);

  return {
    vaultVersionDir:
      asNonEmptyText(vaultPaths.vaultVersionDir) ??
      asNonEmptyText(promotion.vault_version_dir) ??
      null,
    manifestPath: asNonEmptyText(vaultPaths.manifestPath),
    entrypointPath: asNonEmptyText(vaultPaths.entrypointPath),
    testCasesPath: asNonEmptyText(vaultPaths.testCasesPath),
    securitySummaryPath: asNonEmptyText(vaultPaths.securitySummaryPath),
    artifactBundleHash:
      asNonEmptyText(promotion.artifact_bundle_hash) ??
      asNonEmptyText(artifactIntegrity.bundle_sha256) ??
      null,
    artifactSignature:
      asNonEmptyText(promotion.artifact_signature) ??
      asNonEmptyText(artifactIntegrity.signature) ??
      null,
  };
}

async function resolveSelectedForgeAttemptRun(params: {
  proposal: SSEFProposal;
  forgeRunId: string | null;
  selectedAttempt: number | null;
}) {
  if (!params.forgeRunId || !params.selectedAttempt) {
    return null;
  }
  const runs = await listSSEFRuns({
    proposalId: params.proposal.id,
    runType: "forge_attempt",
    limit: MAX_FORGE_ATTEMPT_SCAN,
    offset: 0,
  });
  return (
    runs.items.find((run) => {
      if (run.attempt !== params.selectedAttempt) {
        return false;
      }
      const metadata = asRecord(run.metadata);
      return metadata.parent_forge_run_id === params.forgeRunId;
    }) ?? null
  );
}

function buildTestsFromRuns(params: {
  forgeRunId: string | null;
  forgeRun: SSEFRun | null;
  selectedAttempt: number | null;
  selectedAttemptRun: SSEFRun | null;
  securitySummary: Record<string, unknown> | null;
}) {
  const sourceResult = params.selectedAttemptRun?.result ?? params.forgeRun?.result ?? null;
  const sandbox = asRecord(params.securitySummary?.sandbox);
  const diagnostics = Array.isArray(sandbox.diagnostics)
    ? sandbox.diagnostics
        .map((entry) => asNonEmptyText(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  return {
    forgeRunId: params.forgeRunId,
    forgeRunStatus: params.forgeRun?.status ?? null,
    selectedAttempt: params.selectedAttempt,
    sandboxPassed:
      asBoolean(sourceResult?.sandbox_passed) ?? asBoolean(sandbox.passed) ?? null,
    totalCases:
      asInteger(sourceResult?.total_cases) ?? asInteger(sandbox.total_cases) ?? null,
    passedCases:
      asInteger(sourceResult?.passed_cases) ?? asInteger(sandbox.passed_cases) ?? null,
    failedCases:
      asInteger(sourceResult?.failed_cases) ?? asInteger(sandbox.failed_cases) ?? null,
    diagnostics,
  } satisfies SSEFReviewQueueTests;
}

async function readCriticReports(params: {
  candidateVersion: SSEFSkillVersion;
  selectedAttempt: number | null;
}) {
  const config = getSSEFConfig();
  const metadata = asRecord(params.candidateVersion.metadata);
  const jobRootPath = resolveWorkspacePath(config.workspaceRoot, metadata.job_root);
  if (!jobRootPath || !params.selectedAttempt) {
    return {
      functional: null,
      safety: null,
      functionalReportPath: null,
      safetyReportPath: null,
    } satisfies SSEFReviewQueueCritics;
  }

  const functionalPath = path.join(
    jobRootPath,
    "critic_reports",
    `functional_attempt_${params.selectedAttempt}.json`
  );
  const safetyPath = path.join(
    jobRootPath,
    "critic_reports",
    `safety_attempt_${params.selectedAttempt}.json`
  );
  const functional = asRecordOrNull(await readJsonIfExists(functionalPath));
  const safety = asRecordOrNull(await readJsonIfExists(safetyPath));

  return {
    functional,
    safety,
    functionalReportPath:
      functional !== null
        ? toWorkspaceRelativePath(config.workspaceRoot, functionalPath)
        : null,
    safetyReportPath:
      safety !== null
        ? toWorkspaceRelativePath(config.workspaceRoot, safetyPath)
        : null,
  } satisfies SSEFReviewQueueCritics;
}

async function buildReviewQueueItem(proposal: SSEFProposal) {
  const issues: string[] = [];
  const candidateVersion = await getLatestSSEFSkillVersionBySourceProposal(proposal.id);
  if (!candidateVersion) {
    issues.push("No skill version is linked to this proposal yet.");
    return {
      proposal,
      skill: null,
      candidateVersion: null,
      manifest: null,
      tests: null,
      critics: null,
      permissionDiff: null,
      riskSummary: null,
      artifacts: null,
      issues,
    } satisfies SSEFReviewQueueItem;
  }

  const skill = await getSSEFSkillBySkillId(candidateVersion.skillId);
  if (!skill) {
    issues.push(`Skill '${candidateVersion.skillId}' could not be loaded.`);
  }

  const activeBaseline =
    skill?.activeVersion && skill.activeVersion !== candidateVersion.version
      ? await getSSEFSkillVersionBySkillAndVersion(
          candidateVersion.skillId,
          skill.activeVersion
        )
      : null;

  const metadata = asRecord(candidateVersion.metadata);
  const proposalMetadata = asRecord(proposal.metadata);
  const forgeRunId =
    asNonEmptyText(metadata.forge_run_id) ??
    asNonEmptyText(proposalMetadata.forge_run_id) ??
    null;
  const selectedAttempt =
    asInteger(metadata.selected_attempt) ??
    asInteger(proposalMetadata.selected_attempt) ??
    null;
  const forgeRun = forgeRunId ? await getSSEFRunById(forgeRunId) : null;
  const selectedAttemptRun = await resolveSelectedForgeAttemptRun({
    proposal,
    forgeRunId,
    selectedAttempt,
  });
  const critics = await readCriticReports({
    candidateVersion,
    selectedAttempt,
  });
  const securitySummary = asRecordOrNull(candidateVersion.securitySummary);
  const tests = buildTestsFromRuns({
    forgeRunId,
    forgeRun,
    selectedAttempt,
    selectedAttemptRun,
    securitySummary,
  });

  if (!forgeRunId) {
    issues.push("Missing forge run linkage in proposal/version metadata.");
  }
  if (!critics.functional || !critics.safety) {
    issues.push("Critic report artifacts are incomplete.");
  }

  const permissionDiff = buildPermissionDiff(activeBaseline, candidateVersion);
  const riskSummary = buildRiskSummary({
    securitySummary,
    tests,
    permissionDiff,
  });

  return {
    proposal,
    skill,
    candidateVersion,
    manifest: candidateVersion.manifest as unknown as Record<string, unknown>,
    tests,
    critics,
    permissionDiff,
    riskSummary,
    artifacts: readMetadataPaths(candidateVersion),
    issues,
  } satisfies SSEFReviewQueueItem;
}

function buildErroredReviewQueueItem(
  proposal: SSEFProposal,
  error: unknown
): SSEFReviewQueueItem {
  const message =
    error instanceof Error ? error.message : "Unknown review queue item failure.";
  return {
    proposal,
    skill: null,
    candidateVersion: null,
    manifest: null,
    tests: null,
    critics: null,
    permissionDiff: null,
    riskSummary: null,
    artifacts: null,
    issues: [`Failed to build review context: ${message}`],
  } satisfies SSEFReviewQueueItem;
}

function assertCanPromoteToActive(
  currentState: SkillLifecycleState,
  actor: string,
  reason: string,
  approvalEventId: string
) {
  let state: SkillLifecycleState = currentState;
  for (let guard = 0; guard < 10 && state !== "active"; guard += 1) {
    const next = APPROVAL_LIFECYCLE_PATH[state];
    if (!next) {
      throw new Error(
        `Lifecycle '${state}' cannot be promoted to active through approval flow.`
      );
    }
    transitionSkillLifecycle({
      currentState: state,
      nextState: next,
      actor,
      reason,
      approvalEventId:
        next === "approved" || next === "active" ? approvalEventId : undefined,
    });
    state = next;
  }
  if (state !== "active") {
    throw new Error("Lifecycle transition overflow while validating promotion.");
  }
}

async function copyFileSafe(sourcePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
}

async function promoteArtifactBundle(
  version: SSEFSkillVersion
): Promise<PromotionArtifactSnapshot> {
  const config = getSSEFConfig();
  const metadata = asRecord(version.metadata);
  const vaultPaths = asRecord(metadata.vault_paths);
  const vaultVersionDir = path.join(config.vaultDir, version.skillId, version.version);
  const testCaseName = version.testCases[0] ?? "test_cases.json";

  const defaultManifestPath = path.join(vaultVersionDir, "manifest.json");
  const defaultEntrypointPath = path.join(vaultVersionDir, version.entrypoint);
  const defaultTestCasesPath = path.join(vaultVersionDir, testCaseName);
  const defaultSecuritySummaryPath = path.join(vaultVersionDir, "security_summary.json");

  const sourceManifestPath =
    resolveWorkspacePath(config.workspaceRoot, vaultPaths.manifestPath) ??
    defaultManifestPath;
  const sourceEntrypointPath =
    resolveWorkspacePath(config.workspaceRoot, vaultPaths.entrypointPath) ??
    defaultEntrypointPath;
  const sourceTestCasesPath =
    resolveWorkspacePath(config.workspaceRoot, vaultPaths.testCasesPath) ??
    defaultTestCasesPath;
  const sourceSecuritySummaryPath =
    resolveWorkspacePath(config.workspaceRoot, vaultPaths.securitySummaryPath) ??
    (await pathExists(defaultSecuritySummaryPath) ? defaultSecuritySummaryPath : null);

  if (!(await pathExists(sourceManifestPath))) {
    throw new Error(`Missing manifest artifact for promotion: ${sourceManifestPath}`);
  }
  if (!(await pathExists(sourceEntrypointPath))) {
    throw new Error(`Missing entrypoint artifact for promotion: ${sourceEntrypointPath}`);
  }
  if (!(await pathExists(sourceTestCasesPath))) {
    throw new Error(`Missing test_cases artifact for promotion: ${sourceTestCasesPath}`);
  }

  await copyFileSafe(sourceManifestPath, defaultManifestPath);
  await copyFileSafe(sourceEntrypointPath, defaultEntrypointPath);
  await copyFileSafe(sourceTestCasesPath, defaultTestCasesPath);
  if (sourceSecuritySummaryPath) {
    await copyFileSafe(sourceSecuritySummaryPath, defaultSecuritySummaryPath);
  }

  const fileHashes: Record<string, string> = {
    manifest_sha256: await sha256File(defaultManifestPath),
    entrypoint_sha256: await sha256File(defaultEntrypointPath),
    test_cases_sha256: await sha256File(defaultTestCasesPath),
  };
  if (await pathExists(defaultSecuritySummaryPath)) {
    fileHashes.security_summary_sha256 = await sha256File(defaultSecuritySummaryPath);
  }

  const artifactBundleHash = sha256Text(
    stableStringify({
      bundle_version: 1,
      files: fileHashes,
    })
  );
  const artifactSignature = `ssef-sha256-v1:${artifactBundleHash}`;

  return {
    vaultVersionDir: toWorkspaceRelativePath(config.workspaceRoot, vaultVersionDir),
    manifestPath: toWorkspaceRelativePath(config.workspaceRoot, defaultManifestPath),
    entrypointPath: toWorkspaceRelativePath(config.workspaceRoot, defaultEntrypointPath),
    testCasesPath: toWorkspaceRelativePath(config.workspaceRoot, defaultTestCasesPath),
    securitySummaryPath: (await pathExists(defaultSecuritySummaryPath))
      ? toWorkspaceRelativePath(config.workspaceRoot, defaultSecuritySummaryPath)
      : null,
    fileHashes,
    artifactBundleHash,
    artifactSignature,
  };
}

export async function listSSEFReviewQueue(
  options: SSEFReviewQueueOptions = {}
): Promise<SSEFReviewQueueResult> {
  await ensureSSEFReady();
  const statuses = normalizeQueueStatuses(options.status);
  const limit = toSafeLimit(options.limit);
  const offset = toSafeOffset(options.offset);
  const scanLimit = Math.min(
    MAX_MULTI_STATUS_SCAN,
    Math.max(limit + offset + 20, 100)
  );

  const resultSets = await Promise.all(
    statuses.map((status) =>
      listSSEFProposals({
        status,
        limit: scanLimit,
        offset: 0,
      })
    )
  );

  const merged = resultSets
    .flatMap((result) => result.items)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return b.id.localeCompare(a.id);
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

  const sliced = merged.slice(offset, offset + limit);
  const items = await Promise.all(
    sliced.map(async (proposal) => {
      try {
        return await buildReviewQueueItem(proposal);
      } catch (error) {
        return buildErroredReviewQueueItem(proposal, error);
      }
    })
  );

  return {
    items,
    total: resultSets.reduce((sum, result) => sum + result.total, 0),
    limit,
    offset,
    statuses,
  };
}

export async function approveSSEFProposalPromotion(
  input: ApproveSSEFProposalInput
): Promise<ApproveSSEFProposalResult> {
  await ensureSSEFReady();
  const proposalId = asNonEmptyText(input.proposalId);
  if (!proposalId) {
    throw new Error("proposalId is required.");
  }

  const actor = asOptionalText(input.actor, "ssef-review");
  const reason = asOptionalText(input.reason, "Approved via SSEF review queue.");
  const note = asNonEmptyText(input.note);

  const proposal = await getSSEFProposalById(proposalId);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }
  if (!APPROVAL_ALLOWED_PROPOSAL_STATUSES.has(proposal.status)) {
    throw new Error(
      `Proposal '${proposal.id}' is not approvable from status '${proposal.status}'.`
    );
  }

  const candidateVersion = await getLatestSSEFSkillVersionBySourceProposal(proposal.id);
  if (!candidateVersion) {
    throw new Error(
      `No skill version is linked to proposal '${proposal.id}' for promotion.`
    );
  }
  const skill = await getSSEFSkillBySkillId(candidateVersion.skillId);
  if (!skill) {
    throw new Error(`Skill '${candidateVersion.skillId}' not found.`);
  }

  if (
    proposal.status === "approved" &&
    skill.lifecycleState === "active" &&
    skill.activeVersion === candidateVersion.version &&
    candidateVersion.lifecycleState === "active"
  ) {
    const existingMetadata = asRecord(candidateVersion.metadata);
    const dependencyInstall = asRecord(existingMetadata.dependency_install);
    return {
      proposal,
      skill,
      version: candidateVersion,
      approvalEventId: asNonEmptyText(asRecord(proposal.metadata).approval_event_id) ?? "",
      previousActiveVersion: null,
      artifacts: readMetadataPaths(candidateVersion),
      dependencyInstall:
        Object.keys(dependencyInstall).length > 0
          ? {
              status:
                dependencyInstall.status === "skipped" ? "skipped" : "ok",
              attempted: Boolean(dependencyInstall.attempted),
              npmInstalled: Boolean(dependencyInstall.npm_installed),
              pipInstalled: Boolean(dependencyInstall.pip_installed),
              markerPath: asNonEmptyText(dependencyInstall.marker_path),
              error: asNonEmptyText(dependencyInstall.error),
            }
          : null,
    };
  }

  const approvalEventId = `approval:${randomUUID()}`;
  assertCanPromoteToActive(
    candidateVersion.lifecycleState,
    actor,
    reason,
    approvalEventId
  );
  assertCanPromoteToActive(skill.lifecycleState, actor, reason, approvalEventId);

  const previousActiveVersion =
    skill.activeVersion && skill.activeVersion !== candidateVersion.version
      ? skill.activeVersion
      : null;

  const artifactSnapshot = await promoteArtifactBundle(candidateVersion);
  const config = getSSEFConfig();
  const promotedVaultVersionPath =
    resolveWorkspacePath(config.workspaceRoot, artifactSnapshot.vaultVersionDir) ??
    path.join(config.vaultDir, candidateVersion.skillId, candidateVersion.version);
  const dependencyInstall = await ensureSSEFSkillRuntimeDependencies({
    versionRoot: promotedVaultVersionPath,
    manifest: candidateVersion.manifest,
    mode: "activation",
    allowInstall: true,
  });
  if (dependencyInstall.status === "failed") {
    await appendSSEFAuditEvent({
      eventType: "promotion.activation_dependencies_failed",
      actor,
      skillDbId: skill.id,
      skillVersionId: candidateVersion.id,
      proposalId: proposal.id,
      payload: {
        skill_id: skill.skillId,
        version: candidateVersion.version,
        error: dependencyInstall.error,
        marker_path: dependencyInstall.markerPath,
        dependency_logs: dependencyInstall.logs,
      },
    });
    throw new Error(
      `Runtime dependency installation failed during activation: ${
        dependencyInstall.error ?? "unknown dependency setup error"
      }`
    );
  }
  const now = new Date().toISOString();

  if (previousActiveVersion) {
    const currentActiveVersion = await getSSEFSkillVersionBySkillAndVersion(
      skill.skillId,
      previousActiveVersion
    );
    if (currentActiveVersion && currentActiveVersion.lifecycleState === "active") {
      transitionSkillLifecycle({
        currentState: "active",
        nextState: "disabled",
        actor,
        reason: `Superseded by ${candidateVersion.version}.`,
      });
      await updateSSEFSkillVersionLifecycle({
        skillVersionId: currentActiveVersion.id,
        lifecycleState: "disabled",
        metadata: mergeRecords(currentActiveVersion.metadata, {
          superseded_by_version: candidateVersion.version,
          superseded_at: now,
          superseded_by_actor: actor,
        }),
        actor,
        reason: `Superseded by ${candidateVersion.version}.`,
      });
    }
  }

  const promotedVersion = await updateSSEFSkillVersionLifecycle({
    skillVersionId: candidateVersion.id,
    lifecycleState: "active",
    metadata: mergeRecords(candidateVersion.metadata, {
      approval_event_id: approvalEventId,
      vault_paths: {
        vaultVersionDir: artifactSnapshot.vaultVersionDir,
        manifestPath: artifactSnapshot.manifestPath,
        entrypointPath: artifactSnapshot.entrypointPath,
        testCasesPath: artifactSnapshot.testCasesPath,
        securitySummaryPath: artifactSnapshot.securitySummaryPath,
      },
      artifact_integrity: {
        bundle_sha256: artifactSnapshot.artifactBundleHash,
        signature: artifactSnapshot.artifactSignature,
        file_hashes: artifactSnapshot.fileHashes,
      },
      dependency_install: {
        status: dependencyInstall.status,
        attempted: dependencyInstall.attempted,
        npm_installed: dependencyInstall.npmInstalled,
        pip_installed: dependencyInstall.pipInstalled,
        marker_path: dependencyInstall.markerPath,
        python_bin: dependencyInstall.pythonBin,
        error: dependencyInstall.error,
        installed_at: now,
      },
      promotion: {
        approved_at: now,
        approved_by: actor,
        approval_event_id: approvalEventId,
        previous_active_version: previousActiveVersion,
        artifact_bundle_hash: artifactSnapshot.artifactBundleHash,
        artifact_signature: artifactSnapshot.artifactSignature,
        vault_version_dir: artifactSnapshot.vaultVersionDir,
      },
    }),
    actor,
    reason,
  });

  const promotedSkill = await updateSSEFSkillLifecycle({
    skillId: skill.skillId,
    lifecycleState: "active",
    activeVersion: promotedVersion.version,
    latestVersion: skill.latestVersion ?? promotedVersion.version,
    actor,
    reason,
  });

  const updatedProposal = await updateSSEFProposalStatus({
    proposalId: proposal.id,
    status: "approved",
    metadata: mergeRecords(proposal.metadata, {
      reviewed_by: actor,
      reviewed_at: now,
      review_decision: "approved",
      review_note: note,
      approval_event_id: approvalEventId,
      skill_id: promotedSkill.skillId,
      promoted_version: promotedVersion.version,
      previous_active_version: previousActiveVersion,
      artifact_bundle_hash: artifactSnapshot.artifactBundleHash,
      artifact_signature: artifactSnapshot.artifactSignature,
      dependency_install: {
        status: dependencyInstall.status,
        attempted: dependencyInstall.attempted,
        npm_installed: dependencyInstall.npmInstalled,
        pip_installed: dependencyInstall.pipInstalled,
        marker_path: dependencyInstall.markerPath,
      },
    }),
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "promotion.approved",
    actor,
    skillDbId: promotedSkill.id,
    skillVersionId: promotedVersion.id,
    proposalId: updatedProposal.id,
    payload: {
      skill_id: promotedSkill.skillId,
      version: promotedVersion.version,
      previous_active_version: previousActiveVersion,
      approval_event_id: approvalEventId,
      artifact_bundle_hash: artifactSnapshot.artifactBundleHash,
      artifact_signature: artifactSnapshot.artifactSignature,
      dependency_install: {
        status: dependencyInstall.status,
        attempted: dependencyInstall.attempted,
        npm_installed: dependencyInstall.npmInstalled,
        pip_installed: dependencyInstall.pipInstalled,
        marker_path: dependencyInstall.markerPath,
      },
      vault_paths: {
        vaultVersionDir: artifactSnapshot.vaultVersionDir,
        manifestPath: artifactSnapshot.manifestPath,
        entrypointPath: artifactSnapshot.entrypointPath,
        testCasesPath: artifactSnapshot.testCasesPath,
        securitySummaryPath: artifactSnapshot.securitySummaryPath,
      },
      note,
    },
  });

  return {
    proposal: updatedProposal,
    skill: promotedSkill,
    version: promotedVersion,
    approvalEventId,
    previousActiveVersion,
    artifacts: {
      vaultVersionDir: artifactSnapshot.vaultVersionDir,
      manifestPath: artifactSnapshot.manifestPath,
      entrypointPath: artifactSnapshot.entrypointPath,
      testCasesPath: artifactSnapshot.testCasesPath,
      securitySummaryPath: artifactSnapshot.securitySummaryPath,
      artifactBundleHash: artifactSnapshot.artifactBundleHash,
      artifactSignature: artifactSnapshot.artifactSignature,
    },
    dependencyInstall: {
      status: dependencyInstall.status,
      attempted: dependencyInstall.attempted,
      npmInstalled: dependencyInstall.npmInstalled,
      pipInstalled: dependencyInstall.pipInstalled,
      markerPath: dependencyInstall.markerPath,
      error: dependencyInstall.error,
    },
  };
}

export async function rejectSSEFProposalPromotion(
  input: RejectSSEFProposalInput
): Promise<RejectSSEFProposalResult> {
  await ensureSSEFReady();
  const proposalId = asNonEmptyText(input.proposalId);
  if (!proposalId) {
    throw new Error("proposalId is required.");
  }

  const actor = asOptionalText(input.actor, "ssef-review");
  const reason = asOptionalText(input.reason, "Rejected via SSEF review queue.");
  const note = asNonEmptyText(input.note);

  const proposal = await getSSEFProposalById(proposalId);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }

  if (!APPROVAL_ALLOWED_PROPOSAL_STATUSES.has(proposal.status)) {
    throw new Error(
      `Proposal '${proposal.id}' is not rejectable from status '${proposal.status}'.`
    );
  }

  const candidateVersion = await getLatestSSEFSkillVersionBySourceProposal(proposal.id);
  const now = new Date().toISOString();
  const updatedProposal = await updateSSEFProposalStatus({
    proposalId: proposal.id,
    status: "rejected",
    metadata: mergeRecords(proposal.metadata, {
      reviewed_by: actor,
      reviewed_at: now,
      review_decision: "rejected",
      review_reason: reason,
      review_note: note,
      candidate_version: candidateVersion?.version ?? null,
      skill_id: candidateVersion?.skillId ?? null,
    }),
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "promotion.rejected",
    actor,
    skillVersionId: candidateVersion?.id ?? null,
    proposalId: updatedProposal.id,
    payload: {
      reason,
      note,
      candidate_version: candidateVersion?.version ?? null,
      skill_id: candidateVersion?.skillId ?? null,
    },
  });

  return {
    proposal: updatedProposal,
    candidateVersion,
  };
}
