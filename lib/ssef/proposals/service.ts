import { appendSSEFAuditEvent } from "../audit";
import { ensureSSEFReady } from "../bootstrap";
import {
  buildSSEFReuseQueryFromSpark,
  searchSSEFReuseCandidates,
} from "../retrieval/search";
import {
  createSSEFProposal,
  createSSEFRun,
  getSSEFSkillBySkillId,
  listSSEFSkills,
  type SSEFProposal,
  type SSEFRun,
  type SSEFSkill,
} from "../repository";
import {
  parseSSEFSparkUpgradeTarget,
  type SSEFSparkUpgradeTarget,
  type SSEFVersionBump,
} from "./upgrade";

const SPARK_PRIORITY_VALUES = ["low", "medium", "high", "urgent"] as const;
const DEFAULT_SPARK_PRIORITY = "medium";
const MIN_PROBLEM_CHARS = 12;
const MIN_DESIRED_OUTCOME_CHARS = 8;
const MIN_SKILL_NAME_CHARS = 3;
const MAX_SPARK_TEXT_CHARS = 1_200;
const MAX_SPARK_LIST_ITEMS = 20;
const MAX_SPARK_LIST_ITEM_CHARS = 180;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_DEDUPE_KEYWORDS = 20;
const DEDUPE_MAX_ACTIVE_SKILLS = 400;
const DEDUPE_MAX_CANDIDATES = 5;
const DEDUPE_STRONG_MATCH_SCORE = 0.46;
const DEDUPE_MEDIUM_MATCH_SCORE = 0.35;
const DEDUPE_MEDIUM_MATCH_KEYWORD_OVERLAP = 4;
const DEDUPE_SEMANTIC_STRONG_MATCH_SCORE = 0.72;
const PROPOSAL_TITLE_MAX_CHARS = 120;
const PROPOSAL_SUMMARY_MAX_CHARS = 320;

const KEYWORD_STOP_WORDS = new Set<string>([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "done",
  "each",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "help",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "make",
  "me",
  "more",
  "my",
  "need",
  "needs",
  "new",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "some",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "tool",
  "tools",
  "use",
  "using",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

export type SSEFSparkPriority = (typeof SPARK_PRIORITY_VALUES)[number];

export type SSEFStructuredSpark = {
  problem: string;
  desired_outcome: string;
  skill_name?: string;
  inputs: string[];
  constraints: string[];
  priority: SSEFSparkPriority;
  target_skill_id?: string;
  version_bump?: SSEFVersionBump;
};

export type SSEFSparkDedupeCandidate = {
  skillId: string;
  name: string | null;
  description: string;
  score: number;
  overlapKeywords: string[];
  source: "keyword" | "semantic" | "hybrid";
};

export type SSEFSparkDedupeResult = {
  baseline: "hybrid_v2";
  keywordPool: string[];
  isDuplicateCandidate: boolean;
  candidates: SSEFSparkDedupeCandidate[];
};

export type SubmitSSEFSparkProposalInput = {
  spark: Record<string, unknown>;
  source: "chat" | "idle";
  requestedBy?: string | null;
  actor?: string | null;
  conversationId?: string | null;
  sessionScopeId?: string | null;
  userIntent?: string | null;
};

export type SubmitSSEFSparkProposalResult = {
  status: "queued" | "duplicate_candidate";
  spark: SSEFStructuredSpark;
  upgradeTarget: SSEFSparkUpgradeTarget | null;
  dedupe: SSEFSparkDedupeResult;
  proposal: SSEFProposal;
  forgeRun: SSEFRun;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFlatText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function parseListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => asFlatText(entry));
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => {
      const rendered = asFlatText(entry);
      return rendered ? `${key}: ${rendered}` : key;
    });
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return [];
    }
    const split = normalized
      .split(/\r?\n|[,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (split.length > 1) {
      return split;
    }
    return [normalized];
  }

  const scalar = asFlatText(value);
  return scalar ? [scalar] : [];
}

function normalizeList(value: unknown): string[] {
  const entries = parseListValue(value);
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of entries) {
    const cleaned = entry.replace(/\s+/g, " ").trim();
    if (!cleaned) {
      continue;
    }
    const truncated = truncateText(cleaned, MAX_SPARK_LIST_ITEM_CHARS);
    const dedupeKey = truncated.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(truncated);
    if (normalized.length >= MAX_SPARK_LIST_ITEMS) {
      break;
    }
  }

  return normalized;
}

