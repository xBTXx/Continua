import type { ToolDefinition } from "@/lib/openrouter";
import { ssefEnabled } from "../config";
import {
  submitSSEFSparkProposal,
  type SubmitSSEFSparkProposalResult,
} from "./service";

export const SSEF_PROPOSAL_TRIGGER_TOOL_NAME = "ssef_propose_skill";
export const SSEF_PROPOSAL_TOOL_NAMES = [
  SSEF_PROPOSAL_TRIGGER_TOOL_NAME,
] as const;

type SSEFProposalTriggerToolName = (typeof SSEF_PROPOSAL_TOOL_NAMES)[number];

export type RunSSEFProposalTriggerToolContext = {
  source: "chat" | "idle";
  conversationId?: string | null;
  sessionScopeId?: string | null;
  userIntent?: string | null;
  requestedBy?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ssefProposalToolEnabled() {
  return ssefEnabled() && process.env.SSEF_PROPOSAL_TOOL_ENABLED !== "false";
}

export function ssefProposalToolIdleEnabled() {
  return (
    ssefProposalToolEnabled() &&
    process.env.SSEF_PROPOSAL_TOOL_IDLE_ENABLED === "true"
  );
}

export function isSSEFProposalTriggerToolName(
  name: string
): name is SSEFProposalTriggerToolName {
  return SSEF_PROPOSAL_TOOL_NAMES.includes(name as SSEFProposalTriggerToolName);
}

export function getSSEFProposalTriggerToolDefinitions(): ToolDefinition[] {
  if (!ssefProposalToolEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: SSEF_PROPOSAL_TRIGGER_TOOL_NAME,
        description:
          "Submit a structured SSEF spark proposal to request a new skill or upgrade an existing skill.",
        parameters: {
          type: "object",
          properties: {
            problem: {
              type: "string",
              description:
                "The current gap/problem the assistant cannot solve with existing tools.",
            },
            desired_outcome: {
              type: "string",
              description:
                "What the new skill should accomplish when completed successfully.",
            },
            skill_name: {
              type: "string",
              description:
                "Optional preferred skill name (short and human-readable, for example: 'HTTP Request Bridge').",
            },
            target_skill_id: {
              type: "string",
              description:
                "Optional existing SSEF skill id to upgrade in-place (for example: 'http-request-bridge').",
            },
            version_bump: {
              type: "string",
              enum: ["patch", "minor", "major"],
              description:
                "When target_skill_id is provided, selects the semantic version bump for the upgraded artifact.",
            },
            inputs: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Optional list of expected inputs the skill should accept.",
            },
            constraints: {
              type: "array",
              items: {
                type: "string",
              },
              description:
                "Optional guardrails, restrictions, or non-goals for the requested skill.",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
              description:
                "How urgent this capability is relative to other pending proposals.",
            },
          },
          required: ["problem", "desired_outcome"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function formatProposalToolResponse(result: SubmitSSEFSparkProposalResult) {
  return {
    status: result.status,
    proposal_id: result.proposal.id,
    proposal_status: result.proposal.status,
    forge_job_run_id: result.forgeRun.id,
    forge_job_status: result.forgeRun.status,
    duplicate_candidate: result.dedupe.isDuplicateCandidate,
    dedupe_baseline: result.dedupe.baseline,
    dedupe_keyword_pool: result.dedupe.keywordPool,
    duplicate_matches: result.dedupe.candidates.map((candidate) => ({
      skill_id: candidate.skillId,
      name: candidate.name,
      description: candidate.description,
      score: candidate.score,
      overlap_keywords: candidate.overlapKeywords,
    })),
    spark: result.spark,
    upgrade_target: result.upgradeTarget
      ? {
          skill_id: result.upgradeTarget.targetSkillId,
          version_bump: result.upgradeTarget.versionBump,
        }
      : null,
    next_step: result.upgradeTarget
      ? `Draft forge job queued to upgrade skill '${result.upgradeTarget.targetSkillId}' with ${result.upgradeTarget.versionBump} version bump.`
      : result.dedupe.isDuplicateCandidate
        ? "Draft queue entry created and duplicate candidates were flagged for reuse review."
        : "Draft forge job queued for net-new skill generation.",
  };
}

export async function runSSEFProposalTriggerTool(
  name: string,
  rawArgs: Record<string, unknown>,
  context: RunSSEFProposalTriggerToolContext
) {
  if (!isSSEFProposalTriggerToolName(name)) {
    throw new Error(`Unknown SSEF proposal trigger tool: ${name}`);
  }
  if (!ssefProposalToolEnabled()) {
    throw new Error("SSEF proposal trigger tool is disabled.");
  }
  if (context.source === "idle" && !ssefProposalToolIdleEnabled()) {
    throw new Error("SSEF proposal trigger tool is disabled for idle execution.");
  }

  const spark = isRecord(rawArgs) ? rawArgs : {};
  const result = await submitSSEFSparkProposal({
    spark,
    source: context.source,
    requestedBy: context.requestedBy ?? `assistant-${context.source}`,
    actor: "ssef-proposal-trigger-tool",
    conversationId: context.conversationId ?? null,
    sessionScopeId: context.sessionScopeId ?? null,
    userIntent: context.userIntent ?? null,
  });

  return formatProposalToolResponse(result);
}
