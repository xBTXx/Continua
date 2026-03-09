import { ChatMessage } from "@/lib/openrouter";
import { ToolCategory, ToolConfidence } from "@/lib/tooling";
import {
  retrieveMemories,
  retrievePersonalMemories,
  retrieveToolHistory,
  retrieveWorkspaceHistory,
  retrieveConversationExcerpts,
  injectMemories,
  injectPersonalMemories,
  injectScratchpadNotes,
  injectCalendarReminders,
  injectToolHistory,
  injectWorkspaceHistory,
  injectWebSessionContext,
  injectWebArtifactContext,
  injectConversationExcerpts,
  expandTemporalResonance,
  generateSearchQueries,
  extractTopicsFromMemories,
  rankResonanceMemories,
  type ConversationExcerpt,
  type MemorySnippet,
} from "@/lib/retrieval";
import { getWebSessionContextBlock } from "@/lib/webSessions";
import { getWebArtifactContextBlock } from "@/lib/webArtifacts";
import {
  calendarToolsEnabled,
  listCalendarEventReminders,
  markCalendarEventsReminded,
} from "@/lib/calendarTools";
import { updateRollingMemoryLog } from "@/lib/rollingMemoryLog";
import {
  listScratchpadNotesForConversation,
  shouldInjectScratchpadNotes,
} from "@/lib/scratchpad";
import { buildCalendarReminder } from "./memoryHelpers";
import { dedupeMemories } from "./responseHelpers";
import {
  PERSONAL_MEMORY_COLLECTION,
  SCRATCHPAD_NOTE_LIMIT,
} from "./constants";
import { ChatPayload } from "./types";

export type ChatContextBuildResult = {
  lastUserMessage: ChatMessage | undefined;
  lastAssistantMessage: ChatMessage | undefined;
  preparedMessages: ChatMessage[];
  baseMessages: ChatMessage[];
  retrievedMemories: MemorySnippet[];
  retrievedPersonalMemories: MemorySnippet[];
  resonantMemories: MemorySnippet[];
  resonantPersonalMemories: MemorySnippet[];
  temporalMemories: MemorySnippet[];
  temporalPersonalMemories: MemorySnippet[];
  injectedMemories: MemorySnippet[];
  injectedPersonalMemories: MemorySnippet[];
  scratchpadNotes: MemorySnippet[];
  calendarReminders: MemorySnippet[];
  generatedQueries: string[];
  generatedPersonalQueries: string[];
  generatedResonanceQueries: string[];
  generatedResonanceTags: string[];
  generatedResonanceWeight: string | undefined;
  generatedToolCategories: ToolCategory[];
  generatedToolConfidence: ToolConfidence | undefined;
  toolHistory: string | null;
  workspaceHistory: string | null;
  conversationExcerpts: ConversationExcerpt[];
};

