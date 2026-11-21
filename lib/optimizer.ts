import {
  calculateActivityExposureIndex,
  calculatePlanExposureIndex,
} from "./exposure";

import type {
  Activity,
  ExposureModelConfig,
  HourlyPm25Profile,
  SchedulePlacement,
} from "./types";

const DAY_MINUTES = 24 * 60;
const SCORE_EPSILON = 1e-9;

export type OptimizerOptions = {
  /** Candidate start times are normally considered at this interval. */
  slotMinutes?: number;
  /** Safety cap. If reached, the optimizer throws instead of claiming an optimum. */
  maxSearchNodes?: number;
};

export type OptimizationResult = {
  baselinePlacements: SchedulePlacement[];
  optimizedPlacements: SchedulePlacement[];
  baselineExposureIndex: number;
  optimizedExposureIndex: number;
  /** null when the baseline score is zero, so a percentage is undefined. */
  reductionPercent: number | null;
  /** Complete, feasible schedules whose scores were evaluated. */
  completeSchedulesEvaluated: number;
  searchNodesVisited: number;
  /** Candidate starts skipped because required hourly PM2.5 data was missing. */
  skippedCandidateSlotsMissingData: number;
};

type Candidate = {
  startMinute: number;
  exposureIndex: number;
};

function validateInputs(activities: Activity[], slotMinutes: number): void {
  if (activities.length === 0) {
    throw new Error("Add at least one activity to optimize.");
  }

  if (
    !Number.isInteger(slotMinutes) ||
    slotMinutes <= 0 ||
    slotMinutes > 60 ||
    60 % slotMinutes !== 0
  ) {
    throw new Error(
      "slotMinutes must be a positive integer that divides 60.",
    );
  }

  const ids = new Set<string>();

  for (const activity of activities) {
    if (!activity.id.trim() || ids.has(activity.id)) {
      throw new Error(
        `Activity IDs must be non-empty and unique: ${activity.id}`,
      );
    }
    ids.add(activity.id);

    if (
      !Number.isInteger(activity.durationMinutes) ||
      activity.durationMinutes <= 0 ||
      activity.durationMinutes > DAY_MINUTES
    ) {
      throw new Error(`Invalid duration for activity: ${activity.name}`);
    }

    if (activity.kind === "fixed") {
      if (
        !Number.isInteger(activity.startMinute) ||
        activity.startMinute < 0 ||
        activity.startMinute + activity.durationMinutes > DAY_MINUTES
      ) {
        throw new Error(`Invalid fixed start time for activity: ${activity.name}`);
      }
      continue;
    }

    const {
      earliestStartMinute,
      latestStartMinute,
      preferredStartMinute,
    } = activity;

    if (
      !Number.isInteger(earliestStartMinute) ||
      !Number.isInteger(latestStartMinute) ||
      !Number.isInteger(preferredStartMinute) ||
      earliestStartMinute < 0 ||
      latestStartMinute < earliestStartMinute ||
      latestStartMinute + activity.durationMinutes > DAY_MINUTES
    ) {
      throw new Error(`Invalid time window for activity: ${activity.name}`);
    }

    if (
      preferredStartMinute < earliestStartMinute ||
      preferredStartMinute > latestStartMinute ||
      preferredStartMinute + activity.durationMinutes > DAY_MINUTES
    ) {
      throw new Error(
        `Preferred start must be within the time window for: ${activity.name}`,
      );
    }
  }
}

function assertFeasibleSchedule(
  activities: Activity[],
  placements: SchedulePlacement[],
): void {
  if (placements.length !== activities.length) {
    throw new Error("Every activity must have exactly one placement.");
  }

  const activityById = new Map<string, Activity>(
    activities.map((activity) => [activity.id, activity] as const),
  );
  const startById = new Map<string, number>();

  for (const placement of placements) {
    if (startById.has(placement.activityId)) {
      throw new Error(`Duplicate placement: ${placement.activityId}`);
    }

    const activity = activityById.get(placement.activityId);
    if (!activity) {
      throw new Error(`Unknown activity: ${placement.activityId}`);
    }

    if (
      !Number.isInteger(placement.startMinute) ||
      placement.startMinute < 0 ||
      placement.startMinute + activity.durationMinutes > DAY_MINUTES
    ) {
      throw new Error(`Invalid placement for activity: ${activity.name}`);
    }

    if (activity.kind === "fixed") {
      if (placement.startMinute !== activity.startMinute) {
        throw new Error(`Fixed activity cannot move: ${activity.name}`);
      }
    } else if (
      placement.startMinute < activity.earliestStartMinute ||
      placement.startMinute > activity.latestStartMinute
    ) {
      throw new Error(
        `Activity is outside its permitted window: ${activity.name}`,
      );
    }

    startById.set(placement.activityId, placement.startMinute);
  }

  for (const activity of activities) {
    if (!startById.has(activity.id)) {
      throw new Error(`Missing placement for activity: ${activity.name}`);
    }
  }

  // Intervals are half-open: an activity ending at 9:00 does not overlap one
  // starting at 9:00.
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const first = activities[i];
      const second = activities[j];
      const firstStart = startById.get(first.id)!;
      const secondStart = startById.get(second.id)!;

      const overlaps =
        firstStart < secondStart + second.durationMinutes &&
        secondStart < firstStart + first.durationMinutes;

      if (overlaps) {
        throw new Error(`Activities overlap: ${first.name} and ${second.name}`);
      }
    }
  }
}

