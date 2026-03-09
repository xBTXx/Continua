import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ChatItem,
  ConversationSummary,
  StoredMessage,
  ImageAttachment,
} from "@/types/chat";
import {
  formatTimestamp,
  buildSystemPrompt,
  shouldForceMemoryTrigger,
  estimateTokens,
  CONTEXT_LIMIT,
} from "@/lib/chatUtils";
import {
  buildChatContent,
  IMAGE_MIME_TYPES,
} from "@/lib/chatContent";
import { withBasePath } from "@/lib/basePath";

interface UseChatProps {
  apiKey: string;
  systemPrompt: string;
  personaProfile: string;
  selectedModelId: string;
  supportsVision: boolean;
  reasoningEnabled: boolean;
  reasoningEffort: string;
  webSearchEnabled: boolean;
  toolDebugEnabled: boolean;
  onRefreshToolDebug: () => void;
  triggerMemoryAgent: (
    history: ChatItem[],
    conversationId?: string | null
  ) => Promise<void>;
  incrementPulse: () => void;
  messagesSinceMemory: number;
  setMessagesSinceMemory: (n: number) => void;
  triggerInterval: number;
}

export function useChat({
  apiKey,
  systemPrompt,
  personaProfile,
  selectedModelId,
  supportsVision,
  reasoningEnabled,
  reasoningEffort,
  webSearchEnabled,
  toolDebugEnabled,
  onRefreshToolDebug,
  triggerMemoryAgent,
  incrementPulse,
  messagesSinceMemory,
  setMessagesSinceMemory,
  triggerInterval,
}: UseChatProps) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null
  );
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  const MAX_ATTACHMENT_COUNT = 4;
  const allowedImageTypes = useMemo(
    () => new Set<string>(IMAGE_MIME_TYPES),
    []
  );

  const readFileAsDataUrl = useCallback((file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("Unable to read image."));
        }
      };
      reader.onerror = () => reject(new Error("Unable to read image."));
      reader.readAsDataURL(file);
    });
  }, []);

  const addAttachments = useCallback(
    async (fileList: FileList) => {
      setError(null);
      if (!supportsVision) {
        setError("Selected model does not support images.");
        return;
      }
      const files = Array.from(fileList ?? []);
      if (files.length === 0) {
        return;
      }

      const remainingSlots = Math.max(
        0,
        MAX_ATTACHMENT_COUNT - attachments.length
      );
      if (remainingSlots === 0) {
        setError(`You can attach up to ${MAX_ATTACHMENT_COUNT} images.`);
        return;
      }

      const nextFiles = files.slice(0, remainingSlots);
      if (files.length > remainingSlots) {
        setError(`Only the first ${remainingSlots} images were added.`);
      }

      const nextAttachments: ImageAttachment[] = [];
      for (const file of nextFiles) {
        if (!allowedImageTypes.has(file.type)) {
          setError(
            `Unsupported file type "${file.type || "unknown"}". Use PNG, JPEG, WEBP, or GIF.`
          );
          continue;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError("Each image must be 5MB or smaller.");
          continue;
        }
        try {
          const url = await readFileAsDataUrl(file);
          nextAttachments.push({
            id: crypto.randomUUID(),
            url,
            mimeType: file.type,
            name: file.name,
            size: file.size,
          });
        } catch (readError) {
          const message =
            readError instanceof Error
              ? readError.message
              : "Unable to read image.";
          setError(message);
        }
      }

      if (nextAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...nextAttachments]);
      }
    },
    [
      MAX_ATTACHMENT_BYTES,
      allowedImageTypes,
      attachments.length,
      readFileAsDataUrl,
      supportsVision,
    ]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const activeConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.id === activeConversationId
      ) ?? null,
    [conversations, activeConversationId]
  );

  useEffect(() => {
    if (!supportsVision && attachments.length > 0) {
      setAttachments([]);
    }
  }, [attachments.length, supportsVision]);

  const mapStoredMessage = (message: StoredMessage): ChatItem => ({
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments ?? [],
    timestamp: formatTimestamp(new Date(message.createdAt)),
    injectionId: message.injectionId ?? null,
  });

  const calculateMessagesSinceMemory = (items: Array<{ role: string }>) => {
    const count = items.filter((message) => message.role === "user").length;
    return count % triggerInterval;
  };

  const persistMessage = async (
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    injectionId?: string | null,
    attachments?: ImageAttachment[]
  ) => {
    const response = await fetch(withBasePath("/api/conversations/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        role,
        content,
        attachments,
        injectionId: injectionId ?? null,
      }),
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const errorText = contentType.includes("text/html")
        ? ""
        : await response.text();
      throw new Error(
        errorText || `Failed to save message (status ${response.status}).`
      );
    }
    return (await response.json()) as StoredMessage;
  };

  const createConversation = async (select = true) => {
    setConversationError(null);
    const response = await fetch(withBasePath("/api/conversations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New conversation" }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Failed to create conversation.");
    }
    const conversation = (await response.json()) as ConversationSummary;
    setConversations((prev) => [conversation, ...prev]);
    if (select) {
      setActiveConversationId(conversation.id);
      setMessages([]);
      setMessagesSinceMemory(0);
    }
    return conversation;
  };

  const loadConversation = async (conversationId: string) => {
    setIsLoadingMessages(true);
    setConversationError(null);
    setMessages([]);
    try {
      const response = await fetch(withBasePath(`/api/conversations/${conversationId}`));
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Failed to load conversation.");
      }
      const data = (await response.json()) as {
        conversation: ConversationSummary;
        messages: StoredMessage[];
      };
      setActiveConversationId(data.conversation.id);
      setConversations((prev) => {
        const exists = prev.some(
          (conversation) => conversation.id === data.conversation.id
        );
        const next = exists
          ? prev.map((conversation) =>
              conversation.id === data.conversation.id
                ? data.conversation
                : conversation
            )
          : [data.conversation, ...prev];
        return next.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
      const mappedMessages = data.messages.map(mapStoredMessage);
      setMessages(mappedMessages);
      setMessagesSinceMemory(calculateMessagesSinceMemory(mappedMessages));
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : "Unable to load conversation.";
      setConversationError(message);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const refreshConversations = async (selectId?: string | null) => {
    setIsLoadingConversations(true);
    setConversationError(null);
    try {
      const response = await fetch(withBasePath("/api/conversations"));
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Failed to load conversations.");
      }
      const data = (await response.json()) as ConversationSummary[];
      setConversations(data);
      if (data.length === 0) {
        await createConversation(true);
        return;
      }
      const nextId = selectId ?? activeConversationId ?? data[0]?.id ?? null;
      if (nextId && nextId !== activeConversationId) {
        setActiveConversationId(nextId);
        await loadConversation(nextId);
      }
    } catch (loadError) {
      const message =
        loadError instanceof Error
          ? loadError.message
          : "Unable to load conversations.";
      setConversationError(message);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  const updateConversationSummary = (
    conversationId: string,
    updates: Partial<ConversationSummary>
  ) => {
    setConversations((prev) => {
      const next = prev.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, ...updates }
          : conversation
      );
      return next.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
  };

  const resolveGlobalLastInteraction = (items: ConversationSummary[]) => {
    let latestMs = -1;
    let latest: string | null = null;
    for (const conversation of items) {
      const candidate = conversation.lastMessageAt ?? null;
      if (!candidate) {
        continue;
      }
      const candidateMs = new Date(candidate).getTime();
      if (Number.isNaN(candidateMs)) {
        continue;
      }
      if (candidateMs > latestMs) {
        latestMs = candidateMs;
        latest = candidate;
      }
    }
    return latest;
  };

  const handleNewConversation = async () => {
    if (isSending || isLoadingMessages) return;
    setError(null);
    setAttachments([]);
    setIsLoadingMessages(true);
    try {
      await createConversation(true);
    } catch (creationError) {
      const message =
        creationError instanceof Error
          ? creationError.message
          : "Unable to start a new conversation.";
      setConversationError(message);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (isSending || isLoadingMessages) return;

    if (!window.confirm("Are you sure you want to delete this conversation?")) {
      return;
    }

    try {
      const response = await fetch(withBasePath(`/api/conversations/${conversationId}`), {
        method: "DELETE",
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to delete conversation.");
      }

      setConversations((prev) => prev.filter((c) => c.id !== conversationId));

      if (activeConversationId === conversationId) {
        const remaining = conversations.filter((c) => c.id !== conversationId);
        if (remaining.length > 0) {
          await handleSelectConversation(remaining[0].id);
        } else {
          setActiveConversationId(null);
          setMessages([]);
          void handleNewConversation();
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to delete conversation.";
      setConversationError(message);
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    if (
      conversationId === activeConversationId ||
      isSending ||
      isLoadingMessages
    ) {
      return;
    }
    setError(null);
    setAttachments([]);
    await loadConversation(conversationId);
  };

  const handleSend = async () => {
    if (isSending || isLoadingMessages) return;

    const trimmedInput = inputValue.trim();
    const hasAttachments = attachments.length > 0;
    if (!trimmedInput && !hasAttachments) return;
    if (hasAttachments && !supportsVision) {
      setError("Selected model does not support images.");
      return;
    }

    let conversationId = activeConversationId;
    if (!conversationId) {
      try {
        const created = await createConversation(true);
        conversationId = created.id;
      } catch (creationError) {
        const message =
          creationError instanceof Error
            ? creationError.message
            : "Unable to start a new conversation.";
        setConversationError(message);
        return;
      }
    }

    const forceMemoryTrigger = shouldForceMemoryTrigger(trimmedInput);
    const nextMessageCount = messagesSinceMemory + 1;
    const shouldTriggerMemory = 
      forceMemoryTrigger || nextMessageCount >= triggerInterval;
    setMessagesSinceMemory(shouldTriggerMemory ? 0 : nextMessageCount);

    setError(null);

    const timestamp = formatTimestamp(new Date());
    const outgoingAttachments = attachments;
    const userMessage: ChatItem = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedInput,
      attachments: outgoingAttachments,
      timestamp,
    };
    const assistantId = crypto.randomUUID();
    let storedUserMessageId: string | null = null;
    let storedAssistantMessageId: string | null = null;
    const assistantMessage: ChatItem = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp,
      isStreaming: true,
      injectionId: null,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInputValue("");
    if (outgoingAttachments.length > 0) {
      setAttachments([]);
    }
    setIsSending(true);

    void persistMessage(conversationId, "user", trimmedInput, null, outgoingAttachments)
      .then((stored) => {
        storedUserMessageId = stored.id;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === userMessage.id
              ? { ...message, id: stored.id }
              : message
          )
        );
        updateConversationSummary(conversationId, {
          updatedAt: stored.createdAt,
          lastMessageAt: stored.createdAt,
          title:
            activeConversation?.title === "New conversation"
              ? trimmedInput.length > 48
                ? `${trimmedInput.slice(0, 48)}…`
                : trimmedInput
              : activeConversation?.title ?? "New conversation",
        });
      })
      .catch((persistError) => {
        const message =
          persistError instanceof Error
            ? persistError.message
            : "Unable to save the message.";
        setConversationError(message);
      });

    const history = [...messages, userMessage].filter(
      (message) => message.role !== "memory"
    );
    const globalLastInteraction = resolveGlobalLastInteraction(conversations);
    const runtimeSystemPrompt = buildSystemPrompt(
      systemPrompt,
      personaProfile,
      globalLastInteraction
    );
    const apiMessages = [
      { role: "system", content: runtimeSystemPrompt },
      ...history.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content:
          message.role === "assistant"
            ? message.content
            : buildChatContent(
                message.content,
                supportsVision ? message.attachments ?? [] : []
              ),
      })),
    ];

    const requestBody: Record<string, unknown> = {
      model: selectedModelId,
      messages: apiMessages,
      stream: true,
      webSearchEnabled,
      conversationId,
    };

    if (toolDebugEnabled) {
      requestBody.debugTools = true;
    }

    if (reasoningEnabled) {
      if (["low", "medium", "high"].includes(reasoningEffort)) {
        requestBody.reasoning = { effort: reasoningEffort };
      } else {
        requestBody.reasoning = { enabled: true };
      }
    }

    const trimmedKey = apiKey.trim();
    if (trimmedKey) {
      requestBody.apiKey = trimmedKey;
    }
    requestBody.appUrl = window.location.origin;

    let assistantContentBuffer = "";
    let allowMemoryTrigger = shouldTriggerMemory;
    let assistantStoredAt: string | null = null;

    try {
      const response = await fetch(withBasePath("/api/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "OpenRouter request failed.");
      }

      if (!response.body) {
        throw new Error("OpenRouter returned an empty stream.");
      }

      if (response.headers.get("x-assistant-personal-memory") === "1") {
        incrementPulse();
      }
      const injectionId = response.headers.get("x-assistant-injection-id");
      if (injectionId) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, injectionId }
              : message
          )
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneStreaming = false;
      let receivedContent = false;
      let streamError: string | null = null;

      while (!doneStreaming) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split("\n\n");
        buffer = segments.pop() ?? "";

        for (const segment of segments) {
          const lines = segment.split("\n");
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine.startsWith("data:")) {
              continue;
            }

            const data = trimmedLine.replace(/^data:\s*/, "");
            if (data === "[DONE]") {
              doneStreaming = true;
              break;
            }

            try {
              const json = JSON.parse(data) as {
                error?: { message?: string };
                choices?: Array<{ delta?: { content?: string } }>;
              };

              if (json.error) {
                streamError =
                  json.error.message ?? "OpenRouter returned a stream error.";
                doneStreaming = true;
                break;
              }

              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                receivedContent = true;
                assistantContentBuffer += delta;
                setMessages((prev) =>
                  prev.map((message) =>
                    message.id === assistantId
                      ? { ...message, content: message.content + delta }
                      : message
                  )
                );
              }
            } catch {
              continue;
            }
          }

          if (doneStreaming) {
            break;
          }
        }
      }

      if (toolDebugEnabled) {
        onRefreshToolDebug();
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (!receivedContent) {
        throw new Error("No response content was returned by the model.");
      }

      if (assistantContentBuffer.trim().length > 0) {
        const stored = await persistMessage(
          conversationId,
          "assistant",
          assistantContentBuffer,
          injectionId
        );
        storedAssistantMessageId = stored.id;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId ? { ...message, id: stored.id } : message
          )
        );
        assistantStoredAt = stored.createdAt;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to reach OpenRouter.";
      setError(message);
      if (toolDebugEnabled) {
        onRefreshToolDebug();
      }
      allowMemoryTrigger = false;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === (storedAssistantMessageId ?? assistantId)
            ? {
                ...message,
                content: message.content || "Unable to connect to the model.",
              }
            : message
        )
      );
    } finally {
      setIsSending(false);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === (storedAssistantMessageId ?? assistantId)
            ? { ...message, isStreaming: false }
            : message
        )
      );

      if (assistantStoredAt) {
        updateConversationSummary(conversationId, {
          updatedAt: assistantStoredAt,
          lastMessageAt: assistantStoredAt,
        });
      }

      if (allowMemoryTrigger && assistantContentBuffer.trim().length > 0) {
        const memoryHistory: ChatItem[] = [
          ...history.map((message) => {
            if (message.id === userMessage.id && storedUserMessageId) {
              return { ...message, id: storedUserMessageId };
            }
            return message;
          }),
          {
            id: storedAssistantMessageId ?? assistantId,
            role: "assistant",
            content: assistantContentBuffer,
          },
        ];
        void triggerMemoryAgent(memoryHistory, conversationId);
      }
    }
  };

  const estimatedTokens = useMemo(() => {
    const historyTokens = messages
      .filter((message) => message.role !== "memory")
      .reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const total = 
      historyTokens + estimateTokens(systemPrompt) + estimateTokens(inputValue);
    return Math.min(total, CONTEXT_LIMIT);
  }, [messages, inputValue, systemPrompt]);

  // Initial load
  useEffect(() => {
    void refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    messages,
    setMessages,
    conversations,
    setConversations,
    activeConversationId,
    setActiveConversationId,
    activeConversation,
    isLoadingConversations,
    isLoadingMessages,
    conversationError,
    inputValue,
    setInputValue,
    isSending,
    error,
    estimatedTokens,
    attachments,
    addAttachments,
    removeAttachment,
    handleSend,
    handleNewConversation,
    handleDeleteConversation,
    handleSelectConversation,
  };
}
