import { useState, useRef, useEffect } from "react";
import modelsData from "@/config/models.json";
import { withBasePath } from "@/lib/basePath";

const memoryAgentConfig = modelsData.memory_agent;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "memory" | "system";
  content: string;
}

export function useMemoryAgent(apiKey: string) {
  const [memoryAgentStatus, setMemoryAgentStatus] = useState<
    "idle" | "running" | "error"
  >("idle");
  const [lastMemoryRun, setLastMemoryRun] = useState<string | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [messagesSinceMemory, setMessagesSinceMemory] = useState(0);
  const [personalMemoryPulse, setPersonalMemoryPulse] = useState(0);
  const memoryAgentInFlight = useRef(false);

  const triggerInterval = memoryAgentConfig?.trigger_interval ?? 5;
  const nextTriggerIn = triggerInterval - messagesSinceMemory;

  const fetchMemoryCount = async () => {
    try {
      const response = await fetch(withBasePath("/api/memory/count"));
      if (!response.ok) return;
      const data = (await response.json()) as { count?: number };
      if (typeof data.count === "number") {
        setMemoryCount(data.count);
      }
    } catch {
      // Ignore errors
    }
  };

  useEffect(() => {
    void fetchMemoryCount();
  }, []);

  const triggerMemoryAgent = async (
    historyForMemory: ChatMessage[],
    conversationId?: string | null
  ) => {
    if (memoryAgentInFlight.current) {
      console.log("[MemoryAgent] Already in flight, skipping.");
      return;
    }

    if (historyForMemory.length === 0) {
      console.log("[MemoryAgent] No messages to consolidate.");
      return;
    }

    memoryAgentInFlight.current = true;
    setMemoryAgentStatus("running");

    try {
      const response = await fetch(withBasePath("/api/memory"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: historyForMemory.map((msg) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
          })),
          conversationId: conversationId ?? undefined,
          apiKey: apiKey || undefined,
          appUrl: typeof window !== "undefined" ? window.location.origin : undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || "Memory consolidation failed.");
      }

      const result = await response.json() as {
        status: string;
        stored?: number;
        candidates?: number;
        newMemories?: string[];
      };

      console.log("[MemoryAgent] Consolidation complete:", result);
      setMemoryAgentStatus("idle");
      setLastMemoryRun(new Date().toLocaleTimeString());

      // Refresh memory count after successful consolidation
      void fetchMemoryCount();
    } catch (error) {
      console.error("[MemoryAgent] Consolidation error:", error);
      setMemoryAgentStatus("error");
    } finally {
      memoryAgentInFlight.current = false;
    }
  };

  const incrementPulse = () => setPersonalMemoryPulse((prev) => prev + 1);

  return {
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
    fetchMemoryCount,
  };
}
