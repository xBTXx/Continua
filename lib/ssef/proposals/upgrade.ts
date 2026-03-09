const VERSION_BUMP_VALUES = ["patch", "minor", "major"] as const;
const TARGET_SKILL_ID_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/;

const TARGET_SKILL_ID_KEYS = [
  "target_skill_id",
  "targetSkillId",
  "existing_skill_id",
  "existingSkillId",
  "upgrade_skill_id",
  "upgradeSkillId",
] as const;

const VERSION_BUMP_KEYS = [
  "version_bump",
  "versionBump",
  "bump",
  "bump_type",
  "bumpType",
] as const;

export type SSEFVersionBump = (typeof VERSION_BUMP_VALUES)[number];

export type SSEFSparkUpgradeTarget = {
  targetSkillId: string;
  versionBump: SSEFVersionBump;
};

type SSEFProposalLike = {
  spark?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickFirstText(
  source: Record<string, unknown>,
  keys: readonly string[]
) {
  for (const key of keys) {
    const value = asNonEmptyText(source[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeVersionBump(value: string | null): SSEFVersionBump {
  if (!value) {
    return "patch";
  }
  const normalized = value.toLowerCase();
  if (VERSION_BUMP_VALUES.includes(normalized as SSEFVersionBump)) {
    return normalized as SSEFVersionBump;
  }
  throw new Error(
    "ssef_propose_skill 'version_bump' must be one of: patch, minor, major."
  );
}

function normalizeTargetSkillId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!TARGET_SKILL_ID_PATTERN.test(normalized)) {
    throw new Error(
      "ssef_propose_skill 'target_skill_id' must be a valid SSEF skill id."
    );
  }
  return normalized;
}

function hasAnyUpgradeFields(source: Record<string, unknown>) {
  return [...TARGET_SKILL_ID_KEYS, ...VERSION_BUMP_KEYS].some(
    (key) => key in source
  );
}

export function parseSSEFSparkUpgradeTarget(
  source: Record<string, unknown>
): SSEFSparkUpgradeTarget | null {
  const targetSkillIdRaw = pickFirstText(source, TARGET_SKILL_ID_KEYS);
  const versionBumpRaw = pickFirstText(source, VERSION_BUMP_KEYS);

  if (!targetSkillIdRaw) {
    if (versionBumpRaw) {
      throw new Error(
        "ssef_propose_skill 'version_bump' requires 'target_skill_id'."
      );
    }
    return null;
  }

  return {
    targetSkillId: normalizeTargetSkillId(targetSkillIdRaw),
    versionBump: normalizeVersionBump(versionBumpRaw),
  };
}

export function readSSEFProposalUpgradeTarget(
  proposal: SSEFProposalLike
): SSEFSparkUpgradeTarget | null {
  const metadata = asRecord(proposal.metadata);
  const metadataUpgrade = asRecord(metadata.upgrade);
  if (hasAnyUpgradeFields(metadataUpgrade)) {
    return parseSSEFSparkUpgradeTarget(metadataUpgrade);
  }

  const spark = asRecord(proposal.spark);
  if (hasAnyUpgradeFields(spark)) {
    return parseSSEFSparkUpgradeTarget(spark);
  }

  return null;
}
