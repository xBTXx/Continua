import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as mcpTypes from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolDefinition } from "@/lib/openrouter";

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpToolListResponse = {
  tools?: McpTool[];
};

type McpToolCallResponse = {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type McpRpcError = {
  message?: string;
};

type McpRpcResponse<T> = {
  result?: T;
  error?: McpRpcError;
};

export type Crawl4AIToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = ["-y", "mcp-crawl4ai-ts"];
const TOOL_CACHE_MS = 60_000;
const MAX_CRAWL4AI_TEXT_CHARS = parseEnvNumber(
  process.env.CRAWL4AI_MAX_TEXT_CHARS,
  24_000,
  2_000,
  120_000
);
const MAX_CRAWL4AI_CONTENT_ITEMS = parseEnvNumber(
  process.env.CRAWL4AI_MAX_CONTENT_ITEMS,
  12,
  1,
  60
);
const MAX_CRAWL4AI_RECURSION_DEPTH = parseEnvNumber(
  process.env.CRAWL4AI_MAX_RECURSION_DEPTH,
  6,
  2,
  20
);
const CRAWL4AI_FORCE_LEAN_OUTPUT =
  process.env.CRAWL4AI_FORCE_LEAN_OUTPUT !== "false";

let clientPromise: Promise<Client> | null = null;
let toolCache: { tools: McpTool[]; fetchedAt: number } | null = null;
let toolNameCache = new Set<string>();

function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function resolveHttpUrl() {
  const raw = process.env.CRAWL4AI_MCP_URL?.trim();
  if (raw) {
    return raw;
  }
  return null;
}

function resolveCommandConfig() {
  const rawCommand = process.env.CRAWL4AI_MCP_COMMAND;
  const rawArgs = process.env.CRAWL4AI_MCP_ARGS;
  if (rawCommand && rawCommand.trim().length > 0) {
    const args = rawArgs
      ? rawArgs.trim().split(/\s+/).filter(Boolean)
      : [];
    return { command: rawCommand.trim(), args };
  }

  const localBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    "mcp-crawl4ai-ts"
  );
  if (fs.existsSync(localBin)) {
    return { command: localBin, args: [] };
  }

  return { command: DEFAULT_COMMAND, args: DEFAULT_ARGS };
}

function buildMcpEnv() {
  const env = { ...process.env } as Record<string, string>;
  if (process.env.CRAWL4AI_BASE_URL) {
    env.CRAWL4AI_BASE_URL = process.env.CRAWL4AI_BASE_URL;
  }
  if (process.env.CRAWL4AI_API_KEY) {
    env.CRAWL4AI_API_KEY = process.env.CRAWL4AI_API_KEY;
  }
  return env;
}

export function crawl4aiToolsEnabled() {
  if (process.env.CRAWL4AI_TOOLS_ENABLED === "false") {
    return false;
  }
  return Boolean(resolveHttpUrl() || process.env.CRAWL4AI_BASE_URL);
}

function ensureConfigured() {
  if (process.env.CRAWL4AI_TOOLS_ENABLED === "false") {
    throw new Error("Crawl4AI tools are disabled.");
  }
  if (!resolveHttpUrl() && !process.env.CRAWL4AI_BASE_URL) {
    throw new Error("Set CRAWL4AI_BASE_URL or CRAWL4AI_MCP_URL.");
  }
}

async function getClient() {
  if (clientPromise) {
    return clientPromise;
  }
  clientPromise = (async () => {
    const { command, args } = resolveCommandConfig();
    const transport = new StdioClientTransport({
      command,
      args,
      env: buildMcpEnv(),
    });
    const client = new Client(
      { name: "assistant-crawl4ai-client", version: "1.0.0" },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      clientPromise = null;
      throw error;
    }
  })();
  return clientPromise;
}

function updateToolCache(tools: McpTool[]) {
  toolCache = { tools, fetchedAt: Date.now() };
  toolNameCache = new Set(tools.map((tool) => tool.name));
}

function resolveListToolsSchema() {
  if ("ListToolsResultSchema" in mcpTypes) {
    return (mcpTypes as { ListToolsResultSchema?: unknown })
      .ListToolsResultSchema;
  }
  if ("ListToolsResponseSchema" in mcpTypes) {
    return (mcpTypes as { ListToolsResponseSchema?: unknown })
      .ListToolsResponseSchema;
  }
  return null;
}

