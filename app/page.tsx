"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ChatInput from "@/components/ChatInput";
import ChatMessage from "@/components/ChatMessage";
import ModelSelector from "@/components/ModelSelector";
import SettingsModal from "@/components/SettingsModal";
import Sidebar from "@/components/Sidebar";
import TokenCounter from "@/components/TokenCounter";
import ToolboxStatus from "@/components/ToolboxStatus";
import { useSettings } from "@/hooks/useSettings";
import { useTools } from "@/hooks/useTools";
import { useMemoryAgent } from "@/hooks/useMemoryAgent";
import { useChat } from "@/hooks/useChat";
import { CONTEXT_LIMIT } from "@/lib/chatUtils";
import { withBasePath } from "@/lib/basePath";

const QUICK_LINKS: Array<{ href: string; label: string }> = [
  { href: "/memories", label: "Memories" },
  { href: "/scratchpad", label: "Scratchpad" },
  { href: "/ssef", label: "SSEF Console" },
  { href: "/idle-actions", label: "IDLE Actions" },
  { href: "/idle-workspace", label: "Workspace Log" },
  { href: "/idle-metrics", label: "IDLE Metrics" },
];

export default function Home() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const quickMenuRef = useRef<HTMLDivElement | null>(null);

  const {
    models,
    settingsOpen,
    setSettingsOpen,
    systemPrompt,
    setSystemPrompt,
    personaProfile,
    setPersonaProfile,
    apiKey,
    setApiKey,
    imapHost,
    setImapHost,
    imapPort,
    setImapPort,
    smtpHost,
    setSmtpHost,
    smtpPort,
    setSmtpPort,
    selectedModelId,
    setSelectedModelId,
    reasoningEnabled,
    setReasoningEnabled,
    reasoningEffort,
    setReasoningEffort,
    webSearchEnabled,
    setWebSearchEnabled,
    idleThinkingEnabled,
    setIdleThinkingEnabled,
    idleThinkingLoaded,
    supportsVision,
  } = useSettings();

  const {
    toolStatus: toolboxTools,
    toolStatusLoading,
    toolStatusError,
    fetchToolStatus,
    toolDebugEnabled,
    refreshToolDebug,
  } = useTools(webSearchEnabled);

  const {
    memoryAgentStatus,
    lastMemoryRun,
    memoryCount,
    messagesSinceMemory,
    setMessagesSinceMemory,
    personalMemoryPulse,
    incrementPulse,
    triggerMemoryAgent,
    nextTriggerIn,
    triggerInterval,
  } = useMemoryAgent(apiKey);

  const {
    messages,
    conversations,
    activeConversationId,
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
  } = useChat({
    apiKey,
    systemPrompt,
    personaProfile,
    selectedModelId,
    supportsVision,
    reasoningEnabled,
    reasoningEffort,
    webSearchEnabled,
    toolDebugEnabled,
    onRefreshToolDebug: refreshToolDebug,
    triggerMemoryAgent,
    incrementPulse,
    messagesSinceMemory,
    setMessagesSinceMemory,
    triggerInterval,
  });

  const memoryStatusLabel =
    memoryAgentStatus === "running"
      ? "Consolidating now"
      : memoryAgentStatus === "error"
        ? "Last run failed"
        : "Idle";
  const idleIndicatorLabel = idleThinkingLoaded
    ? idleThinkingEnabled
      ? "IDLE: On"
      : "IDLE: Off"
    : "IDLE: Loading";
  const idleIndicatorDotClass = idleThinkingLoaded
    ? idleThinkingEnabled
      ? "bg-[var(--green-500)]"
      : "bg-black/30"
    : "bg-black/20";
  const uiBusy = isSending || isLoadingMessages || isLoadingConversations;

  useEffect(() => {
    if (!quickMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!quickMenuRef.current) {
        return;
      }
      if (quickMenuRef.current.contains(event.target as Node)) {
        return;
      }
      setQuickMenuOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [quickMenuOpen]);

  const onNewConversationWrapper = async () => {
    await handleNewConversation();
    setMobileSidebarOpen(false);
  };

  const onSelectConversationWrapper = async (id: string) => {
    await handleSelectConversation(id);
    setMobileSidebarOpen(false);
  };

  const handleLogout = async () => {
    if (isLoggingOut) {
      return;
    }
    setQuickMenuOpen(false);
    setIsLoggingOut(true);
    try {
      await fetch(withBasePath("/api/auth/logout"), {
        method: "POST",
      });
    } catch {
      // Ignore and continue redirecting to login.
    } finally {
      window.location.href = withBasePath("/login");
    }
  };

  return (
    <div className="relative min-h-screen bg-[radial-gradient(circle_at_14%_18%,rgba(122,190,255,0.24),transparent_42%),radial-gradient(circle_at_85%_8%,rgba(96,229,210,0.24),transparent_38%),radial-gradient(circle_at_80%_90%,rgba(182,215,255,0.18),transparent_45%),linear-gradient(180deg,#edf3ff_0%,#eaf4ff_50%,#edf8ff_100%)] lg:h-screen lg:overflow-hidden">
      <div className="pointer-events-none absolute -top-28 right-[-12%] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(84,216,197,0.22),transparent_68%)] blur-2xl" />
      <div className="pointer-events-none absolute bottom-[-120px] left-[-140px] h-[320px] w-[320px] rounded-full bg-[radial-gradient(circle,rgba(108,168,255,0.28),transparent_70%)] blur-2xl" />

      <div className="relative flex min-h-screen lg:h-full">
        <Sidebar
          collapsed={sidebarCollapsed}
          onCollapseToggle={() => setSidebarCollapsed((prev) => !prev)}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={onSelectConversationWrapper}
          onNewConversation={onNewConversationWrapper}
          onDeleteConversation={handleDeleteConversation}
          disabled={uiBusy}
        />

        <main className="flex min-h-0 flex-1 flex-col gap-6 px-5 py-6 lg:px-10">
          <header className="relative z-50 flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-white/60 bg-white/50 px-4 py-3 shadow-[var(--shadow)] backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full border border-white/70 bg-white/70 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] backdrop-blur hover:border-[var(--green-400)] lg:hidden"
                onClick={() => setMobileSidebarOpen(true)}
              >
                Menu
              </button>
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-[var(--muted)]">
                  Assistant
                </p>
                <p className="text-[0.68rem] uppercase tracking-[0.2em] text-[var(--muted)]/80">
                  Conversational Core
                </p>
              </div>
            </div>

            <div ref={quickMenuRef} className="relative flex items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-[0.62rem] uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur">
                <span className={`h-2 w-2 rounded-full ${idleIndicatorDotClass}`} />
                {idleIndicatorLabel}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-[0.62rem] uppercase tracking-[0.2em] text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur transition hover:border-[var(--green-400)] hover:text-[var(--ink)]"
                onClick={() => setQuickMenuOpen((prev) => !prev)}
                aria-expanded={quickMenuOpen}
                aria-label="Toggle quick menu"
              >
                Quick Menu
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${quickMenuOpen ? "rotate-180" : ""}`}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {quickMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+0.7rem)] z-[120] w-64 rounded-2xl border border-white/70 bg-[linear-gradient(160deg,rgba(255,255,255,0.92),rgba(239,248,255,0.88))] p-2 shadow-[0_24px_50px_rgba(35,66,112,0.2)] backdrop-blur-xl">
                  <div className="flex flex-col gap-1">
                    {QUICK_LINKS.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="rounded-xl px-3 py-2 text-xs uppercase tracking-[0.17em] text-[var(--muted)] transition hover:bg-white/80 hover:text-[var(--ink)]"
                        onClick={() => setQuickMenuOpen(false)}
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                  <div className="my-2 border-t border-black/10" />
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      className="rounded-xl px-3 py-2 text-left text-xs uppercase tracking-[0.17em] text-[var(--muted)] transition hover:bg-white/80 hover:text-[var(--ink)]"
                      onClick={() => {
                        setQuickMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                    >
                      Settings
                    </button>
                    <button
                      type="button"
                      className="rounded-xl px-3 py-2 text-left text-xs uppercase tracking-[0.17em] text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={handleLogout}
                      disabled={isLoggingOut}
                    >
                      {isLoggingOut ? "Logging out" : "Logout"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </header>

          <section className="relative z-10 grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-h-0 flex-col gap-6 rounded-[32px] border border-white/65 bg-[linear-gradient(160deg,rgba(255,255,255,0.78),rgba(237,247,255,0.7))] p-6 shadow-[var(--shadow)] backdrop-blur-xl animate-rise">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                    Current thread
                  </p>
                  <h2 className="font-display text-xl text-[var(--ink)]">
                    {activeConversation?.title ?? "New conversation"}
                  </h2>
                </div>
                <button
                  type="button"
                  className="rounded-full border border-white/80 bg-white/70 px-4 py-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)] hover:border-[var(--green-400)] hover:text-[var(--ink)]"
                >
                  Export
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
                {isLoadingMessages && (
                  <div className="rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-sm text-[var(--muted)]">
                    Loading conversation...
                  </div>
                )}
                {!isLoadingMessages && messages.length === 0 && (
                  <div className="rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-sm text-[var(--muted)]">
                    Start a new conversation to see messages here.
                  </div>
                )}
                {messages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    role={message.role}
                    content={message.content}
                    attachments={message.attachments}
                    timestamp={message.timestamp}
                    isStreaming={message.isStreaming}
                    injectionId={message.injectionId ?? undefined}
                    className="animate-rise"
                    style={{ animationDelay: `${index * 60}ms` }}
                  />
                ))}
              </div>

              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
              {conversationError && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {conversationError}
                </div>
              )}

              <ChatInput
                value={inputValue}
                onChange={setInputValue}
                onSend={handleSend}
                attachments={attachments}
                onAddAttachments={addAttachments}
                onRemoveAttachment={removeAttachment}
                supportsVision={supportsVision}
                disabled={uiBusy}
              />
            </div>

            <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pr-2">
              <TokenCounter used={estimatedTokens} limit={CONTEXT_LIMIT} />

              <ModelSelector
                models={models}
                value={selectedModelId}
                onChange={setSelectedModelId}
                reasoningEnabled={reasoningEnabled}
                onReasoningChange={setReasoningEnabled}
                effort={reasoningEffort}
                onEffortChange={setReasoningEffort}
              />

              <ToolboxStatus
                tools={toolboxTools}
                loading={toolStatusLoading}
                error={toolStatusError}
                onRefresh={fetchToolStatus}
              />

              <div className="relative flex flex-col gap-4 rounded-2xl border border-white/65 bg-[linear-gradient(165deg,rgba(255,255,255,0.83),rgba(236,248,255,0.75))] p-4 shadow-[var(--shadow)] backdrop-blur-xl">
                {personalMemoryPulse > 0 && (
                  <div
                    key={personalMemoryPulse}
                    className="pointer-events-none absolute right-4 top-4"
                  >
                    <div className="personal-memory-pulse" />
                  </div>
                )}
                <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                  Memory loop
                </p>
                <div className="rounded-2xl border border-dashed border-black/15 bg-white/40 p-4 text-sm text-[var(--muted)]">
                  <p className="text-[var(--ink)]">
                    Next consolidation in {nextTriggerIn}{" "}
                    {nextTriggerIn === 1 ? "message" : "messages"}.
                  </p>
                  <p className="mt-2">
                    Memories stored in ChromaDB: {memoryCount ?? "N/A"}.
                  </p>
                  <p className="mt-2">Status: {memoryStatusLabel}.</p>
                  {lastMemoryRun && <p className="mt-2">Last run at {lastMemoryRun}.</p>}
                </div>
                <div className="rounded-2xl border border-black/10 bg-[rgba(20,159,147,0.12)] p-4 text-sm text-[var(--muted)]">
                  <p className="text-[var(--ink)]">Manual control</p>
                  <p className="mb-3 mt-1 text-xs opacity-80">
                    Force a memory update immediately.
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      setMessagesSinceMemory(0);
                      await triggerMemoryAgent(messages, activeConversationId);
                    }}
                    disabled={memoryAgentStatus === "running" || messages.length === 0}
                    className="w-full rounded-xl border border-[var(--green-500)] bg-[var(--green-500)] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white shadow-sm transition hover:bg-[var(--green-600)] hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Consolidate now
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        systemPrompt={systemPrompt}
        onSystemPromptChange={setSystemPrompt}
        personaProfile={personaProfile}
        onPersonaProfileChange={setPersonaProfile}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        imapHost={imapHost}
        onImapHostChange={setImapHost}
        imapPort={imapPort}
        onImapPortChange={setImapPort}
        smtpHost={smtpHost}
        onSmtpHostChange={setSmtpHost}
        smtpPort={smtpPort}
        onSmtpPortChange={setSmtpPort}
        webSearchEnabled={webSearchEnabled}
        onWebSearchEnabledChange={setWebSearchEnabled}
        idleThinkingEnabled={idleThinkingEnabled}
        onIdleThinkingEnabledChange={setIdleThinkingEnabled}
      />
    </div>
  );
}
