import path from "node:path";
import type { SkillPermission } from "./permissions";
import { validateSkillPermissions } from "./permissions";

export const SKILL_RUNTIMES = [
  "node",
  "python",
  "template",
  "composite",
] as const;

export type SkillRuntime = (typeof SKILL_RUNTIMES)[number];

export type SkillRuntimeDependencies = {
  npm?: string[];
  pip?: string[];
};

export type SkillManifestV1 = {
  manifest_version: 1;
  id: string;
  version: string;
  name?: string;
  description: string;
  runtime: SkillRuntime;
  entrypoint: string;
  permissions: SkillPermission[];
  requires_context: boolean;
  context_keys: string[];
  inputs_schema: Record<string, unknown>;
  outputs_schema: Record<string, unknown>;
  test_cases: string[];
  dependencies?: string[];
  invocation_graph?: SkillManifestInvocationStep[];
  runtime_dependencies?: SkillRuntimeDependencies;
};

export type SkillManifestInvocationStep = {
  step: string;
  skill_id: string;
  description?: string;
  input?: Record<string, unknown>;
};

const MAX_TEXT_FIELD_LENGTH = 500;
const MAX_CONTEXT_KEYS = 64;
const MAX_TEST_CASES = 128;
const MAX_DEPENDENCIES = 64;
const MAX_INVOCATION_STEPS = 128;
const MAX_RUNTIME_DEPENDENCIES_PER_MANAGER = 64;
const MAX_PACKAGE_SPEC_LENGTH = 180;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, label: string, maxLength = 128) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be <= ${maxLength} characters.`);
  }
  return normalized;
}

function asBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function asManifestVersion(value: unknown) {
  if (value === undefined) {
    return 1 as const;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed !== 1) {
    throw new Error("manifest_version must equal 1.");
  }
  return 1 as const;
}

function normalizeSkillId(value: string) {
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(value)) {
    throw new Error(
      "id must be 3-64 chars: lowercase letters, digits, dot, underscore, hyphen."
    );
  }
  return value;
}

function normalizeSkillVersion(value: string) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("version must use semver format (example: 1.0.0).");
  }
  return value;
}

function normalizeDependencySkillId(value: string, label: string) {
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(value)) {
    throw new Error(`${label} must be a valid SSEF skill id.`);
  }
  return value;
}

function normalizeNpmPackageSpec(value: string, label: string) {
  const normalized = value.trim();
  if (
    !/^(?:@(?:[a-z0-9][a-z0-9._-]*)\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/i.test(
      normalized
    )
  ) {
    throw new Error(
      `${label} must be a valid npm package spec (example: lodash or @scope/pkg@1.2.3).`
    );
  }
  return normalized;
}

function normalizePipPackageSpec(value: string, label: string) {
  const normalized = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:==|>=|<=|>|<|~=|!=)\s*[A-Za-z0-9*_.+-]+)?$/.test(
      normalized
    )
  ) {
    throw new Error(
      `${label} must be a valid pip package spec (example: ddgs or requests>=2.31.0).`
    );
  }
  return normalized;
}

function normalizeInvocationStepId(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)) {
    throw new Error(
      `${label} must be 2-64 chars and use lowercase letters, digits, underscore, or hyphen.`
    );
  }
  return normalized;
}

function normalizeEntrypoint(value: string) {
  const slashNormalized = value.replace(/\\/g, "/");
  const withoutLeadingSlash = slashNormalized.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(
      "entrypoint must be a workspace-relative path and cannot escape its directory."
    );
  }
  return normalized;
}

function asSchemaObject(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function normalizeContextKey(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be a valid context key identifier.`);
  }
  return normalized;
}

