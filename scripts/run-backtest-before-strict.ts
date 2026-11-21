import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  calculateActivityExposureIndex,
  calculatePlanExposureIndex,
} from "../lib/exposure";
import {
  BASELINE_MODEL_CONFIG,
  MODEL_ASSUMPTIONS,
  SENSITIVITY_MODEL_CONFIGS,
} from "../lib/model-config";
import { optimizeSchedule } from "../lib/optimizer";
import {
  STUDENT_SCENARIO_ASSUMPTIONS,
  STUDENT_WEEKDAY_ACTIVITIES,
} from "../lib/scenario";
import type {
  Activity,
  ExposureModelConfig,
  HourlyPm25Profile,
  SchedulePlacement,
} from "../lib/types";

const root = process.cwd();
const inputPath = join(root, "data", "processed", "openaq-normalized-60d.json");

type ModelScenarioName = "baseline" | "indoorLow" | "indoorHigh" | "higherVentilation";

const MODEL_SCENARIO = (process.env.AQI_MODEL_SCENARIO ?? "baseline") as ModelScenarioName;

const ACTIVE_MODEL_CONFIG: ExposureModelConfig = (() => {
  if (MODEL_SCENARIO === "baseline") return BASELINE_MODEL_CONFIG;
  const config = SENSITIVITY_MODEL_CONFIGS[MODEL_SCENARIO];
  if (!config) {
    throw new Error(
      `Unknown AQI_MODEL_SCENARIO: ${MODEL_SCENARIO}. Use baseline, indoorLow, indoorHigh, or higherVentilation.`,
    );
  }
  return config;
})();

const OUTPUT_SUFFIX = MODEL_SCENARIO === "baseline" ? "baseline" : MODEL_SCENARIO;

const MIN_LOOKBACK_DAYS = 14;
const MIN_HISTORY_VALUES_PER_HOUR = 7;
const SLOT_MINUTES = 15;
const PLANNING_START_HOUR = 5;
const PLANNING_END_HOUR_EXCLUSIVE = 21;

// The random-feasible baseline is calculated exactly by scoring every feasible
// schedule, rather than estimating it with random sampling. This is the expected
// score of a uniformly selected feasible schedule, with no Monte Carlo noise.

type NormalizedProfile = {
  date: string;
  stationId: string;
  stationName: string;
  sourceName: string;
  sourceUrl: string;
  dataRetrievedAt: string;
  timezone: string;
  hourlyPm25UgM3: (number | null)[];
  strictHourlyPm25UgM3?: (number | null)[];
  hourlyCoveragePercent?: (number | null)[];
  observedCounts?: (number | null)[];
  expectedCounts?: (number | null)[];
  hasFlags?: (boolean | null)[];
  qualityReasons?: string[][];
};

type NormalizedStation = {
  stationName: string;
  stationId: string;
  area: string;
  stationCoveragePercent: number;
  strictStationCoveragePercent: number;
  primaryStationEligible: boolean;
  profiles: NormalizedProfile[];
};

type NormalizedDataset = {
  datasetName: string;
  source: string;
  timezone: string;
  requestedFrom: string;
  requestedTo: string;
  generatedAt: string;
  rules: Record<string, unknown>;
  stations: NormalizedStation[];
};

type ScheduleDescription = {
  activityId: string;
  activityName: string;
  kind: Activity["kind"];
  startMinute: number;
  startTime: string;
  endMinute: number;
  endTime: string;
};

