export const SKILL_LIFECYCLE_STATES = [
  "draft",
  "sandbox_passed",
  "review_pending",
  "approved",
  "active",
  "disabled",
  "retired",
] as const;

export type SkillLifecycleState = (typeof SKILL_LIFECYCLE_STATES)[number];

export type SkillLifecycleTransition = {
  from: SkillLifecycleState;
  to: SkillLifecycleState;
  at: string;
  actor?: string;
  reason?: string;
  approvalEventId?: string;
};

export type TransitionSkillLifecycleInput = {
  currentState: SkillLifecycleState;
  nextState: SkillLifecycleState;
  actor?: string;
  reason?: string;
  approvalEventId?: string;
  occurredAt?: string;
};

const ALLOWED_SKILL_LIFECYCLE_TRANSITIONS: Record<
  SkillLifecycleState,
  SkillLifecycleState[]
> = {
  draft: ["sandbox_passed"],
  sandbox_passed: ["review_pending"],
  review_pending: ["approved"],
  approved: ["active"],
  active: ["disabled", "retired"],
  disabled: ["active", "retired"],
  retired: [],
};

function asNonEmptyText(value: string | undefined, label: string) {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty when provided.`);
  }
  return trimmed;
}

function resolveTransitionTimestamp(value: string | undefined) {
  if (!value) {
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("occurredAt must be a valid ISO timestamp.");
  }
  return parsed.toISOString();
}

export function createInitialSkillLifecycleState(): SkillLifecycleState {
  return "draft";
}

export function getAllowedSkillLifecycleTransitions(
  from: SkillLifecycleState
): SkillLifecycleState[] {
  return [...ALLOWED_SKILL_LIFECYCLE_TRANSITIONS[from]];
}

export function canTransitionSkillLifecycle(
  from: SkillLifecycleState,
  to: SkillLifecycleState
) {
  return ALLOWED_SKILL_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertValidSkillLifecycleTransition(
  from: SkillLifecycleState,
  to: SkillLifecycleState
) {
  if (from === to) {
    throw new Error(`Invalid lifecycle transition: ${from} -> ${to}.`);
  }
  if (!canTransitionSkillLifecycle(from, to)) {
    const allowed = getAllowedSkillLifecycleTransitions(from);
    throw new Error(
      `Invalid lifecycle transition: ${from} -> ${to}. Allowed: ${
        allowed.length > 0 ? allowed.join(", ") : "(none)"
      }.`
    );
  }
}

function assertApprovalEventRequirements(
  from: SkillLifecycleState,
  to: SkillLifecycleState,
  approvalEventId: string | undefined
) {
  if (to === "approved" || to === "active") {
    if (!approvalEventId) {
      throw new Error(
        `approvalEventId is required for transition ${from} -> ${to}.`
      );
    }
  }
}

export function transitionSkillLifecycle(
  input: TransitionSkillLifecycleInput
): SkillLifecycleTransition {
  const from = input.currentState;
  const to = input.nextState;

  assertValidSkillLifecycleTransition(from, to);
  const approvalEventId = asNonEmptyText(
    input.approvalEventId,
    "approvalEventId"
  );
  assertApprovalEventRequirements(from, to, approvalEventId);

  return {
    from,
    to,
    at: resolveTransitionTimestamp(input.occurredAt),
    actor: asNonEmptyText(input.actor, "actor"),
    reason: asNonEmptyText(input.reason, "reason"),
    approvalEventId,
  };
}
