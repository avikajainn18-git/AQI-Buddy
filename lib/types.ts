export type Environment = "indoor" | "outdoor";

export type ActivityIntensity =
  | "sedentary"
  | "light"
  | "moderate"
  | "high";

type ActivityBase = {
  id: string;
  name: string;
  durationMinutes: number;
  environment: Environment;
  intensity: ActivityIntensity;
};

export type FixedActivity = ActivityBase & {
  kind: "fixed";
  startMinute: number;
};

export type FlexibleActivity = ActivityBase & {
  kind: "flexible";
  earliestStartMinute: number;
  latestStartMinute: number;

  // The student's original or habitual start time.
  preferredStartMinute: number;
};

export type Activity = FixedActivity | FlexibleActivity;

export type SchedulePlacement = {
  activityId: string;
  startMinute: number;
};

export type HourlyPm25Profile = {
  date: string;
  stationId: string;
  stationName: string;
  sourceName: string;
  sourceUrl: string;
  dataRetrievedAt: string;
  timezone: string;

  // Index 0 = midnight–1 AM; index 23 = 11 PM–midnight.
  // null means the measurement is missing.
  hourlyPm25UgM3: (number | null)[];
};

export type ExposureModelConfig = {
  modelVersion: string;

  // Relative factors. We will research and document their values.
  intensityMultipliers: Record<ActivityIntensity, number>;
  microenvironmentMultipliers: Record<Environment, number>;
};