type DayResult = {
  date: string;
  stationName: string;
  stationId: string;
  lookbackDays: number;
  minHistoryValuesPerHour: number;
  feasibleScheduleCount: number;
  habitualTotalExposureIndex: number;
  habitualFlexibleExposureIndex: number;
  oracleTotalExposureIndex: number;
  oracleFlexibleExposureIndex: number;
  oracleTotalReductionPercent: number | null;
  oracleFlexibleReductionPercent: number | null;
  deployableTotalExposureIndex: number;
  deployableFlexibleExposureIndex: number;
  deployableTotalReductionPercent: number | null;
  deployableFlexibleReductionPercent: number | null;
  randomMeanTotalExposureIndex: number;
  randomMeanFlexibleExposureIndex: number;
  randomTotalReductionPercent: number | null;
  randomFlexibleReductionPercent: number | null;
  randomTotalExposureP25: number;
  randomTotalExposureMedian: number;
  randomTotalExposureP75: number;
  habitualExerciseStartMinute: number;
  oracleExerciseStartMinute: number;
  deployableExerciseStartMinute: number;
  habitualExercisePeriod: string;
  oracleExercisePeriod: string;
  deployableExercisePeriod: string;
  oracleExerciseFlipFromHabitual: boolean;
  deployableExerciseFlipFromHabitual: boolean;
  habitualSchedule: ScheduleDescription[];
  oracleSchedule: ScheduleDescription[];
  deployableSchedule: ScheduleDescription[];
};

type ExclusionCount = {
  stationName: string;
  stationId: string;
  overallStationEligible: boolean;
  datesConsideredAfterLookback: number;
  targetWindowIncomplete: number;
  insufficientHistoricalProfile: number;
  evaluatedStationDays: number;
};

function assertValidNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlanningWindowComplete(values: (number | null)[]): boolean {
  if (values.length !== 24) return false;
  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    if (!assertValidNumber(values[hour])) return false;
  }
  return true;
}

function asHourlyProfile(profile: NormalizedProfile): HourlyPm25Profile {
  return {
    date: profile.date,
    stationId: profile.stationId,
    stationName: profile.stationName,
    sourceName: profile.sourceName,
    sourceUrl: profile.sourceUrl,
    dataRetrievedAt: profile.dataRetrievedAt,
    timezone: profile.timezone,
    hourlyPm25UgM3: profile.hourlyPm25UgM3,
  };
}

function buildHistoricalProfile(
  station: NormalizedStation,
  target: NormalizedProfile,
  previousProfiles: NormalizedProfile[],
): { profile: HourlyPm25Profile | null; minimumSamples: number; countsByHour: number[] } {
  const hourlyPm25UgM3: (number | null)[] = Array(24).fill(null);
  const countsByHour = Array(24).fill(0) as number[];
  let minimumSamples = Number.POSITIVE_INFINITY;

  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    const observations = previousProfiles
      .map((profile) => profile.hourlyPm25UgM3[hour])
      .filter((value): value is number => assertValidNumber(value));

    countsByHour[hour] = observations.length;
    minimumSamples = Math.min(minimumSamples, observations.length);

    if (observations.length < MIN_HISTORY_VALUES_PER_HOUR) {
      return { profile: null, minimumSamples, countsByHour };
    }

    hourlyPm25UgM3[hour] =
      observations.reduce((sum, value) => sum + value, 0) / observations.length;
  }

  return {
    profile: {
      date: target.date,
      stationId: station.stationId,
      stationName: station.stationName,
      sourceName: "OpenAQ API v3: mean of previous 14 calendar days",
      sourceUrl: `https://api.openaq.org/v3/sensors/${station.stationId}/hours`,
      dataRetrievedAt: target.dataRetrievedAt,
      timezone: target.timezone,
      hourlyPm25UgM3,
    },
    minimumSamples,
    countsByHour,
  };
}

function overlaps(
  startA: number,
  durationA: number,
  startB: number,
  durationB: number,
): boolean {
  return startA < startB + durationB && startB < startA + durationA;
}