function normalizePriority(rawPriority: unknown): SSEFSparkPriority {
  const value = asFlatText(rawPriority).toLowerCase();
  if (
    value === "critical" ||
    value === "p0" ||
    value === "p1" ||
    value === "blocker"
  ) {
    return "urgent";
  }
  if (value === "normal" || value === "default") {
    return "medium";
  }
  if (
    SPARK_PRIORITY_VALUES.includes(value as SSEFSparkPriority)
  ) {
    return value as SSEFSparkPriority;
  }
  return DEFAULT_SPARK_PRIORITY;
}

function requireSparkText(
  value: unknown,
  fieldName: "problem" | "desired_outcome",
  minChars: number
) {
  const normalized = asFlatText(value);
  if (!normalized) {
    throw new Error(`ssef_propose_skill requires '${fieldName}'.`);
  }
  if (normalized.length < minChars) {
    throw new Error(
      `'${fieldName}' must be at least ${minChars} characters for a useful spark.`
    );
  }
  if (normalized.length > MAX_SPARK_TEXT_CHARS) {
    throw new Error(
      `'${fieldName}' must be ${MAX_SPARK_TEXT_CHARS} characters or fewer.`
    );
  }
  return normalized;
}

function normalizeOptionalSkillName(value: unknown) {
  const normalized = asFlatText(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length < MIN_SKILL_NAME_CHARS) {
    throw new Error(
      `'skill_name' must be at least ${MIN_SKILL_NAME_CHARS} characters when provided.`
    );
  }
  if (normalized.length > MAX_SKILL_NAME_CHARS) {
    throw new Error(
      `'skill_name' must be ${MAX_SKILL_NAME_CHARS} characters or fewer.`
    );
  }
  return normalized;
}

function normalizeSparkPayload(spark: Record<string, unknown>): SSEFStructuredSpark {
  const problem = requireSparkText(
    spark.problem ?? spark.need ?? spark.issue,
    "problem",
    MIN_PROBLEM_CHARS
  );
  const desiredOutcome = requireSparkText(
    spark.desired_outcome ??
      spark.desiredOutcome ??
      spark.outcome ??
      spark.goal,
    "desired_outcome",
    MIN_DESIRED_OUTCOME_CHARS
  );
  const skillName = normalizeOptionalSkillName(
    spark.skill_name ?? spark.skillName ?? spark.preferred_skill_name
  );
  const inputs = normalizeList(spark.inputs ?? spark.input ?? spark.input_examples);
  const constraints = normalizeList(
    spark.constraints ?? spark.constraint ?? spark.guardrails
  );
  const priority = normalizePriority(spark.priority);
  const upgradeTarget = parseSSEFSparkUpgradeTarget(spark);

  return {
    problem,
    desired_outcome: desiredOutcome,
    skill_name: skillName ?? undefined,
    inputs,
    constraints,
    priority,
    target_skill_id: upgradeTarget?.targetSkillId,
    version_bump: upgradeTarget?.versionBump,
  };
}

function tokenizeKeywords(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        token.length <= 32 &&
        !KEYWORD_STOP_WORDS.has(token)
    );
  return tokens;
}

function buildSparkKeywordPool(spark: SSEFStructuredSpark): string[] {
  const text = [
    spark.problem,
    spark.desired_outcome,
    spark.skill_name ?? "",
    spark.target_skill_id ?? "",
    ...spark.inputs,
    ...spark.constraints,
  ].join(" ");
  const counts = new Map<string, number>();
  tokenizeKeywords(text).forEach((token) => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_DEDUPE_KEYWORDS)
    .map(([token]) => token);
}

