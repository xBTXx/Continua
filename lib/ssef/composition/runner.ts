import type {
  SkillManifestInvocationStep,
  SkillManifestV1,
} from "../contracts/manifest";

export type SSEFCompositionExecutionContext = {
  source: string;
  conversationId?: string | null;
  sessionScopeId?: string | null;
  userIntent?: string | null;
};

export type SSEFCompositionPlanStep = {
  step: string;
  skillId: string;
  description?: string;
  input?: Record<string, unknown>;
};

export type SSEFCompositionPlan = {
  compositeSkillId?: string;
  compositeVersion?: string;
  dependencies: string[];
  invocationGraph: SSEFCompositionPlanStep[];
};

export type SSEFCompositionStepResult = {
  step: string;
  skillId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type RunSSEFCompositionPlanInput = {
  plan: SSEFCompositionPlan;
  args: Record<string, unknown>;
  context: SSEFCompositionExecutionContext;
  invokeSkill: (
    skillId: string,
    args: Record<string, unknown>,
    context: SSEFCompositionExecutionContext
  ) => Promise<Record<string, unknown> | null>;
  onStepStart?: (step: SSEFCompositionPlanStep, stepInput: Record<string, unknown>) => void;
  onStepComplete?: (
    step: SSEFCompositionPlanStep,
    stepInput: Record<string, unknown>,
    stepOutput: Record<string, unknown>
  ) => void;
  assertToolAllowed?: (skillId: string) => void;
};

export type SSEFCompositionRunResult = {
  status: "ok";
  mode: "composition";
  compositeSkillId: string | null;
  compositeVersion: string | null;
  dependencies: string[];
  invocationOrder: string[];
  steps: SSEFCompositionStepResult[];
  finalOutput: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeStepName(value: string, index: number) {
  const normalized = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)) {
    return normalized;
  }
  return `step_${String(index + 1)}`;
}

function normalizeInvocationStep(
  step: SkillManifestInvocationStep,
  index: number
): SSEFCompositionPlanStep {
  return {
    step: normalizeStepName(step.step, index),
    skillId: step.skill_id,
    description: step.description,
    input: step.input,
  };
}

export function buildSSEFCompositionPlanFromManifest(
  manifest: SkillManifestV1
): SSEFCompositionPlan {
  const invocationGraph = (manifest.invocation_graph ?? []).map(
    normalizeInvocationStep
  );
  const dependencies = Array.from(
    new Set([
      ...(manifest.dependencies ?? []),
      ...invocationGraph.map((step) => step.skillId),
    ])
  );

  const fallbackGraph =
    invocationGraph.length > 0
      ? invocationGraph
      : dependencies.map((skillId, index) => ({
          step: `step_${String(index + 1)}`,
          skillId,
          input: {},
        }));

  if (fallbackGraph.length === 0) {
    throw new Error("Composition plan requires at least one invocation step.");
  }

  return {
    compositeSkillId: manifest.id,
    compositeVersion: manifest.version,
    dependencies,
    invocationGraph: fallbackGraph,
  };
}

function resolvePathValue(payload: Record<string, unknown>, pathInput: string) {
  const parts = pathInput
    .split(".")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let current: unknown = payload;
  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function toTemplateText(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderTemplateString(
  template: string,
  payload: Record<string, unknown>
): unknown {
  const singleToken = template.match(/^\s*\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}\s*$/);
  if (singleToken?.[1]) {
    return resolvePathValue(payload, singleToken[1]);
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token) => {
    return toTemplateText(resolvePathValue(payload, token));
  });
}

function renderTemplateValue(
  value: unknown,
  payload: Record<string, unknown>
): unknown {
  if (typeof value === "string") {
    return renderTemplateString(value, payload);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, payload));
  }
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, entry]) => {
      rendered[key] = renderTemplateValue(entry, payload);
    });
    return rendered;
  }
  return value;
}

function normalizeStepInput(
  stepInputTemplate: Record<string, unknown> | undefined,
  templatePayload: Record<string, unknown>
) {
  if (!stepInputTemplate) {
    return {};
  }
  const rendered = renderTemplateValue(stepInputTemplate, templatePayload);
  return asRecord(rendered);
}

function ensureValidPlan(input: RunSSEFCompositionPlanInput) {
  const steps = input.plan.invocationGraph;
  if (steps.length === 0) {
    throw new Error("Composition invocation graph cannot be empty.");
  }

  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const stepName = normalizeStepName(step.step, index);
    if (seen.has(stepName)) {
      throw new Error(`Composition step '${stepName}' is duplicated.`);
    }
    seen.add(stepName);
    if (!step.skillId || step.skillId.trim().length === 0) {
      throw new Error(`Composition step '${stepName}' is missing skillId.`);
    }
    if (input.plan.compositeSkillId && step.skillId === input.plan.compositeSkillId) {
      throw new Error(
        `Composite skill '${input.plan.compositeSkillId}' cannot invoke itself.`
      );
    }
  });
}

export async function runSSEFCompositionPlan(
  input: RunSSEFCompositionPlanInput
): Promise<SSEFCompositionRunResult> {
  ensureValidPlan(input);

  const steps: SSEFCompositionStepResult[] = [];
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  for (let index = 0; index < input.plan.invocationGraph.length; index += 1) {
    const step = input.plan.invocationGraph[index];
    const stepName = normalizeStepName(step.step, index);
    if (input.assertToolAllowed) {
      input.assertToolAllowed(step.skillId);
    }

    const stepInput = normalizeStepInput(step.input, {
      args: input.args,
      context: input.context,
      steps: stepOutputs,
    });
    input.onStepStart?.(step, stepInput);

    const output = await input.invokeSkill(step.skillId, stepInput, input.context);
    if (!output) {
      throw new Error(
        `Composition step '${stepName}' failed because tool '${step.skillId}' is unavailable.`
      );
    }

    stepOutputs[stepName] = output;
    steps.push({
      step: stepName,
      skillId: step.skillId,
      input: stepInput,
      output,
    });
    input.onStepComplete?.(step, stepInput, output);
  }

  const finalOutput = steps[steps.length - 1]?.output ?? null;
  return {
    status: "ok",
    mode: "composition",
    compositeSkillId: input.plan.compositeSkillId ?? null,
    compositeVersion: input.plan.compositeVersion ?? null,
    dependencies: input.plan.dependencies,
    invocationOrder: steps.map((step) => step.step),
    steps,
    finalOutput,
  };
}