function generateAllFeasibleSchedules(
  activities: Activity[],
  slotMinutes: number,
): SchedulePlacement[][] {
  const fixed = activities.filter((activity) => activity.kind === "fixed");
  const flexible = activities.filter((activity) => activity.kind === "flexible");
  const placements = new Map<string, number>();
  const activityById = new Map<string, Activity>(
    activities.map((activity) => [activity.id, activity] as const),
  );

  for (let i = 0; i < fixed.length; i++) {
    placements.set(fixed[i].id, fixed[i].startMinute);
    for (let j = 0; j < i; j++) {
      if (
        overlaps(
          fixed[i].startMinute,
          fixed[i].durationMinutes,
          fixed[j].startMinute,
          fixed[j].durationMinutes,
        )
      ) {
        throw new Error(`Fixed activities overlap: ${fixed[i].name} and ${fixed[j].name}`);
      }
    }
  }

  const candidatesByActivity = new Map<string, number[]>();
  for (const activity of flexible) {
    const candidates = new Set<number>();
    const firstSlot = Math.ceil(activity.earliestStartMinute / slotMinutes) * slotMinutes;
    for (
      let start = firstSlot;
      start <= activity.latestStartMinute;
      start += slotMinutes
    ) {
      candidates.add(start);
    }
    // Preserve the habitual slot even if a future scenario uses an off-grid time.
    if (
      activity.preferredStartMinute >= activity.earliestStartMinute &&
      activity.preferredStartMinute <= activity.latestStartMinute
    ) {
      candidates.add(activity.preferredStartMinute);
    }
    candidatesByActivity.set(activity.id, [...candidates].sort((a, b) => a - b));
  }

  const schedules: SchedulePlacement[][] = [];

  function search(index: number): void {
    if (index === flexible.length) {
      schedules.push(
        activities.map((activity) => ({
          activityId: activity.id,
          startMinute: placements.get(activity.id)!,
        })),
      );
      return;
    }

    const activity = flexible[index];
    for (const start of candidatesByActivity.get(activity.id) ?? []) {
      let collision = false;
      for (const [otherId, otherStart] of placements) {
        const other = activityById.get(otherId);
        if (!other) throw new Error(`Unknown activity ${otherId} in feasible-schedule search.`);
        if (overlaps(start, activity.durationMinutes, otherStart, other.durationMinutes)) {
          collision = true;
          break;
        }
      }
      if (collision) continue;

      placements.set(activity.id, start);
      search(index + 1);
      placements.delete(activity.id);
    }
  }

  search(0);
  if (schedules.length === 0) {
    throw new Error("No feasible schedules exist for the configured student scenario.");
  }
  return schedules;
}

function flexibleExposureIndex(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number {
  const startById = new Map(placements.map((placement) => [placement.activityId, placement.startMinute] as const));
  let total = 0;
  for (const activity of activities) {
    if (activity.kind !== "flexible") continue;
    const startMinute = startById.get(activity.id);
    if (startMinute === undefined) throw new Error(`Missing placement for ${activity.id}.`);
    total += calculateActivityExposureIndex(activity, startMinute, profile, config);
  }
  return total;
}

function percentReduction(baseline: number, alternative: number): number | null {
  if (!(baseline > 0)) return null;
  return ((baseline - alternative) / baseline) * 100;
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length,
  );
}

function summarize(
  values: (number | null)[],
  tenPercentThreshold = false,
): {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  shareAtLeast10Percent: number | null;
} {
  const valid = values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value),
  );
  return {
    n: valid.length,
    median: median(valid),
    p25: quantile(valid, 0.25),
    p75: quantile(valid, 0.75),
    min: valid.length ? Math.min(...valid) : null,
    max: valid.length ? Math.max(...valid) : null,
    shareAtLeast10Percent: tenPercentThreshold
      ? valid.length
        ? (100 * valid.filter((value) => value >= 10).length) / valid.length
        : null
      : null,
  };
}

function formatTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timePeriod(minutes: number): "morning" | "evening" {
  return minutes < 12 * 60 ? "morning" : "evening";
}

