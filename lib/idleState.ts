import { savePersonalMemory } from "./personalMemory";
import {
  saveIdleActionLogEntries,
  saveIdleActionPlan,
} from "./idleActions";
import { saveIdleTickMetrics } from "./idleMetrics";
import {
  listScratchpadNotesForIdle,
  consumeScratchpadNotesByTarget,
  markScratchpadNoteIdleProcessed,
} from "./scratchpad";
import { formatDateTime } from "./chatUtils";
import {
  listDueCalendarEvents,
  markCalendarEventTriggered,
  getNextCalendarTriggerAt,
} from "./calendarTools";
import { createIdleConversation } from "./idleConversations";
import { runIdleWorkspace } from "./idleWorkspace";
import { runMemoryConsolidationLoop } from "./memoryScheduler";
import {
  IDLE_STATE_KEY,
  ENERGY_MAX,
  RECENT_THOUGHT_LIMIT,
} from "./idle/constants";
import {
  IdleConfig,
  IdleRuntimeState,
  IdleSeed,
  IdleThought,
  IdleEvaluation,
} from "./idle/types";

export type { IdleConfig, IdleRuntimeState };

import {
  getNextSparkIntervalMs,
  updateIdleEnergy,
  updateEmotionalMomentum,
  getIdleConfig,
} from "./idle/config";

export { getIdleConfig };
import { collectIdleSeeds } from "./idle/seeds";
import {
  getPersonaAnchor,
  buildPersonaFocusCache,
} from "./idle/persona";
import {
  getRelatedThoughts,
  scoreIdleThought,
} from "./idle/scoring";
import {
  generateIdleThought,
  reviewIdleThought,
  handleScratchpadActions,
  generateIdleResonanceMetadata,
} from "./idle/generation";

async function storeIdleThought(
  thought: IdleThought,
  seed: IdleSeed,
  evaluation: IdleEvaluation,
  config: IdleConfig
) {
  if (!thought.thought.trim()) {
    return;
  }
  try {
    const resonance =
      (await generateIdleResonanceMetadata(thought, seed, config)) ?? null;
    const fallbackTag = "reflection";
    const resonanceTags =
      resonance?.resonanceTags && resonance.resonanceTags.length > 0
        ? resonance.resonanceTags
        : [fallbackTag];
    const resonanceWeight = resonance?.resonanceWeight ?? "transient";
    const resonanceIntensity =
      typeof resonance?.resonanceIntensity === "number"
        ? resonance.resonanceIntensity
        : 2;
    const resonanceState = resonance?.resonanceState ?? "quiet";
    const resonanceMotifs =
      resonance?.resonanceMotifs && resonance.resonanceMotifs.length > 0
        ? resonance.resonanceMotifs
        : [];

    await savePersonalMemory({
      content: thought.thought,
      category: "thought",
      model: config.modelLite,
      resonanceTags,
      resonanceWeight,
      resonanceIntensity,
      resonanceState,
      resonanceMotifs,
      metadata: {
        source: "idle_state",
        idle_salience: Number(evaluation.score.toFixed(3)),
        idle_decision: evaluation.decision,
        idle_seed_id: seed.id,
        idle_seed_source: seed.source,
        idle_tas_temporal: thought.tas?.temporal ?? null,
        idle_tas_valence: thought.tas?.valence ?? null,
        idle_tas_self: thought.tas?.self_relevance ?? null,
      },
    });
  } catch (error) {
    console.warn("Idle thought storage failed.", error);
  }
}

function getIdleRuntime(): IdleRuntimeState {
  const globalScope = globalThis as typeof globalThis & {
    [IDLE_STATE_KEY]?: IdleRuntimeState;
  };
  if (!globalScope[IDLE_STATE_KEY]) {
    globalScope[IDLE_STATE_KEY] = {
      started: false,
      inFlight: false,
      lastActivityAt: Date.now(),
      lastTickAt: 0,
      lastActivitySource: null,
      currentEnergy: 0.5,
      lastEnergyAt: Date.now(),
      personaFocusCache: null,
      intervalId: null,
      nextSparkAt: 0,
      recentThoughts: [],
      lastEscalatedBySeed: {},
      lastSeedUsedAt: {},
      seedUseCounts: {},
      lastConsolidationCheck: 0,
      // Emotional momentum: 0 = neutral, -1 = negative, +1 = positive
      emotionalMomentum: 0,
      lastMomentumAt: Date.now(),
    };
  }
  return globalScope[IDLE_STATE_KEY] as IdleRuntimeState;
}

