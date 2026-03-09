import type { SSEFProposal } from "../repository";
import { readSSEFProposalUpgradeTarget } from "../proposals/upgrade";

export const SSEF_FORGE_PROMPT_CONTRACT_VERSION = "forge_prompt_contract_v2";

export type BuildSSEFForgePromptContractInput = {
  proposal: SSEFProposal;
  attempt: number;
  maxAttempts: number;
  previousFailureSummary?: string[];
};

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asSparkText(
  spark: Record<string, unknown>,
  keys: string[],
  fallback: string
) {
  for (const key of keys) {
    const text = asNonEmptyText(spark[key]);
    if (text) {
      return text;
    }
  }
  return fallback;
}

function asSparkList(
  spark: Record<string, unknown>,
  keys: string[]
): string[] {
  for (const key of keys) {
    const value = spark[key];
    if (Array.isArray(value)) {
      const normalized = value
        .map((entry) => asNonEmptyText(entry))
        .filter(Boolean);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return [];
}

export function buildSSEFForgePromptContract(
  input: BuildSSEFForgePromptContractInput
) {
  const spark = input.proposal.spark ?? {};
  const upgradeTarget = readSSEFProposalUpgradeTarget(input.proposal);
  const problem = asSparkText(
    spark,
    ["problem", "need", "issue"],
    "No explicit problem statement supplied."
  );
  const desiredOutcome = asSparkText(
    spark,
    ["desired_outcome", "desiredOutcome", "outcome", "goal"],
    "No desired outcome supplied."
  );
  const skillName = asSparkText(
    spark,
    ["skill_name", "skillName", "preferred_skill_name"],
    ""
  );
  const inputs = asSparkList(spark, ["inputs", "input", "input_examples"]);
  const constraints = asSparkList(spark, [
    "constraints",
    "constraint",
    "guardrails",
  ]);
  const previousFailures =
    input.previousFailureSummary && input.previousFailureSummary.length > 0
      ? input.previousFailureSummary
      : ["(none)"];

  return [
    `SSEF Forge Prompt Contract (${SSEF_FORGE_PROMPT_CONTRACT_VERSION})`,
    `Proposal ID: ${input.proposal.id}`,
    `Attempt: ${input.attempt}/${input.maxAttempts}`,
    "",
    "Spark:",
    `- problem: ${problem}`,
    `- desired_outcome: ${desiredOutcome}`,
    `- skill_name: ${skillName || "(not provided)"}`,
    `- inputs: ${inputs.length > 0 ? inputs.join(" | ") : "(none)"}`,
    `- constraints: ${constraints.length > 0 ? constraints.join(" | ") : "(none)"}`,
    `- upgrade_target_skill_id: ${upgradeTarget?.targetSkillId ?? "(none)"}`,
    `- upgrade_version_bump: ${upgradeTarget?.versionBump ?? "(none)"}`,
    "",
    "Output Contract:",
    "- Return one skill candidate with manifest + entrypoint + deterministic tests.",
    "- For upgrade proposals, preserve backward compatibility with existing tool inputs unless explicitly changed by spark constraints.",
    "- For upgrade proposals, prefer surgical workspace edits over broad rewrites.",
    "- Manifest must be SkillManifestV1 compliant.",
    "- If third-party libraries are required, declare them in manifest.runtime_dependencies (npm/pip).",
    "- Entrypoint must read JSON from stdin and write JSON to stdout.",
    "- Tests must be deterministic and validate behavior against spark intent.",
    "- Permissions must be least-privilege for declared runtime behavior.",
    "",
    "Refine Guidance:",
    `- Prior failures: ${previousFailures.join(" || ")}`,
    "- Fix hard failures first (runtime error, invalid JSON, failing assertions).",
    "- Keep generated output bounded and machine-parseable.",
  ].join("\n");
}