function describeSchedule(
  activities: Activity[],
  placements: SchedulePlacement[],
): ScheduleDescription[] {
  const activitiesById = new Map<string, Activity>(
    activities.map((activity) => [activity.id, activity] as const),
  );
  return placements.map((placement) => {
    const activity = activitiesById.get(placement.activityId);
    if (!activity) throw new Error(`Unknown activity ${placement.activityId}.`);
    return {
      activityId: activity.id,
      activityName: activity.name,
      kind: activity.kind,
      startMinute: placement.startMinute,
      startTime: formatTime(placement.startMinute),
      endMinute: placement.startMinute + activity.durationMinutes,
      endTime: formatTime(placement.startMinute + activity.durationMinutes),
    };
  });
}

function scheduleLabel(schedule: ScheduleDescription[]): string {
  return schedule
    .map((item) => `${item.activityName}=${item.startTime}`)
    .join("; ");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const raw = readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const data = JSON.parse(raw) as NormalizedDataset;

if (!Array.isArray(data.stations) || data.stations.length === 0) {
  throw new Error(`No stations found in ${inputPath}. Run the data preparation script first.`);
}

const activities = STUDENT_WEEKDAY_ACTIVITIES;
const flexibleActivities = activities.filter((activity) => activity.kind === "flexible");
const exerciseActivity = flexibleActivities.find((activity) => activity.id === "outdoor-exercise");
if (!exerciseActivity || exerciseActivity.kind !== "flexible") {
  throw new Error("Scenario must include an outdoor-exercise flexible activity.");
}

const allFeasibleSchedules = generateAllFeasibleSchedules(activities, SLOT_MINUTES);
const habitualExerciseStart = exerciseActivity.preferredStartMinute;
const habitualExercisePeriod = timePeriod(habitualExerciseStart);

console.log(`Loaded ${data.stations.length} stations from normalised dataset.`);
console.log(`Enumerated ${allFeasibleSchedules.length} feasible schedules for the student scenario.`);
console.log(`Using a ${MIN_LOOKBACK_DAYS}-day lookback, with at least ${MIN_HISTORY_VALUES_PER_HOUR} historical values per hour.`);

const dailyResults: DayResult[] = [];
const exclusions: ExclusionCount[] = [];
const temporalSamples = new Map<string, Map<number, number[]>>();

for (const station of [...data.stations].sort((a, b) => Number(a.stationId) - Number(b.stationId))) {
  const stationProfiles = [...station.profiles].sort((a, b) => a.date.localeCompare(b.date));
  const exclusion: ExclusionCount = {
    stationName: station.stationName,
    stationId: station.stationId,
    overallStationEligible: station.primaryStationEligible,
    datesConsideredAfterLookback: 0,
    targetWindowIncomplete: 0,
    insufficientHistoricalProfile: 0,
    evaluatedStationDays: 0,
  };
  exclusions.push(exclusion);

  if (!station.primaryStationEligible) {
    console.log(`Skipping ${station.stationName}: below 75% overall primary-coverage threshold.`);
    continue;
  }

  for (let index = MIN_LOOKBACK_DAYS; index < stationProfiles.length; index++) {
    const target = stationProfiles[index];
    exclusion.datesConsideredAfterLookback++;

    if (!isPlanningWindowComplete(target.hourlyPm25UgM3)) {
      exclusion.targetWindowIncomplete++;
      continue;
    }

    // Strictly prior calendar days only. The target day's measurements are never used here.
    const previousProfiles = stationProfiles.slice(index - MIN_LOOKBACK_DAYS, index);
    const historyBuild = buildHistoricalProfile(station, target, previousProfiles);
    if (!historyBuild.profile) {
      exclusion.insufficientHistoricalProfile++;
      continue;
    }

    const actualProfile = asHourlyProfile(target);
    const historicalProfile = historyBuild.profile;

    // Habitual baseline scored on the target day's actual data.
    const oracleResult = optimizeSchedule(
      activities,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
      { slotMinutes: SLOT_MINUTES },
    );
    const baselinePlacements = oracleResult.baselinePlacements;
    const habitualTotal = calculatePlanExposureIndex(
      activities,
      baselinePlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );
    const habitualFlexible = flexibleExposureIndex(
      activities,
      baselinePlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );

    // Oracle: chooses times using the same target day's actual profile.
    const oracleTotal = calculatePlanExposureIndex(
      activities,
      oracleResult.optimizedPlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );
    const oracleFlexible = flexibleExposureIndex(
      activities,
      oracleResult.optimizedPlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );

    // Deployable policy: optimise only against the mean profile from the previous 14 days,
    // then score that already-chosen schedule against the target day's actual observations.
    const deployablePlan = optimizeSchedule(
      activities,
      historicalProfile,
      ACTIVE_MODEL_CONFIG,
      { slotMinutes: SLOT_MINUTES },
    );
    const deployableTotal = calculatePlanExposureIndex(
      activities,
      deployablePlan.optimizedPlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );
    const deployableFlexible = flexibleExposureIndex(
      activities,
      deployablePlan.optimizedPlacements,
      actualProfile,
      ACTIVE_MODEL_CONFIG,
    );

    // Exact random-feasible baseline: score every feasible schedule and treat one
    // uniformly chosen schedule as random. This avoids Monte Carlo sampling noise.
    const randomTotalScores: number[] = [];
    const randomFlexibleScores: number[] = [];
    for (const schedule of allFeasibleSchedules) {
      randomTotalScores.push(
        calculatePlanExposureIndex(activities, schedule, actualProfile, ACTIVE_MODEL_CONFIG),
      );
      randomFlexibleScores.push(
        flexibleExposureIndex(activities, schedule, actualProfile, ACTIVE_MODEL_CONFIG),
      );
    }
    const randomMeanTotal = mean(randomTotalScores);
    const randomMeanFlexible = mean(randomFlexibleScores);
    if (randomMeanTotal === null || randomMeanFlexible === null) {
      throw new Error("Random-feasible baseline unexpectedly had no schedules.");
    }

    const oracleExerciseStart = oracleResult.optimizedPlacements.find(
      (placement) => placement.activityId === exerciseActivity.id,
    )!.startMinute;
    const deployableExerciseStart = deployablePlan.optimizedPlacements.find(
      (placement) => placement.activityId === exerciseActivity.id,
    )!.startMinute;

    dailyResults.push({
      date: target.date,
      stationName: station.stationName,
      stationId: station.stationId,
      lookbackDays: previousProfiles.length,
      minHistoryValuesPerHour: historyBuild.minimumSamples,
      feasibleScheduleCount: allFeasibleSchedules.length,
      habitualTotalExposureIndex: habitualTotal,
      habitualFlexibleExposureIndex: habitualFlexible,
      oracleTotalExposureIndex: oracleTotal,
      oracleFlexibleExposureIndex: oracleFlexible,
      oracleTotalReductionPercent: percentReduction(habitualTotal, oracleTotal),
      oracleFlexibleReductionPercent: percentReduction(habitualFlexible, oracleFlexible),
      deployableTotalExposureIndex: deployableTotal,
      deployableFlexibleExposureIndex: deployableFlexible,
      deployableTotalReductionPercent: percentReduction(habitualTotal, deployableTotal),
      deployableFlexibleReductionPercent: percentReduction(habitualFlexible, deployableFlexible),
      randomMeanTotalExposureIndex: randomMeanTotal,
      randomMeanFlexibleExposureIndex: randomMeanFlexible,
      randomTotalReductionPercent: percentReduction(habitualTotal, randomMeanTotal),
      randomFlexibleReductionPercent: percentReduction(habitualFlexible, randomMeanFlexible),
      randomTotalExposureP25: quantile(randomTotalScores, 0.25)!,
      randomTotalExposureMedian: quantile(randomTotalScores, 0.5)!,
      randomTotalExposureP75: quantile(randomTotalScores, 0.75)!,
      habitualExerciseStartMinute: habitualExerciseStart,
      oracleExerciseStartMinute: oracleExerciseStart,
      deployableExerciseStartMinute: deployableExerciseStart,
      habitualExercisePeriod,
      oracleExercisePeriod: timePeriod(oracleExerciseStart),
      deployableExercisePeriod: timePeriod(deployableExerciseStart),
      oracleExerciseFlipFromHabitual: timePeriod(oracleExerciseStart) !== habitualExercisePeriod,
      deployableExerciseFlipFromHabitual: timePeriod(deployableExerciseStart) !== habitualExercisePeriod,
      habitualSchedule: describeSchedule(activities, baselinePlacements),
      oracleSchedule: describeSchedule(activities, oracleResult.optimizedPlacements),
      deployableSchedule: describeSchedule(activities, deployablePlan.optimizedPlacements),
    });

    exclusion.evaluatedStationDays++;

    if (!temporalSamples.has(station.stationId)) {
      temporalSamples.set(station.stationId, new Map<number, number[]>());
    }
    const stationHourMap = temporalSamples.get(station.stationId)!;
    for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
      if (!stationHourMap.has(hour)) stationHourMap.set(hour, []);
      stationHourMap.get(hour)!.push(target.hourlyPm25UgM3[hour]!);
    }
  }
}

