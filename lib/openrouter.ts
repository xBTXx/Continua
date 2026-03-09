import type { ChatContentPart } from "@/types/chat";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_APP_URL =
  process.env.OPENROUTER_APP_URL ?? "http://localhost:3000";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  name?: string;
  reasoning?: string;
  reasoning_details?: unknown;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  reasoning?: {
    enabled?: boolean;
    effort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    max_tokens?: number;
    exclude?: boolean;
  };
  plugins?: Array<{
    id: string;
    engine?: "native" | "exa";
    max_results?: number;
    search_prompt?: string;
  }>;
  web_search_options?: {
    search_context_size?: "low" | "medium" | "high";
  };
  tools?: ToolDefinition[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  apiKey?: string;
  appUrl?: string;
};

type OpenRouterRequest = {
  path: string;
  body: Record<string, unknown>;
  apiKey?: string;
  appUrl?: string;
};

function resolveApiKey(apiKey?: string) {
  const resolvedKey = apiKey ?? OPENROUTER_API_KEY;
  if (!resolvedKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  return resolvedKey;
}

export async function openRouterRequest({
  path,
  body,
  apiKey,
  appUrl,
}: OpenRouterRequest) {
  const resolvedKey = resolveApiKey(apiKey);
  const resolvedAppUrl = appUrl ?? OPENROUTER_APP_URL;

  return fetch(`${OPENROUTER_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolvedKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": resolvedAppUrl,
      "X-Title": "Continua",
    },
    body: JSON.stringify(body),
  });
}

export async function createChatCompletion(payload: ChatCompletionRequest) {
  return openRouterRequest({
    path: "chat/completions",
    body: {
      model: payload.model,
      messages: payload.messages,
      temperature: payload.temperature ?? 0.7,
      stream: payload.stream ?? false,
      reasoning: payload.reasoning,
      plugins: payload.plugins,
      web_search_options: payload.web_search_options,
      tools: payload.tools,
      tool_choice: payload.tool_choice,
      parallel_tool_calls: payload.parallel_tool_calls,
    },
    apiKey: payload.apiKey,
    appUrl: payload.appUrl,
  });
}

export async function createEmbeddingRequest(
  model: string,
  input: string,
  apiKey?: string
) {
  return openRouterRequest({
    path: "embeddings",
    body: {
      model,
      input,
    },
    apiKey,
  });
}