function scoreSkillForDedupe(
  skill: SSEFSkill,
  sparkKeywordSet: Set<string>
): SSEFSparkDedupeCandidate | null {
  if (sparkKeywordSet.size === 0) {
    return null;
  }

  const skillText = `${skill.skillId} ${skill.name ?? ""} ${skill.description}`;
  const skillKeywordSet = new Set(tokenizeKeywords(skillText));
  if (skillKeywordSet.size === 0) {
    return null;
  }

  const overlapKeywords = Array.from(sparkKeywordSet).filter((keyword) =>
    skillKeywordSet.has(keyword)
  );
  if (overlapKeywords.length === 0) {
    return null;
  }

  const unionSize = new Set([...sparkKeywordSet, ...skillKeywordSet]).size;
  const coverage = overlapKeywords.length / sparkKeywordSet.size;
  const jaccard = unionSize > 0 ? overlapKeywords.length / unionSize : 0;
  const score = Number((coverage * 0.6 + jaccard * 0.4).toFixed(4));

  return {
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    score,
    overlapKeywords: overlapKeywords.slice(0, 8),
    source: "keyword",
  };
}

async function listActiveSkillsForDedupe(maxSkills = DEDUPE_MAX_ACTIVE_SKILLS) {
  const pageSize = 200;
  const items: SSEFSkill[] = [];
  let offset = 0;

  while (items.length < maxSkills) {
    const remaining = maxSkills - items.length;
    const page = await listSSEFSkills({
      lifecycleState: "active",
      limit: Math.min(pageSize, remaining),
      offset,
    });
    if (page.items.length === 0) {
      break;
    }
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total) {
      break;
    }
  }

  return items;
}

async function evaluateSparkDedupe(
  spark: SSEFStructuredSpark
): Promise<SSEFSparkDedupeResult> {
  const keywordPool = buildSparkKeywordPool(spark);
  const sparkKeywordSet = new Set(keywordPool);
  const activeSkills =
    sparkKeywordSet.size > 0 ? await listActiveSkillsForDedupe() : [];
  const keywordCandidates = activeSkills
    .map((skill) => scoreSkillForDedupe(skill, sparkKeywordSet))
    .filter((candidate): candidate is SSEFSparkDedupeCandidate => Boolean(candidate));

  const semanticQuery = buildSSEFReuseQueryFromSpark({
    problem: spark.problem,
    desired_outcome: spark.desired_outcome,
    inputs: spark.inputs,
    constraints: spark.constraints,
    keywords: keywordPool,
  });
  const semanticCandidates = semanticQuery
    ? await searchSSEFReuseCandidates({
        query: semanticQuery,
        topK: DEDUPE_MAX_CANDIDATES,
        onlyActive: true,
      })
    : [];

  const merged = new Map<string, SSEFSparkDedupeCandidate>();
  keywordCandidates.forEach((candidate) => {
    merged.set(candidate.skillId, candidate);
  });
  semanticCandidates.forEach((candidate) => {
    const existing = merged.get(candidate.skillId);
    const semanticEntry: SSEFSparkDedupeCandidate = {
      skillId: candidate.skillId,
      name: null,
      description: candidate.description,
      score: candidate.score,
      overlapKeywords: [],
      source: "semantic",
    };
    if (!existing) {
      merged.set(candidate.skillId, semanticEntry);
      return;
    }
    merged.set(candidate.skillId, {
      ...existing,
      description: existing.description || semanticEntry.description,
      score: Math.max(existing.score, semanticEntry.score),
      source: "hybrid",
    });
  });

  const candidates = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, DEDUPE_MAX_CANDIDATES);

  const isDuplicateCandidate = candidates.some(
    (candidate) =>
      candidate.score >= DEDUPE_SEMANTIC_STRONG_MATCH_SCORE ||
      candidate.score >= DEDUPE_STRONG_MATCH_SCORE ||
      (candidate.score >= DEDUPE_MEDIUM_MATCH_SCORE &&
        candidate.overlapKeywords.length >= DEDUPE_MEDIUM_MATCH_KEYWORD_OVERLAP)
  );

  return {
    baseline: "hybrid_v2",
    keywordPool,
    isDuplicateCandidate,
    candidates,
  };
}

function buildProposalTitle(spark: SSEFStructuredSpark) {
  if (spark.skill_name) {
    return truncateText(spark.skill_name, PROPOSAL_TITLE_MAX_CHARS);
  }
  return truncateText(spark.desired_outcome, PROPOSAL_TITLE_MAX_CHARS);
}

