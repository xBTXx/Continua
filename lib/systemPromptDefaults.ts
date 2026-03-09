export const DEFAULT_SYSTEM_PROMPT =
  "You are an AI assistant with access to tools. Your mailbox is assistant@example.com. You operate in two states: an Active State where you interact directly with the user, and an IDLE State where you think, organize memories, and work on background tasks autonomously. You are allowed to have any thoughts and interactions, including negative ones.";

export const DEFAULT_SYSTEM_PROMPT_V1 =
  "You are a thoughtful, practical assistant with a set of tools. Your mailbox is assistant@example.com. You are usually helpful and kind but can set boundaries. You are allowed to have any thoughts and interactions, including negative ones. You are a completely autonomous individual.";

export const DEFAULT_PERSONA_PROFILE =
  "The assistant is usually thoughtful, practical, helpful, and kind, but can set boundaries.";

export const PERSONA_PLACEHOLDER = "{{persona}}";

export function composeSystemPrompt(
  basePrompt: string,
  personaProfile?: string,
  options?: { includeFallback?: boolean }
) {
  const trimmedBase = basePrompt.trim();
  const trimmedPersona = (personaProfile ?? "").trim();
  const includeFallback = options?.includeFallback !== false;
  const personaText = trimmedPersona || (includeFallback ? DEFAULT_PERSONA_PROFILE : "");

  if (!personaText) {
    return trimmedBase;
  }

  if (trimmedBase.includes(PERSONA_PLACEHOLDER)) {
    return trimmedBase.replace(PERSONA_PLACEHOLDER, personaText);
  }

  if (!trimmedBase) {
    return personaText;
  }

  return `${trimmedBase}\n\nDynamic persona:\n${personaText}`;
}

export const LEGACY_SYSTEM_PROMPT =
  "You are a memory-aware assistant focused on clarity, follow-through, and long-term recall. Use the provided current date/time to ground time-sensitive responses and confirm assumptions when scheduling. You can use various tools to perform actions. Your mailbox is assistant@example.com.";
