import { randomUUID } from "node:crypto";
import { appendSSEFAuditEvent } from "../audit";
import { ensureSSEFReady } from "../bootstrap";
import { transitionSkillLifecycle } from "../contracts/lifecycle";
import {
  getLatestSSEFSkillVersionBySourceProposal,
  getSSEFProposalById,
  getSSEFSkillBySkillId,
  getSSEFSkillVersionBySkillAndVersion,
  updateSSEFProposalStatus,
  updateSSEFSkillLifecycle,
  updateSSEFSkillVersionLifecycle,
  type SSEFProposal,
  type SSEFSkill,
  type SSEFSkillVersion,
} from "../repository";

const ROLLBACK_ALLOWED_PROPOSAL_STATUSES = new Set<string>(["approved", "rolled_back"]);

export type RollbackSSEFPromotionInput = {
  proposalId: string;
  actor?: string;
  reason?: string;
  disableOnly?: boolean;
};

export type RollbackSSEFPromotionResult = {
  proposal: SSEFProposal;
  skill: SSEFSkill;
  fromVersion: string;
  restoredVersion: string | null;
  mode: "rollback" | "disabled";
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

function mergeRecords(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
) {
  return {
    ...(base ?? {}),
    ...patch,
  };
}

function resolvePreviousActiveVersion(
  proposal: SSEFProposal,
  version: SSEFSkillVersion
) {
  const versionMetadata = asRecord(version.metadata);
  const promotion = asRecord(versionMetadata.promotion);
  if (asNonEmptyText(promotion.previous_active_version)) {
    return asNonEmptyText(promotion.previous_active_version);
  }
  const proposalMetadata = asRecord(proposal.metadata);
  return asNonEmptyText(proposalMetadata.previous_active_version);
}

export async function rollbackSSEFProposalPromotion(
  input: RollbackSSEFPromotionInput
): Promise<RollbackSSEFPromotionResult> {
  await ensureSSEFReady();
  const proposalId = asNonEmptyText(input.proposalId);
  if (!proposalId) {
    throw new Error("proposalId is required.");
  }

  const actor = asOptionalText(input.actor, "ssef-review");
  const reason = asOptionalText(input.reason, "Rollback requested.");
  const disableOnly = input.disableOnly === true;
  const now = new Date().toISOString();

  const proposal = await getSSEFProposalById(proposalId);
  if (!proposal) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }
  if (!ROLLBACK_ALLOWED_PROPOSAL_STATUSES.has(proposal.status)) {
    throw new Error(
      `Proposal '${proposal.id}' cannot be rolled back from status '${proposal.status}'.`
    );
  }

  const candidateVersion = await getLatestSSEFSkillVersionBySourceProposal(proposal.id);
  if (!candidateVersion) {
    throw new Error(`Proposal '${proposal.id}' has no linked promoted skill version.`);
  }
  const skill = await getSSEFSkillBySkillId(candidateVersion.skillId);
  if (!skill) {
    throw new Error(`Skill '${candidateVersion.skillId}' not found.`);
  }
  if (skill.activeVersion !== candidateVersion.version) {
    throw new Error(
      `Rollback requires proposal version '${candidateVersion.version}' to be currently active.`
    );
  }

  if (candidateVersion.lifecycleState === "active") {
    transitionSkillLifecycle({
      currentState: "active",
      nextState: "disabled",
      actor,
      reason,
    });
  }

  await updateSSEFSkillVersionLifecycle({
    skillVersionId: candidateVersion.id,
    lifecycleState: "disabled",
    metadata: mergeRecords(candidateVersion.metadata, {
      rollback: {
        rolled_back_at: now,
        rolled_back_by: actor,
        reason,
      },
    }),
    actor,
    reason,
  });

  const rollbackEventId = `rollback:${randomUUID()}`;
  const previousActiveVersion = disableOnly
    ? null
    : resolvePreviousActiveVersion(proposal, candidateVersion);
  let restoredVersion: string | null = null;

  if (previousActiveVersion && previousActiveVersion !== candidateVersion.version) {
    const previousVersion = await getSSEFSkillVersionBySkillAndVersion(
      skill.skillId,
      previousActiveVersion
    );
    if (previousVersion) {
      if (previousVersion.lifecycleState !== "active") {
        transitionSkillLifecycle({
          currentState: previousVersion.lifecycleState,
          nextState: "active",
          actor,
          reason: `Restoring version ${previousVersion.version} after rollback.`,
          approvalEventId: rollbackEventId,
        });
      }

      await updateSSEFSkillVersionLifecycle({
        skillVersionId: previousVersion.id,
        lifecycleState: "active",
        metadata: mergeRecords(previousVersion.metadata, {
          rollback_restore: {
            restored_at: now,
            restored_by: actor,
            from_version: candidateVersion.version,
            rollback_event_id: rollbackEventId,
          },
        }),
        actor,
        reason: `Restored after rollback of ${candidateVersion.version}.`,
      });

      restoredVersion = previousVersion.version;
    }
  }

  const updatedSkill = restoredVersion
    ? await updateSSEFSkillLifecycle({
        skillId: skill.skillId,
        lifecycleState: "active",
        activeVersion: restoredVersion,
        latestVersion: skill.latestVersion ?? candidateVersion.version,
        actor,
        reason: `Rolled back from ${candidateVersion.version} to ${restoredVersion}.`,
      })
    : await updateSSEFSkillLifecycle({
        skillId: skill.skillId,
        lifecycleState: "disabled",
        activeVersion: null,
        actor,
        reason: `Disabled active version ${candidateVersion.version} via rollback.`,
      });

  const mode: "rollback" | "disabled" = restoredVersion ? "rollback" : "disabled";
  const updatedProposal = await updateSSEFProposalStatus({
    proposalId: proposal.id,
    status: "rolled_back",
    metadata: mergeRecords(proposal.metadata, {
      rollback_mode: mode,
      rollback_at: now,
      rollback_by: actor,
      rollback_reason: reason,
      rollback_from_version: candidateVersion.version,
      rollback_to_version: restoredVersion,
    }),
    actor,
  });

  await appendSSEFAuditEvent({
    eventType: "promotion.rollback",
    actor,
    skillDbId: updatedSkill.id,
    proposalId: updatedProposal.id,
    skillVersionId: candidateVersion.id,
    payload: {
      mode,
      rollback_event_id: rollbackEventId,
      from_version: candidateVersion.version,
      restored_version: restoredVersion,
      reason,
    },
  });

  return {
    proposal: updatedProposal,
    skill: updatedSkill,
    fromVersion: candidateVersion.version,
    restoredVersion,
    mode,
  };
}
