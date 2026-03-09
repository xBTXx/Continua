import { ensureSchema, query } from "./db";
import { ToolDefinition } from "./openrouter";

const WARSAW_TIMEZONE = "Europe/Warsaw";
const CALENDAR_TRIGGER_LOCK_MINUTES = 5;
const CALENDAR_REMINDER_COOLDOWN_MINUTES = 30;

export type CalendarRecurrenceFrequency = "daily" | "weekly";

export type CalendarRecurrence = {
  frequency: CalendarRecurrenceFrequency;
  time?: string | null;
  weekday?: string | null;
  timezone: string;
};

type CalendarEventRow = {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  description: string | null;
  all_day: boolean;
  recurrence: unknown;
  next_trigger_at: string | null;
  last_triggered_at: string | null;
  last_reminded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  description: string | null;
  allDay: boolean;
  recurrence: CalendarRecurrence | null;
  nextTriggerAt: string | null;
  lastTriggeredAt: string | null;
  lastRemindedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RecurrenceParseResult = {
  explicit: boolean;
  value: CalendarRecurrence | null;
  error?: string;
};

const WEEKDAY_ALIASES: Record<string, string> = {
  sunday: "sunday",
  sun: "sunday",
  niedziela: "sunday",
  monday: "monday",
  mon: "monday",
  poniedzialek: "monday",
  tuesday: "tuesday",
  tue: "tuesday",
  tues: "tuesday",
  wtorek: "tuesday",
  wednesday: "wednesday",
  wed: "wednesday",
  sroda: "wednesday",
  thursday: "thursday",
  thu: "thursday",
  thurs: "thursday",
  czwartek: "thursday",
  friday: "friday",
  fri: "friday",
  piatek: "friday",
  saturday: "saturday",
  sat: "saturday",
  sobota: "saturday",
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export const CALENDAR_TOOL_NAMES = [
  "add_calendar_event",
  "list_calendar_events",
  "update_calendar_event",
  "delete_calendar_event",
] as const;

export function calendarToolsEnabled() {
  return true;
}

function normalizeWeekday(value?: string | null) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return WEEKDAY_ALIASES[normalized] ?? null;
}

function normalizeFrequency(value?: string | null): CalendarRecurrenceFrequency | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "daily" || normalized === "day") {
    return "daily";
  }
  if (normalized === "weekly" || normalized === "week") {
    return "weekly";
  }
  return null;
}

