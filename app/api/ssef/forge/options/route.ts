import {
  getSSEFConfig,
  SSEF_FORGE_REASONING_EFFORTS,
} from "@/lib/ssef/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getSSEFConfig();
    return Response.json({
      models: config.forgeGeneration.modelCatalog,
      defaultModel: config.forgeGeneration.defaultModel,
      reasoningEfforts: SSEF_FORGE_REASONING_EFFORTS,
      defaultReasoningEffort: config.forgeGeneration.defaultReasoningEffort,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to load SSEF forge options.";
    return new Response(message, { status: 500 });
  }
}
