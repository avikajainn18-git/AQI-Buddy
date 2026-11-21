import type {
  Activity,
  Environment,
  ExposureModelConfig,
  HourlyPm25Profile,
  SchedulePlacement,
} from "./types";

function validateMultiplier(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${label} must be a finite, non-negative number.`,
    );
  }
}

export function calculateActivityExposureIndex(
  activity: Activity,
  startMinute: number,
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number {
  if (!Number.isInteger(startMinute) || startMinute < 0) {
    throw new Error(
      "Start time must be a non-negative integer minute.",
    );
  }

  if (
    !Number.isInteger(activity.durationMinutes) ||
    activity.durationMinutes <= 0
  ) {
    throw new Error(
      "Activity duration must be a positive integer.",
    );
  }

  const endMinute = startMinute + activity.durationMinutes;

  if (endMinute > 24 * 60) {
    throw new Error(
      "Activities cannot extend past midnight.",
    );
  }

  if (profile.hourlyPm25UgM3.length !== 24) {
    throw new Error(
      "A daily PM2.5 profile must contain 24 hourly slots.",
    );
  }

  const intensityMultiplier =
    config.intensityMultipliers[activity.intensity];

  const environment: Environment = activity.environment;

  const microenvironmentMultiplier =
    config.microenvironmentMultipliers[environment];

  validateMultiplier(
    intensityMultiplier,
    "Intensity multiplier",
  );

  validateMultiplier(
    microenvironmentMultiplier,
    "Microenvironment multiplier",
  );

  let exposureIndex = 0;

  // Evaluate each hour that overlaps with the activity.
  for (
    let hour = Math.floor(startMinute / 60);
    hour <= Math.floor((endMinute - 1) / 60);
    hour++
  ) {
    const concentration = profile.hourlyPm25UgM3[hour];

    if (
      concentration == null ||
      !Number.isFinite(concentration) ||
      concentration < 0
    ) {
      throw new Error(
        `Missing or invalid PM2.5 measurement for hour ${hour}.`,
      );
    }

    const hourStart = hour * 60;
    const hourEnd = hourStart + 60;

    const overlapStart = Math.max(startMinute, hourStart);
    const overlapEnd = Math.min(endMinute, hourEnd);
    const overlapMinutes = overlapEnd - overlapStart;

    exposureIndex +=
      concentration *
      overlapMinutes *
      intensityMultiplier *
      microenvironmentMultiplier;
  }

  return exposureIndex;
}

export function calculatePlanExposureIndex(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number {
  if (activities.length !== placements.length) {
    throw new Error(
      "Every activity must have exactly one placement.",
    );
  }

  const activityById = new Map<string, Activity>();

  for (const activity of activities) {
    if (activityById.has(activity.id)) {
      throw new Error(
        `Duplicate activity ID: ${activity.id}`,
      );
    }

    activityById.set(activity.id, activity);
  }

  const placementById = new Map<string, SchedulePlacement>();

  for (const placement of placements) {
    if (placementById.has(placement.activityId)) {
      throw new Error(
        `Duplicate placement: ${placement.activityId}`,
      );
    }

    if (!activityById.has(placement.activityId)) {
      throw new Error(
        `Unknown activity: ${placement.activityId}`,
      );
    }

    placementById.set(placement.activityId, placement);
  }

  let totalExposureIndex = 0;

  for (const activity of activities) {
    const placement = placementById.get(activity.id);

    if (!placement) {
      throw new Error(
        `Missing placement for activity: ${activity.id}`,
      );
    }

    totalExposureIndex += calculateActivityExposureIndex(
      activity,
      placement.startMinute,
      profile,
      config,
    );
  }

  return totalExposureIndex;
}