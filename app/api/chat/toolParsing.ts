import { ToolCall } from "./types";

const PERSONAL_MEMORY_CATEGORY_ALIASES: Record<string, string> = {
    feeling: "feeling",
    feelings: "feeling",
    emotion: "feeling",
    emotions: "feeling",
    emotional: "feeling",
    experience: "experience",
    experiences: "experience",
    event: "experience",
    thought: "thought",
    thoughts: "thought",
    reflection: "thought",
    reflections: "thought",
    idea: "thought",
    ideas: "thought",
    view: "view",
    views: "view",
    perspective: "view",
    perspectives: "view",
    opinion: "opinion",
    opinions: "opinion",
    belief: "opinion",
    beliefs: "opinion",
};

export function extractToolCalls(data: unknown): ToolCall[] {
    const message = (
        data as { choices?: Array<{ message?: { tool_calls?: unknown } }> } | null
    )?.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;
    if (!Array.isArray(toolCalls)) {
        return [];
    }
    return toolCalls.filter(
        (call): call is ToolCall =>
            Boolean(
                call &&
                typeof call === "object" &&
                "type" in call &&
                "function" in call &&
                (call as ToolCall).type === "function" &&
                (call as ToolCall).function?.name &&
                typeof (call as ToolCall).function?.arguments === "string"
            )
    );
}

export function normalizeLegacyToolMarkup(content: string) {
    return content
        .replace(new RegExp(`<\\uFF5CDSML\\uFF5C([\\w-]+)`, "g"), "<$1")
        .replace(new RegExp(`</\\uFF5CDSML\\uFF5C([\\w-]+)>`, "g"), "</$1>");
}

export function stripLegacyToolMarkup(content: string) {
    const normalized = normalizeLegacyToolMarkup(content);
    return normalized
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
        .replace(/<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/gi, "")
        .trim();
}

export function parseLegacyParameterArgs(inner: string) {
    const params = Array.from(
        inner.matchAll(
            /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/g
        )
    );
    if (params.length === 0) {
        return null;
    }

    const args: Record<string, unknown> = {};

    params.forEach((match) => {
        const name = match[1];
        const attrs = match[2] || "";
        const rawValue = (match[3] || "").trim();
        const stringAttr = attrs.match(/\bstring="(true|false)"/i);
        let value: unknown = rawValue;

        if (stringAttr?.[1]?.toLowerCase() !== "true") {
            try {
                value = JSON.parse(rawValue);
            } catch {
                value = rawValue;
            }
        }

        args[name] = value;
    });

    return JSON.stringify(args);
}

export function extractLegacyToolCalls(content: string | undefined | null): ToolCall[] {
    const normalized = content ? normalizeLegacyToolMarkup(content) : "";
    const hasInvokeMarkup = normalized.includes("<invoke");
    const hasMemoryMarkup = /<memory(?:\s+[^>]*)?>[\s\S]*?<\/memory>/i.test(
        normalized
    );
    if (!hasInvokeMarkup && !hasMemoryMarkup) {
        return [];
    }
    content = normalized;

    const now = Date.now();
    const invokeMatches = Array.from(
        content.matchAll(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g)
    );
    const memoryMatches = Array.from(
        content.matchAll(
            /<memory(?:\s+([^>]*))?>[\s\S]*?<\/memory>/gi
        )
    );

    const invokeCalls: ToolCall[] = invokeMatches.map((match, index) => {
        const name = match[1];
        const inner = match[2] || "";
        const argsMatch =
            inner.match(/<parameters>([\s\S]*?)<\/parameters>/) ||
            inner.match(/<arguments>([\s\S]*?)<\/arguments>/);
        let args = (argsMatch?.[1] || "").trim();
        if (!args) {
            const parsed = parseLegacyParameterArgs(inner);
            if (parsed) {
                args = parsed;
            }
        }

        return {
            id: `legacy-${now}-${index}`,
            type: "function" as const,
            function: {
                name,
                arguments: args || "{}",
            },
        };
    });

    const memoryCalls = memoryMatches
        .map((match, index) => {
            const fullMatch = match[0] || "";
            const attrs = match[1] || "";
            const bodyMatch = fullMatch.match(
                /<memory(?:\s+[^>]*)?>([\s\S]*?)<\/memory>/i
            );
            const inner = bodyMatch?.[1]?.trim() ?? "";
            if (!inner) {
                return null;
            }

            const attributeCategoryMatch = attrs.match(
                /\bcategory\s*=\s*"([^"]+)"/i
            );
            const headerCategory = attributeCategoryMatch?.[1] ?? null;
            const categoryLineMatch = inner.match(
                /(?:^|\n)\s*(?:category|kind|type)\s*:\s*([^\n\r]+)/i
            );
            const memoryLineMatch = inner.match(
                /(?:^|\n)\s*(?:memory|content|text)\s*:\s*([\s\S]*)$/i
            );

            const normalizedCategoryInput =
                categoryLineMatch?.[1]?.trim() || headerCategory || "";
            const normalizedCategory =
                PERSONAL_MEMORY_CATEGORY_ALIASES[
                    normalizedCategoryInput.toLowerCase()
                ] ?? "thought";

            const memoryText = (
                memoryLineMatch?.[1] ?? inner
            )
                .replace(
                    /(?:^|\n)\s*(?:category|kind|type)\s*:\s*[^\n\r]+/gi,
                    ""
                )
                .trim();

            if (!memoryText) {
                return null;
            }

            return {
                id: `legacy-memory-${now}-${index}`,
                type: "function" as const,
                function: {
                    name: "save_personal_memory",
                    arguments: JSON.stringify({
                        category: normalizedCategory,
                        memory: memoryText,
                    }),
                },
            };
        })
        .filter((call): call is ToolCall => call !== null);

    return [...invokeCalls, ...memoryCalls];
}

export function parseToolArguments(raw: string) {
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}