function shouldRunIdle(
  state: IdleRuntimeState,
  config: IdleConfig,
  options?: { nowMs?: number; bypassNextSparkAt?: boolean }
) {
  if (!config.enabled) {
    return false;
  }
  if (state.inFlight) {
    return false;
  }
  const now = options?.nowMs ?? Date.now();
  if (state.lastActivityAt > 0 && now - state.lastActivityAt < config.cooldownMs) {
    return false;
  }
  if (!options?.bypassNextSparkAt && state.nextSparkAt > 0 && now < state.nextSparkAt) {
    return false;
  }
  if (state.lastTickAt > 0 && now - state.lastTickAt < config.intervalMs) {
    return false;
  }
  return true;
}

const IDLE_ERROR_LOG_MAX = 2000;

function formatIdleError(error: unknown) {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack : "";
    const message = error.message || "Idle tick failed.";
    const combined = stack || message;
    return combined.length > IDLE_ERROR_LOG_MAX
      ? `${combined.slice(0, IDLE_ERROR_LOG_MAX)}...`
      : combined;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // Fall through to default.
  }
  return "Idle tick failed.";
}

async function runIdleTick() {
  const state = getIdleRuntime();
  const config = await getIdleConfig();
  if (!config.enabled || state.inFlight) {
    return;
  }
  const nowMs = Date.now();

  // --- Memory Consolidation Check ---
  // Run every 60 seconds (60000ms) to ensure long-term memory is updated
  // independently of user browser state.
  if (nowMs - (state.lastConsolidationCheck ?? 0) > 60000) {
    try {
      // Mark inFlight to prevent overlapping ticks
      state.inFlight = true;
      await runMemoryConsolidationLoop();
    } catch (error) {
      console.warn("Memory consolidation loop failed.", error);
    } finally {
      state.lastConsolidationCheck = Date.now();
      state.inFlight = false;
    }
  }

  let dueEvents: Awaited<ReturnType<typeof listDueCalendarEvents>> = [];
  let bypassNextSparkAt = false;
  try {
    dueEvents = await listDueCalendarEvents(1);
    bypassNextSparkAt = dueEvents.length > 0;
  } catch (error) {
    console.warn("Calendar due-event check failed.", error);
  }

  if (!shouldRunIdle(state, config, { nowMs, bypassNextSparkAt })) {
    return;
  }
  console.log("[Idle] Running tick...");
  state.inFlight = true;
  state.lastTickAt = nowMs;
  const energyAtTickStart = updateIdleEnergy(state, config, nowMs);
  let errorMessage: string | null = null;
  let seedsCount = 0;
  let thoughtsGenerated = 0;
  let storedCount = 0;
  let escalatedCount = 0;
  let deferredCount = 0;
  let actionsQueued = 0;
  let scratchpadNotes = 0;
  let personaKeywordHits = 0;
  let personaSemanticHits = 0;
  try {
    const scratchpadPriority = await listScratchpadNotesForIdle(1);
    if (scratchpadPriority.length > 0) {
      const note = scratchpadPriority[0];
      seedsCount = scratchpadPriority.length;
      thoughtsGenerated += 1;
      escalatedCount += 1;
      await markScratchpadNoteIdleProcessed(note.id);

      const seed: IdleSeed = {
        id: `scratchpad:${note.id}`,
        source: "scratchpad",
        content: note.content,
        createdAt: note.createdAt,
        metadata: { source: "scratchpad", scratchpad_id: note.id },
      };
      const thought: IdleThought = {
        seedId: seed.id,
        thought: note.content,
      };
      const relatedThoughts = getRelatedThoughts(thought.thought, state);
      const workspaceResult = await runIdleWorkspace({
        thought,
        seed,
        relatedThoughts,
        config,
      });
      if (!workspaceResult) {
        deferredCount += 1;
        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        return;
      }

      const finalThoughtText =
        (typeof workspaceResult.finalThought === "string" &&
          workspaceResult.finalThought.trim()) ||
        thought.thought;
      const finalThought =
        finalThoughtText !== thought.thought
          ? { ...thought, thought: finalThoughtText }
          : thought;
      const evaluation: IdleEvaluation = {
        score: 1,
        decision: "escalate",
        isSimilar: false,
        personaMatch: null,
      };

      await storeIdleThought(finalThought, seed, evaluation, config);
      storedCount += 1;

      if (workspaceResult.actions.length > 0) {
        const noteActions = workspaceResult.actions.filter(
          (action) => action.type === "save_note"
        );
        const startConversationAction =
          workspaceResult.actions.find((action) => action.type === "start_conversation") ??
          null;
        const queuedActions = workspaceResult.actions.filter(
          (action) =>
            action.type !== "edit_thought" &&
            action.type !== "save_note" &&
            action.type !== "start_conversation"
        );

        if (noteActions.length > 0) {
          scratchpadNotes += await handleScratchpadActions(noteActions, config);
          try {
            await saveIdleActionLogEntries({
              thoughtText: finalThought.thought,
              actions: noteActions,
              model: config.modelSmart,
              source: "executed",
            });
          } catch (error) {
            console.warn("Idle scratchpad action log failed.", error);
          }
        }

        if (startConversationAction) {
          try {
            await createIdleConversation({
              thoughtText: finalThought.thought,
              action: startConversationAction,
            });
            await saveIdleActionLogEntries({
              thoughtText: finalThought.thought,
              actions: [startConversationAction],
              model: config.modelSmart,
              source: "executed",
            });
          } catch (error) {
            console.warn("Idle start conversation failed.", error);
          }
        }

        if (queuedActions.length > 0) {
          await saveIdleActionPlan({
            thoughtText: finalThought.thought,
            seedId: seed.id,
            seedSource: seed.source,
            actions: queuedActions,
            model: config.modelSmart,
          });
          actionsQueued += queuedActions.length;
        }
      }

      state.recentThoughts.unshift(finalThought.thought);
      state.recentThoughts = state.recentThoughts.slice(0, RECENT_THOUGHT_LIMIT);
      state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
      return;
    }

    if (dueEvents.length > 0) {
      const event = dueEvents[0];
      seedsCount = dueEvents.length;
      thoughtsGenerated += 1;
      escalatedCount += 1;

      const scheduledAt = event.nextTriggerAt ?? event.startTime;
      const noteParts = [event.title];
      if (event.description) {
        noteParts.push(event.description);
      }
      if (scheduledAt) {
        const scheduledDate = new Date(scheduledAt);
        if (!Number.isNaN(scheduledDate.getTime())) {
          const formattedTime = formatDateTime(scheduledDate);
          noteParts.push(`Scheduled at ${formattedTime}.`);
        }
      }
      const eventNote = noteParts.filter(Boolean).join(" - ").trim();
      const seed: IdleSeed = {
        id: `calendar:${event.id}`,
        source: "calendar_event",
        content: eventNote || event.title,
        createdAt: event.createdAt,
        metadata: {
          source: "calendar_event",
          event_id: event.id,
          event_time: scheduledAt ?? null,
          event_timezone: event.recurrence?.timezone ?? "Europe/Warsaw",
        },
      };
      const thought: IdleThought = {
        seedId: seed.id,
        thought: seed.content,
      };

      // Mark as triggered and advance next_trigger_at immediately to prevent loops.
      // Even if the workspace fails or defers, we consider this occurrence "consumed".
      const nextTriggerAt = getNextCalendarTriggerAt(event, new Date());
      await markCalendarEventTriggered({
        eventId: event.id,
        triggeredAt: new Date(),
        nextTriggerAt: nextTriggerAt ?? null,
      });

      const relatedThoughts = getRelatedThoughts(thought.thought, state);
      const workspaceResult = await runIdleWorkspace({
        thought,
        seed,
        relatedThoughts,
        config,
      });
      if (!workspaceResult) {
        deferredCount += 1;
        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        return;
      }

      const finalThoughtText =
        (typeof workspaceResult.finalThought === "string" &&
          workspaceResult.finalThought.trim()) ||
        thought.thought;
      const finalThought =
        finalThoughtText !== thought.thought
          ? { ...thought, thought: finalThoughtText }
          : thought;
      const evaluation: IdleEvaluation = {
        score: 1,
        decision: "escalate",
        isSimilar: false,
        personaMatch: null,
      };

      await storeIdleThought(finalThought, seed, evaluation, config);
      storedCount += 1;

      if (workspaceResult.actions.length > 0) {
        const noteActions = workspaceResult.actions.filter(
          (action) => action.type === "save_note"
        );
        const startConversationAction =
          workspaceResult.actions.find((action) => action.type === "start_conversation") ??
          null;
        const queuedActions = workspaceResult.actions.filter(
          (action) =>
            action.type !== "edit_thought" &&
            action.type !== "save_note" &&
            action.type !== "start_conversation"
        );

        if (noteActions.length > 0) {
          scratchpadNotes += await handleScratchpadActions(noteActions, config);
          try {
            await saveIdleActionLogEntries({
              thoughtText: finalThought.thought,
              actions: noteActions,
              model: config.modelSmart,
              source: "executed",
            });
          } catch (error) {
            console.warn("Idle scratchpad action log failed.", error);
          }
        }

        if (startConversationAction) {
          try {
            await createIdleConversation({
              thoughtText: finalThought.thought,
              action: startConversationAction,
            });
            await saveIdleActionLogEntries({
              thoughtText: finalThought.thought,
              actions: [startConversationAction],
              model: config.modelSmart,
              source: "executed",
            });
          } catch (error) {
            console.warn("Idle start conversation failed.", error);
          }
        }

        if (queuedActions.length > 0) {
          await saveIdleActionPlan({
            thoughtText: finalThought.thought,
            seedId: seed.id,
            seedSource: seed.source,
            actions: queuedActions,
            model: config.modelSmart,
          });
          actionsQueued += queuedActions.length;
        }
      }

      state.recentThoughts.unshift(finalThought.thought);
      state.recentThoughts = state.recentThoughts.slice(0, RECENT_THOUGHT_LIMIT);
      state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
      return;
    }

    const personaAnchor = await getPersonaAnchor(config);
    const personaFocusCache = await buildPersonaFocusCache(personaAnchor, state);
    const seeds = await collectIdleSeeds(config, state);
    seedsCount = seeds.length;
    if (seeds.length === 0) {
      console.log("[Idle] No seeds found. Skipping tick.");
      return;
    }

    const usedSeedIds = new Set<string>();
    const burstCount = Math.max(1, config.burstCount);

    for (let i = 0; i < burstCount; i += 1) {
      let thought = await generateIdleThought(
        seeds,
        usedSeedIds,
        state.recentThoughts,
        state.lastSeedUsedAt,
        state.seedUseCounts,
        config
      );
      if (!thought) {
        continue;
      }
      thoughtsGenerated += 1;
      const currentThought = thought;
      const seed = seeds.find((entry) => entry.id === currentThought.seedId);
      if (!seed) {
        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        break;
      }
      const seedUsedAt = Date.now();
      state.lastSeedUsedAt[seed.id] = seedUsedAt;
      state.seedUseCounts[seed.id] = (state.seedUseCounts[seed.id] ?? 0) + 1;
      const review = await reviewIdleThought(
        thought,
        seed,
        state.recentThoughts,
        config
      );
      if (review?.skip) {
        deferredCount += 1;
        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        break;
      }
      if (review?.editedThought) {
        thought = { ...thought, thought: review.editedThought };
      }
      const evaluation = await scoreIdleThought(
        thought,
        seed,
        state,
        config,
        personaAnchor,
        personaFocusCache
      );
      if (evaluation.personaMatch === "keyword") {
        personaKeywordHits += 1;
      } else if (evaluation.personaMatch === "semantic") {
        personaSemanticHits += 1;
      }
      if (evaluation.decision === "defer") {
        deferredCount += 1;
        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        break;
      }

      usedSeedIds.add(thought.seedId);

      // Update emotional momentum based on thought valence
      updateEmotionalMomentum(state, config, thought.tas?.valence);

      if (evaluation.decision === "store") {
        await storeIdleThought(thought, seed, evaluation, config);
        storedCount += 1;
        state.recentThoughts.unshift(thought.thought);
        state.recentThoughts = state.recentThoughts.slice(0, RECENT_THOUGHT_LIMIT);

        // Check for associative thought chaining
        if (
          config.chainEnabled &&
          thought.expand &&
          Math.random() < config.chainProbability
        ) {
          // Generate a follow-up chain thought from the same seed or related seeds
          const chainThought = await generateIdleThought(
            seeds,
            usedSeedIds,
            [...state.recentThoughts, thought.thought],
            state.lastSeedUsedAt,
            state.seedUseCounts,
            config
          );
          if (chainThought) {
            thoughtsGenerated += 1;
            const chainSeed = seeds.find((entry) => entry.id === chainThought.seedId);
            if (chainSeed) {
              state.lastSeedUsedAt[chainSeed.id] = Date.now();
              state.seedUseCounts[chainSeed.id] = (state.seedUseCounts[chainSeed.id] ?? 0) + 1;
              const chainEvaluation: IdleEvaluation = {
                score: evaluation.score * 0.8, // Slightly lower score for chain thoughts
                decision: "store",
                isSimilar: false,
                personaMatch: null,
              };
              await storeIdleThought(chainThought, chainSeed, chainEvaluation, config);
              storedCount += 1;
              updateEmotionalMomentum(state, config, chainThought.tas?.valence);
              state.recentThoughts.unshift(chainThought.thought);
              state.recentThoughts = state.recentThoughts.slice(0, RECENT_THOUGHT_LIMIT);
              usedSeedIds.add(chainThought.seedId);
            }
          }
        }

        state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
        break;
      }

      state.lastEscalatedBySeed[seed.id] = Date.now();
      escalatedCount += 1;

      let finalThought = thought;
      try {
        const relatedThoughts = getRelatedThoughts(thought.thought, state);
        const workspaceResult = await runIdleWorkspace({
          thought,
          seed,
          relatedThoughts,
          config,
        });
        if (!workspaceResult) {
          deferredCount += 1;
          state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
          break;
        }

        const finalThoughtText =
          (typeof workspaceResult.finalThought === "string" &&
            workspaceResult.finalThought.trim()) ||
          thought.thought;

        finalThought =
          finalThoughtText !== thought.thought
            ? { ...thought, thought: finalThoughtText }
            : thought;

        await storeIdleThought(finalThought, seed, evaluation, config);
        storedCount += 1;

        if (workspaceResult.actions.length > 0) {
          const noteActions = workspaceResult.actions.filter(
            (action) => action.type === "save_note"
          );
          const startConversationAction =
            workspaceResult.actions.find((action) => action.type === "start_conversation") ??
            null;
          const queuedActions = workspaceResult.actions.filter(
            (action) =>
              action.type !== "edit_thought" &&
              action.type !== "save_note" &&
              action.type !== "start_conversation"
          );

          if (noteActions.length > 0) {
            scratchpadNotes += await handleScratchpadActions(noteActions, config);
            try {
              await saveIdleActionLogEntries({
                thoughtText: finalThought.thought,
                actions: noteActions,
                model: config.modelSmart,
                source: "executed",
              });
            } catch (error) {
              console.warn("Idle scratchpad action log failed.", error);
            }
          }

          if (startConversationAction) {
            try {
              await createIdleConversation({
                thoughtText: finalThought.thought,
                action: startConversationAction,
              });
              await saveIdleActionLogEntries({
                thoughtText: finalThought.thought,
                actions: [startConversationAction],
                model: config.modelSmart,
                source: "executed",
              });
            } catch (error) {
              console.warn("Idle start conversation failed.", error);
            }
          }

          if (queuedActions.length > 0) {
            await saveIdleActionPlan({
              thoughtText: finalThought.thought,
              seedId: seed.id,
              seedSource: seed.source,
              actions: queuedActions,
              model: config.modelSmart,
            });
            actionsQueued += queuedActions.length;
          }
        }
      } catch (error) {
        console.error("Idle escalation/storage failed.", error);
        throw error; // Re-throw to be caught by the main loop and logged in metrics
      }

      state.recentThoughts.unshift(finalThought.thought);
      state.recentThoughts = state.recentThoughts.slice(0, RECENT_THOUGHT_LIMIT);
      state.nextSparkAt = Date.now() + getNextSparkIntervalMs(config);
      break;
    }
  } catch (error) {
    errorMessage = formatIdleError(error);
    if (error instanceof Error && error.stack) {
      console.warn("Idle tick failed.\n", error.stack);
    } else {
      console.warn("Idle tick failed.", error);
    }
  } finally {
    if (seedsCount > 0 || errorMessage) {
      try {
        await saveIdleTickMetrics({
          seedsCount,
          thoughtsGenerated,
          storedCount,
          escalatedCount,
          deferredCount,
          actionsQueued,
          scratchpadNotes,
          personaKeywordHits,
          personaSemanticHits,
          energy: energyAtTickStart,
          modelLite: config.modelLite,
          modelSmart: config.modelSmart,
          error: errorMessage,
        });
        console.log(
          `[Idle] Tick finished. Seeds: ${seedsCount}, Thoughts: ${thoughtsGenerated}, Stored: ${storedCount}, Actions: ${actionsQueued}, Err: ${errorMessage || "none"
          }`
        );
      } catch (error) {
        console.warn("Idle metrics save failed.", error);
      }
    }
    try {
      await consumeScratchpadNotesByTarget("idle");
    } catch (error) {
      console.warn("Scratchpad idle cleanup failed.", error);
    }
    state.inFlight = false;
  }
}