function parseTimeOfDay(value?: string | null) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function formatTimeOfDay(hour: number, minute: number) {
  const hh = `${hour}`.padStart(2, "0");
  const mm = `${minute}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

function hasExplicitTimezone(value: string) {
  return /z$/i.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function getTimeZoneOffset(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return asUtc - date.getTime();
}

function buildDateInTimeZone(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second?: number;
  },
  timeZone: string
) {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0
  );
  const offset = getTimeZoneOffset(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  const weekday = normalizeWeekday(values.weekday) ?? "sunday";
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday,
    weekdayIndex: WEEKDAY_INDEX[weekday] ?? 0,
  };
}

function parseDateInput(value: string | Date) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (hasExplicitTimezone(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      trimmed
    );
  if (!match) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] ? Number(match[4]) : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  const second = match[6] ? Number(match[6]) : 0;
  return buildDateInTimeZone(
    { year, month, day, hour, minute, second },
    WARSAW_TIMEZONE
  );
}

function parseRecurrenceInput(args: Record<string, unknown>): RecurrenceParseResult {
  const hasRecurrenceInput =
    "recurrence" in args ||
    "recurrence_frequency" in args ||
    "recurrence_time" in args ||
    "recurrence_weekday" in args;
  if (!hasRecurrenceInput) {
    return { explicit: false, value: null };
  }

  const raw = args.recurrence;
  if (raw === null) {
    return { explicit: true, value: null };
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["none", "off", "disable", "disabled", "no"].includes(normalized)) {
      return { explicit: true, value: null };
    }
  }

  let frequency: CalendarRecurrenceFrequency | null = null;
  let time: string | null = null;
  let weekday: string | null = null;

  const tokens: string[] = [];
  if (typeof raw === "string") {
    tokens.push(raw);
  } else if (Array.isArray(raw)) {
    tokens.push(...raw.filter((entry): entry is string => typeof entry === "string"));
  }

  for (const token of tokens) {
    if (!frequency) {
      frequency = normalizeFrequency(token);
      if (frequency) {
        continue;
      }
    }
    if (!time) {
      const parsedTime = parseTimeOfDay(token);
      if (parsedTime) {
        time = formatTimeOfDay(parsedTime.hour, parsedTime.minute);
        continue;
      }
    }
    if (!weekday) {
      weekday = normalizeWeekday(token);
    }
  }

  let frequencyRaw: string | null = null;
  let timeRaw: string | null = null;
  let weekdayRaw: string | null = null;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.frequency === "string") {
      frequencyRaw = record.frequency;
    } else if (typeof record.recurrence === "string") {
      frequencyRaw = record.recurrence;
    } else if (typeof record.repeat === "string") {
      frequencyRaw = record.repeat;
    }
    if (typeof record.time === "string") {
      timeRaw = record.time;
    } else if (typeof record.at === "string") {
      timeRaw = record.at;
    } else if (typeof record.hour === "string") {
      timeRaw = record.hour;
    }
    if (typeof record.weekday === "string") {
      weekdayRaw = record.weekday;
    } else if (typeof record.day === "string") {
      weekdayRaw = record.day;
    }
  }

  if (typeof args.recurrence_frequency === "string") {
    frequencyRaw ??= args.recurrence_frequency;
  }
  if (typeof args.recurrence_time === "string") {
    timeRaw ??= args.recurrence_time;
  }
  if (typeof args.recurrence_weekday === "string") {
    weekdayRaw ??= args.recurrence_weekday;
  }

  if (frequencyRaw) {
    const parsedFrequency = normalizeFrequency(frequencyRaw);
    if (!parsedFrequency) {
      return {
        explicit: true,
        value: null,
        error: "recurrence_frequency must be 'daily' or 'weekly'.",
      };
    }
    frequency = parsedFrequency;
  }

  if (timeRaw) {
    const parsedTime = parseTimeOfDay(timeRaw);
    if (!parsedTime) {
      return {
        explicit: true,
        value: null,
        error: "recurrence_time must be in HH:MM (24h) format.",
      };
    }
    time = formatTimeOfDay(parsedTime.hour, parsedTime.minute);
  }

  if (weekdayRaw) {
    const parsedWeekday = normalizeWeekday(weekdayRaw);
    if (!parsedWeekday) {
      return {
        explicit: true,
        value: null,
        error: "recurrence_weekday must be a weekday name (e.g., monday).",
      };
    }
    weekday = parsedWeekday;
  }

  if (!frequency) {
    return {
      explicit: true,
      value: null,
      error: "recurrence_frequency must be provided ('daily' or 'weekly').",
    };
  }

  return {
    explicit: true,
    value: {
      frequency,
      time,
      weekday,
      timezone: WARSAW_TIMEZONE,
    },
  };
}

function resolveRecurrence(
  recurrence: CalendarRecurrence,
  startTime: Date | null,
  now: Date
) {
  let time = recurrence.time ?? null;
  let weekday = recurrence.weekday ?? null;

  if (!time && startTime) {
    const parts = getZonedParts(startTime, WARSAW_TIMEZONE);
    time = formatTimeOfDay(parts.hour, parts.minute);
  }
  if (!time) {
    return null;
  }

  if (recurrence.frequency === "weekly") {
    if (!weekday && startTime) {
      const parts = getZonedParts(startTime, WARSAW_TIMEZONE);
      weekday = parts.weekday;
    }
    if (!weekday) {
      const parts = getZonedParts(now, WARSAW_TIMEZONE);
      weekday = parts.weekday;
    }
  } else {
    weekday = null;
  }

  return {
    frequency: recurrence.frequency,
    time,
    weekday,
    timezone: WARSAW_TIMEZONE,
  } satisfies CalendarRecurrence;
}

function computeNextTriggerAt(recurrence: CalendarRecurrence, now: Date) {
  if (!recurrence.time) {
    return null;
  }
  const timeParts = parseTimeOfDay(recurrence.time);
  if (!timeParts) {
    return null;
  }
  const nowParts = getZonedParts(now, WARSAW_TIMEZONE);
  const candidateToday = buildDateInTimeZone(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: timeParts.hour,
      minute: timeParts.minute,
      second: 0,
    },
    WARSAW_TIMEZONE
  );
  const candidatePassed = now.getTime() >= candidateToday.getTime();

  let dayOffset = 0;
  if (recurrence.frequency === "daily") {
    dayOffset = candidatePassed ? 1 : 0;
  } else {
    const targetWeekday = normalizeWeekday(recurrence.weekday) ?? nowParts.weekday;
    const targetIndex = WEEKDAY_INDEX[targetWeekday] ?? nowParts.weekdayIndex;
    let delta = (targetIndex - nowParts.weekdayIndex + 7) % 7;
    if (delta === 0 && candidatePassed) {
      delta = 7;
    }
    dayOffset = delta;
  }

  return buildDateInTimeZone(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day + dayOffset,
      hour: timeParts.hour,
      minute: timeParts.minute,
      second: 0,
    },
    WARSAW_TIMEZONE
  );
}

function parseRecurrenceRecord(raw: unknown): CalendarRecurrence | null {
  if (!raw) {
    return null;
  }
  const record =
    typeof raw === "string"
      ? ((): Record<string, unknown> | null => {
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : (raw as Record<string, unknown>);
  if (!record) {
    return null;
  }
  const frequency =
    normalizeFrequency(
      typeof record.frequency === "string" ? record.frequency : null
    ) ?? null;
  if (!frequency) {
    return null;
  }
  const time = typeof record.time === "string" ? record.time : null;
  const weekday =
    typeof record.weekday === "string" ? normalizeWeekday(record.weekday) : null;
  const timezone =
    typeof record.timezone === "string" ? record.timezone : WARSAW_TIMEZONE;

  return {
    frequency,
    time,
    weekday,
    timezone,
  };
}

function mapCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    startTime: row.start_time,
    endTime: row.end_time,
    description: row.description,
    allDay: row.all_day,
    recurrence: parseRecurrenceRecord(row.recurrence),
    nextTriggerAt: row.next_trigger_at,
    lastTriggeredAt: row.last_triggered_at,
    lastRemindedAt: row.last_reminded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getNextCalendarTriggerAt(
  event: CalendarEvent,
  referenceTime = new Date()
) {
  if (!event.recurrence) {
    return null;
  }
  const startTimeDate = parseDateInput(event.startTime);
  const resolved = resolveRecurrence(event.recurrence, startTimeDate, referenceTime);
  if (!resolved) {
    return null;
  }
  return computeNextTriggerAt(resolved, referenceTime);
}

async function addCalendarEvent(args: Record<string, unknown>) {
  await ensureSchema();
  const title = String(args.title || "").trim();
  const startTimeRaw =
    typeof args.start_time === "string" ? args.start_time.trim() : "";
  const endTimeRaw =
    typeof args.end_time === "string" ? args.end_time.trim() : "";
  const description =
    typeof args.description === "string" ? args.description.trim() : null;
  const allDay =
    typeof args.all_day === "boolean"
      ? args.all_day
      : typeof args.all_day === "string"
        ? ["true", "1", "yes", "y"].includes(args.all_day.trim().toLowerCase())
        : false;

  if (!title) {
    return { error: "Title is required." };
  }

  const recurrenceResult = parseRecurrenceInput(args);
  if (recurrenceResult.error) {
    return { error: recurrenceResult.error };
  }

  const startTimeDate = startTimeRaw ? parseDateInput(startTimeRaw) : null;
  if (recurrenceResult.value && startTimeRaw && !startTimeDate) {
    return { error: "start_time must be ISO 8601 when using recurrence." };
  }

  const endTimeDate = endTimeRaw ? parseDateInput(endTimeRaw) : null;
  const endTimeValue = endTimeRaw
    ? endTimeDate
      ? endTimeDate.toISOString()
      : endTimeRaw
    : null;

  const now = new Date();
  let resolvedRecurrence: CalendarRecurrence | null = null;
  if (recurrenceResult.value) {
    resolvedRecurrence = resolveRecurrence(
      recurrenceResult.value,
      startTimeDate,
      now
    );
    if (!resolvedRecurrence) {
      return { error: "recurrence_time is required (HH:MM)." };
    }
  }

  let startTimeValue = startTimeDate
    ? startTimeDate.toISOString()
    : startTimeRaw;
  let nextTriggerAtValue: string | null = null;

  if (resolvedRecurrence) {
    const nextTriggerAt =
      startTimeDate && startTimeDate > now
        ? startTimeDate
        : computeNextTriggerAt(resolvedRecurrence, now);
    if (!nextTriggerAt) {
      return { error: "Failed to compute next recurrence time." };
    }
    nextTriggerAtValue = nextTriggerAt.toISOString();
    if (!startTimeValue) {
      startTimeValue = nextTriggerAtValue;
    }
  } else if (startTimeValue) {
    nextTriggerAtValue = startTimeValue;
  }

  if (!startTimeValue) {
    return { error: "start_time is required." };
  }

  const id = crypto.randomUUID();

  try {
    await query(
      `INSERT INTO calendar_events (
         id, title, start_time, end_time, description, all_day,
         recurrence, next_trigger_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        title,
        startTimeValue,
        endTimeValue,
        description,
        allDay,
        resolvedRecurrence ? JSON.stringify(resolvedRecurrence) : null,
        nextTriggerAtValue,
      ]
    );
    return { success: true, id, message: "Event created successfully." };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to create event.",
    };
  }
}