dailyResults.sort(
  (a, b) => a.date.localeCompare(b.date) || Number(a.stationId) - Number(b.stationId),
);

if (dailyResults.length === 0) {
  throw new Error(
    "No station-days qualified. Inspect coverage rules, normalised data, and the 14-day lookback before continuing.",
  );
}

const metricNames = [
  "oracleTotalReductionPercent",
  "oracleFlexibleReductionPercent",
  "deployableTotalReductionPercent",
  "deployableFlexibleReductionPercent",
  "randomTotalReductionPercent",
  "randomFlexibleReductionPercent",
] as const;

function metricsSummary(rows: DayResult[]) {
  const output: Record<string, ReturnType<typeof summarize>> = {};
  for (const metric of metricNames) {
    output[metric] = summarize(
      rows.map((row) => row[metric]),
      true,
    );
  }
  return output;
}

const byStation = [...new Set(dailyResults.map((row) => row.stationId))]
  .map((stationId) => {
    const stationRows = dailyResults.filter((row) => row.stationId === stationId);
    return {
      stationName: stationRows[0].stationName,
      stationId,
      evaluatedStationDays: stationRows.length,
      metrics: metricsSummary(stationRows),
    };
  });

const temporalStdDevs: { stationName: string; stationId: string; sdAcrossHourlyMeans: number | null }[] = [];
const meanConcentrationByStationAndHour = new Map<string, Map<number, number>>();

