"use client";

import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type ChatRole, type ImageAttachment } from "@/types/chat";
import { withBasePath } from "@/lib/basePath";

type ChatMessageProps = {
  role: ChatRole;
  content: string;
  attachments?: ImageAttachment[];
  timestamp?: string;
  className?: string;
  style?: CSSProperties;
  isStreaming?: boolean;
  injectionId?: string;
};

type InjectionMemory = {
  content: string;
  createdAt?: string;
  sourceAt?: string;
};

type InjectionExcerptMessage = {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
};

type InjectionConversationExcerpt = {
  conversationId: string;
  memoryContent: string;
  messages: InjectionExcerptMessage[];
};

type InjectionContextBlock = {
  label: string;
  content: string;
};

type InjectionPayload = {
  queries?: string[];
  personalQueries?: string[];
  resonanceQueries?: string[];
  resonanceTags?: string[];
  resonanceWeight?: string;
  injectedMemories?: InjectionMemory[];
  injectedPersonalMemories?: InjectionMemory[];
  memories?: InjectionMemory[];
  resonantMemories?: InjectionMemory[];
  temporalMemories?: InjectionMemory[];
  personalMemories?: InjectionMemory[];
  resonantPersonalMemories?: InjectionMemory[];
  temporalPersonalMemories?: InjectionMemory[];
  conversationExcerpts?: InjectionConversationExcerpt[];
  scratchpadNotes?: InjectionMemory[];
  calendarReminders?: InjectionMemory[];
  toolHistory?: string | null;
  workspaceHistory?: string | null;
  injectedBlocks?: InjectionContextBlock[];
  contextMessages?: Array<{
    role: string;
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
    reasoning?: string;
    reasoning_details?: unknown;
  }>;
  toolDefinitions?: Array<{
    type?: string;
    function?: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
};

type InjectionView = "none" | "info" | "memory";

export default function ChatMessage({
  role,
  content,
  attachments = [],
  timestamp,
  className = "",
  style,
  isStreaming = false,
  injectionId,
}: ChatMessageProps) {
  const isUser = role === "user";
  const isMemory = role === "memory";
  const [activeView, setActiveView] = useState<InjectionView>("none");
  const [injectionLoading, setInjectionLoading] = useState(false);
  const [injectionError, setInjectionError] = useState<string | null>(null);
  const [injectionPayload, setInjectionPayload] =
    useState<InjectionPayload | null>(null);

  if (isMemory) {
    return (
      <div className={`flex justify-center ${className}`} style={style}>
        <div className="rounded-full border border-[var(--green-400)] bg-[rgba(59,155,90,0.08)] px-4 py-2 text-[10px] uppercase tracking-[0.3em] text-[var(--green-600)]">
          {content}
        </div>
      </div>
    );
  }

  const trimmedContent = content.trim();
  const hasText = trimmedContent.length > 0;
  const hasAttachments = attachments.length > 0;
  const hasContent = hasText || hasAttachments;
  const displayContent = hasText ? content : isStreaming ? "...." : content;
  const canShowInjection = !isUser && Boolean(injectionId);

  const formatDate = (raw?: string | null) => {
    if (!raw) {
      return null;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return raw;
    }
    return date.toISOString().replace("T", " ").replace("Z", " UTC");
  };

  const resolveMemoryTimestamp = (memory: InjectionMemory) =>
    memory.sourceAt ?? memory.createdAt ?? null;

  const stripInjectedBlocksFromSystem = (
    content: string,
    blocks: InjectionContextBlock[]
  ) => {
    let next = content.trimEnd();
    const reversed = [...blocks].reverse();
    reversed.forEach((block) => {
      const blockContent = block.content?.trim();
      if (!blockContent) {
        return;
      }
      const suffixes = [
        `\n\n${blockContent}`,
        `\n${blockContent}`,
        blockContent,
      ];
      for (const suffix of suffixes) {
        if (next.endsWith(suffix)) {
          next = next.slice(0, Math.max(0, next.length - suffix.length)).trimEnd();
          break;
        }
      }
    });
    return next.trim();
  };

  const handleToggleView = async (view: InjectionView) => {
    if (!injectionId) {
      return;
    }
    if (activeView === view) {
      setActiveView("none");
      return;
    }
    setActiveView(view);
    
    if (injectionPayload || injectionLoading) {
      return;
    }
    setInjectionLoading(true);
    setInjectionError(null);
    try {
      const response = await fetch(
        withBasePath(`/api/chat/injections?id=${encodeURIComponent(injectionId)}`)
      );
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        const errorText = contentType.includes("application/json")
          ? ((await response.json()) as { error?: string }).error ?? ""
          : contentType.includes("text/html")
            ? ""
            : await response.text();
        throw new Error(errorText || "Unable to load injection details.");
      }
      const data = (await response.json()) as { payload?: InjectionPayload };
      setInjectionPayload(data.payload ?? null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to load injection details.";
      setInjectionError(message);
    } finally {
      setInjectionLoading(false);
    }
  };

  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"} ${className}`}
      style={style}
    >
      <div
        className={`chat-bubble max-w-[78%] rounded-3xl px-5 py-4 text-sm leading-6 shadow-[var(--shadow)] ${
          isUser
            ? "chat-bubble-user bg-[var(--green-500)] text-white"
            : "chat-bubble-assistant bg-white text-[var(--ink)]"
        }`}
      >
        {hasContent ? (
          <>
            {hasAttachments && (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map((attachment) => (
                  <Fragment key={attachment.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- attachment URLs may be transient or data URLs. */}
                    <img
                      src={attachment.url}
                      alt={attachment.name ?? "Chat attachment"}
                      className="h-32 w-40 rounded-2xl border border-black/10 object-cover"
                    />
                  </Fragment>
                ))}
              </div>
            )}
            {hasText && (
              <ReactMarkdown
                className="chat-markdown"
                remarkPlugins={[remarkGfm]}
              >
                {displayContent}
              </ReactMarkdown>
            )}
          </>
        ) : (
          <p className={isStreaming ? "chat-typing" : ""}>
            {displayContent}
          </p>
        )}
        {(timestamp || canShowInjection) && (
          <div
            className={`mt-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] ${
              isUser ? "text-white/70" : "text-[var(--muted)]"
            }`}
          >
            <span>{timestamp ?? ""}</span>
            {canShowInjection && (
              <div className="ml-3 flex gap-2">
                 <button
                  type="button"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[9px] ${
                    activeView === "info"
                      ? "border-[var(--green-500)] text-[var(--green-600)]"
                      : "border-black/10 text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
                  }`}
                  onClick={() => handleToggleView("info")}
                  aria-label="Toggle technical info"
                >
                  i
                </button>
                <button
                  type="button"
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[9px] ${
                    activeView === "memory"
                      ? "border-[var(--green-500)] text-[var(--green-600)]"
                      : "border-black/10 text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
                  }`}
                  onClick={() => handleToggleView("memory")}
                  aria-label="Toggle injected memories"
                >
                  M
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {activeView !== "none" && canShowInjection && (
        <div className="mt-3 max-w-[78%] rounded-3xl border border-black/10 bg-white/90 px-4 py-3 text-xs text-[var(--ink)] shadow-[var(--shadow)]">
          {injectionLoading && (
            <p className="text-[var(--muted)]">Loading context...</p>
          )}
          {injectionError && (
            <p className="text-red-600">{injectionError}</p>
          )}
          {!injectionLoading && !injectionError && !injectionPayload && (
            <p className="text-[var(--muted)]">No injected context recorded.</p>
          )}
          {!injectionLoading && !injectionError && injectionPayload && (() => {
            const injectedBlocks = injectionPayload.injectedBlocks ?? [];
            const injectedMemories = injectionPayload.injectedMemories ?? [];
            const injectedPersonalMemories =
              injectionPayload.injectedPersonalMemories ?? [];
            const systemMessages =
              injectionPayload.contextMessages?.filter(
                (message) => message.role === "system"
              ) ?? [];
            const systemBlocks = systemMessages
              .map((message, index) => {
                const label =
                  index === 0
                    ? "System prompt"
                    : systemMessages.length === 2
                      ? "Tooling prompt"
                      : `System prompt ${index + 1}`;
                const content =
                  index === 0
                    ? stripInjectedBlocksFromSystem(
                        message.content ?? "",
                        injectedBlocks
                      )
                    : message.content ?? "";
                return { label, content };
              })
              .filter((block) => block.content.trim().length > 0);
            const candidateGroups = [
              {
                label: "Main",
                items: injectionPayload.memories ?? [],
                key: "main",
              },
              {
                label: "Resonant",
                items: injectionPayload.resonantMemories ?? [],
                key: "resonant",
              },
              {
                label: "Temporal",
                items: injectionPayload.temporalMemories ?? [],
                key: "temporal",
              },
            ];
            const personalCandidateGroups = [
              {
                label: "Main",
                items: injectionPayload.personalMemories ?? [],
                key: "personal-main",
              },
              {
                label: "Resonant",
                items: injectionPayload.resonantPersonalMemories ?? [],
                key: "personal-resonant",
              },
              {
                label: "Temporal",
                items: injectionPayload.temporalPersonalMemories ?? [],
                key: "personal-temporal",
              },
            ];
            const hasCandidateMemories =
              candidateGroups.some((group) => group.items.length > 0) ||
              personalCandidateGroups.some((group) => group.items.length > 0);
            
            const hasPickedMemories =
              injectedMemories.length > 0 || injectedPersonalMemories.length > 0;

            // For Memory view, we check if we have memory data
            const hasMemoryData = 
              hasPickedMemories || hasCandidateMemories;

            const hasInfoData =
              systemBlocks.length > 0 || injectedBlocks.length > 0;

            if (activeView === "memory" && !hasMemoryData) {
               return <p className="text-[var(--muted)]">No memory candidates recorded.</p>;
            }

            if (activeView === "info" && !hasInfoData) {
              return (
                <p className="text-[var(--muted)]">No injected blocks recorded.</p>
              );
            }

            return (
              <div className="grid gap-3">
              {/* --- INFO VIEW SECTIONS --- */}
              {activeView === "info" && (
                <>
                  {systemBlocks.map((block, index) => (
                    <div
                      key={`sys-${index}`}
                      className="rounded-2xl border border-black/10 bg-white px-3 py-2 text-[11px]"
                    >
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        {block.label}
                      </p>
                      <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--ink)]">
                        {block.content}
                      </pre>
                    </div>
                  ))}
                  {injectedBlocks.map((block, index) => (
                    <div
                      key={`ib-${index}`}
                      className="rounded-2xl border border-black/10 bg-white px-3 py-2 text-[11px]"
                    >
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        {block.label || `Block ${index + 1}`}
                      </p>
                      <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--ink)]">
                        {block.content}
                      </pre>
                    </div>
                  ))}
                </>
              )}

              {/* --- MEMORY VIEW SECTIONS --- */}
              
              {activeView === "memory" && (
                <>
                  {hasPickedMemories && (
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--green-600)] font-bold">
                        Picked for injection
                      </p>
                      {injectedMemories.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                            Main memories
                          </p>
                          <ul className="mt-2 grid gap-1">
                            {injectedMemories.map((memory, index) => (
                              <li key={`m-${index}`}>
                                -{" "}
                                {formatDate(resolveMemoryTimestamp(memory))
                                  ? `[${formatDate(resolveMemoryTimestamp(memory))}] `
                                  : ""}
                                {memory.content}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {injectedPersonalMemories.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                            Personal memories
                          </p>
                          <ul className="mt-2 grid gap-1">
                            {injectedPersonalMemories.map((memory, index) => (
                              <li key={`pm-${index}`}>
                                -{" "}
                                {formatDate(resolveMemoryTimestamp(memory))
                                  ? `[${formatDate(resolveMemoryTimestamp(memory))}] `
                                  : ""}
                                {memory.content}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  {hasCandidateMemories && (
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        Memory candidates
                      </p>
                      {candidateGroups.map(
                        (group) =>
                          group.items.length > 0 && (
                            <div key={group.key} className="mt-2">
                              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                                {group.label}
                              </p>
                              <ul className="mt-2 grid gap-1">
                                {group.items.map((memory, index) => (
                                  <li key={`${group.key}-${index}`}>
                                    -{" "}
                                    {formatDate(resolveMemoryTimestamp(memory))
                                      ? `[${formatDate(resolveMemoryTimestamp(memory))}] `
                                      : ""}
                                    {memory.content}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )
                      )}
                      {personalCandidateGroups.map(
                        (group) =>
                          group.items.length > 0 && (
                            <div key={group.key} className="mt-2">
                              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                                Personal {group.label.toLowerCase()}
                              </p>
                              <ul className="mt-2 grid gap-1">
                                {group.items.map((memory, index) => (
                                  <li key={`${group.key}-${index}`}>
                                    -{" "}
                                    {formatDate(resolveMemoryTimestamp(memory))
                                      ? `[${formatDate(resolveMemoryTimestamp(memory))}] `
                                      : ""}
                                    {memory.content}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )
                      )}
                    </div>
                  )}
                </>
              )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