async function listCalendarEvents(args: Record<string, unknown>) {
  await ensureSchema();
  const now = new Date();
  const startDate = args.start_date ? String(args.start_date) : now.toISOString();
  const endDate = args.end_date ? String(args.end_date) : null; // Optional end date
  const limit = typeof args.limit === "number" ? args.limit : 20;

  try {
    let sql = `
      SELECT id,
             title,
             start_time,
             end_time,
             description,
             all_day,
             recurrence,
             next_trigger_at,
             last_triggered_at,
             last_reminded_at,
             created_at,
             updated_at
      FROM calendar_events
      WHERE COALESCE(next_trigger_at, start_time) >= $1
        AND (next_trigger_at IS NOT NULL OR last_triggered_at IS NULL)
    `;
    const params: unknown[] = [startDate];

    if (endDate) {
      sql += ` AND COALESCE(next_trigger_at, start_time) <= $2`;
      params.push(endDate);
    }

    sql += ` ORDER BY COALESCE(next_trigger_at, start_time) ASC LIMIT $${
      params.length + 1
    }`;
    params.push(limit);

    const result = await query<CalendarEventRow>(sql, params);
    return result.rows.map(mapCalendarEvent);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to list events." };
  }
}

async function updateCalendarEvent(args: Record<string, unknown>) {
  await ensureSchema();
  const id = String(args.event_id || "").trim();
  if (!id) {
    return { error: "event_id is required." };
  }

  const recurrenceResult = parseRecurrenceInput(args);
  if (recurrenceResult.error) {
    return { error: recurrenceResult.error };
  }

  const updates: string[] = [];
  const params: unknown[] = [id];
  let paramIdx = 2;

  if (args.title) {
    updates.push(`title = $${paramIdx++}`);
    params.push(args.title);
  }

  let startTimeValue: string | null = null;
  let startTimeDate: Date | null = null;
  if (args.start_time !== undefined) {
    const raw =
      typeof args.start_time === "string" ? args.start_time.trim() : "";
    if (!raw) {
      return { error: "start_time cannot be empty." };
    }
    startTimeDate = parseDateInput(raw);
    if (recurrenceResult.value && raw && !startTimeDate) {
      return { error: "start_time must be ISO 8601 when using recurrence." };
    }
    startTimeValue = startTimeDate ? startTimeDate.toISOString() : raw;
    updates.push(`start_time = $${paramIdx++}`);
    params.push(startTimeValue);
  }

  if (args.end_time !== undefined) {
    const raw =
      typeof args.end_time === "string" ? args.end_time.trim() : "";
    const parsed = raw ? parseDateInput(raw) : null;
    const endTimeValue = raw ? (parsed ? parsed.toISOString() : raw) : null;
    updates.push(`end_time = $${paramIdx++}`);
    params.push(endTimeValue);
  }

  if (args.description !== undefined) {
    updates.push(`description = $${paramIdx++}`);
    params.push(args.description);
  }
  if (args.all_day !== undefined) {
    const parsed =
      typeof args.all_day === "boolean"
        ? args.all_day
        : typeof args.all_day === "string"
          ? ["true", "1", "yes", "y"].includes(
              args.all_day.trim().toLowerCase()
            )
          : false;
    updates.push(`all_day = $${paramIdx++}`);
    params.push(parsed);
  }

  const scheduleNeedsUpdate =
    args.start_time !== undefined || recurrenceResult.explicit;
  if (scheduleNeedsUpdate) {
    const currentResult = await query<CalendarEventRow>(
      `
        SELECT id,
               title,
               start_time,
               end_time,
               description,
               all_day,
               recurrence,
               next_trigger_at,
               last_triggered_at,
               last_reminded_at,
               created_at,
               updated_at
        FROM calendar_events
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );
    const currentRow = currentResult.rows[0];
    if (!currentRow) {
      return { error: "Event not found." };
    }
    const current = mapCalendarEvent(currentRow);
    const now = new Date();

    const baseStartTime = startTimeValue ?? current.startTime;
    const baseStartDate =
      startTimeDate ?? (baseStartTime ? parseDateInput(baseStartTime) : null);

    const baseRecurrence = recurrenceResult.explicit
      ? recurrenceResult.value
      : current.recurrence;
    let resolvedRecurrence: CalendarRecurrence | null = null;
    if (baseRecurrence) {
      resolvedRecurrence = resolveRecurrence(baseRecurrence, baseStartDate, now);
      if (!resolvedRecurrence) {
        return { error: "recurrence_time is required (HH:MM)." };
      }
    }

    let nextTriggerAtValue: string | null = null;
    if (resolvedRecurrence) {
      const nextTriggerAt =
        baseStartDate && baseStartDate > now
          ? baseStartDate
          : computeNextTriggerAt(resolvedRecurrence, now);
      if (!nextTriggerAt) {
        return { error: "Failed to compute next recurrence time." };
      }
      nextTriggerAtValue = nextTriggerAt.toISOString();
    } else if (baseStartTime) {
      nextTriggerAtValue = baseStartDate
        ? baseStartDate.toISOString()
        : baseStartTime;
    }

    updates.push(`next_trigger_at = $${paramIdx++}`);
    params.push(nextTriggerAtValue);

    if (recurrenceResult.explicit) {
      updates.push(`recurrence = $${paramIdx++}`);
      params.push(
        resolvedRecurrence ? JSON.stringify(resolvedRecurrence) : null
      );
    }
  }

  if (updates.length === 0) {
    return { error: "No fields to update." };
  }

  updates.push(`updated_at = NOW()`);

  try {
    const sql = `UPDATE calendar_events SET ${updates.join(", ")} WHERE id = $1 RETURNING *`;
    const result = await query<CalendarEventRow>(sql, params);
    if (result.rowCount === 0) {
      return { error: "Event not found." };
    }
    return { success: true, event: mapCalendarEvent(result.rows[0]) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update event." };
  }
}

async function deleteCalendarEvent(args: Record<string, unknown>) {
  await ensureSchema();
  const id = String(args.event_id || "");
  if (!id) {
    return { error: "event_id is required." };
  }

  try {
    const result = await query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return { error: "Event not found." };
    }
    return { success: true, message: "Event deleted." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to delete event." };
  }
}

function normalizeTimestampInput(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = parseDateInput(value);
  return parsed ? parsed.toISOString() : value;
}

export async function listDueCalendarEvents(limit = 1): Promise<CalendarEvent[]> {
  await ensureSchema();
  const result = await query<CalendarEventRow>(
    `
      SELECT id,
             title,
             start_time,
             end_time,
             description,
             all_day,
             recurrence,
             next_trigger_at,
             last_triggered_at,
             last_reminded_at,
             created_at,
             updated_at
      FROM calendar_events
      WHERE (
          (next_trigger_at IS NOT NULL AND next_trigger_at <= NOW())
          OR (next_trigger_at IS NULL AND last_triggered_at IS NULL AND start_time <= NOW())
        )
        AND (
          last_triggered_at IS NULL
          OR last_triggered_at <= NOW() - ($2 * INTERVAL '1 minute')
        )
      ORDER BY COALESCE(next_trigger_at, start_time) ASC
      LIMIT $1
    `,
    [limit, CALENDAR_TRIGGER_LOCK_MINUTES]
  );
  return result.rows.map(mapCalendarEvent);
}

export async function listCalendarEventReminders(
  limit = 3
): Promise<CalendarEvent[]> {
  await ensureSchema();
  const result = await query<CalendarEventRow>(
    `
      SELECT id,
             title,
             start_time,
             end_time,
             description,
             all_day,
             recurrence,
             next_trigger_at,
             last_triggered_at,
             last_reminded_at,
             created_at,
             updated_at
      FROM calendar_events
      WHERE (
          (next_trigger_at IS NOT NULL AND next_trigger_at <= NOW())
          OR (next_trigger_at IS NULL AND last_triggered_at IS NULL AND start_time <= NOW())
        )
        AND (
          last_triggered_at IS NULL
          OR last_triggered_at <= NOW() - ($2 * INTERVAL '1 minute')
        )
        AND (
          last_reminded_at IS NULL
          OR last_reminded_at <= NOW() - ($3 * INTERVAL '1 minute')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM idle_workspace_sessions
          WHERE idle_workspace_sessions.seed_id = ('calendar:' || calendar_events.id)
            AND idle_workspace_sessions.created_at >= COALESCE(calendar_events.next_trigger_at, calendar_events.start_time)
        )
      ORDER BY COALESCE(next_trigger_at, start_time) ASC
      LIMIT $1
    `,
    [limit, CALENDAR_TRIGGER_LOCK_MINUTES, CALENDAR_REMINDER_COOLDOWN_MINUTES]
  );
  return result.rows.map(mapCalendarEvent);
}

export async function markCalendarEventTriggered({
  eventId,
  triggeredAt,
  nextTriggerAt,
}: {
  eventId: string;
  triggeredAt?: Date;
  nextTriggerAt?: Date | string | null;
}) {
  await ensureSchema();
  const timestamp = triggeredAt ?? new Date();
  const updates: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [eventId];
  let paramIdx = 2;

  updates.push(`last_triggered_at = $${paramIdx++}`);
  params.push(timestamp.toISOString());

  if (nextTriggerAt !== undefined) {
    updates.push(`next_trigger_at = $${paramIdx++}`);
    params.push(normalizeTimestampInput(nextTriggerAt));
  }

  await query(
    `UPDATE calendar_events SET ${updates.join(", ")} WHERE id = $1`,
    params
  );
}

export async function markCalendarEventsReminded(eventIds: string[]) {
  if (eventIds.length === 0) {
    return;
  }
  await ensureSchema();
  await query(
    `UPDATE calendar_events
     SET last_reminded_at = NOW(),
         updated_at = NOW()
     WHERE id = ANY($1)`,
    [eventIds]
  );
}

export function getCalendarToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "add_calendar_event",
        description: "Schedule a new event in the calendar.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the event." },
            start_time: {
              type: "string",
              description:
                "ISO 8601 start time (Europe/Warsaw if no timezone provided). Optional if recurrence is provided.",
            },
            end_time: { type: "string", description: "ISO 8601 end time." },
            description: { type: "string", description: "Notes or description for the event." },
            all_day: { type: "boolean", description: "True if it's an all-day event." },
            recurrence: {
              type: "object",
              description:
                "Optional recurrence rule. Example: {\"frequency\":\"daily\",\"time\":\"09:00\"} or {\"frequency\":\"weekly\",\"weekday\":\"monday\",\"time\":\"09:00\"}.",
              properties: {
                frequency: {
                  type: "string",
                  enum: ["daily", "weekly"],
                  description: "Recurrence frequency.",
                },
                time: {
                  type: "string",
                  description: "Time of day in HH:MM (24h) Europe/Warsaw.",
                },
                weekday: {
                  type: "string",
                  description:
                    "Weekday for weekly recurrence (monday..sunday).",
                },
              },
              required: ["frequency"],
            },
            recurrence_frequency: {
              type: "string",
              description: "Recurrence frequency ('daily' or 'weekly').",
            },
            recurrence_time: {
              type: "string",
              description: "Recurrence time in HH:MM (24h) Europe/Warsaw.",
            },
            recurrence_weekday: {
              type: "string",
              description: "Weekday for weekly recurrence (monday..sunday).",
            },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_calendar_events",
        description: "List calendar events. Defaults to upcoming events.",
        parameters: {
          type: "object",
          properties: {
            start_date: { type: "string", description: "Filter events starting after this ISO 8601 date. Defaults to now." },
            end_date: { type: "string", description: "Filter events starting before this ISO 8601 date." },
            limit: { type: "number", description: "Max number of events to return. Default 20." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_calendar_event",
        description: "Update an existing calendar event.",
        parameters: {
          type: "object",
          properties: {
            event_id: { type: "string", description: "The UUID of the event to update." },
            title: { type: "string" },
            start_time: { type: "string" },
            end_time: { type: "string" },
            description: { type: "string" },
            all_day: { type: "boolean" },
            recurrence: {
              type: "object",
              description:
                "Optional recurrence rule. Example: {\"frequency\":\"daily\",\"time\":\"09:00\"} or {\"frequency\":\"weekly\",\"weekday\":\"monday\",\"time\":\"09:00\"}. Use null to clear recurrence.",
              properties: {
                frequency: { type: "string", enum: ["daily", "weekly"] },
                time: { type: "string" },
                weekday: { type: "string" },
              },
            },
            recurrence_frequency: { type: "string" },
            recurrence_time: { type: "string" },
            recurrence_weekday: { type: "string" },
          },
          required: ["event_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_calendar_event",
        description: "Delete a calendar event.",
        parameters: {
          type: "object",
          properties: {
            event_id: { type: "string", description: "The UUID of the event to delete." },
          },
          required: ["event_id"],
        },
      },
    },
  ];
}

export async function runCalendarTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "add_calendar_event":
      return addCalendarEvent(args);
    case "list_calendar_events":
      return listCalendarEvents(args);
    case "update_calendar_event":
      return updateCalendarEvent(args);
    case "delete_calendar_event":
      return deleteCalendarEvent(args);
    default:
      throw new Error(`Unknown calendar tool: ${name}`);
  }
}

export type CalendarToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

export function getCalendarToolStatus(): CalendarToolStatus[] {
  return [
    {
      id: "calendar-tools",
      label: "Calendar",
      status: "ok",
      details: ["Internal calendar tool is active."],
    },
  ];
}