for (const [stationId, hourMap] of temporalSamples) {
  const hourlyMeans = new Map<number, number>();
  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    const values = hourMap.get(hour) ?? [];
    const average = mean(values);
    if (average !== null) hourlyMeans.set(hour, average);
  }
  const sd = standardDeviation([...hourlyMeans.values()]);
  const stationName = dailyResults.find((row) => row.stationId === stationId)!.stationName;
  temporalStdDevs.push({ stationName, stationId, sdAcrossHourlyMeans: sd });
  meanConcentrationByStationAndHour.set(stationId, hourlyMeans);
}

const betweenStationSpreadByHour = [] as { hour: number; stationCount: number; standardDeviation: number | null }[];
for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
  const stationMeans: number[] = [];
  for (const hourMeans of meanConcentrationByStationAndHour.values()) {
    const value = hourMeans.get(hour);
    if (value !== undefined) stationMeans.push(value);
  }
  betweenStationSpreadByHour.push({
    hour,
    stationCount: stationMeans.length,
    standardDeviation: standardDeviation(stationMeans),
  });
}

const withinStationSdValues = temporalStdDevs
  .map((item) => item.sdAcrossHourlyMeans)
  .filter((value): value is number => value !== null);
const betweenStationSdValues = betweenStationSpreadByHour
  .map((item) => item.standardDeviation)
  .filter((value): value is number => value !== null);

