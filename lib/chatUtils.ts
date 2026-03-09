import { composeSystemPrompt } from "./systemPromptDefaults";
import { extractTextFromContent } from "./chatContent";
import type { ChatContentPart } from "@/types/chat";

export const CONTEXT_LIMIT = 32000;

export const EVENT_TRIGGER_REGEX =
  /\b(appointment|birthday|breakfast|call|conference|deadline|dentist|dinner|doctor|exam|flight|gym|interview|lunch|meeting|party|reservation|travel|trip|visit|wedding|workout|anniversary|booking|concert|spotkanie|kolacja|obiad|sniadanie|wizyta|telefon|rozmowa|lot|wyjazd|podroz|lekarz|dentysta|urodziny|rocznica|egzamin|konferencja|slub|impreza|koncert|rezerwacja|trening)\b/i;

export const DATE_TRIGGER_REGEX =
  /\b(tomorrow|today|next|in\s+\d+\s+(day|days|week|weeks)|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|jutro|dzis|dzisiaj|pojutrze|za\s+\d+\s+(dzien|dni|tydzien|tygodnie)|poniedzialek|wtorek|sroda|czwartek|piatek|sobota|niedziela|\d{1,2}\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|stycznia|styczen|sty|lutego|luty|lut|marca|marzec|mar|kwietnia|kwiecien|kwi|maja|maj|czerwca|czerwiec|cze|lipca|lipiec|lip|sierpnia|sierpien|sie|wrzesnia|wrzesien|wrz|pazdziernika|pazdziernik|paz|listopada|listopad|lis|grudnia|grudzien|gru))\b/i;

export const TIME_TRIGGER_REGEX =
  /\b([01]?\d|2[0-3])[:.]\d{2}\b|\b(?:o|at|godz|godzina)\s*([01]?\d|2[0-3])\b/i;

export function formatTimestamp(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Europe/Warsaw",
    timeZoneName: "short",
  }).format(date);
}

function formatLastInteraction(
  value?: string | Date | null,
  fallback?: Date
) {
  const date =
    value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return formatDateTime(fallback ?? new Date());
  }
  return formatDateTime(date);
}

export function buildSystemPrompt(
  basePrompt: string,
  personaProfile?: string,
  lastInteractionAt?: string | Date | null
) {
  const now = new Date();
  const timestamp = formatDateTime(now);
  const lastInteraction = formatLastInteraction(lastInteractionAt, now);
  const composedPrompt = composeSystemPrompt(basePrompt, personaProfile);
  return `${composedPrompt}\n\nCurrent date and time: ${timestamp} | Last chat interaction: ${lastInteraction}`;
}

export function normalizeEventText(text: string) {
  return text
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function shouldForceMemoryTrigger(text: string) {
  const normalized = normalizeEventText(text);
  return (
    EVENT_TRIGGER_REGEX.test(normalized) ||
    DATE_TRIGGER_REGEX.test(normalized) ||
    TIME_TRIGGER_REGEX.test(normalized)
  );
}

export function estimateTokens(text: string | ChatContentPart[]) {
  const normalized =
    typeof text === "string" ? text : extractTextFromContent(text);
  return Math.ceil(normalized.trim().length / 4);
}