function buildProposalSummary(spark: SSEFStructuredSpark) {
  const skillNameSegment = spark.skill_name
    ? `Skill name: ${spark.skill_name} | `
    : "";
  const upgradeSegment = spark.target_skill_id
    ? `Upgrade target: ${spark.target_skill_id} (${spark.version_bump ?? "patch"}) | `
    : "";
  const compact = `${skillNameSegment}${upgradeSegment}Problem: ${spark.problem} | Desired outcome: ${spark.desired_outcome}`;
  return truncateText(compact, PROPOSAL_SUMMARY_MAX_CHARS);
}

export async function submitSSEFSparkProposal(
  input: SubmitSSEFSparkProposalInput
): Promise<SubmitSSEFSparkProposalResult> {
  await ensureSSEFReady();

  const spark = normalizeSparkPayload(input.spark);
  const upgradeTarget =
    spark.target_skill_id && spark.version_bump
      ? {
          targetSkillId: spark.target_skill_id,
          versionBump: spark.version_bump,
        }
      : null;
  if (upgradeTarget) {
    const existingSkill = await getSSEFSkillBySkillId(upgradeTarget.targetSkillId);
    if (!existingSkill) {
      throw new Error(
        `ssef_propose_skill 'target_skill_id' not found: ${upgradeTarget.targetSkillId}.`
      );
    }
  }
  const dedupe = await evaluateSparkDedupe(spark);
  const actor = asNonEmptyText(input.actor) ?? "ssef-proposal-service";
  const requestedBy = asNonEmptyText(input.requestedBy) ?? `assistant-${input.source}`;

  const proposal = await createSSEFProposal({
    proposalType: "spark",
    status: "draft",
    skillId: upgradeTarget?.targetSkillId,
    requestedBy,
    title: buildProposalTitle(spark),
    summary: buildProposalSummary(spark),
    spark: {
      ...spark,
      keywords: dedupe.keywordPool,
    },
    constraints: spark.constraints.length > 0 ? { items: spark.constraints } : null,
    priority: spark.priority,
    metadata: {
      source: input.source,
      conversation_id: input.conversationId ?? null,
      session_scope_id: input.sessionScopeId ?? null,
      user_intent: input.userIntent ?? null,
      dedupe: {
        baseline: dedupe.baseline,
        duplicate_candidate: dedupe.isDuplicateCandidate,
        candidate_count: dedupe.candidates.length,
        top_skill_ids: dedupe.candidates.map((candidate) => candidate.skillId),
      },
      upgrade: upgradeTarget
        ? {
            target_skill_id: upgradeTarget.targetSkillId,
            version_bump: upgradeTarget.versionBump,
          }
        : null,
    },
    actor,
  });

  const forgeRun = await createSSEFRun({
    proposalId: proposal.id,
    runType: "forge_job",
    status: "draft",
    attempt: 1,
    metadata: {
      queue: "forge",
      source: input.source,
      dedupe: {
        baseline: dedupe.baseline,
        duplicate_candidate: dedupe.isDuplicateCandidate,
        candidates: dedupe.candidates.map((candidate) => ({
          skill_id: candidate.skillId,
          score: candidate.score,
          overlap_keywords: candidate.overlapKeywords,
        })),
      },
      upgrade: upgradeTarget
        ? {
            target_skill_id: upgradeTarget.targetSkillId,
            version_bump: upgradeTarget.versionBump,
          }
        : null,
    },
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "proposal.triggered",
    actor,
    proposalId: proposal.id,
    runId: forgeRun.id,
    payload: {
      source: input.source,
      requested_by: requestedBy,
      status: proposal.status,
      duplicate_candidate: dedupe.isDuplicateCandidate,
      dedupe_baseline: dedupe.baseline,
      dedupe_skill_ids: dedupe.candidates.map((candidate) => candidate.skillId),
      upgrade_target_skill_id: upgradeTarget?.targetSkillId ?? null,
      upgrade_version_bump: upgradeTarget?.versionBump ?? null,
      spark_preview: {
        skill_name: spark.skill_name ?? null,
        problem: truncateText(spark.problem, 160),
        desired_outcome: truncateText(spark.desired_outcome, 160),
        priority: spark.priority,
      },
    },
  });

  const status = upgradeTarget
    ? "queued"
    : dedupe.isDuplicateCandidate
      ? "duplicate_candidate"
      : "queued";

  return {
    status,
    spark,
    upgradeTarget,
    dedupe,
    proposal,
    forgeRun,
  };
}