function resolveCallToolSchema() {
  if ("CallToolResultSchema" in mcpTypes) {
    return (mcpTypes as { CallToolResultSchema?: unknown })
      .CallToolResultSchema;
  }
  if ("CallToolResponseSchema" in mcpTypes) {
    return (mcpTypes as { CallToolResponseSchema?: unknown })
      .CallToolResponseSchema;
  }
  return null;
}

function buildHttpHeaders(url: string) {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  const apiKey = process.env.CRAWL4AI_API_KEY;
  if (apiKey && !url.includes(apiKey)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function callHttpRpc<T>(method: string, params: Record<string, unknown>) {
  const url = resolveHttpUrl();
  if (!url) {
    throw new Error("CRAWL4AI_MCP_URL is not set.");
  }
  const payload = {
    jsonrpc: "2.0",
    id: `c4a-${Date.now()}`,
    method,
    params,
  };
  const response = await fetch(url, {
    method: "POST",
    headers: buildHttpHeaders(url),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Crawl4AI MCP HTTP error (${response.status}): ${text || response.statusText}`
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const raw = await response.text();
    const payload = parseSseJson(raw) as McpRpcResponse<T>;
    if (payload?.error?.message) {
      throw new Error(payload.error.message);
    }
    if (payload?.result) {
      return payload.result;
    }
    return payload as T;
  }

  const data = (await response.json()) as McpRpcResponse<T>;
  if (data?.error?.message) {
    throw new Error(data.error.message);
  }
  if (data?.result) {
    return data.result;
  }
  return data as T;
}

function parseSseJson(raw: string) {
  const events: string[] = [];
  let buffer: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data:")) {
      buffer.push(line.slice(5).trim());
      continue;
    }
    if (line.trim() === "") {
      if (buffer.length > 0) {
        events.push(buffer.join("\n"));
        buffer = [];
      }
    }
  }
  if (buffer.length > 0) {
    events.push(buffer.join("\n"));
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i].trim();
    if (!event || event === "[DONE]") {
      continue;
    }
    try {
      return JSON.parse(event);
    } catch {
      // Try earlier events if this one is not JSON.
    }
  }
  throw new Error("Unable to parse Crawl4AI MCP stream response.");
}

async function listTools() {
  ensureConfigured();
  const now = Date.now();
  if (toolCache && now - toolCache.fetchedAt < TOOL_CACHE_MS) {
    return toolCache.tools;
  }
  const httpUrl = resolveHttpUrl();
  if (process.env.CRAWL4AI_MCP_URL) {
    const response = await callHttpRpc<McpToolListResponse>("tools/list", {});
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    updateToolCache(tools);
    return tools;
  }

  try {
    const client = await getClient();
    const maybeListTools = (client as { listTools?: () => Promise<unknown> })
      .listTools;
    if (typeof maybeListTools === "function") {
      const response = (await maybeListTools.call(client)) as McpToolListResponse;
      const tools = Array.isArray(response?.tools) ? response.tools : [];
      updateToolCache(tools);
      return tools;
    }

    const schema = resolveListToolsSchema();
    const response = (schema
      ? await client.request(
          { method: "tools/list", params: {} },
          schema as AnySchema
        )
      : await (client.request as (payload: unknown) => Promise<unknown>)({
          method: "tools/list",
          params: {},
        })) as McpToolListResponse;
    const tools =
      Array.isArray(response?.tools)
        ? response.tools
        : Array.isArray(
            (response as { result?: McpToolListResponse })?.result?.tools
          )
          ? ((response as { result?: McpToolListResponse }).result
              ?.tools as McpTool[])
          : [];
    updateToolCache(tools);
    return tools;
  } catch (error) {
    if (httpUrl) {
      const response = await callHttpRpc<McpToolListResponse>("tools/list", {});
      const tools = Array.isArray(response?.tools) ? response.tools : [];
      updateToolCache(tools);
      return tools;
    }
    throw error;
  }
}

function formatToolParameters(tool: McpTool) {
  if (tool.inputSchema && typeof tool.inputSchema === "object") {
    return normalizeToolSchema(tool.inputSchema);
  }
  return { type: "object", properties: {} };
}

function normalizeToolSchema(schema: Record<string, unknown>) {
  const normalized = normalizeSchemaNode(schema);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return { type: "object", properties: {} };
  }
  return normalized as Record<string, unknown>;
}

function normalizeSchemaNode(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => normalizeSchemaNode(entry));
  }

  const current = node as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const next: Record<string, unknown> = {};
      for (const [propKey, propSchema] of Object.entries(
        value as Record<string, unknown>
      )) {
        next[propKey] = normalizeSchemaNode(propSchema);
      }
      normalized[key] = next;
      continue;
    }

    if (
      key === "items" ||
      key === "additionalProperties" ||
      key === "contains" ||
      key === "if" ||
      key === "then" ||
      key === "else" ||
      key === "not"
    ) {
      normalized[key] = normalizeSchemaNode(value);
      continue;
    }

    if (
      (key === "allOf" || key === "anyOf" || key === "oneOf" || key === "prefixItems") &&
      Array.isArray(value)
    ) {
      normalized[key] = value.map((entry) => normalizeSchemaNode(entry));
      continue;
    }

    normalized[key] = value;
  }

  const hasItems = "items" in normalized;
  const hasProperties = "properties" in normalized;
  const hasAdditionalProperties = "additionalProperties" in normalized;
  const rawType = normalized.type;
  const normalizedType =
    typeof rawType === "string" ? rawType.trim().toLowerCase() : undefined;

  // Gemini/Vertex requires ARRAY type when `items` is present.
  if (hasItems) {
    normalized.type = "array";
  } else if (!normalizedType && (hasProperties || hasAdditionalProperties)) {
    normalized.type = "object";
  }

  if (Array.isArray(normalized.required)) {
    normalized.required = normalized.required.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
    );
  }

  return normalized;
}

export async function getCrawl4AIToolDefinitions(): Promise<ToolDefinition[]> {
  if (!crawl4aiToolsEnabled()) {
    return [];
  }
  try {
    const tools = await listTools();
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "Crawl4AI MCP tool.",
        parameters: formatToolParameters(tool),
      },
    }));
  } catch (error) {
    console.warn("Failed to load Crawl4AI MCP tools.", error);
    return [];
  }
}

export async function isCrawl4AIToolName(name: string) {
  if (!name) {
    return false;
  }
  if (toolNameCache.has(name)) {
    return true;
  }
  try {
    const tools = await listTools();
    return tools.some((tool) => tool.name === name);
  } catch {
    return false;
  }
}

function extractToolError(result: McpToolCallResponse) {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item && typeof item.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "Crawl4AI tool failed.";
}

export async function runCrawl4AITool(
  name: string,
  args: Record<string, unknown>
) {
  ensureConfigured();
  const httpUrl = resolveHttpUrl();
  const sanitizedArgs = sanitizeCrawl4AIArguments(args ?? {});
  if (process.env.CRAWL4AI_MCP_URL) {
    const response = await callHttpRpc<unknown>("tools/call", {
      name,
      arguments: sanitizedArgs,
    });
    return normalizeCrawl4AIResult(response);
  }

  try {
    const client = await getClient();
    const maybeCallTool = (client as {
      callTool?: (input: {
        name: string;
        arguments?: Record<string, unknown>;
      }) => Promise<unknown>;
    }).callTool;
    if (typeof maybeCallTool === "function") {
      const response = await maybeCallTool.call(client, {
        name,
        arguments: sanitizedArgs,
      });
      return normalizeCrawl4AIResult(response);
    }

    const schema = resolveCallToolSchema();
    const response = schema
      ? await client.request(
          {
            method: "tools/call",
            params: {
              name,
              arguments: sanitizedArgs,
            },
          },
          schema as AnySchema
        )
      : await (client.request as (payload: unknown) => Promise<unknown>)({
          method: "tools/call",
          params: {
            name,
            arguments: sanitizedArgs,
          },
        });
    return normalizeCrawl4AIResult(response);
  } catch (error) {
    if (httpUrl) {
      const response = await callHttpRpc<unknown>("tools/call", {
        name,
        arguments: sanitizedArgs,
      });
      return normalizeCrawl4AIResult(response);
    }
    throw error;
  }
}

function normalizeCrawl4AIResult(rawResponse: unknown): McpToolCallResponse {
  const response =
    rawResponse &&
    typeof rawResponse === "object" &&
    "result" in rawResponse
      ? (rawResponse as { result?: unknown }).result ?? rawResponse
      : rawResponse;

  if (!response || typeof response !== "object") {
    return {
      content: [{ type: "text", text: "[Invalid Crawl4AI response]" }],
      isError: false,
    };
  }

  const normalized = response as McpToolCallResponse;
  if (normalized.isError) {
    throw new Error(extractToolError(normalized));
  }

  return sanitizeCrawl4AIOutput(normalized);
}

function sanitizeCrawl4AIArguments(
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!CRAWL4AI_FORCE_LEAN_OUTPUT) {
    return { ...args };
  }
  const sanitized = { ...args };
  const disableHeavyKeys = [
    "html",
    "rawHtml",
    "raw_html",
    "include_html",
    "include_raw_html",
    "includeRawHtml",
    "capture_html",
    "screenshot",
    "capture_screenshot",
    "captureScreenshot",
    "include_screenshot",
    "includeScreenshot",
    "save_screenshot",
    "saveScreenshot",
    "take_screenshot",
    "takeScreenshot",
  ];

  for (const key of disableHeavyKeys) {
    if (key in sanitized) {
      sanitized[key] = false;
    }
  }

  for (const key of ["output_format", "outputFormat", "format"] as const) {
    const value = sanitized[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "html" ||
      normalized === "raw_html" ||
      normalized === "rawhtml"
    ) {
      sanitized[key] = "markdown";
    }
  }

  return sanitized;
}

function sanitizeCrawl4AIOutput(response: McpToolCallResponse): McpToolCallResponse {
  if (!response.content || !Array.isArray(response.content)) {
    return response;
  }

  const limited = response.content.slice(0, MAX_CRAWL4AI_CONTENT_ITEMS);
  const sanitizedContent = limited.map((item) =>
    recursivelySanitize(item, 0)
  ) as Array<Record<string, unknown>>;

  if (response.content.length > MAX_CRAWL4AI_CONTENT_ITEMS) {
    sanitizedContent.push({
      type: "text",
      text: `[${response.content.length - MAX_CRAWL4AI_CONTENT_ITEMS} additional content item(s) omitted]`,
    });
  }

  return { ...response, content: sanitizedContent };
}

function recursivelySanitize(data: unknown, depth = 0): unknown {
  if (typeof data === "string") {
    return truncateLongText(data, MAX_CRAWL4AI_TEXT_CHARS);
  }
  if (!data || typeof data !== "object") {
    return data;
  }

  if (depth >= MAX_CRAWL4AI_RECURSION_DEPTH) {
    return "[Crawl4AI content omitted for depth]";
  }

  if (Array.isArray(data)) {
    return data
      .slice(0, MAX_CRAWL4AI_CONTENT_ITEMS)
      .map((entry) => recursivelySanitize(entry, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "html" || normalizedKey === "rawhtml") {
      result[key] = "[HTML Content Omitted for Brevity]";
    } else if (normalizedKey === "screenshot") {
      result[key] = "[Screenshot Omitted for Brevity]";
    } else if (key === "text" && typeof value === "string") {
      result[key] = sanitizeTextPayload(value);
    } else {
      result[key] = recursivelySanitize(value, depth + 1);
    }
  }
  return result;
}

function sanitizeTextPayload(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return truncateLongText(
      JSON.stringify(recursivelySanitize(parsed, 0)),
      MAX_CRAWL4AI_TEXT_CHARS
    );
  } catch {
    return truncateLongText(trimmed, MAX_CRAWL4AI_TEXT_CHARS);
  }
}

function truncateLongText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }
  const remaining = text.length - maxLength;
  return `${text.slice(0, maxLength)}\n...[${remaining} chars truncated]`;
}

export async function getCrawl4AIToolStatus(): Promise<Crawl4AIToolStatus[]> {
  if (process.env.CRAWL4AI_TOOLS_ENABLED === "false") {
    return [
      {
        id: "crawl4ai",
        label: "Crawl4AI MCP",
        status: "error",
        details: ["Disabled (CRAWL4AI_TOOLS_ENABLED=false)."],
      },
    ];
  }
  if (!resolveHttpUrl() && !process.env.CRAWL4AI_BASE_URL) {
    return [
      {
        id: "crawl4ai",
        label: "Crawl4AI MCP",
        status: "error",
        details: ["Missing CRAWL4AI_BASE_URL (or CRAWL4AI_MCP_URL)."],
      },
    ];
  }

  try {
    const tools = await listTools();
    const commandConfig = resolveCommandConfig();
    const details = [
      `Tools: ${tools.length}.`,
      process.env.CRAWL4AI_MCP_URL
        ? `Endpoint: ${resolveHttpUrl() || "HTTP"}`
        : `Command: ${commandConfig.command} ${commandConfig.args.join(" ")}`.trim(),
    ];
    return [
      {
        id: "crawl4ai",
        label: "Crawl4AI MCP",
        status: "ok",
        details,
      },
    ];
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to reach Crawl4AI MCP server.";
    return [
      {
        id: "crawl4ai",
        label: "Crawl4AI MCP",
        status: "error",
        details: [message],
      },
    ];
  }
}
