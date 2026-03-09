"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/basePath";

const LIST_LIMIT = 100;
const FORGE_AUTO_REFRESH_MS = 10_000;
const DEFAULT_REVIEW_STATUSES = "review_pending,sandbox_passed";
const DEFAULT_FORGE_MODEL_OPTIONS = [
  "openai/gpt-5.3-codex",
  "anthropic/claude-sonnet-4.6",
  "z-ai/glm-5",
  "google/gemini-3-flash-preview",
];
const DEFAULT_FORGE_REASONING_OPTIONS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "minimal",
];

type JsonRecord = Record<string, unknown>;

type PaginatedResponse<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

type SSEFProposal = {
  id: string;
  proposalType: string;
  status: string;
  skillDbId: string | null;
  requestedBy: string | null;
  title: string | null;
  summary: string | null;
  spark: JsonRecord;
  constraints: JsonRecord | null;
  priority: string | null;
  metadata: JsonRecord | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SSEFRun = {
  id: string;
  proposalId: string | null;
  skillVersionId: string | null;
  runType: string;
  status: string;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  stdoutLogPath: string | null;
  stderrLogPath: string | null;
  traceLogPath: string | null;
  error: string | null;
  result: JsonRecord | null;
  metadata: JsonRecord | null;
  createdAt: string;
};

type SSEFSkill = {
  id: string;
  skillId: string;
  name: string | null;
  description: string;
  lifecycleState: string;
  latestVersion: string | null;
  activeVersion: string | null;
  metadata: JsonRecord | null;
  createdAt: string;
  updatedAt: string;
};

type SSEFPermissionDiff = {
  baselineVersion: string | null;
  baselinePermissionCount: number;
  candidatePermissionCount: number;
  added: string[];
  removed: string[];
};

type SSEFReviewRiskSummary = {
  riskLevel: "low" | "medium" | "high" | "critical" | "unknown";
  safetyVerdict: "pass" | "fail" | "unknown";
  functionalVerdict: "pass" | "fail" | "unknown";
  sandboxPassed: boolean | null;
  reviewReady: boolean;
  flags: string[];
};

type SSEFReviewQueueTests = {
  forgeRunId: string | null;
  forgeRunStatus: string | null;
  selectedAttempt: number | null;
  sandboxPassed: boolean | null;
  totalCases: number | null;
  passedCases: number | null;
  failedCases: number | null;
  diagnostics: string[];
};

type SSEFReviewQueueCritics = {
  functional: JsonRecord | null;
  safety: JsonRecord | null;
  functionalReportPath: string | null;
  safetyReportPath: string | null;
};

type SSEFReviewQueueArtifactPaths = {
  vaultVersionDir: string | null;
  manifestPath: string | null;
  entrypointPath: string | null;
  testCasesPath: string | null;
  securitySummaryPath: string | null;
  artifactBundleHash: string | null;
  artifactSignature: string | null;
};

type SSEFReviewQueueItem = {
  proposal: SSEFProposal;
  skill: SSEFSkill | null;
  candidateVersion: {
    id: string;
    skillId: string;
    version: string;
    lifecycleState: string;
    permissions: Array<Record<string, unknown>>;
    metadata: JsonRecord | null;
  } | null;
  manifest: JsonRecord | null;
  tests: SSEFReviewQueueTests | null;
  critics: SSEFReviewQueueCritics | null;
  permissionDiff: SSEFPermissionDiff | null;
  riskSummary: SSEFReviewRiskSummary | null;
  artifacts: SSEFReviewQueueArtifactPaths | null;
  issues: string[];
};

type SSEFReviewQueueResponse = {
  items: SSEFReviewQueueItem[];
  total: number;
  limit: number;
  offset: number;
  statuses: string[];
};

type ForgeRunProcessResult = {
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

type ForgeProcessQueueResponse = {
  mode: "queue";
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  items: ForgeRunProcessResult[];
};

type ForgeProcessSingleResponse = {
  mode: "single";
  result: ForgeRunProcessResult;
};

type ForgeOptionsResponse = {
  models: string[];
  defaultModel: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
};

type DeleteProposalResponse = {
  proposalId: string;
  deleted: boolean;
  deletedRuns: number;
  deletedRunArtifacts: number;
  deletedAuditEvents: number;
  deletedPolicyIncidents: number;
};

type DeleteSkillResponse = {
  skillId: string;
  deleted: boolean;
  deletedVersions: number;
  deletedRuns: number;
  deletedLinkedProposals: number;
  deletedVaultArtifacts: boolean;
  deletedForgeArtifacts: number;
  deletedAuditEvents: number;
  deletedPolicyIncidents: number;
};

type ResetSSEFResponse = {
  deletedRows: {
    policyIncidents: number;
    auditEvents: number;
    runs: number;
    versions: number;
    proposals: number;
    skills: number;
  };
  workspaceRootDeleted: boolean;
  embeddingCollectionDeleted: boolean;
  bootstrapReady: boolean;
};

type DashboardFilters = {
  proposalStatus: string;
  proposalQuery: string;
  forgeStatus: string;
  reviewStatus: string;
  skillState: string;
};

const DEFAULT_FILTERS: DashboardFilters = {
  proposalStatus: "",
  proposalQuery: "",
  forgeStatus: "",
  reviewStatus: DEFAULT_REVIEW_STATUSES,
  skillState: "",
};

type NoticeTone = "info" | "success" | "error";

function formatDateTime(raw: string | null | undefined) {
  if (!raw) {
    return "n/a";
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadgeClass(value: string) {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("active") ||
    normalized.includes("approved") ||
    normalized.includes("complete") ||
    normalized === "pass"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (
    normalized.includes("review") ||
    normalized.includes("sandbox") ||
    normalized.includes("running") ||
    normalized.includes("draft") ||
    normalized.includes("queued")
  ) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (
    normalized.includes("reject") ||
    normalized.includes("fail") ||
    normalized.includes("disable") ||
    normalized.includes("retired") ||
    normalized.includes("error")
  ) {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-black/10 bg-black/[0.03] text-[var(--muted)]";
}

function riskBadgeClass(value: SSEFReviewRiskSummary["riskLevel"] | null | undefined) {
  if (value === "critical" || value === "high") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (value === "medium") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (value === "low") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return "border-black/10 bg-black/[0.03] text-[var(--muted)]";
}

function noticeClass(tone: NoticeTone) {
  if (tone === "error") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (tone === "success") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const flattened = value
      .map((entry) => toText(entry))
      .filter((entry): entry is string => Boolean(entry));
    return flattened.length > 0 ? flattened.join(", ") : null;
  }
  return null;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactId(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function pluralize(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(path), init);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed (${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {} as T;
  }
  return (await response.json()) as T;
}

function buildQuery(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    const text = String(value).trim();
    if (text.length === 0) {
      return;
    }
    search.set(key, text);
  });
  return search.toString();
}

function joinPathWithQuery(path: string, query: string) {
  return query.length > 0 ? `${path}?${query}` : path;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown request failure.";
}

function readForgeGenerationMetadata(
  metadata: JsonRecord | null | undefined
): { model: string | null; reasoningEffort: string | null } {
  if (!metadata) {
    return { model: null, reasoningEffort: null };
  }
  const nested =
    metadata.generation &&
    typeof metadata.generation === "object" &&
    !Array.isArray(metadata.generation)
      ? (metadata.generation as JsonRecord)
      : null;
  const model =
    toText(nested?.model) ?? toText(metadata.generation_model) ?? null;
  const reasoningEffort =
    toText(nested?.reasoning_effort) ??
    toText(metadata.generation_reasoning_effort) ??
    null;
  return {
    model,
    reasoningEffort,
  };
}

type ForgeAttemptSummaryView = {
  attempt: number;
  attemptRunId: string | null;
  status: string;
  sandboxPassed: boolean | null;
  totalCases: number | null;
  passedCases: number | null;
  failedCases: number | null;
  functionalVerdict: string | null;
  safetyVerdict: string | null;
  safetyRiskLevel: string | null;
  diagnostics: string[];
  caseFailures: string[];
  failureMessage: string | null;
};

type ForgeProgressView = {
  state: string | null;
  phase: string | null;
  maxAttempts: number | null;
  attemptsExecuted: number | null;
  selectedAttempt: number | null;
  lastAttemptStatus: string | null;
};

function readForgeAttemptSummaries(
  result: JsonRecord | null | undefined
): ForgeAttemptSummaryView[] {
  if (!result) {
    return [];
  }
  const source = Array.isArray(result.attempt_summaries)
    ? result.attempt_summaries
    : [];
  return source
    .map((entry) => {
      const record = asRecord(entry);
      const caseFailures = Array.isArray(record.caseFailures)
        ? record.caseFailures.flatMap((item) => {
            const caseRecord = asRecord(item);
            const caseId = toText(caseRecord.id) ?? "case";
            const assertionMessages = Array.isArray(caseRecord.assertions)
              ? caseRecord.assertions
                  .map((assertion) => toText(assertion))
                  .filter((assertion): assertion is string => Boolean(assertion))
              : [];
            const parseError = toText(caseRecord.parseError);
            if (assertionMessages.length > 0) {
              return assertionMessages.map(
                (assertion) => `[${caseId}] ${assertion}`
              );
            }
            if (parseError) {
              return [`[${caseId}] ${parseError}`];
            }
            return [];
          })
        : [];
      const diagnostics = Array.isArray(record.diagnostics)
        ? record.diagnostics
            .map((diagnostic) => toText(diagnostic))
            .filter((diagnostic): diagnostic is string => Boolean(diagnostic))
        : [];
      const uniqueDiagnostics = Array.from(
        new Set([...diagnostics, ...caseFailures])
      );
      return {
        attempt: asInteger(record.attempt) ?? 0,
        attemptRunId: toText(record.attemptRunId),
        status: toText(record.status) ?? "unknown",
        sandboxPassed: asBoolean(record.sandboxPassed),
        totalCases: asInteger(record.totalCases),
        passedCases: asInteger(record.passedCases),
        failedCases: asInteger(record.failedCases),
        functionalVerdict: toText(record.functionalVerdict),
        safetyVerdict: toText(record.safetyVerdict),
        safetyRiskLevel: toText(record.safetyRiskLevel),
        diagnostics: uniqueDiagnostics,
        caseFailures: [],
        failureMessage: toText(record.failureMessage),
      } satisfies ForgeAttemptSummaryView;
    })
    .filter((entry) => entry.attempt > 0)
    .sort((a, b) => a.attempt - b.attempt);
}

function readForgeProgress(run: SSEFRun): ForgeProgressView {
  const metadata = asRecord(run.metadata);
  const forge = asRecord(metadata.forge);
  const result = asRecord(run.result);
  return {
    state: toText(forge.state),
    phase: toText(forge.phase) ?? toText(result.phase),
    maxAttempts: asInteger(forge.max_attempts) ?? asInteger(result.max_attempts),
    attemptsExecuted:
      asInteger(forge.attempts_executed) ?? asInteger(result.attempts_executed),
    selectedAttempt:
      asInteger(forge.selected_attempt) ?? asInteger(result.selected_attempt),
    lastAttemptStatus: toText(forge.last_attempt_status),
  };
}

function latestForgeRunForProposal(runs: SSEFRun[] | undefined) {
  if (!runs || runs.length === 0) {
    return null;
  }
  return runs[0] ?? null;
}

function processableForgeRunForProposal(runs: SSEFRun[] | undefined) {
  if (!runs || runs.length === 0) {
    return null;
  }
  return runs.find((item) => item.status === "draft")
    ?? runs.find((item) => item.status === "failed")
    ?? null;
}

export default function SSEFPage() {
  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<DashboardFilters>(DEFAULT_FILTERS);
  const [refreshTick, setRefreshTick] = useState(0);
  const hasLoadedOnceRef = useRef(false);
  const [openReviewDetailsByProposalId, setOpenReviewDetailsByProposalId] = useState<
    Record<string, boolean>
  >({});
  const [openForgeAttemptDetailsByRunId, setOpenForgeAttemptDetailsByRunId] =
    useState<Record<string, boolean>>({});

  const [proposalsData, setProposalsData] = useState<PaginatedResponse<SSEFProposal>>({
    items: [],
    total: 0,
    limit: LIST_LIMIT,
    offset: 0,
  });
  const [forgeRunsData, setForgeRunsData] = useState<PaginatedResponse<SSEFRun>>({
    items: [],
    total: 0,
    limit: LIST_LIMIT,
    offset: 0,
  });
  const [skillsData, setSkillsData] = useState<PaginatedResponse<SSEFSkill>>({
    items: [],
    total: 0,
    limit: LIST_LIMIT,
    offset: 0,
  });
  const [reviewQueueData, setReviewQueueData] = useState<SSEFReviewQueueResponse>({
    items: [],
    total: 0,
    limit: LIST_LIMIT,
    offset: 0,
    statuses: DEFAULT_REVIEW_STATUSES.split(","),
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const [operatorActor, setOperatorActor] = useState("operator");
  const [operatorReason, setOperatorReason] = useState("");
  const [operatorNote, setOperatorNote] = useState("");
  const [forgeModels, setForgeModels] = useState<string[]>(DEFAULT_FORGE_MODEL_OPTIONS);
  const [forgeReasoningOptions, setForgeReasoningOptions] = useState<string[]>(
    DEFAULT_FORGE_REASONING_OPTIONS
  );
  const [forgeModel, setForgeModel] = useState(DEFAULT_FORGE_MODEL_OPTIONS[0]);
  const [forgeReasoningEffort, setForgeReasoningEffort] = useState(
    DEFAULT_FORGE_REASONING_OPTIONS[3] ?? "high"
  );

  useEffect(() => {
    let cancelled = false;

    const loadForgeOptions = async () => {
      try {
        const response = await requestJson<ForgeOptionsResponse>(
          "/api/ssef/forge/options"
        );
        if (cancelled) {
          return;
        }
        const normalizedModels = Array.isArray(response.models)
          ? response.models
              .map((item) => item.trim())
              .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index)
          : [];
        const normalizedReasoning = Array.isArray(response.reasoningEfforts)
          ? response.reasoningEfforts
              .map((item) => item.trim().toLowerCase())
              .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index)
          : [];

        const modelOptions =
          normalizedModels.length > 0
            ? normalizedModels
            : DEFAULT_FORGE_MODEL_OPTIONS;
        const reasoningOptions =
          normalizedReasoning.length > 0
            ? normalizedReasoning
            : DEFAULT_FORGE_REASONING_OPTIONS;

        const defaultModel =
          response.defaultModel && modelOptions.includes(response.defaultModel)
            ? response.defaultModel
            : modelOptions[0];
        const defaultReasoning =
          response.defaultReasoningEffort &&
          reasoningOptions.includes(response.defaultReasoningEffort)
            ? response.defaultReasoningEffort
            : reasoningOptions[0];

        setForgeModels(modelOptions);
        setForgeReasoningOptions(reasoningOptions);
        setForgeModel((current) =>
          modelOptions.includes(current) ? current : defaultModel
        );
        setForgeReasoningEffort((current) =>
          reasoningOptions.includes(current) ? current : defaultReasoning
        );
      } catch {
        // Keep defaults when options endpoint is unavailable.
      }
    };

    void loadForgeOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const shouldShowLoadingState = !hasLoadedOnceRef.current;

    const load = async () => {
      if (shouldShowLoadingState) {
        setIsLoading(true);
      }
      setLoadingError(null);

      try {
        const proposalQuery = buildQuery({
          limit: LIST_LIMIT,
          offset: 0,
          status: appliedFilters.proposalStatus,
          q: appliedFilters.proposalQuery,
        });
        const forgeQuery = buildQuery({
          limit: LIST_LIMIT,
          offset: 0,
          status: appliedFilters.forgeStatus,
        });
        const reviewQuery = buildQuery({
          limit: LIST_LIMIT,
          offset: 0,
          status: appliedFilters.reviewStatus,
        });
        const skillsQuery = buildQuery({
          limit: LIST_LIMIT,
          offset: 0,
          state: appliedFilters.skillState,
        });

        const [
          proposalsResponse,
          forgeResponse,
          reviewResponse,
          skillsResponse,
        ] = await Promise.allSettled([
          requestJson<PaginatedResponse<SSEFProposal>>(
            joinPathWithQuery("/api/ssef/proposals", proposalQuery)
          ),
          requestJson<PaginatedResponse<SSEFRun>>(
            joinPathWithQuery("/api/ssef/forge", forgeQuery)
          ),
          requestJson<SSEFReviewQueueResponse>(
            joinPathWithQuery("/api/ssef/review/queue", reviewQuery)
          ),
          requestJson<PaginatedResponse<SSEFSkill>>(
            joinPathWithQuery("/api/ssef/skills", skillsQuery)
          ),
        ]);

        if (cancelled) {
          return;
        }

        const partialErrors: string[] = [];

        if (proposalsResponse.status === "fulfilled") {
          setProposalsData(proposalsResponse.value);
        } else {
          partialErrors.push(`proposals: ${toErrorMessage(proposalsResponse.reason)}`);
        }

        if (forgeResponse.status === "fulfilled") {
          setForgeRunsData(forgeResponse.value);
        } else {
          partialErrors.push(`forge: ${toErrorMessage(forgeResponse.reason)}`);
        }

        if (reviewResponse.status === "fulfilled") {
          setReviewQueueData(reviewResponse.value);
        } else {
          partialErrors.push(`review: ${toErrorMessage(reviewResponse.reason)}`);
        }

        if (skillsResponse.status === "fulfilled") {
          setSkillsData(skillsResponse.value);
        } else {
          partialErrors.push(`skills: ${toErrorMessage(skillsResponse.reason)}`);
        }

        if (partialErrors.length > 0) {
          setLoadingError(`Partial SSEF data load failed: ${partialErrors.join(" | ")}`);
        }

        setLastUpdatedAt(new Date().toISOString());
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadingError(toErrorMessage(error));
      } finally {
        if (!cancelled) {
          if (shouldShowLoadingState) {
            setIsLoading(false);
          }
          hasLoadedOnceRef.current = true;
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [appliedFilters, refreshTick]);

  const forgeRunsByProposalId = useMemo(() => {
    const map = new Map<string, SSEFRun[]>();
    forgeRunsData.items.forEach((run) => {
      if (!run.proposalId) {
        return;
      }
      const existing = map.get(run.proposalId);
      if (existing) {
        existing.push(run);
        return;
      }
      map.set(run.proposalId, [run]);
    });
    return map;
  }, [forgeRunsData.items]);

  const proposalStatusSummary = useMemo(() => {
    const counts = new Map<string, number>();
    proposalsData.items.forEach((proposal) => {
      counts.set(proposal.status, (counts.get(proposal.status) ?? 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [proposalsData.items]);

  const activeSkillCount = useMemo(
    () => skillsData.items.filter((skill) => skill.lifecycleState === "active").length,
    [skillsData.items]
  );

  const reviewReadyCount = useMemo(
    () =>
      reviewQueueData.items.filter((item) => item.riskSummary?.reviewReady === true)
        .length,
    [reviewQueueData.items]
  );

  const hasRunningForgeWork = useMemo(() => {
    if (forgeRunsData.items.some((run) => run.status === "running")) {
      return true;
    }
    return proposalsData.items.some((proposal) => proposal.status === "in_progress");
  }, [forgeRunsData.items, proposalsData.items]);

  useEffect(() => {
    const isForgeAction = busyActionKey?.startsWith("forge-") ?? false;
    if (!hasRunningForgeWork && !isForgeAction) {
      return;
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }
      setRefreshTick((value) => value + 1);
    }, FORGE_AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [busyActionKey, hasRunningForgeWork]);

  const triggerRefresh = () => {
    setRefreshTick((value) => value + 1);
  };

  const applyFilters = () => {
    setAppliedFilters({
      proposalStatus: filters.proposalStatus.trim(),
      proposalQuery: filters.proposalQuery.trim(),
      forgeStatus: filters.forgeStatus.trim(),
      reviewStatus: filters.reviewStatus.trim(),
      skillState: filters.skillState.trim(),
    });
  };

  const buildReviewPayload = (
    fallbackReason: string,
    includeNote: boolean
  ): Record<string, unknown> => {
    const payload: Record<string, unknown> = {};
    const actor = operatorActor.trim();
    const reason = operatorReason.trim();
    const note = operatorNote.trim();
    if (actor.length > 0) {
      payload.actor = actor;
    }
    payload.reason = reason.length > 0 ? reason : fallbackReason;
    if (includeNote && note.length > 0) {
      payload.note = note;
    }
    return payload;
  };

  const buildOperatorPayload = (fallbackReason: string): Record<string, unknown> => {
    const payload: Record<string, unknown> = {};
    const actor = operatorActor.trim();
    const reason = operatorReason.trim();
    if (actor.length > 0) {
      payload.actor = actor;
    }
    payload.reason = reason.length > 0 ? reason : fallbackReason;
    return payload;
  };

  const runAction = async (
    actionKey: string,
    action: () => Promise<string>,
    pendingMessage?: string
  ) => {
    if (busyActionKey) {
      return;
    }
    setBusyActionKey(actionKey);
    if (pendingMessage && pendingMessage.trim().length > 0) {
      setNotice(pendingMessage);
      setNoticeTone("info");
    } else {
      setNotice(null);
    }
    setLoadingError(null);
    try {
      const message = await action();
      setNotice(message);
      setNoticeTone("success");
      triggerRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed.";
      setNotice(message);
      setNoticeTone("error");
    } finally {
      setBusyActionKey(null);
    }
  };

  const processForgeQueue = async (maxJobs: number) => {
    await runAction(`forge-queue-${maxJobs}`, async () => {
      const actor = operatorActor.trim();
      const response = await requestJson<ForgeProcessQueueResponse>(
        "/api/ssef/forge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            maxJobs,
            actor: actor.length > 0 ? actor : undefined,
            generationModel: forgeModel,
            reasoningEffort: forgeReasoningEffort,
          }),
        }
      );
      return `Forge queue processed with ${forgeModel} (${forgeReasoningEffort}): ${pluralize(response.processed, "job", "jobs")} (${response.completed} completed, ${response.failed} failed, ${response.skipped} skipped).`;
    }, `Forge queue started: up to ${maxJobs} jobs with ${forgeModel} (${forgeReasoningEffort}). Live status refresh every 10s.`);
  };

  const processForgeRun = async (runId: string) => {
    await runAction(`forge-run-${runId}`, async () => {
      const actor = operatorActor.trim();
      const response = await requestJson<ForgeProcessSingleResponse>(
        "/api/ssef/forge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            actor: actor.length > 0 ? actor : undefined,
            generationModel: forgeModel,
            reasoningEffort: forgeReasoningEffort,
          }),
        }
      );
      return `Forge run ${compactId(response.result.runId)} [${forgeModel}/${forgeReasoningEffort}] finished with '${response.result.status}' (${response.result.message}).`;
    }, `Forge run ${compactId(runId)} started with ${forgeModel} (${forgeReasoningEffort}). Live status refresh every 10s.`);
  };

  const approveProposal = async (proposalId: string) => {
    await runAction(`approve-${proposalId}`, async () => {
      const payload = buildReviewPayload("Approved via SSEF console.", true);
      const response = await requestJson<{
        proposal: SSEFProposal;
        skill: SSEFSkill;
        version: { version: string };
      }>(`/api/ssef/review/${encodeURIComponent(proposalId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return `Approved proposal ${compactId(response.proposal.id)}. Activated ${response.skill.skillId}@${response.version.version}.`;
    });
  };

  const rejectProposal = async (proposalId: string) => {
    if (!window.confirm("Reject this proposal from the SSEF review queue?")) {
      return;
    }
    await runAction(`reject-${proposalId}`, async () => {
      const payload = buildReviewPayload("Rejected via SSEF console.", true);
      const response = await requestJson<{
        proposal: SSEFProposal;
      }>(`/api/ssef/review/${encodeURIComponent(proposalId)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return `Rejected proposal ${compactId(response.proposal.id)}.`;
    });
  };

  const rollbackProposal = async (proposalId: string, disableOnly: boolean) => {
    const actionLabel = disableOnly
      ? "Disable current active skill version for this proposal?"
      : "Rollback to previous active version for this proposal?";
    if (!window.confirm(actionLabel)) {
      return;
    }

    await runAction(`rollback-${proposalId}-${disableOnly ? "disable" : "restore"}`, async () => {
      const payload = buildReviewPayload("Rollback via SSEF console.", false);
      payload.disableOnly = disableOnly;
      const response = await requestJson<{
        proposal: SSEFProposal;
        skill: SSEFSkill;
        fromVersion: string;
        restoredVersion: string | null;
        mode: "rollback" | "disabled";
      }>(`/api/ssef/review/${encodeURIComponent(proposalId)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.mode === "rollback") {
        return `Rolled back ${response.skill.skillId} from ${response.fromVersion} to ${response.restoredVersion ?? "n/a"}.`;
      }
      return `Disabled ${response.skill.skillId} version ${response.fromVersion}.`;
    });
  };

  const deleteProposal = async (proposalId: string) => {
    if (!window.confirm("Delete this proposal and its forge runs/artifacts?")) {
      return;
    }
    await runAction(`delete-proposal-${proposalId}`, async () => {
      const payload = buildOperatorPayload("Deleted proposal via SSEF console.");
      const response = await requestJson<DeleteProposalResponse>(
        `/api/ssef/proposals/${encodeURIComponent(proposalId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      return `Deleted proposal ${compactId(response.proposalId)} (runs ${response.deletedRuns}, artifacts ${response.deletedRunArtifacts}).`;
    });
  };

  const deleteSkill = async (skillId: string) => {
    const confirmation = window.prompt(
      `Type the skill id '${skillId}' to confirm permanent deletion.`
    );
    if (confirmation?.trim() !== skillId) {
      return;
    }
    await runAction(`delete-skill-${skillId}`, async () => {
      const payload = buildOperatorPayload("Deleted skill via SSEF console.");
      payload.deleteLinkedProposals = true;
      const response = await requestJson<DeleteSkillResponse>(
        `/api/ssef/skills/${encodeURIComponent(skillId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      return `Deleted skill ${response.skillId} (versions ${response.deletedVersions}, runs ${response.deletedRuns}, linked proposals ${response.deletedLinkedProposals}).`;
    });
  };

  const resetSSEF = async () => {
    const confirmation = window.prompt(
      "Type RESET_SSEF to fully wipe SSEF drafts, skills, runs, and artifacts."
    );
    if (confirmation?.trim() !== "RESET_SSEF") {
      return;
    }
    await runAction("reset-ssef", async () => {
      const payload = buildOperatorPayload("Full SSEF reset via SSEF console.");
      payload.confirm = "RESET_SSEF";
      const response = await requestJson<ResetSSEFResponse>(
        "/api/ssef/admin/reset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      return `SSEF reset complete (skills ${response.deletedRows.skills}, proposals ${response.deletedRows.proposals}, runs ${response.deletedRows.runs}).`;
    });
  };

  const renderSparkSummary = (proposal: SSEFProposal) => {
    const problem = toText(proposal.spark.problem);
    const outcome = toText(proposal.spark.desired_outcome);
    if (problem && outcome) {
      return `${problem} -> ${outcome}`;
    }
    if (problem) {
      return problem;
    }
    if (outcome) {
      return outcome;
    }
    return proposal.summary ?? proposal.title ?? "No spark summary.";
  };

  const hasActiveAction = Boolean(busyActionKey);

  return (
    <div className="relative min-h-screen bg-[radial-gradient(circle_at_14%_18%,rgba(122,190,255,0.24),transparent_42%),radial-gradient(circle_at_85%_8%,rgba(96,229,210,0.24),transparent_38%),radial-gradient(circle_at_80%_90%,rgba(182,215,255,0.18),transparent_45%),linear-gradient(180deg,#edf3ff_0%,#eaf4ff_50%,#edf8ff_100%)] px-5 py-8 lg:px-10">
      <div className="pointer-events-none absolute -top-28 right-[-12%] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(84,216,197,0.22),transparent_68%)] blur-2xl" />
      <div className="pointer-events-none absolute bottom-[-120px] left-[-140px] h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(108,168,255,0.28),transparent_70%)] blur-2xl" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
              Operator
            </p>
            <h1 className="font-display text-3xl text-[var(--ink)]">SSEF Console</h1>
            <p className="text-sm text-[var(--muted)]">
              Manage skill proposals, forge queue, review decisions, and rollback from one place.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-black/10 bg-white/70 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur">
              Last sync: {formatDateTime(lastUpdatedAt)}
            </span>
            <Link
              href="/"
              className="rounded-full border border-black/10 bg-white/70 px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur hover:border-[var(--green-400)] hover:text-[var(--ink)]"
            >
              Back to chat
            </Link>
          </div>
        </header>

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Proposals
              </p>
              <p className="mt-2 font-display text-3xl text-[var(--ink)]">
                {proposalsData.total}
              </p>
            </div>
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Review queue
              </p>
              <p className="mt-2 font-display text-3xl text-[var(--ink)]">
                {reviewQueueData.total}
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {reviewReadyCount} review-ready
              </p>
            </div>
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Forge runs
              </p>
              <p className="mt-2 font-display text-3xl text-[var(--ink)]">
                {forgeRunsData.total}
              </p>
            </div>
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Active skills
              </p>
              <p className="mt-2 font-display text-3xl text-[var(--ink)]">
                {activeSkillCount}
              </p>
            </div>
          </div>

          {proposalStatusSummary.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {proposalStatusSummary.map(([status, count]) => (
                <span
                  key={status}
                  className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(status)}`}
                >
                  {status}: {count}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Proposal status filter
                <input
                  type="text"
                  value={filters.proposalStatus}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      proposalStatus: event.target.value,
                    }))
                  }
                  placeholder="draft, review_pending, approved..."
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Proposal search
                <input
                  type="text"
                  value={filters.proposalQuery}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      proposalQuery: event.target.value,
                    }))
                  }
                  placeholder="title/summary query"
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Forge run status filter
                <input
                  type="text"
                  value={filters.forgeStatus}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      forgeStatus: event.target.value,
                    }))
                  }
                  placeholder="draft, running, completed..."
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Review status filter
                <input
                  type="text"
                  value={filters.reviewStatus}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      reviewStatus: event.target.value,
                    }))
                  }
                  placeholder="review_pending,sandbox_passed"
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Skill lifecycle filter
                <input
                  type="text"
                  value={filters.skillState}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      skillState: event.target.value,
                    }))
                  }
                  placeholder="active,disabled,review_pending..."
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
            </div>

            <div className="grid gap-3">
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Actor
                <input
                  type="text"
                  value={operatorActor}
                  onChange={(event) => setOperatorActor(event.target.value)}
                  placeholder="operator"
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Forge model
                <select
                  value={forgeModel}
                  onChange={(event) => setForgeModel(event.target.value)}
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                >
                  {forgeModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Forge reasoning effort
                <select
                  value={forgeReasoningEffort}
                  onChange={(event) =>
                    setForgeReasoningEffort(event.target.value.toLowerCase())
                  }
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                >
                  {forgeReasoningOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Reason (optional global)
                <input
                  type="text"
                  value={operatorReason}
                  onChange={(event) => setOperatorReason(event.target.value)}
                  placeholder="Used for approve/reject/rollback"
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
              <label className="grid gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Note (optional global)
                <textarea
                  value={operatorNote}
                  onChange={(event) => setOperatorNote(event.target.value)}
                  placeholder="Applied to approve/reject actions"
                  className="min-h-20 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm tracking-normal text-[var(--ink)] outline-none focus:border-[var(--green-400)]"
                />
              </label>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-full border border-black/10 bg-[var(--green-500)] px-5 py-3 text-xs uppercase tracking-[0.2em] text-white shadow-[var(--shadow)] hover:bg-[var(--green-600)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={applyFilters}
              disabled={isLoading || hasActiveAction}
            >
              Apply filters
            </button>
            <button
              type="button"
              className="rounded-full border border-black/10 bg-white px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={triggerRefresh}
              disabled={isLoading || hasActiveAction}
            >
              Refresh
            </button>
            <button
              type="button"
              className="rounded-full border border-black/10 bg-white px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void processForgeQueue(1)}
              disabled={isLoading || hasActiveAction}
            >
              Process 1 forge job
            </button>
            <button
              type="button"
              className="rounded-full border border-black/10 bg-white px-5 py-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void processForgeQueue(5)}
              disabled={isLoading || hasActiveAction}
            >
              Process 5 forge jobs
            </button>
            <span className="rounded-full border border-black/10 bg-white px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
              Forge profile: {forgeModel} · {forgeReasoningEffort}
            </span>
          </div>
        </section>

        {notice && (
          <div className={`rounded-2xl border px-4 py-3 text-sm ${noticeClass(noticeTone)}`}>
            {notice}
          </div>
        )}
        {hasRunningForgeWork && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Forge processing is active. Console auto-refreshes every 10 seconds.
          </div>
        )}
        {loadingError && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {loadingError}
          </div>
        )}
        {isLoading && (
          <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
            Loading SSEF dashboard...
          </div>
        )}

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Review Queue
              </p>
              <h2 className="font-display text-2xl text-[var(--ink)]">
                {reviewQueueData.total} candidates
              </h2>
            </div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
              statuses: {reviewQueueData.statuses.join(", ")}
            </p>
          </div>

          {!isLoading && reviewQueueData.items.length === 0 && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              No review candidates for current filters.
            </div>
          )}

          {!isLoading && reviewQueueData.items.length > 0 && (
            <ul className="grid gap-4">
              {reviewQueueData.items.map((item) => {
                const proposal = item.proposal;
                const candidateVersion = item.candidateVersion;
                const risk = item.riskSummary;
                const tests = item.tests;
                const canApprove = ["sandbox_passed", "review_pending", "approved"].includes(
                  proposal.status
                );
                const canReject = ["sandbox_passed", "review_pending", "approved"].includes(
                  proposal.status
                );
                const canRollback = ["approved", "rolled_back"].includes(proposal.status);

                return (
                  <li
                    key={proposal.id}
                    className="rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="grid gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(proposal.status)}`}
                          >
                            {proposal.status}
                          </span>
                          {candidateVersion && (
                            <span className="rounded-full border border-black/10 bg-black/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                              {candidateVersion.skillId}@{candidateVersion.version}
                            </span>
                          )}
                          <span
                            className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${riskBadgeClass(risk?.riskLevel)}`}
                          >
                            risk {risk?.riskLevel ?? "unknown"}
                          </span>
                        </div>
                        <p className="text-[15px] font-medium text-[var(--ink)]">
                          {proposal.title ?? renderSparkSummary(proposal)}
                        </p>
                        {proposal.summary && (
                          <p className="text-sm text-[var(--muted)]">{proposal.summary}</p>
                        )}
                        <p className="text-xs text-[var(--muted)]">
                          Proposal {compactId(proposal.id)} · Created{" "}
                          {formatDateTime(proposal.createdAt)}
                        </p>
                        {tests && (
                          <p className="text-xs text-[var(--muted)]">
                            Sandbox{" "}
                            {tests.sandboxPassed === null
                              ? "unknown"
                              : tests.sandboxPassed
                                ? "passed"
                                : "failed"}{" "}
                            · cases{" "}
                            {tests.totalCases ?? "n/a"} ({tests.passedCases ?? "n/a"} passed /{" "}
                            {tests.failedCases ?? "n/a"} failed)
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-full border border-black/10 bg-[var(--green-500)] px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-white hover:bg-[var(--green-600)] disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void approveProposal(proposal.id)}
                          disabled={hasActiveAction || !canApprove}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="rounded-full border border-black/10 bg-white px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-red-400 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void rejectProposal(proposal.id)}
                          disabled={hasActiveAction || !canReject}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="rounded-full border border-black/10 bg-white px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-amber-400 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void rollbackProposal(proposal.id, false)}
                          disabled={hasActiveAction || !canRollback}
                        >
                          Rollback
                        </button>
                        <button
                          type="button"
                          className="rounded-full border border-black/10 bg-white px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-red-400 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void rollbackProposal(proposal.id, true)}
                          disabled={hasActiveAction || !canRollback}
                        >
                          Disable only
                        </button>
                      </div>
                    </div>

                    {risk && risk.flags.length > 0 && (
                      <ul className="mt-3 grid gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {risk.flags.map((flag) => (
                          <li key={flag}>{flag}</li>
                        ))}
                      </ul>
                    )}

                    {item.issues.length > 0 && (
                      <ul className="mt-3 grid gap-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        {item.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}

                    <details
                      className="mt-3 rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2"
                      open={Boolean(openReviewDetailsByProposalId[proposal.id])}
                      onToggle={(event) => {
                        const { open } = event.currentTarget;
                        setOpenReviewDetailsByProposalId((prev) => ({
                          ...prev,
                          [proposal.id]: open,
                        }));
                      }}
                    >
                      <summary className="cursor-pointer text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                        Details
                      </summary>
                      <div className="mt-3 grid gap-3 text-xs text-[var(--ink)]">
                        {item.permissionDiff && (
                          <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
                            <p className="font-medium">Permission diff</p>
                            <p>
                              baseline {item.permissionDiff.baselineVersion ?? "none"} · added{" "}
                              {item.permissionDiff.added.length} · removed{" "}
                              {item.permissionDiff.removed.length}
                            </p>
                            {item.permissionDiff.added.length > 0 && (
                              <p className="mt-1 break-all text-[var(--muted)]">
                                + {item.permissionDiff.added.join(" | ")}
                              </p>
                            )}
                            {item.permissionDiff.removed.length > 0 && (
                              <p className="mt-1 break-all text-[var(--muted)]">
                                - {item.permissionDiff.removed.join(" | ")}
                              </p>
                            )}
                          </div>
                        )}

                        {item.artifacts && (
                          <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
                            <p className="font-medium">Artifacts</p>
                            <p className="break-all text-[var(--muted)]">
                              manifest: {item.artifacts.manifestPath ?? "n/a"}
                            </p>
                            <p className="break-all text-[var(--muted)]">
                              entrypoint: {item.artifacts.entrypointPath ?? "n/a"}
                            </p>
                            <p className="break-all text-[var(--muted)]">
                              tests: {item.artifacts.testCasesPath ?? "n/a"}
                            </p>
                            <p className="break-all text-[var(--muted)]">
                              security: {item.artifacts.securitySummaryPath ?? "n/a"}
                            </p>
                          </div>
                        )}

                        {tests && tests.diagnostics.length > 0 && (
                          <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
                            <p className="font-medium">Diagnostics</p>
                            <ul className="mt-1 grid gap-1 text-[var(--muted)]">
                              {tests.diagnostics.map((diagnostic) => (
                                <li key={diagnostic}>{diagnostic}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {item.manifest && (
                          <pre className="max-h-80 overflow-auto rounded-xl border border-black/10 bg-white p-3 text-[11px] text-[var(--ink)]">
                            {stringifyJson(item.manifest)}
                          </pre>
                        )}

                        {item.critics && (
                          <div className="rounded-xl border border-black/10 bg-white px-3 py-2">
                            <p className="font-medium">Critic reports</p>
                            <p className="break-all text-[var(--muted)]">
                              functional: {item.critics.functionalReportPath ?? "n/a"}
                            </p>
                            <p className="break-all text-[var(--muted)]">
                              safety: {item.critics.safetyReportPath ?? "n/a"}
                            </p>
                          </div>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                  Proposals
                </p>
                <h2 className="font-display text-2xl text-[var(--ink)]">
                  {proposalsData.total}
                </h2>
              </div>
            </div>
            {!isLoading && proposalsData.items.length === 0 && (
              <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                No proposals for current filters.
              </div>
            )}
            {!isLoading && proposalsData.items.length > 0 && (
              <ul className="grid gap-3">
                {proposalsData.items.map((proposal) => {
                  const linkedRuns = forgeRunsByProposalId.get(proposal.id);
                  const latestRun = latestForgeRunForProposal(linkedRuns);
                  const processableRun = processableForgeRunForProposal(linkedRuns);
                  const latestRunProgress = latestRun ? readForgeProgress(latestRun) : null;
                  const isForgeRunning = latestRun?.status === "running";
                  const processButtonLabel = processableRun
                    ? "Process forge run"
                    : isForgeRunning
                      ? "Forge running"
                      : latestRun
                        ? `Run ${latestRun.status}`
                        : "No forge run";
                  return (
                    <li
                      key={proposal.id}
                      className="rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="grid gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(proposal.status)}`}
                            >
                              {proposal.status}
                            </span>
                            {proposal.priority && (
                              <span className="rounded-full border border-black/10 bg-black/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                                priority {proposal.priority}
                              </span>
                            )}
                          </div>
                          <p className="font-medium text-[var(--ink)]">
                            {proposal.title ?? renderSparkSummary(proposal)}
                          </p>
                          <p className="text-xs text-[var(--muted)]">
                            {renderSparkSummary(proposal)}
                          </p>
                          <p className="text-xs text-[var(--muted)]">
                            {compactId(proposal.id)} · {formatDateTime(proposal.createdAt)}
                          </p>
                        </div>

                        <button
                          type="button"
                          className="rounded-full border border-black/10 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() =>
                            processableRun && void processForgeRun(processableRun.id)
                          }
                          disabled={hasActiveAction || !processableRun || isForgeRunning}
                          title={
                            processableRun
                              ? `Process run ${processableRun.id}`
                              : latestRun
                                ? `Latest run ${latestRun.id} is '${latestRun.status}'.`
                                : "No forge run linked"
                          }
                        >
                          {processButtonLabel}
                        </button>
                        <button
                          type="button"
                          className="rounded-full border border-red-200 bg-white px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-red-700 hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void deleteProposal(proposal.id)}
                          disabled={hasActiveAction}
                        >
                          Delete
                        </button>
                      </div>

                      {linkedRuns && linkedRuns.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {linkedRuns.map((run) => (
                            <span
                              key={run.id}
                              className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(run.status)}`}
                              title={`Run ${run.id}`}
                            >
                              {run.status} #{run.attempt}
                            </span>
                          ))}
                        </div>
                      )}

                      {latestRun && (
                        <p className="mt-2 text-xs text-[var(--muted)]">
                          Latest forge {compactId(latestRun.id)}
                          {latestRunProgress?.phase ? ` · ${latestRunProgress.phase}` : ""}
                          {latestRun.error ? ` · error: ${latestRun.error}` : ""}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                  Forge Runs
                </p>
                <h2 className="font-display text-2xl text-[var(--ink)]">
                  {forgeRunsData.total}
                </h2>
              </div>
            </div>
            {!isLoading && forgeRunsData.items.length === 0 && (
              <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
                No forge runs for current filters.
              </div>
            )}
            {!isLoading && forgeRunsData.items.length > 0 && (
              <ul className="grid gap-3">
                {forgeRunsData.items.map((run) => {
                  const canProcess = run.status === "draft" || run.status === "failed";
                  const resultMessage =
                    toText(run.result?.message) ?? toText(run.result?.last_failure);
                  const generation = readForgeGenerationMetadata(run.metadata);
                  const progress = readForgeProgress(run);
                  const attemptSummaries = readForgeAttemptSummaries(run.result);
                  const attemptProgress =
                    progress.maxAttempts !== null && progress.attemptsExecuted !== null
                      ? `${progress.attemptsExecuted}/${progress.maxAttempts}`
                      : null;
                  return (
                    <li
                      key={run.id}
                      className="rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="grid gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(run.status)}`}
                            >
                              {run.status}
                            </span>
                            <span className="rounded-full border border-black/10 bg-black/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                              attempt {run.attempt}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--muted)]">
                            run {compactId(run.id)} · proposal {compactId(run.proposalId)}
                          </p>
                          <p className="text-xs text-[var(--muted)]">
                            started {formatDateTime(run.startedAt)} · finished{" "}
                            {formatDateTime(run.finishedAt)}
                          </p>
                          {(progress.phase || attemptProgress || progress.lastAttemptStatus) && (
                            <p className="text-xs text-[var(--muted)]">
                              {progress.phase ? `phase ${progress.phase}` : "phase n/a"}
                              {attemptProgress ? ` · attempts ${attemptProgress}` : ""}
                              {progress.lastAttemptStatus
                                ? ` · last attempt ${progress.lastAttemptStatus}`
                                : ""}
                            </p>
                          )}
                          {(generation.model || generation.reasoningEffort) && (
                            <p className="text-xs text-[var(--muted)]">
                              forge generator: {generation.model ?? "n/a"} · reasoning{" "}
                              {generation.reasoningEffort ?? "n/a"}
                            </p>
                          )}
                          {run.error && (
                            <p className="text-xs text-red-700">error: {run.error}</p>
                          )}
                          {resultMessage && (
                            <p className="text-xs text-[var(--muted)]">{resultMessage}</p>
                          )}
                          {(run.stdoutLogPath || run.stderrLogPath || run.traceLogPath) && (
                            <div className="grid gap-1 text-xs text-[var(--muted)]">
                              {run.stdoutLogPath && (
                                <p className="break-all">stdout: {run.stdoutLogPath}</p>
                              )}
                              {run.stderrLogPath && (
                                <p className="break-all">stderr: {run.stderrLogPath}</p>
                              )}
                              {run.traceLogPath && (
                                <p className="break-all">trace: {run.traceLogPath}</p>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="rounded-full border border-black/10 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => void processForgeRun(run.id)}
                          disabled={hasActiveAction || !canProcess}
                        >
                          Process run
                        </button>
                      </div>

                      {attemptSummaries.length > 0 && (
                        <details
                          className="mt-3 rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2"
                          open={Boolean(openForgeAttemptDetailsByRunId[run.id])}
                          onToggle={(event) => {
                            const { open } = event.currentTarget;
                            setOpenForgeAttemptDetailsByRunId((prev) => ({
                              ...prev,
                              [run.id]: open,
                            }));
                          }}
                        >
                          <summary className="cursor-pointer text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                            Attempt diagnostics ({attemptSummaries.length})
                          </summary>
                          <div className="mt-2 grid gap-2">
                            {attemptSummaries.map((attempt) => (
                              <div
                                key={`${run.id}-attempt-${attempt.attempt}`}
                                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-[var(--ink)]"
                              >
                                <p className="font-medium">
                                  Attempt {attempt.attempt} · {attempt.status}
                                </p>
                                <p className="text-[var(--muted)]">
                                  sandbox{" "}
                                  {attempt.sandboxPassed === null
                                    ? "unknown"
                                    : attempt.sandboxPassed
                                      ? "passed"
                                      : "failed"}
                                  {attempt.totalCases !== null
                                    ? ` · cases ${attempt.passedCases ?? "n/a"}/${attempt.totalCases} passed`
                                    : ""}
                                  {attempt.functionalVerdict
                                    ? ` · functional ${attempt.functionalVerdict}`
                                    : ""}
                                  {attempt.safetyVerdict
                                    ? ` · safety ${attempt.safetyVerdict}`
                                    : ""}
                                  {attempt.safetyRiskLevel
                                    ? ` · risk ${attempt.safetyRiskLevel}`
                                    : ""}
                                </p>
                                {attempt.failureMessage && (
                                  <p className="mt-1 text-red-700">
                                    {attempt.failureMessage}
                                  </p>
                                )}
                                {attempt.diagnostics.length > 0 && (
                                  <ul className="mt-1 grid gap-1 text-[var(--muted)]">
                                    {attempt.diagnostics.map((diagnostic, index) => (
                                      <li
                                        key={`${run.id}-${attempt.attempt}-diag-${String(index)}`}
                                      >
                                        {diagnostic}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-[32px] border border-black/10 bg-white/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Skills
              </p>
              <h2 className="font-display text-2xl text-[var(--ink)]">
                {skillsData.total}
              </h2>
            </div>
          </div>
          {!isLoading && skillsData.items.length === 0 && (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm text-[var(--muted)]">
              No skills for current filters.
            </div>
          )}
          {!isLoading && skillsData.items.length > 0 && (
            <ul className="grid gap-3">
              {skillsData.items.map((skill) => (
                <li
                  key={skill.id}
                  className="rounded-2xl border border-black/10 bg-white px-4 py-4 text-sm shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${statusBadgeClass(skill.lifecycleState)}`}
                        >
                          {skill.lifecycleState}
                        </span>
                        {skill.activeVersion && (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-700">
                            active {skill.activeVersion}
                          </span>
                        )}
                        {skill.latestVersion && (
                          <span className="rounded-full border border-black/10 bg-black/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                            latest {skill.latestVersion}
                          </span>
                        )}
                      </div>
                      <p className="font-medium text-[var(--ink)]">{skill.skillId}</p>
                      {skill.name && <p className="text-xs text-[var(--muted)]">{skill.name}</p>}
                      <p className="text-xs text-[var(--muted)]">{skill.description}</p>
                      <p className="text-xs text-[var(--muted)]">
                        Updated {formatDateTime(skill.updatedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full border border-red-200 bg-white px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-red-700 hover:border-red-400 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => void deleteSkill(skill.skillId)}
                      disabled={hasActiveAction}
                    >
                      Delete skill
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-[32px] border border-red-200 bg-red-50/70 p-6 shadow-[var(--shadow)] backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-red-700">
                Danger zone
              </p>
              <p className="text-sm text-red-700/90">
                Permanently remove all SSEF proposals, skills, runs, workspace artifacts, and SSEF embeddings.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full border border-red-300 bg-white px-5 py-3 text-xs uppercase tracking-[0.2em] text-red-700 hover:border-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void resetSSEF()}
              disabled={hasActiveAction}
            >
              Reset SSEF
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