function overlapsPlacedActivity(
  activity: Activity,
  startMinute: number,
    placementsById: Map<string, number>,
  activityById: Map<string, Activity>,
): boolean {
  for (const [otherId, otherStart] of placementsById) {
    const otherActivity = activityById.get(otherId);
    if (!otherActivity) {
      throw new Error(`Unknown activity in partial schedule: ${otherId}`);
    }

    const overlaps =
      startMinute < otherStart + otherActivity.durationMinutes &&
      otherStart < startMinute + activity.durationMinutes;

    if (overlaps) return true;
  }

  return false;
}

function scoreCandidate(
  activity: Activity,
  startMinute: number,
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number | null {
  try {
    return calculateActivityExposureIndex(
      activity,
      startMinute,
        profile,
      config,
    );
  } catch (error) {
    // Keep this aligned with the specific missing-data error from exposure.ts.
    // Other errors (bad configuration, bad duration, malformed profile) must surface.
    if (
      error instanceof Error &&
      /^Missing or invalid PM2\.5 measurement for hour \d+\.$/.test(
        error.message,
      )
    ) {
      return null;
    }
    throw error;
  }
}

export function optimizeSchedule(
    activities: Activity[],
    profile: HourlyPm25Profile,
    config: ExposureModelConfig,
    options: OptimizerOptions = {},
): OptimizationResult {
    const slotMinutes = options.slotMinutes ?? 15;
    const maxSearchNodes = options.maxSearchNodes ?? 1_000_000;

    if (!Number.isInteger(maxSearchNodes) || maxSearchNodes <= 0) {
        throw new Error("maxSearchNodes must be a positive integer.");
    }

    validateInputs(activities, slotMinutes);

    const baselinePlacements: SchedulePlacement[] = activities.map((activity) => ({
        activityId: activity.id,
        startMinute:
            activity.kind === "fixed"
                ? activity.startMinute
                : activity.preferredStartMinute,
    }));
    
    // The original schedule must itself be feasible and have complete data,
    // otherwise a fair before/after percentage cannot be calculated.
    assertFeasibleSchedule(activities, baselinePlacements);
    const baselineExposureIndex = calculatePlanExposureIndex(
        activities,
        baselinePlacements,
        profile,
        config,
    );

    const activityById = new Map<string, Activity>(
        activities.map((activity) => [activity.id, activity] as const),
    );
    const placementsById = new Map<string, number>();
    const fixedActivities = activities.filter(
        (activity) => activity.kind === "fixed",
    );
    const flexibleActivities = activities.filter(
        (activity) => activity.kind === "flexible",
    );

    let fixedExposureIndex = 0;
    for (const activity of fixedActivities) {
        placementsById.set(activity.id, activity.startMinute);
        fixedExposureIndex += calculateActivityExposureIndex(
            activity,
            activity.startMinute,
            profile,
            config,
        );
    }

    let skippedCandidateSlotsMissingData = 0;
    const candidatesById = new Map<string, Candidate[]>();

    for (const activity of flexibleActivities) {
        const startTimes = new Set<number>();
        const firstGridSlot =
            Math.ceil(activity.earliestStartMinute / slotMinutes) * slotMinutes;

        for (
            let startMinute = firstGridSlot;
            startMinute <= activity.latestStartMinute;
            startMinute += slotMinutes
        ) {
            startTimes.add(startMinute);
        }

        // Always include the original preferred start, even if it is not aligned
        // to the grid. This guarantees the optimizer can retain the baseline.
        startTimes.add(activity.preferredStartMinute);

        const candidates: Candidate[] = [];
        for (const startMinute of startTimes) {
            const exposureIndex = scoreCandidate(
                activity,
                startMinute,
                profile,
                config,
            );

            if (exposureIndex === null) {
                skippedCandidateSlotsMissingData++;
                continue;
            }

            candidates.push({ startMinute, exposureIndex });
        }

        if (candidates.length === 0) {
            throw new Error(
                `No data-supported start slots are available for: ${activity.name}`,
            );
        }

        candidates.sort(
            (a, b) =>
                a.exposureIndex - b.exposureIndex ||
                Math.abs(a.startMinute - activity.preferredStartMinute) -
                Math.abs(b.startMinute - activity.preferredStartMinute) ||
                a.startMinute - b.startMinute,
        );

        candidatesById.set(activity.id, candidates);
    }

    // Search activities with fewer candidate times first to prune earlier.
    flexibleActivities.sort(
        (a, b) => candidatesById.get(a.id)!.length - candidatesById.get(b.id)!.length,
    );
    
    // Optimistic lower bound: each remaining activity's independent minimum.
    // It can ignore collisions because ignoring constraints cannot increase it.
    const suffixMinimumExposure = Array<number>(flexibleActivities.length + 1).fill(0);

    for (let i = flexibleActivities.length - 1; i >= 0; i--) {
        const candidates = candidatesById.get(flexibleActivities[i].id)!;
        let minimum = Number.POSITIVE_INFINITY;

        for (const candidate of candidates) {
            minimum = Math.min(minimum, candidate.exposureIndex);
        }

        suffixMinimumExposure[i] = suffixMinimumExposure[i + 1] + minimum;
    }

    let bestExposureIndex = Number.POSITIVE_INFINITY;
    let bestDisplacementMinutes = Number.POSITIVE_INFINITY;
    let bestPlacementsById: Map<string, number> | null = null;
    let completeSchedulesEvaluated = 0;
    let searchNodesVisited = 0;
    let searchLimitReached = false;

    function search(
        index: number,
        exposureSoFar: number,
        displacementSoFar: number,
    ): void {
        if (searchNodesVisited >= maxSearchNodes) {
            searchLimitReached = true;
            return;
        }
        searchNodesVisited++;

        const lowerBound = exposureSoFar + suffixMinimumExposure[index];
        if (lowerBound > bestExposureIndex + SCORE_EPSILON) {
            return;
        }

        if (index === flexibleActivities.length) {
            completeSchedulesEvaluated++;
            const hasLowerExposure =
                exposureSoFar < bestExposureIndex - SCORE_EPSILON;
            const exposureIsTied =
                Math.abs(exposureSoFar - bestExposureIndex) <= SCORE_EPSILON;
            const hasLessScheduleChange =
                displacementSoFar < bestDisplacementMinutes;
        
            if (hasLowerExposure || (exposureIsTied && hasLessScheduleChange)) {
                bestExposureIndex = exposureSoFar;
                bestDisplacementMinutes = displacementSoFar;
                bestPlacementsById = new Map(placementsById);
            }
            return;
        }

        const activity = flexibleActivities[index];
        const candidates = candidatesById.get(activity.id)!;

        for (const candidate of candidates) {
            if (
                overlapsPlacedActivity(
                    activity,
                    candidate.startMinute,
                    placementsById,
                    activityById,
                )
            ) {
                continue;
            }

            placementsById.set(activity.id, candidate.startMinute);
            search(
                index + 1,
                exposureSoFar + candidate.exposureIndex,
                displacementSoFar +
                Math.abs(candidate.startMinute - activity.preferredStartMinute),
            );
            placementsById.delete(activity.id);

            if (searchLimitReached) return;
        }
    }

    search(0, fixedExposureIndex, 0);

    if (searchLimitReached) {
        throw new Error(
            "Search limit reached before optimality was proved. Narrow time windows, reduce flexible activities, or increase maxSearchNodes deliberately.",
        );
    }

    if (!bestPlacementsById) {
        throw new Error("No feasible schedule exists without overlapping activities.");
    }

    const optimizedPlacements: SchedulePlacement[] = activities.map((activity) => {
        const startMinute = bestPlacementsById!.get(activity.id);
        if (startMinute === undefined) {
            throw new Error(`Optimizer failed to place activity: ${activity.name}`);
        }
        return { activityId: activity.id, startMinute };
    });
    
    assertFeasibleSchedule(activities, optimizedPlacements);
    const optimizedExposureIndex = calculatePlanExposureIndex(
        activities,
        optimizedPlacements,
        profile,
        config,
    );

    const reductionPercent =
        baselineExposureIndex > 0
            ? ((baselineExposureIndex - optimizedExposureIndex) /
                baselineExposureIndex) *
            100
            : null;

    return {
        baselinePlacements,
        optimizedPlacements,
        baselineExposureIndex,
        optimizedExposureIndex,
        reductionPercent,
        completeSchedulesEvaluated,
        searchNodesVisited,
        skippedCandidateSlotsMissingData,
    };
}