function normalizeTestCaseReference(value: string, label: string) {
  const slashNormalized = value.replace(/\\/g, "/");
  const withoutLeadingSlash = slashNormalized.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${label} must be a valid relative test case reference.`);
  }
  return normalized;
}

function normalizeUniqueStringList(
  value: unknown,
  label: string,
  maxItems: number,
  normalizer: (entry: string, itemLabel: string) => string
) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  if (value.length > maxItems) {
    throw new Error(`${label} exceeds max size ${maxItems}.`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  value.forEach((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const text = asString(entry, itemLabel, MAX_TEXT_FIELD_LENGTH);
    const next = normalizer(text, itemLabel);
    if (!seen.has(next)) {
      seen.add(next);
      normalized.push(next);
    }
  });
  return normalized;
}

function normalizeFlexibleStringList(
  value: unknown,
  label: string,
  maxItems: number,
  normalizer: (entry: string, itemLabel: string) => string
) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(/[\r\n,;]+/g)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  if (!Array.isArray(source)) {
    throw new Error(`${label} must be an array or delimited string.`);
  }
  return normalizeUniqueStringList(source, label, maxItems, normalizer);
}

function normalizeDependencies(value: unknown) {
  if (value === undefined) {
    return [] as string[];
  }
  return normalizeUniqueStringList(
    value,
    "dependencies",
    MAX_DEPENDENCIES,
    normalizeDependencySkillId
  );
}

function normalizeInvocationGraph(value: unknown): SkillManifestInvocationStep[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("invocation_graph must be an array.");
  }
  if (value.length > MAX_INVOCATION_STEPS) {
    throw new Error(
      `invocation_graph exceeds max size ${MAX_INVOCATION_STEPS}.`
    );
  }

  const seenSteps = new Set<string>();
  return value.map((entry, index) => {
    const label = `invocation_graph[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${label} must be an object.`);
    }

    const rawStep =
      entry.step ?? entry.step_id ?? entry.id ?? `step_${String(index + 1)}`;
    const step = normalizeInvocationStepId(
      asString(rawStep, `${label}.step`, 64),
      `${label}.step`
    );
    if (seenSteps.has(step)) {
      throw new Error(`${label}.step '${step}' is duplicated.`);
    }
    seenSteps.add(step);

    const skillId = normalizeDependencySkillId(
      asString(entry.skill_id, `${label}.skill_id`, 64),
      `${label}.skill_id`
    );
    const stepEntry: SkillManifestInvocationStep = {
      step,
      skill_id: skillId,
    };

    if (entry.description !== undefined) {
      stepEntry.description = asString(
        entry.description,
        `${label}.description`,
        240
      );
    }
    if (entry.input !== undefined) {
      stepEntry.input = asSchemaObject(entry.input, `${label}.input`);
    }
    return stepEntry;
  });
}

function normalizeRuntimeDependencies(
  value: unknown
): SkillRuntimeDependencies | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("runtime_dependencies must be an object.");
  }

  const npmRaw = value.npm ?? value.node ?? value.npm_packages;
  const pipRaw = value.pip ?? value.python ?? value.pip_packages;

  const npm =
    npmRaw === undefined
      ? []
      : normalizeFlexibleStringList(
          npmRaw,
          "runtime_dependencies.npm",
          MAX_RUNTIME_DEPENDENCIES_PER_MANAGER,
          (entry, itemLabel) =>
            normalizeNpmPackageSpec(asString(entry, itemLabel, MAX_PACKAGE_SPEC_LENGTH), itemLabel)
        );
  const pip =
    pipRaw === undefined
      ? []
      : normalizeFlexibleStringList(
          pipRaw,
          "runtime_dependencies.pip",
          MAX_RUNTIME_DEPENDENCIES_PER_MANAGER,
          (entry, itemLabel) =>
            normalizePipPackageSpec(asString(entry, itemLabel, MAX_PACKAGE_SPEC_LENGTH), itemLabel)
        );

  if (npm.length === 0 && pip.length === 0) {
    return null;
  }
  const normalized: SkillRuntimeDependencies = {};
  if (npm.length > 0) {
    normalized.npm = npm;
  }
  if (pip.length > 0) {
    normalized.pip = pip;
  }
  return normalized;
}

function normalizeSkillRuntime(value: string) {
  if (!SKILL_RUNTIMES.includes(value as SkillRuntime)) {
    throw new Error(`runtime must be one of: ${SKILL_RUNTIMES.join(", ")}.`);
  }
  return value as SkillRuntime;
}

export function validateSkillManifestV1(value: unknown): SkillManifestV1 {
  if (!isRecord(value)) {
    throw new Error("manifest must be an object.");
  }

  const id = normalizeSkillId(asString(value.id, "id", 64));
  const version = normalizeSkillVersion(asString(value.version, "version", 64));
  const runtime = normalizeSkillRuntime(asString(value.runtime, "runtime", 32));
  const entrypoint = normalizeEntrypoint(
    asString(value.entrypoint, "entrypoint", MAX_TEXT_FIELD_LENGTH)
  );
  const description = asString(
    value.description,
    "description",
    MAX_TEXT_FIELD_LENGTH
  );
  const permissions = validateSkillPermissions(value.permissions);
  const requiresContext = asBoolean(
    value.requires_context ?? false,
    "requires_context"
  );
  const contextKeysRaw = value.context_keys ?? [];
  const contextKeys = normalizeUniqueStringList(
    contextKeysRaw,
    "context_keys",
    MAX_CONTEXT_KEYS,
    normalizeContextKey
  );
  if (requiresContext && contextKeys.length === 0) {
    throw new Error("context_keys cannot be empty when requires_context=true.");
  }
  if (!requiresContext && contextKeys.length > 0) {
    throw new Error(
      "context_keys must be empty when requires_context is false."
    );
  }

  const inputsSchema = asSchemaObject(value.inputs_schema, "inputs_schema");
  const outputsSchema = asSchemaObject(value.outputs_schema, "outputs_schema");

  const testCases = normalizeUniqueStringList(
    value.test_cases,
    "test_cases",
    MAX_TEST_CASES,
    normalizeTestCaseReference
  );
  if (testCases.length === 0) {
    throw new Error("test_cases cannot be empty.");
  }

  let dependencies = normalizeDependencies(value.dependencies);
  const invocationGraph = normalizeInvocationGraph(value.invocation_graph);
  const runtimeDependencies = normalizeRuntimeDependencies(
    value.runtime_dependencies ?? value.runtimeDependencies
  );
  if (invocationGraph.length > 0) {
    const fromGraph = invocationGraph.map((step) => step.skill_id);
    const merged = new Set<string>([...dependencies, ...fromGraph]);
    dependencies = Array.from(merged.values());
  }

  if (runtime === "composite" && invocationGraph.length === 0) {
    throw new Error(
      "invocation_graph cannot be empty when runtime is composite."
    );
  }
  if (runtime === "composite" && dependencies.length === 0) {
    throw new Error("dependencies cannot be empty when runtime is composite.");
  }

  const manifest: SkillManifestV1 = {
    manifest_version: asManifestVersion(value.manifest_version),
    id,
    version,
    description,
    runtime,
    entrypoint,
    permissions,
    requires_context: requiresContext,
    context_keys: contextKeys,
    inputs_schema: inputsSchema,
    outputs_schema: outputsSchema,
    test_cases: testCases,
  };

  if (value.name !== undefined) {
    manifest.name = asString(value.name, "name", 120);
  }
  if (dependencies.length > 0) {
    manifest.dependencies = dependencies;
  }
  if (invocationGraph.length > 0) {
    manifest.invocation_graph = invocationGraph;
  }
  if (runtimeDependencies) {
    manifest.runtime_dependencies = runtimeDependencies;
  }

  return manifest;
}

export function isSkillManifestV1(value: unknown): value is SkillManifestV1 {
  try {
    validateSkillManifestV1(value);
    return true;
  } catch {
    return false;
  }
}
