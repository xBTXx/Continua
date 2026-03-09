import { createChatCompletion, type ChatMessage } from "../openrouter";
import { extractTextFromContent } from "../chatContent";
import {
  PERSONAL_MEMORY_CATEGORIES,
  normalizePersonalMemoryCategory,
} from "../personalMemory";
import {
  getToolCategoryPromptBlock,
  normalizeToolCategories,
  normalizeToolConfidence,
  type ToolCategory,
  type ToolConfidence,
} from "../tooling";
import {
  DEFAULT_TOP_K,
  DYNAMIC_TOPK_ENABLED,
  TOPK_BASE,
  TOPK_SPECIFIC_REDUCTION,
  TOPK_EXPLORATORY_BOOST,
  RESONANCE_TAGS,
  RESONANCE_TAG_SET,
  RESONANCE_WEIGHT_SET,
} from "./config";

/**
 * Compute dynamic topK based on query characteristics.
 * Specific questions get fewer results; exploratory queries get more.
 */
function computeDynamicTopK(
  query: string,
  queryType: string | undefined,
  resonanceTags: string[]
): number {
  if (!DYNAMIC_TOPK_ENABLED) {
    return DEFAULT_TOP_K;
  }

  // Specific factual questions need fewer, more precise results
  const SPECIFIC_PATTERNS = [
    /^what('?s| is| was) (my|the|his|her|their|our)/i,
    /^who (is|was|are|were)/i,
    /^when (is|was|did|does|do)/i,
    /^where (is|was|does|do)/i,
    /^how (much|many|old|long|far)/i,
    /what('?s| is) .{1,30}\?$/i,
  ];

  if (SPECIFIC_PATTERNS.some((pattern) => pattern.test(query))) {
    return Math.max(3, TOPK_BASE - TOPK_SPECIFIC_REDUCTION);
  }

  // Exploratory queries benefit from more context
  const EXPLORATORY_PATTERNS = [
    /what do you (know|remember) about/i,
    /tell me (about|more)/i,
    /can you (summarize|recap|remind)/i,
    /what happened/i,
    /give me an overview/i,
  ];

  const EXPLORATORY_TAGS = ["discovery", "curiosity", "expansion", "reflection"];
  const hasExploratoryTag = resonanceTags.some((tag) => EXPLORATORY_TAGS.includes(tag));

  if (hasExploratoryTag || EXPLORATORY_PATTERNS.some((pattern) => pattern.test(query))) {
    return TOPK_BASE + TOPK_EXPLORATORY_BOOST;
  }

  // Filtered queries (type specified) can reduce noise
  if (queryType) {
    return Math.max(4, TOPK_BASE - 1);
  }

  return TOPK_BASE;
}

export async function generateSearchQueries(
  messages: ChatMessage[],
  apiKey?: string,
  appUrl?: string
): Promise<{
  queries: string[];
  personalQueries: string[];
  resonanceQueries: string[];
  negativeQueries: string[];
  resonanceTags: string[];
  resonanceWeight?: string;
  dateRange?: { start?: string; end?: string };
  type?: string;
  personalCategory?: string;
  toolCategories?: ToolCategory[];
  toolConfidence?: ToolConfidence;
  dynamicTopK?: number;
}> {
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMessage) {
    return {
      queries: [],
      personalQueries: [],
      resonanceQueries: [],
      negativeQueries: [],
      resonanceTags: [],
      toolCategories: [],
      toolConfidence: "high",
    };
  }
  const lastUserText = extractTextFromContent(lastUserMessage.content);

  // 1. Semantic Routing (Optimization)
  // Skip retrieval for short, trivial greetings or acknowledgments
  const TRIVIAL_MSG_REGEX = /^(hi|hello|hey|greetings|sup|yo|ok|okay|cool|thanks|thank you|bye|goodbye|what's up|how are you)(\W.*)?$/i;
  if (
    lastUserText.length < 50 &&
    TRIVIAL_MSG_REGEX.test(lastUserText.trim())
  ) {
    return {
      queries: [],
      personalQueries: [],
      resonanceQueries: [],
      negativeQueries: [],
      resonanceTags: [],
      toolCategories: [],
      toolConfidence: "high",
    };
  }

  // Use the fast Lite model as requested
  const model = "google/gemini-2.5-flash-lite";

  // Create a context window for the query generator
  const contextWindow = messages
    .slice(-15)
    .map((message) => ({
      ...message,
      content: extractTextFromContent(message.content),
    }))
    .filter(
      (message) =>
        message.role === "system" ||
        (typeof message.content === "string" && message.content.trim().length > 0)
    );
  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `You are an expert at retrieving relevant context for an AI assistant.
  Today is ${today}.
  
  Given the conversation history, generate search queries to retrieve relevant memories from two different databases:
  
  1. **Main Memory Queries** (3 queries): Focus on facts about the user, their preferences, past events, work, and social details.
  2. **Personal Memory Queries** (3 queries): Focus on the assistant's own past thoughts, feelings, perspectives, or internal reflections that might be relevant.
  
  Also extract:
  3. A **Date Range** if the user specifies a time period (e.g., "yesterday", "last week"). Extract "start" and "end" (YYYY-MM-DD).
  4. A **Type Filter** for the Main Memory if the user is asking about a specific category:
     - "profile", "work", "social", "health", "media", "event", "fact".
     - null if broad.
  5. A **Personal Category Filter** if the user is asking specifically about the assistant's feelings, experiences, thoughts, views, or opinions.
     - "feeling", "experience", "thought", "view", "opinion".
     - null if broad.
  6. **Resonance Queries** (2-3): vibe-focused queries based on emotional undertone.
  7. **Resonance Tags** (1-3) from this list only:
     ${RESONANCE_TAGS.join(", ")}
  8. **Resonance Weight** (optional): core, pivot, notable, transient.
  9. **Tool Categories** (optional): predict which tool categories are needed for the user's request.
     - Return an empty array if no tools are needed.
     - Available categories:
${getToolCategoryPromptBlock()}
  10. **Tool Confidence**: "high", "medium", or "low" for toolCategories.
  11. **Negative Queries** (0-2): Queries to EXCLUDE irrelevant results. Use when the user asks about likes (exclude dislikes), preferences, or when there's potential for opposite-meaning confusion.
  
  Output purely a JSON object:
  {
    "queries": ["main query 1", "main query 2", "main query 3"],
    "personalQueries": ["personal query 1", "personal query 2", "personal query 3"],
    "resonanceQueries": ["vibe query 1", "vibe query 2"],
    "negativeQueries": ["things to exclude"],
    "resonanceTags": ["alignment", "reflection"],
    "resonanceWeight": "notable",
    "dateRange": { "start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null },
    "type": "profile" | "work" | "social" | "health" | "media" | "event" | "fact" | null,
    "personalCategory": "feeling" | "experience" | "thought" | "view" | "opinion" | null,
    "toolCategories": ["web", "communication"],
    "toolConfidence": "medium"
  }`;

  try {
    const response = await createChatCompletion({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...contextWindow,
      ],
      temperature: 0.1,
      apiKey,
      appUrl,
    });

    if (!response.ok) {
      return {
        queries: [lastUserText],
        personalQueries: [lastUserText],
        resonanceQueries: [],
        negativeQueries: [],
        resonanceTags: [],
        toolCategories: [],
        toolConfidence: "low",
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return {
        queries: [lastUserText],
        personalQueries: [lastUserText],
        resonanceQueries: [],
        negativeQueries: [],
        resonanceTags: [],
        toolCategories: [],
        toolConfidence: "low",
      };
    }

    // Attempt to parse JSON
    try {
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        const jsonStr = content.substring(start, end + 1);
        const parsed = JSON.parse(jsonStr);

        let queries: string[] = [];
        if (Array.isArray(parsed.queries)) {
          queries = parsed.queries.filter((s: unknown) => typeof s === "string");
        }

        let personalQueries: string[] = [];
        if (Array.isArray(parsed.personalQueries)) {
          personalQueries = parsed.personalQueries.filter(
            (s: unknown) => typeof s === "string"
          );
        }

        let resonanceQueries: string[] = [];
        if (Array.isArray(parsed.resonanceQueries)) {
          resonanceQueries = parsed.resonanceQueries.filter(
            (s: unknown) => typeof s === "string"
          );
        }

        let resonanceTags: string[] = [];
        if (Array.isArray(parsed.resonanceTags)) {
          resonanceTags = parsed.resonanceTags
            .filter((s: unknown) => typeof s === "string")
            .map((tag: string) => tag.trim().toLowerCase())
            .filter((tag: string) => RESONANCE_TAG_SET.has(tag));
          resonanceTags = Array.from(new Set(resonanceTags));
        }

        let resonanceWeight: string | undefined = undefined;
        if (typeof parsed.resonanceWeight === "string") {
          const normalized = parsed.resonanceWeight.trim().toLowerCase();
          if (RESONANCE_WEIGHT_SET.has(normalized)) {
            resonanceWeight = normalized;
          }
        }

        // Add original message as a fallback query if lists are empty
        const finalQueries = queries.length > 0 ? queries : [lastUserText];
        const finalPersonalQueries = personalQueries.length > 0 ? personalQueries : [lastUserText];

        let dateRange = undefined;
        if (parsed.dateRange && typeof parsed.dateRange === "object") {
          const { start, end } = parsed.dateRange;
          if (start || end) {
            dateRange = { start: start || undefined, end: end || undefined };
          }
        }

        let type = undefined;
        if (parsed.type && ["profile", "work", "social", "health", "media", "event", "fact"].includes(parsed.type)) {
          type = parsed.type;
        }

        let personalCategory = undefined;
        if (typeof parsed.personalCategory === "string") {
          const normalized = normalizePersonalMemoryCategory(parsed.personalCategory);
          if (normalized && PERSONAL_MEMORY_CATEGORIES.includes(normalized)) {
            personalCategory = normalized;
          }
        }

        const toolCategories = normalizeToolCategories(parsed.toolCategories);
        const toolConfidence = normalizeToolConfidence(parsed.toolConfidence);

        // Parse negative queries for filtering
        let negativeQueries: string[] = [];
        if (Array.isArray(parsed.negativeQueries)) {
          negativeQueries = parsed.negativeQueries.filter(
            (s: unknown) => typeof s === "string"
          );
        }

        // Compute dynamic topK based on query characteristics
        const dynamicTopK = computeDynamicTopK(
          lastUserText,
          type,
          resonanceTags
        );

        return {
          queries: finalQueries,
          personalQueries: finalPersonalQueries,
          resonanceQueries,
          negativeQueries,
          resonanceTags,
          resonanceWeight,
          dateRange,
          type,
          personalCategory,
          toolCategories,
          toolConfidence,
          dynamicTopK,
        };
      }
    } catch {
      // Parsing failed
    }

    return {
      queries: [lastUserText],
      personalQueries: [lastUserText],
      resonanceQueries: [],
      negativeQueries: [],
      resonanceTags: [],
      toolCategories: [],
      toolConfidence: "low",
    };
  } catch (error) {
    console.warn("Failed to generate search queries, falling back to original message", error);
    return {
      queries: [lastUserText],
      personalQueries: [lastUserText],
      resonanceQueries: [],
      negativeQueries: [],
      resonanceTags: [],
      toolCategories: [],
      toolConfidence: "low",
    };
  }
}