export async function buildChatContext({
  payload,
  messages,
  conversationId,
}: {
  payload: ChatPayload;
  messages: ChatMessage[];
  conversationId: string | null;
}): Promise<ChatContextBuildResult> {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  let retrievedMemories: MemorySnippet[] = [];
  let retrievedPersonalMemories: MemorySnippet[] = [];
  let resonantMemories: MemorySnippet[] = [];
  let resonantPersonalMemories: MemorySnippet[] = [];
  let temporalMemories: MemorySnippet[] = [];
  let temporalPersonalMemories: MemorySnippet[] = [];
  let rollingMemories: MemorySnippet[] = [];
  let rollingPersonalMemories: MemorySnippet[] = [];
  let injectedMemories: MemorySnippet[] = [];
  let injectedPersonalMemories: MemorySnippet[] = [];
  let scratchpadNotes: MemorySnippet[] = [];
  let calendarReminders: MemorySnippet[] = [];
  let generatedQueries: string[] = [];
  let generatedPersonalQueries: string[] = [];
  let generatedResonanceQueries: string[] = [];
  let generatedResonanceTags: string[] = [];
  let generatedResonanceWeight: string | undefined;
  let generatedToolCategories: ToolCategory[] = [];
  let generatedToolConfidence: ToolConfidence | undefined;
  let retrievalSucceeded = false;
  let preparedMessages = messages;
  let toolHistory: string | null = null;
  let workspaceHistory: string | null = null;
  let webSessionContext: string | null = null;
  let webArtifactContext: string | null = null;
  let conversationExcerpts: ConversationExcerpt[] = [];

  if (lastUserMessage) {
    try {
      const {
        queries,
        personalQueries,
        resonanceQueries,
        resonanceTags,
        resonanceWeight,
        dateRange,
        type,
        personalCategory,
        toolCategories,
        toolConfidence,
      } = await generateSearchQueries(messages, payload.apiKey, payload.appUrl);
      generatedQueries = queries;
      generatedPersonalQueries = personalQueries;
      generatedResonanceQueries = resonanceQueries;
      generatedResonanceTags = resonanceTags;
      generatedResonanceWeight = resonanceWeight;
      generatedToolCategories = toolCategories ?? [];
      generatedToolConfidence = toolConfidence;

      const results = await Promise.all(
        queries.map((query) =>
          retrieveMemories(query, payload.apiKey, { ...dateRange, type })
        )
      );

      retrievedMemories = dedupeMemories(results.flat());

      const resonancePrimary = resonanceTags[0];
      if (resonanceQueries.length > 0) {
        let resonanceResults = await Promise.all(
          resonanceQueries.map((query) =>
            retrieveMemories(query, payload.apiKey, {
              ...dateRange,
              type,
              resonancePrimary,
            })
          )
        );
        let resonanceFlat = resonanceResults.flat();
        if (resonanceFlat.length === 0 && resonancePrimary) {
          resonanceResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrieveMemories(query, payload.apiKey, { ...dateRange, type })
            )
          );
          resonanceFlat = resonanceResults.flat();
        }
        const resonanceDeduped = dedupeMemories(resonanceFlat);
        resonantMemories = rankResonanceMemories(
          resonanceDeduped,
          resonanceTags
        ).slice(0, 4);
      }

      let personalResults = await Promise.all(
        personalQueries.map((query) =>
          retrievePersonalMemories(query, payload.apiKey, {
            topK: 5,
            category: personalCategory,
          })
        )
      );

      retrievedPersonalMemories = dedupeMemories(personalResults.flat());
      if (retrievedPersonalMemories.length === 0 && personalCategory) {
        personalResults = await Promise.all(
          personalQueries.map((query) =>
            retrievePersonalMemories(query, payload.apiKey, {
              topK: 5,
            })
          )
        );
        retrievedPersonalMemories = dedupeMemories(personalResults.flat());
      }

      if (resonanceQueries.length > 0) {
        let resonantPersonalResults = await Promise.all(
          resonanceQueries.map((query) =>
            retrievePersonalMemories(query, payload.apiKey, {
              topK: 5,
              category: personalCategory,
              resonancePrimary,
            })
          )
        );
        let resonantPersonalFlat = resonantPersonalResults.flat();
        if (resonantPersonalFlat.length === 0 && resonancePrimary) {
          resonantPersonalResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrievePersonalMemories(query, payload.apiKey, {
                topK: 5,
                category: personalCategory,
              })
            )
          );
          resonantPersonalFlat = resonantPersonalResults.flat();
        }
        if (resonantPersonalFlat.length === 0 && personalCategory) {
          resonantPersonalResults = await Promise.all(
            resonanceQueries.map((query) =>
              retrievePersonalMemories(query, payload.apiKey, { topK: 5 })
            )
          );
          resonantPersonalFlat = resonantPersonalResults.flat();
        }
        const personalResonanceDeduped = dedupeMemories(resonantPersonalFlat);
        resonantPersonalMemories = rankResonanceMemories(
          personalResonanceDeduped,
          resonanceTags
        ).slice(0, 4);
      }

      // Cross-collection query expansion from personal memories to main memories.
      const allPersonalMemories = dedupeMemories([
        ...retrievedPersonalMemories,
        ...resonantPersonalMemories,
      ]);
      const extractedTopics = extractTopicsFromMemories(allPersonalMemories);
      if (extractedTopics.length > 0) {
        const crossCollectionResults = await Promise.all(
          extractedTopics.map((topic) =>
            retrieveMemories(topic, payload.apiKey, { ...dateRange, type })
          )
        );
        const crossCollectionMemories = dedupeMemories(crossCollectionResults.flat());
        retrievedMemories = dedupeMemories([
          ...retrievedMemories,
          ...crossCollectionMemories,
        ]);
      }

      temporalMemories = await expandTemporalResonance(
        dedupeMemories([...retrievedMemories, ...resonantMemories]),
        { windowMinutes: 20 }
      );
      temporalPersonalMemories = await expandTemporalResonance(
        dedupeMemories([
          ...retrievedPersonalMemories,
          ...resonantPersonalMemories,
        ]),
        {
          windowMinutes: 20,
          collectionName: PERSONAL_MEMORY_COLLECTION,
        }
      );

      const mergedMemories = dedupeMemories([
        ...retrievedMemories,
        ...resonantMemories,
        ...temporalMemories,
      ]);
      const mergedPersonalMemories = dedupeMemories([
        ...retrievedPersonalMemories,
        ...resonantPersonalMemories,
        ...temporalPersonalMemories,
      ]).slice(0, 5);

      injectedMemories = mergedMemories;
      injectedPersonalMemories = mergedPersonalMemories;

      if (conversationId) {
        try {
          const rolling = await updateRollingMemoryLog({
            conversationId,
            mainCandidates: mergedMemories,
            personalCandidates: mergedPersonalMemories,
          });
          rollingMemories = rolling.main;
          rollingPersonalMemories = rolling.personal;
          injectedMemories = rollingMemories;
          injectedPersonalMemories = rollingPersonalMemories;
        } catch (error) {
          console.warn("Rolling memory log update failed.", error);
        }
      }

      if (injectedMemories.length > 0) {
        preparedMessages = injectMemories(preparedMessages, injectedMemories);
      }
      if (injectedPersonalMemories.length > 0) {
        preparedMessages = injectPersonalMemories(
          preparedMessages,
          injectedPersonalMemories
        );
      }
      if (injectedMemories.length > 0 || injectedPersonalMemories.length > 0) {
        try {
          conversationExcerpts = await retrieveConversationExcerpts([
            ...injectedMemories,
            ...injectedPersonalMemories,
          ]);
          if (conversationExcerpts.length > 0) {
            preparedMessages = injectConversationExcerpts(
              preparedMessages,
              conversationExcerpts
            );
          }
        } catch (error) {
          console.warn("Conversation excerpt injection failed.", error);
        }
      }
      retrievalSucceeded = true;
    } catch (error) {
      console.warn("Memory retrieval failed.", error);
    }
  }

  if (conversationId && !retrievalSucceeded) {
    try {
      const rolling = await updateRollingMemoryLog({
        conversationId,
        mainCandidates: [],
        personalCandidates: [],
      });
      rollingMemories = rolling.main;
      rollingPersonalMemories = rolling.personal;
      injectedMemories = rollingMemories;
      injectedPersonalMemories = rollingPersonalMemories;

      if (injectedMemories.length > 0) {
        preparedMessages = injectMemories(preparedMessages, injectedMemories);
      }
      if (injectedPersonalMemories.length > 0) {
        preparedMessages = injectPersonalMemories(
          preparedMessages,
          injectedPersonalMemories
        );
      }
      if (injectedMemories.length > 0 || injectedPersonalMemories.length > 0) {
        try {
          conversationExcerpts = await retrieveConversationExcerpts([
            ...injectedMemories,
            ...injectedPersonalMemories,
          ]);
          if (conversationExcerpts.length > 0) {
            preparedMessages = injectConversationExcerpts(
              preparedMessages,
              conversationExcerpts
            );
          }
        } catch (error) {
          console.warn("Conversation excerpt injection failed.", error);
        }
      }
    } catch (error) {
      console.warn("Rolling memory log fallback failed.", error);
    }
  }

  if (conversationId) {
    try {
      const shouldInject = await shouldInjectScratchpadNotes(conversationId);
      if (shouldInject) {
        scratchpadNotes = await listScratchpadNotesForConversation(
          conversationId,
          SCRATCHPAD_NOTE_LIMIT,
          { consumeOnAssign: true }
        );
        if (scratchpadNotes.length > 0) {
          preparedMessages = injectScratchpadNotes(
            preparedMessages,
            scratchpadNotes
          );
        }
      }
    } catch (error) {
      console.warn("Scratchpad injection failed.", error);
    }
  }

  if (calendarToolsEnabled()) {
    try {
      const reminders = await listCalendarEventReminders(3);
      if (reminders.length > 0) {
        calendarReminders = reminders.map((event) => ({
          content: buildCalendarReminder(event),
        }));
        preparedMessages = injectCalendarReminders(
          preparedMessages,
          calendarReminders
        );
        await markCalendarEventsReminded(reminders.map((event) => event.id));
      }
    } catch (error) {
      console.warn("Calendar reminder injection failed.", error);
    }
  }

  try {
    toolHistory = await retrieveToolHistory(15);
    if (toolHistory) {
      preparedMessages = injectToolHistory(preparedMessages, toolHistory);
    }
  } catch (error) {
    console.warn("Tool history injection failed.", error);
  }

  try {
    workspaceHistory = await retrieveWorkspaceHistory(5);
    if (workspaceHistory) {
      preparedMessages = injectWorkspaceHistory(preparedMessages, workspaceHistory);
    }
  } catch (error) {
    console.warn("Workspace history injection failed.", error);
  }

  if (conversationId) {
    try {
      webSessionContext = await getWebSessionContextBlock(conversationId, 5);
      if (webSessionContext) {
        preparedMessages = injectWebSessionContext(
          preparedMessages,
          webSessionContext
        );
      }
    } catch (error) {
      console.warn("Web session context injection failed.", error);
    }

    try {
      webArtifactContext = await getWebArtifactContextBlock(conversationId, 5);
      if (webArtifactContext) {
        preparedMessages = injectWebArtifactContext(
          preparedMessages,
          webArtifactContext
        );
      }
    } catch (error) {
      console.warn("Web artifact context injection failed.", error);
    }
  }

  return {
    lastUserMessage,
    lastAssistantMessage,
    preparedMessages,
    baseMessages: preparedMessages,
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
  };
}
