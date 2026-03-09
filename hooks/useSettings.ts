import { useState, useEffect, useMemo, useRef } from "react";
import modelsData from "@/config/models.json";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_V1,
  LEGACY_SYSTEM_PROMPT,
} from "@/lib/systemPromptDefaults";
import { withBasePath } from "@/lib/basePath";

export type ModelConfig = {
  id: string;
  name: string;
  capabilities?: string[];
};

const models = modelsData.chat_models as ModelConfig[];
const SETTINGS_STORAGE_KEY = "assistant.settings.v1";

export function useSettings() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const localSystemPromptRef = useRef<string | null>(null);
  const [systemPromptLoaded, setSystemPromptLoaded] = useState(false);
  const [personaProfile, setPersonaProfile] = useState("");
  const localPersonaProfileRef = useRef<string | null>(null);
  const [personaProfileLoaded, setPersonaProfileLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(models[0]?.id ?? "");
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [idleThinkingEnabled, setIdleThinkingEnabledState] = useState(false);
  const [idleThinkingLoaded, setIdleThinkingLoaded] = useState(false);
  const idleThinkingDirtyRef = useRef(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.systemPrompt === "string") {
          localSystemPromptRef.current = parsed.systemPrompt;
        }
        if (typeof parsed.personaProfile === "string") {
          localPersonaProfileRef.current = parsed.personaProfile;
        }
        if (typeof parsed.apiKey === "string") setApiKey(parsed.apiKey);
        if (typeof parsed.imapHost === "string") setImapHost(parsed.imapHost);
        if (typeof parsed.imapPort === "string") setImapPort(parsed.imapPort);
        if (typeof parsed.smtpHost === "string") setSmtpHost(parsed.smtpHost);
        if (typeof parsed.smtpPort === "string") setSmtpPort(parsed.smtpPort);
        if (
          typeof parsed.selectedModelId === "string" &&
          models.some((model) => model.id === parsed.selectedModelId)
        ) {
          setSelectedModelId(parsed.selectedModelId);
        }
        if (typeof parsed.reasoningEnabled === "boolean") setReasoningEnabled(parsed.reasoningEnabled);
        if (typeof parsed.webSearchEnabled === "boolean") setWebSearchEnabled(parsed.webSearchEnabled);
        if (typeof parsed.idleThinkingEnabled === "boolean") {
          setIdleThinkingEnabledState(parsed.idleThinkingEnabled);
        }
        if (
          typeof parsed.reasoningEffort === "string" &&
          ["low", "medium", "high"].includes(parsed.reasoningEffort)
        ) {
          setReasoningEffort(parsed.reasoningEffort);
        }
      } catch {
        // Ignore errors
      }
    }
    setSettingsLoaded(true);
  }, []);

  // Load system prompt from server on mount
  useEffect(() => {
    let mounted = true;
    const loadSystemPrompt = async () => {
      try {
        const response = await fetch(withBasePath("/api/system-prompt"));
        if (!response.ok) {
          throw new Error("Unable to load system prompt.");
        }
        const data = (await response.json()) as { prompt?: string };
        const prompt =
          typeof data.prompt === "string" && data.prompt.trim().length > 0
            ? data.prompt
            : DEFAULT_SYSTEM_PROMPT;
        if (!mounted) return;
        const localPrompt = localSystemPromptRef.current;
        const localTrimmed = localPrompt?.trim() ?? "";
        const isLegacyDefault =
          localTrimmed === LEGACY_SYSTEM_PROMPT ||
          localTrimmed === DEFAULT_SYSTEM_PROMPT_V1;
        const serverTrimmed = prompt.trim();
        const serverIsDefaultish =
          serverTrimmed === DEFAULT_SYSTEM_PROMPT ||
          serverTrimmed === DEFAULT_SYSTEM_PROMPT_V1;
        if (
          localPrompt &&
          localTrimmed.length > 0 &&
          !isLegacyDefault &&
          serverIsDefaultish &&
          localTrimmed !== DEFAULT_SYSTEM_PROMPT
        ) {
          setSystemPrompt(localTrimmed);
          try {
            await fetch(withBasePath("/api/system-prompt"), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: localTrimmed }),
            });
          } catch {
            // Ignore migration errors
          }
        } else if (serverTrimmed === DEFAULT_SYSTEM_PROMPT_V1) {
          setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
          try {
            await fetch(withBasePath("/api/system-prompt"), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: DEFAULT_SYSTEM_PROMPT }),
            });
          } catch {
            // Ignore migration errors
          }
        } else {
          setSystemPrompt(prompt);
        }
        setSystemPromptLoaded(true);
      } catch {
        if (!mounted) return;
        const localPrompt = localSystemPromptRef.current;
        if (localPrompt && localPrompt.trim().length > 0) {
          setSystemPrompt(localPrompt);
        }
        setSystemPromptLoaded(true);
      }
    };
    void loadSystemPrompt();
    return () => {
      mounted = false;
    };
  }, []);

  // Load persona profile from server on mount
  useEffect(() => {
    let mounted = true;
    const loadPersonaProfile = async () => {
      try {
        const response = await fetch(withBasePath("/api/persona"));
        if (!response.ok) {
          throw new Error("Unable to load persona profile.");
        }
        const data = (await response.json()) as { persona?: string };
        const persona =
          typeof data.persona === "string" && data.persona.trim().length > 0
            ? data.persona
            : "";
        if (!mounted) return;
        const localPersona = localPersonaProfileRef.current;
        if (localPersona && localPersona.trim().length > 0 && !persona) {
          setPersonaProfile(localPersona);
          try {
            await fetch(withBasePath("/api/persona"), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ persona: localPersona }),
            });
          } catch {
            // Ignore migration errors
          }
        } else {
          setPersonaProfile(persona);
        }
        setPersonaProfileLoaded(true);
      } catch {
        if (!mounted) return;
        const localPersona = localPersonaProfileRef.current;
        if (localPersona && localPersona.trim().length > 0) {
          setPersonaProfile(localPersona);
        }
        setPersonaProfileLoaded(true);
      }
    };
    void loadPersonaProfile();
    return () => {
      mounted = false;
    };
  }, []);

  // Load idle thinking toggle from server on mount
  useEffect(() => {
    let mounted = true;
    const loadIdleThinking = async () => {
      try {
        const response = await fetch(withBasePath("/api/idle-settings"));
        if (!response.ok) {
          throw new Error("Unable to load idle settings.");
        }
        const data = (await response.json()) as { enabled?: boolean };
        if (!mounted) return;
        if (typeof data.enabled === "boolean") {
          setIdleThinkingEnabledState(data.enabled);
        }
        setIdleThinkingLoaded(true);
      } catch {
        if (!mounted) return;
        setIdleThinkingLoaded(true);
      }
    };
    void loadIdleThinking();
    return () => {
      mounted = false;
    };
  }, []);

  // Save settings to localStorage on change
  useEffect(() => {
    if (!settingsLoaded) return;
    const payload = {
      systemPrompt,
      personaProfile,
      apiKey,
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
      selectedModelId,
      reasoningEnabled,
      reasoningEffort,
      webSearchEnabled,
      idleThinkingEnabled,
    };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  }, [
    systemPrompt,
    personaProfile,
    apiKey,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    selectedModelId,
    reasoningEnabled,
    reasoningEffort,
    webSearchEnabled,
    idleThinkingEnabled,
    settingsLoaded,
  ]);

  // Persist system prompt to server (debounced)
  useEffect(() => {
    if (!systemPromptLoaded) {
      return;
    }
    const timer = setTimeout(() => {
      fetch(withBasePath("/api/system-prompt"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt }),
      }).catch(() => {
        // Ignore save errors
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [systemPrompt, systemPromptLoaded]);

  // Persist persona profile to server (debounced)
  useEffect(() => {
    if (!personaProfileLoaded) {
      return;
    }
    const timer = setTimeout(() => {
      fetch(withBasePath("/api/persona"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona: personaProfile }),
      }).catch(() => {
        // Ignore save errors
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [personaProfile, personaProfileLoaded]);

  const setIdleThinkingEnabled = (value: boolean) => {
    idleThinkingDirtyRef.current = true;
    setIdleThinkingEnabledState(value);
  };

  // Persist idle thinking toggle to server (debounced)
  useEffect(() => {
    if (!idleThinkingLoaded || !idleThinkingDirtyRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      fetch(withBasePath("/api/idle-settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: idleThinkingEnabled }),
      })
        .catch(() => {
          // Ignore save errors
        })
        .finally(() => {
          idleThinkingDirtyRef.current = false;
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [idleThinkingEnabled, idleThinkingLoaded]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId),
    [selectedModelId]
  );
  const supportsReasoning = selectedModel?.capabilities?.includes("reasoning") ?? false;
  const supportsEffort = selectedModel?.capabilities?.includes("effort") ?? false;
  const supportsVision = selectedModel?.capabilities?.includes("vision") ?? false;

  // Auto-correct incompatible settings
  useEffect(() => {
    if (!supportsReasoning && reasoningEnabled) {
      setReasoningEnabled(false);
    }
    if (!supportsEffort && reasoningEffort !== "medium") {
      setReasoningEffort("medium");
    }
  }, [supportsReasoning, supportsEffort, reasoningEnabled, reasoningEffort]);

  return {
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
    supportsReasoning,
    supportsEffort,
    supportsVision,
  };
}