export async function startIdleScheduler() {
  const state = getIdleRuntime();
  const config = await getIdleConfig();

  if (!config.enabled) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
    state.started = false;
    return state;
  }
  if (state.started && state.intervalId) {
    return state;
  }

  console.log(`[Idle] Starting scheduler (Interval: ${config.intervalMs}ms)`);
  state.started = true;
  state.lastActivityAt = Date.now();

  state.intervalId = setInterval(() => {
    void runIdleTick();
  }, config.intervalMs);

  return state;
}

export function recordIdleActivity(source = "unknown") {
  const state = getIdleRuntime();
  const nowMs = Date.now();
  state.lastActivityAt = nowMs;
  state.lastActivitySource = source;
  state.currentEnergy = ENERGY_MAX;
  state.lastEnergyAt = nowMs;
}

export function getIdleStateSnapshot() {
  const state = getIdleRuntime();
  return {
    started: state.started,
    inFlight: state.inFlight,
    lastActivityAt: state.lastActivityAt,
    lastTickAt: state.lastTickAt,
    lastActivitySource: state.lastActivitySource,
    currentEnergy: state.currentEnergy,
  };
}

export async function getIdleStateSnapshotDetailed() {
  const state = getIdleRuntime();
  const config = await getIdleConfig();
  const nowMs = Date.now();
  const currentEnergy = updateIdleEnergy(state, config, nowMs);
  const cooldownRemainingMs = Math.max(
    0,
    state.lastActivityAt + config.cooldownMs - nowMs
  );
  return {
    started: state.started,
    inFlight: state.inFlight,
    lastActivityAt: state.lastActivityAt,
    lastTickAt: state.lastTickAt,
    lastActivitySource: state.lastActivitySource,
    currentEnergy,
    cooldownRemainingMs,
  };
}
