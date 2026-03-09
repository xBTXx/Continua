import {
  SKILL_LIFECYCLE_STATES,
  type SkillLifecycleState,
} from "@/lib/ssef/contracts/lifecycle";
import { listSSEFSkills } from "@/lib/ssef/repository";

export const dynamic = "force-dynamic";

function toSafeNumber(value: string | null, fallback: number, min: number, max: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseLifecycleFilter(
  value: string | null
): SkillLifecycleState[] | null {
  if (!value) {
    return null;
  }
  const states = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (states.length === 0) {
    return null;
  }

  const invalid = states.filter(
    (state) => !SKILL_LIFECYCLE_STATES.includes(state as SkillLifecycleState)
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid lifecycle state filter: ${invalid.join(", ")}. Allowed: ${SKILL_LIFECYCLE_STATES.join(", ")}.`
    );
  }

  return states.filter(
    (state, index, all) => all.indexOf(state) === index
  ) as SkillLifecycleState[];
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = toSafeNumber(url.searchParams.get("limit"), 50, 1, 200);
    const offset = toSafeNumber(url.searchParams.get("offset"), 0, 0, 1_000_000);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const stateFilter = parseLifecycleFilter(url.searchParams.get("state"));

    const data = await listSSEFSkills({
      limit,
      offset,
      search: q || undefined,
      lifecycleState: stateFilter ?? undefined,
    });
    return Response.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list SSEF skills.";
    const status =
      message.startsWith("Invalid lifecycle state filter:") ? 400 : 500;
    return new Response(message, { status });
  }
}