const morningEveningSummary = {
  habitualExercisePeriod,
  oracleMorningDays: dailyResults.filter((row) => row.oracleExercisePeriod === "morning").length,
  oracleEveningDays: dailyResults.filter((row) => row.oracleExercisePeriod === "evening").length,
  oracleFlipsFromHabitual: dailyResults.filter((row) => row.oracleExerciseFlipFromHabitual).length,
  deployableMorningDays: dailyResults.filter((row) => row.deployableExercisePeriod === "morning").length,
  deployableEveningDays: dailyResults.filter((row) => row.deployableExercisePeriod === "evening").length,
  deployableFlipsFromHabitual: dailyResults.filter((row) => row.deployableExerciseFlipFromHabitual).length,
};

const summary = {
  dataset: {
    name: data.datasetName,
    source: data.source,
    timezone: data.timezone,
    requestedFrom: data.requestedFrom,
    requestedTo: data.requestedTo,
    file: "data/processed/openaq-normalized-60d.json",
  },
  experiment: {
    generatedAt: new Date().toISOString(),
    scenario: STUDENT_SCENARIO_ASSUMPTIONS,
    modelScenario: MODEL_SCENARIO,
    modelConfig: ACTIVE_MODEL_CONFIG,
    modelAssumptions: MODEL_ASSUMPTIONS,
    slotMinutes: SLOT_MINUTES,
    planningWindow: "05:00–20:59 local time",
    minimumLookbackCalendarDays: MIN_LOOKBACK_DAYS,
    minimumHistoricalValuesPerHour: MIN_HISTORY_VALUES_PER_HOUR,
    eligibleTargetDayRule: "Every hourly slot from 05:00 through 20:00 must have a valid primary value.",
    deployablePolicyRule: "Optimise on the mean hour-of-day profile from only the preceding 14 calendar days; require at least 7 valid historical values for each planning hour; score the chosen plan on the target day's observations.",
    oraclePolicyRule: "Optimise using the target day's actual hourly values; upper-bound comparison, not deployable forecasting.",
    randomFeasibleBaselineRule: "Exact mean and distribution across every feasible schedule, equivalent to a uniformly random feasible schedule.",
    fixedCommitmentsMovable: false,
    activityOverlapAllowed: false,
    excludedOverallStationCoverageBelow75: exclusions.filter((item) => !item.overallStationEligible).map((item) => ({ stationName: item.stationName, stationId: item.stationId })),
  },
  counts: {
    evaluatedStationDays: dailyResults.length,
    uniqueTargetDates: new Set(dailyResults.map((row) => row.date)).size,
    stationCountEvaluated: new Set(dailyResults.map((row) => row.stationId)).size,
    feasibleSchedulesPerDay: allFeasibleSchedules.length,
  },
  overallMetrics: metricsSummary(dailyResults),
  byStation,
  morningEveningSummary,
  stationVsHourSpread: {
    units: "µg/m³",
    explanation: "Descriptive comparison of station-to-station spread at the same hour against within-station hour-of-day spread. It is not a causal estimate of the benefit of changing time versus location.",
    withinStationHourOfDayStandardDeviationByStation: temporalStdDevs,
    betweenStationStandardDeviationByHour: betweenStationSpreadByHour,
    medianWithinStationHourOfDayStandardDeviation: median(withinStationSdValues),
    medianBetweenStationSameHourStandardDeviation: median(betweenStationSdValues),
  },
  firstChronologicalWorkedExample: dailyResults[0],
  stationEligibilityAndExclusions: exclusions,
  results: dailyResults,
};

