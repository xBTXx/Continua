import { ensureSSEFReady } from "../bootstrap";
import { ssefEnabled } from "../config";
import {
  createSSEFRun,
  recordSSEFPolicyIncident,
  updateSSEFRunStatus,
} from "../repository";
import { executeSSEFSkillRuntime } from "./executor";
import { getActiveSSEFSkillRuntimeRecordByToolName } from "./toolDefinitions";

export type SSEFToolExecutionSource = "chat" | "idle";

export type RunSSEFToolContext = {
  source: SSEFToolExecutionSource;
  conversationId?: string | null;
  userIntent?: string | null;
  sessionScopeId?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function mergeRunMetadata(
  current: Record<string, unknown> | null,
  next: Record<string, unknown>
) {
  return {
    ...(current ?? {}),
    ...next,
  };
}

export async function runSSEFToolByName(
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: RunSSEFToolContext
): Promise<Record<string, unknown> | null> {
  if (!ssefEnabled()) {
    return null;
  }

  await ensureSSEFReady();
  const record = await getActiveSSEFSkillRuntimeRecordByToolName(toolName);
  if (!record) {
    return null;
  }

  const args = asRecord(rawArgs);
  const run = await createSSEFRun({
    skillVersionId: record.skillVersionId,
    runType: "runtime_tool_call",
    status: "running",
    metadata: {
      tool_name: record.skillId,
      source: context.source,
      conversation_id: context.conversationId ?? null,
      session_scope_id: context.sessionScopeId ?? null,
      user_intent: context.userIntent ?? null,
    },
    actor: "ssef-runtime-adapter",
  });

  const execution = await executeSSEFSkillRuntime({
    runId: run.id,
    record,
    args,
    context,
  });

  const baseMetadata = mergeRunMetadata(run.metadata, execution.runMetadata);

  if (execution.ok && execution.toolResult) {
    await updateSSEFRunStatus({
      runId: run.id,
      status: "completed",
      finishedAt: new Date().toISOString(),
      stdoutLogPath: execution.stdoutLogPath,
      stderrLogPath: execution.stderrLogPath,
      traceLogPath: execution.traceLogPath,
      result: execution.runResult,
      metadata: baseMetadata,
      actor: "ssef-runtime-adapter",
    });
    return execution.toolResult;
  }

  let metadataWithIncident = baseMetadata;
  if (execution.policyViolation) {
    try {
      const incident = await recordSSEFPolicyIncident({
        runId: run.id,
        skillVersionId: record.skillVersionId,
        severity: execution.policyViolation.severity,
        category: execution.policyViolation.category,
        decision: "denied",
        message: execution.errorMessage ?? "SSEF policy denied runtime action.",
        details: {
          action: execution.policyViolation.action,
          target: execution.policyViolation.target,
          reason: execution.policyViolation.reason,
          ...(execution.policyViolation.details ?? {}),
        },
        actor: "ssef-runtime-adapter",
      });

      metadataWithIncident = {
        ...metadataWithIncident,
        policy_incident: {
          id: incident.id,
          category: incident.category,
          severity: incident.severity,
        },
      };
    } catch (incidentError) {
      console.warn("Failed to record SSEF policy incident.", incidentError);
    }
  }

  await updateSSEFRunStatus({
    runId: run.id,
    status: "failed",
    finishedAt: new Date().toISOString(),
    stdoutLogPath: execution.stdoutLogPath,
    stderrLogPath: execution.stderrLogPath,
    traceLogPath: execution.traceLogPath,
    error: execution.errorMessage ?? "SSEF skill execution failed.",
    result: execution.runResult,
    metadata: metadataWithIncident,
    actor: "ssef-runtime-adapter",
  });

  throw new Error(execution.errorMessage ?? "SSEF skill execution failed.");
}
