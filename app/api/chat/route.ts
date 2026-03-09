import { extractTextFromContent } from "@/lib/chatContent";
import { applyTokenGuard } from "@/lib/retrieval";
import { isCrawl4AIToolName } from "@/lib/crawl4aiTools";
import { listRecentToolActionTypes } from "@/lib/idleActions";
import { recordIdleActivity, startIdleScheduler } from "@/lib/idleState";
import { createChatInjectionLog } from "@/lib/chatInjections";
import {
  inferToolCategoriesFromText,
  type ToolCategory,
} from "@/lib/tooling";
import { buildChatContext } from "./contextBuilder";
import { parseChatRequest } from "./request";
import { runChatWithTools } from "./toolLoop";
import {
  TOKEN_BUDGET,
  mergeToolCategories,
  isShortAckMessage,
  inferFollowupToolCategories,
  mapToolNameToCategory,
  insertToolSystemPrompt,
  buildToolingBundle,
  summarizeConversationExcerpts,
  buildInjectedBlocks,
} from "./index";

export async function POST(request: Request) {
  try {
    await startIdleScheduler();
    recordIdleActivity("chat_request");

    const parsed = await parseChatRequest(request);
    if (parsed instanceof Response) {
      return parsed;
    }

    const { payload, messages, conversationId, personalMemoryContext } = parsed;

    const {
      lastUserMessage,
      lastAssistantMessage,
      baseMessages,
      retrievedMemories,
      retrievedPersonalMemories,
      resonantMemories,
      resonantPersonalMemories,
      temporalMemories,
      temporalPersonalMemories,
      injectedMemories,
      injectedPersonalMemories,
      scratchpadNotes,
      calendarReminders,
      generatedQueries,
      generatedPersonalQueries,
      generatedResonanceQueries,
      generatedResonanceTags,
      generatedResonanceWeight,
      generatedToolCategories,
      generatedToolConfidence,
      toolHistory,
      workspaceHistory,
      conversationExcerpts,
    } = await buildChatContext({ payload, messages, conversationId });

    const userText = extractTextFromContent(lastUserMessage?.content ?? "");
    const assistantText = extractTextFromContent(
      lastAssistantMessage?.content ?? ""
    );
    const shortAck = isShortAckMessage(userText);
    const useAssistantContext =
      shortAck ||
      /\b(that|same|continue|as before|use that|do that)\b/i.test(userText);
    const assistantCategories = useAssistantContext
      ? inferToolCategoriesFromText(assistantText)
      : [];

    const heuristicToolCategories = mergeToolCategories(
      inferToolCategoriesFromText(userText),
      assistantCategories
    );
    const followupToolCategories = inferFollowupToolCategories(
      lastUserMessage,
      lastAssistantMessage
    );

    let recentToolCategories: ToolCategory[] = [];
    if (shortAck) {
      try {
        const recentToolNames = await listRecentToolActionTypes({
          limit: 5,
          source: "chat",
        });
        const recentCategorySet = new Set<ToolCategory>();
        for (const name of recentToolNames) {
          const category = mapToolNameToCategory(name);
          if (category) {
            recentCategorySet.add(category);
            continue;
          }
          if (await isCrawl4AIToolName(name)) {
            recentCategorySet.add("web");
          }
        }
        recentToolCategories = Array.from(recentCategorySet);
      } catch (error) {
        console.warn("Recent tool lookup failed.", error);
      }
    }

    const selectedToolCategories = mergeToolCategories(
      generatedToolCategories,
      heuristicToolCategories,
      followupToolCategories,
      shortAck ? recentToolCategories : []
    );
    const ssefSelectionQuery = [
      userText,
      useAssistantContext ? assistantText : "",
      ...generatedQueries.slice(0, 2),
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");

    const toolingBundle = await buildToolingBundle(
      new Set(selectedToolCategories),
      {
        ssefSelectionQuery,
      }
    );
    const preparedMessages = applyTokenGuard(
      insertToolSystemPrompt(
        baseMessages,
        toolingBundle.toolFlags,
        toolingBundle.toolCatalogLines
      ),
      TOKEN_BUDGET
    );
    const tools = toolingBundle.tools;
    const toolNameSet = toolingBundle.toolNameSet;

    let injectionId: string | null = null;
    try {
      if (conversationId) {
        const logMessages = preparedMessages.map((message) => ({
          ...message,
          content: extractTextFromContent(message.content),
        }));
        const injectedBlocks = buildInjectedBlocks({
          injectedMemories,
          injectedPersonalMemories,
          conversationExcerpts,
          scratchpadNotes,
          calendarReminders,
          toolHistory,
          workspaceHistory,
        });
        injectionId = await createChatInjectionLog({
          conversationId,
          payload: {
            queries: generatedQueries,
            personalQueries: generatedPersonalQueries,
            resonanceQueries: generatedResonanceQueries,
            resonanceTags: generatedResonanceTags,
            resonanceWeight: generatedResonanceWeight,
            injectedMemories,
            injectedPersonalMemories,
            memories: retrievedMemories,
            resonantMemories,
            temporalMemories,
            personalMemories: retrievedPersonalMemories,
            resonantPersonalMemories,
            temporalPersonalMemories,
            conversationExcerpts:
              conversationExcerpts.length > 0
                ? summarizeConversationExcerpts(conversationExcerpts)
                : undefined,
            scratchpadNotes,
            calendarReminders,
            toolHistory,
            workspaceHistory,
            injectedBlocks: injectedBlocks.length > 0 ? injectedBlocks : undefined,
            toolCategoriesPredicted: generatedToolCategories,
            toolCategoriesHeuristic: heuristicToolCategories,
            toolCategoriesFollowup: followupToolCategories,
            toolCategoriesRecent: recentToolCategories,
            toolCategoriesSelected: selectedToolCategories,
            ssefSelectionQuery,
            toolConfidence: generatedToolConfidence,
            contextMessages: logMessages,
            toolDefinitions: tools,
          },
        });
      }
    } catch (error) {
      console.warn("Failed to store chat injection log.", error);
      injectionId = null;
    }

    if (payload.debug) {
      return Response.json({
        messages: preparedMessages,
        memories: retrievedMemories,
        resonantMemories,
        temporalMemories,
        personalMemories: retrievedPersonalMemories,
        resonantPersonalMemories,
        temporalPersonalMemories,
        conversationExcerpts,
        scratchpadNotes,
        calendarReminders,
        queries: generatedQueries,
        resonanceQueries: generatedResonanceQueries,
        resonanceTags: generatedResonanceTags,
        resonanceWeight: generatedResonanceWeight,
        toolCategoriesPredicted: generatedToolCategories,
        toolCategoriesHeuristic: heuristicToolCategories,
        toolCategoriesFollowup: followupToolCategories,
        toolCategoriesRecent: recentToolCategories,
        toolCategoriesSelected: selectedToolCategories,
        ssefSelectionQuery,
        toolConfidence: generatedToolConfidence,
        tools: tools.map((tool) => tool.function.name),
      });
    }

    const webSearchEnabled = payload.webSearchEnabled !== false;
    const webPlugins = webSearchEnabled ? [{ id: "web" }] : undefined;

    return runChatWithTools({
      payload,
      preparedMessages,
      baseMessages,
      tools,
      toolNameSet,
      selectedToolCategories,
      ssefSelectionQuery,
      conversationId,
      personalMemoryContext,
      webPlugins,
      injectionId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error";
    return new Response(message, { status: 500 });
  }
}