const resultsDir = join(root, "data", "results");
const reportsDir = join(root, "data", "reports");
mkdirSync(resultsDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

writeFileSync(
  join(resultsDir, `backtest-day-results-${OUTPUT_SUFFIX}.json`),
  JSON.stringify(dailyResults, null, 2),
  "utf8",
);

const csvColumns: (keyof DayResult | "habitualScheduleText" | "oracleScheduleText" | "deployableScheduleText")[] = [
  "date",
  "stationName",
  "stationId",
  "lookbackDays",
  "minHistoryValuesPerHour",
  "feasibleScheduleCount",
  "habitualTotalExposureIndex",
  "habitualFlexibleExposureIndex",
  "oracleTotalExposureIndex",
  "oracleFlexibleExposureIndex",
  "oracleTotalReductionPercent",
  "oracleFlexibleReductionPercent",
  "deployableTotalExposureIndex",
  "deployableFlexibleExposureIndex",
  "deployableTotalReductionPercent",
  "deployableFlexibleReductionPercent",
  "randomMeanTotalExposureIndex",
  "randomMeanFlexibleExposureIndex",
  "randomTotalReductionPercent",
  "randomFlexibleReductionPercent",
  "randomTotalExposureP25",
  "randomTotalExposureMedian",
  "randomTotalExposureP75",
  "habitualExercisePeriod",
  "oracleExercisePeriod",
  "deployableExercisePeriod",
  "oracleExerciseFlipFromHabitual",
  "deployableExerciseFlipFromHabitual",
  "habitualScheduleText",
  "oracleScheduleText",
  "deployableScheduleText",
];

const csvLines = [csvColumns.join(",")];
for (const row of dailyResults) {
  const record: Record<string, unknown> = {
    ...row,
    habitualScheduleText: scheduleLabel(row.habitualSchedule),
    oracleScheduleText: scheduleLabel(row.oracleSchedule),
    deployableScheduleText: scheduleLabel(row.deployableSchedule),
  };
  csvLines.push(csvColumns.map((column) => csvCell(record[column])).join(","));
}
writeFileSync(
  join(resultsDir, `backtest-day-results-${OUTPUT_SUFFIX}.csv`),
  csvLines.join("\n"),
  "utf8",
);

writeFileSync(
  join(reportsDir, `backtest-summary-${OUTPUT_SUFFIX}.json`),
  JSON.stringify(summary, null, 2),
  "utf8",
);
writeFileSync(
  join(reportsDir, `backtest-exclusions-${OUTPUT_SUFFIX}.json`),
  JSON.stringify(exclusions, null, 2),
  "utf8",
);

console.log("\n=== BACKTEST COMPLETION SUMMARY ===");
console.table(
  byStation.map((item) => ({
    Station: item.stationName,
    EvaluatedStationDays: item.evaluatedStationDays,
    DeployableMedianTotalReductionPct: item.metrics.deployableTotalReductionPercent.median,
    DeployableMedianFlexibleReductionPct: item.metrics.deployableFlexibleReductionPercent.median,
    DeployableDaysAtLeast10PctTotal: item.metrics.deployableTotalReductionPercent.shareAtLeast10Percent,
    DeployableDaysAtLeast10PctFlexible: item.metrics.deployableFlexibleReductionPercent.shareAtLeast10Percent,
  })),
);

console.log("\n=== OVERALL METRICS ===");
console.log(JSON.stringify(summary.overallMetrics, null, 2));
console.log("\n=== MORNING / EVENING SUMMARY ===");
console.log(JSON.stringify(morningEveningSummary, null, 2));
console.log("\n=== DATA SPREAD COMPARISON ===");
console.log(JSON.stringify(summary.stationVsHourSpread, null, 2));
console.log("\nSaved files:");
console.log(`  data/results/backtest-day-results-${OUTPUT_SUFFIX}.json`);
console.log(`  data/results/backtest-day-results-${OUTPUT_SUFFIX}.csv`);
console.log(`  data/reports/backtest-summary-${OUTPUT_SUFFIX}.json`);
console.log(`  data/reports/backtest-exclusions-${OUTPUT_SUFFIX}.json`);
