import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  calculateActivityExposureIndex,
  calculatePlanExposureIndex,
} from "../lib/exposure";
import { BASELINE_MODEL_CONFIG } from "../lib/model-config";
import { optimizeSchedule } from "../lib/optimizer";
import { STUDENT_WEEKDAY_ACTIVITIES } from "../lib/scenario";
import type {
  Activity,
  ExposureModelConfig,
  HourlyPm25Profile,
  SchedulePlacement,
} from "../lib/types";

const root = process.cwd();
const normalizedPath = join(root, "data", "processed", "openaq-normalized-60d.json");
const cohortPath = join(root, "data", "results", "backtest-day-results-baseline.json");
const resultsDir = join(root, "data", "results");
const reportsDir = join(root, "data", "reports");

const GRID_MINUTES = 15;
const LOOKBACK_DAYS = 14;
const MIN_14_DAY_SAMPLES = 7;
const MIN_7_DAY_SAMPLES = 4;
const MIN_PREDICTED_GAIN_PERCENT = 10;
const PLANNING_START_HOUR = 5;
const PLANNING_END_HOUR_EXCLUSIVE = 21;

interface ProfileRow {
  date: string;
  stationId: string;
  stationName: string;
  sourceName: string;
  sourceUrl: string;
  dataRetrievedAt: string;
  timezone: string;
  hourlyPm25UgM3: (number | null)[];
  strictHourlyPm25UgM3?: (number | null)[];
}

interface StationRow {
  stationName: string;
  stationId: string;
  primaryStationEligible: boolean;
  profiles: ProfileRow[];
}

interface Dataset {
  stations: StationRow[];
}

interface CohortRow {
  date: string;
  stationName: string;
  stationId: string;
}

interface SummaryStats {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  shareAtLeast10Percent: number | null;
}

interface DayResult {
  date: string;
  stationId: string;
  stationName: string;
  decision: "move" | "fallback";
  fallbackReason: string | null;
  predictedGain7DayPct: number | null;
  predictedGain14DayPct: number | null;
  habitualExerciseStartMinute: number;
  recommendedExerciseStartMinute: number;
  habitualErrandStartMinute: number;
  recommendedErrandStartMinute: number;
  totalReductionPct: number | null;
  flexibleReductionPct: number | null;
  predictedBenefitAgreed: boolean;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
}

function validConcentration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asProfile(profile: ProfileRow, values = profile.hourlyPm25UgM3): HourlyPm25Profile {
  return {
    date: profile.date,
    stationId: profile.stationId,
    stationName: profile.stationName,
    sourceName: profile.sourceName,
    sourceUrl: profile.sourceUrl,
    dataRetrievedAt: profile.dataRetrievedAt,
    timezone: profile.timezone,
    hourlyPm25UgM3: values,
  };
}

function hasCompletePlanningWindow(values: (number | null)[]): boolean {
  if (values.length !== 24) return false;
  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    if (!validConcentration(values[hour])) return false;
  }
  return true;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

function summarize(values: (number | null)[]): SummaryStats {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    n: valid.length,
    median: median(valid),
    p25: quantile(valid, 0.25),
    p75: quantile(valid, 0.75),
    mean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null,
    min: valid.length ? Math.min(...valid) : null,
    max: valid.length ? Math.max(...valid) : null,
    shareAtLeast10Percent: valid.length ? (100 * valid.filter((value) => value >= 10).length) / valid.length : null,
  };
}

function startsById(placements: SchedulePlacement[]): Map<string, number> {
  return new Map(placements.map((placement) => [placement.activityId, placement.startMinute] as const));
}

function flexiblePlacementsAgree(a: SchedulePlacement[], b: SchedulePlacement[], activities: Activity[]): boolean {
  const aStarts = startsById(a);
  const bStarts = startsById(b);
  return activities
    .filter((activity) => activity.kind === "flexible")
    .every((activity) => aStarts.get(activity.id) === bStarts.get(activity.id));
}

function getRequiredStarts(placements: SchedulePlacement[]): { exercise: number; errand: number } {
  const starts = startsById(placements);
  const exercise = starts.get("outdoor-exercise");
  const errand = starts.get("outdoor-errand");
  if (exercise === undefined || errand === undefined) throw new Error("Scenario must include outdoor-exercise and outdoor-errand.");
  return { exercise, errand };
}

function aggregateHistory(
  target: ProfileRow,
  history: ProfileRow[],
  minSamples: number,
): HourlyPm25Profile | null {
  const values: (number | null)[] = Array(24).fill(null);
  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    const observations = history
      .map((profile) => profile.hourlyPm25UgM3[hour])
      .filter(validConcentration);
    if (observations.length < minSamples) return null;
    values[hour] = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  }
  return {
    ...asProfile(target, values),
    sourceName: `OpenAQ API v3: mean of prior ${history.length} calendar days`,
  };
}

function planScoreOrNull(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number | null {
  try {
    return calculatePlanExposureIndex(activities, placements, profile, config);
  } catch (error) {
    if (error instanceof Error && /^Missing or invalid PM2\.5 measurement for hour \d+\.$/.test(error.message)) return null;
    throw error;
  }
}

function flexibleScoreOrNull(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number | null {
  const starts = startsById(placements);
  let total = 0;
  try {
    for (const activity of activities) {
      if (activity.kind !== "flexible") continue;
      const start = starts.get(activity.id);
      if (start === undefined) throw new Error(`Missing placement for ${activity.id}`);
      total += calculateActivityExposureIndex(activity, start, profile, config);
    }
    return total;
  } catch (error) {
    if (error instanceof Error && /^Missing or invalid PM2\.5 measurement for hour \d+\.$/.test(error.message)) return null;
    throw error;
  }
}

function reductionPercent(baseline: number, alternative: number): number | null {
  return baseline > 0 ? ((baseline - alternative) / baseline) * 100 : null;
}

const dataset = readJson<Dataset>(normalizedPath);
const cohort = readJson<CohortRow[]>(cohortPath);
const stationById = new Map(dataset.stations.map((station) => [String(station.stationId), station] as const));
const results: DayResult[] = [];
const fallbackCounts = new Map<string, number>();

function addFallback(reason: string): void {
  fallbackCounts.set(reason, (fallbackCounts.get(reason) ?? 0) + 1);
}

let missingStationDays = 0;
let incompleteTargetDays = 0;

for (const cohortRow of cohort) {
  const station = stationById.get(String(cohortRow.stationId));
  if (!station) {
    missingStationDays++;
    continue;
  }

  const profiles = [...station.profiles].sort((a, b) => a.date.localeCompare(b.date));
  const index = profiles.findIndex((profile) => profile.date === cohortRow.date);
  if (index < LOOKBACK_DAYS) continue;

  const target = profiles[index];
  if (!target || !hasCompletePlanningWindow(target.hourlyPm25UgM3)) {
    incompleteTargetDays++;
    continue;
  }

  const previous14 = profiles.slice(index - LOOKBACK_DAYS, index);
  const previous7 = profiles.slice(index - 7, index);

  const actual = asProfile(target);
  const actualOptimisation = optimizeSchedule(STUDENT_WEEKDAY_ACTIVITIES, actual, BASELINE_MODEL_CONFIG, { slotMinutes: GRID_MINUTES });
  const habitualPlacements = actualOptimisation.baselinePlacements;

  const habitualTotal = planScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, habitualPlacements, actual, BASELINE_MODEL_CONFIG);
  const habitualFlexible = flexibleScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, habitualPlacements, actual, BASELINE_MODEL_CONFIG);
  if (habitualTotal === null || habitualFlexible === null) continue;

  const forecast14 = aggregateHistory(target, previous14, MIN_14_DAY_SAMPLES);
  const forecast7 = aggregateHistory(target, previous7, MIN_7_DAY_SAMPLES);

  let predictedGain14: number | null = null;
  let predictedGain7: number | null = null;
  let chosenPlacements = habitualPlacements;
  let fallbackReason: string | null = null;
  let agreement = false;

  let plan14: ReturnType<typeof optimizeSchedule> | null = null;
  let plan7: ReturnType<typeof optimizeSchedule> | null = null;

  if (!forecast14) {
    fallbackReason = "insufficient-14-day-history";
  } else {
    plan14 = optimizeSchedule(STUDENT_WEEKDAY_ACTIVITIES, forecast14, BASELINE_MODEL_CONFIG, { slotMinutes: GRID_MINUTES });
    predictedGain14 = plan14.reductionPercent;
  }

  if (!fallbackReason && !forecast7) {
    fallbackReason = "insufficient-7-day-history";
  } else if (!fallbackReason && forecast7) {
    plan7 = optimizeSchedule(STUDENT_WEEKDAY_ACTIVITIES, forecast7, BASELINE_MODEL_CONFIG, { slotMinutes: GRID_MINUTES });
    predictedGain7 = plan7.reductionPercent;
  }

  if (!fallbackReason && plan14 && plan7) {
    agreement = flexiblePlacementsAgree(plan14.optimizedPlacements, plan7.optimizedPlacements, STUDENT_WEEKDAY_ACTIVITIES);
    if (!agreement) {
      fallbackReason = "7-day-and-14-day-plans-disagree";
    } else if ((predictedGain14 ?? -Infinity) < MIN_PREDICTED_GAIN_PERCENT || (predictedGain7 ?? -Infinity) < MIN_PREDICTED_GAIN_PERCENT) {
      fallbackReason = "one-or-both-predicted-gains-below-10-percent";
    } else {
      chosenPlacements = plan14.optimizedPlacements;
    }
  }

  if (fallbackReason) addFallback(fallbackReason);

  const actualTotal = planScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, chosenPlacements, actual, BASELINE_MODEL_CONFIG);
  const actualFlexible = flexibleScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, chosenPlacements, actual, BASELINE_MODEL_CONFIG);
  if (actualTotal === null || actualFlexible === null) continue;

  const habitualStarts = getRequiredStarts(habitualPlacements);
  const recommendedStarts = getRequiredStarts(chosenPlacements);
  results.push({
    date: target.date,
    stationId: station.stationId,
    stationName: station.stationName,
    decision: fallbackReason ? "fallback" : "move",
    fallbackReason,
    predictedGain7DayPct: predictedGain7,
    predictedGain14DayPct: predictedGain14,
    habitualExerciseStartMinute: habitualStarts.exercise,
    recommendedExerciseStartMinute: recommendedStarts.exercise,
    habitualErrandStartMinute: habitualStarts.errand,
    recommendedErrandStartMinute: recommendedStarts.errand,
    totalReductionPct: reductionPercent(habitualTotal, actualTotal),
    flexibleReductionPct: reductionPercent(habitualFlexible, actualFlexible),
    predictedBenefitAgreed: agreement && !fallbackReason,
  });
}

const moved = results.filter((row) => row.decision === "move");
const fallback = results.filter((row) => row.decision === "fallback");
const harmfulMoved = moved.filter((row) => (row.flexibleReductionPct ?? 0) < 0);
const harmfulOverall = results.filter((row) => (row.flexibleReductionPct ?? 0) < 0);

const summary = {
  generatedAt: new Date().toISOString(),
  evaluationType: "exploratory retrospective evaluation on previously examined station-days; not an independent holdout",
  policy: {
    name: "frozen-mean7-mean14-consensus-10",
    rule: "Move only if 7-day and 14-day mean profiles select identical start times for all flexible activities AND both policies predict at least 10% total exposure-index reduction; otherwise keep habitual schedule.",
    minHistoricalValuesPerHour: { sevenDay: MIN_7_DAY_SAMPLES, fourteenDay: MIN_14_DAY_SAMPLES },
    gridMinutes: GRID_MINUTES,
  },
  data: {
    source: "data/processed/openaq-normalized-60d.json",
    originalCohortRows: cohort.length,
    evaluatedStationDays: results.length,
    movedDays: moved.length,
    fallbackDays: fallback.length,
    movedPercent: results.length ? (100 * moved.length) / results.length : null,
    skippedForMissingStation: missingStationDays,
    skippedForIncompleteTarget: incompleteTargetDays,
  },
  overallIncludingFallbackDays: {
    totalReductionPct: summarize(results.map((row) => row.totalReductionPct)),
    flexibleReductionPct: summarize(results.map((row) => row.flexibleReductionPct)),
    harmfulFlexibleDays: harmfulOverall.length,
    harmfulFlexibleDaysPercent: results.length ? (100 * harmfulOverall.length) / results.length : null,
  },
  onlyWhenScheduleMoves: {
    n: moved.length,
    totalReductionPct: summarize(moved.map((row) => row.totalReductionPct)),
    flexibleReductionPct: summarize(moved.map((row) => row.flexibleReductionPct)),
    harmfulFlexibleDays: harmfulMoved.length,
    harmfulFlexibleDaysPercent: moved.length ? (100 * harmfulMoved.length) / moved.length : null,
  },
  fallbackReasons: Object.fromEntries(fallbackCounts),
  stationSummary: [...new Set(results.map((row) => row.stationId))].map((stationId) => {
    const rows = results.filter((row) => row.stationId === stationId);
    const changed = rows.filter((row) => row.decision === "move");
    return {
      stationId,
      stationName: rows[0]?.stationName,
      evaluatedDays: rows.length,
      movedDays: changed.length,
      medianOverallTotalReductionPct: summarize(rows.map((row) => row.totalReductionPct)).median,
      medianOverallFlexibleReductionPct: summarize(rows.map((row) => row.flexibleReductionPct)).median,
      harmfulFlexibleDays: rows.filter((row) => (row.flexibleReductionPct ?? 0) < 0).length,
    };
  }),
};

mkdirSync(resultsDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(resultsDir, "frozen-policy-results.json"), JSON.stringify(results, null, 2), "utf8");
const csvHeaders = Object.keys(results[0] ?? {});
const escapeCsv = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
writeFileSync(join(resultsDir, "frozen-policy-results.csv"), [csvHeaders.join(","), ...results.map((row) => csvHeaders.map((header) => escapeCsv((row as unknown as Record<string, unknown>)[header])).join(","))].join("\n"), "utf8");
writeFileSync(join(reportsDir, "frozen-policy-summary.json"), JSON.stringify(summary, null, 2), "utf8");

console.log("\n=== FROZEN POLICY: OVERALL INCLUDING FALLBACKS ===");
console.log(JSON.stringify(summary.overallIncludingFallbackDays, null, 2));
console.log("\n=== ONLY WHEN SCHEDULE MOVES ===");
console.log(JSON.stringify(summary.onlyWhenScheduleMoves, null, 2));
console.log("\n=== DECISIONS BY STATION ===");
console.table(summary.stationSummary.map((row) => ({
  Station: row.stationName,
  N: row.evaluatedDays,
  Moved: row.movedDays,
  MedianTotalPct: row.medianOverallTotalReductionPct === null ? null : Number(row.medianOverallTotalReductionPct.toFixed(2)),
  MedianFlexiblePct: row.medianOverallFlexibleReductionPct === null ? null : Number(row.medianOverallFlexibleReductionPct.toFixed(2)),
  HarmfulFlexibleDays: row.harmfulFlexibleDays,
})));
console.log("\n=== FALLBACK REASONS ===");
console.log(JSON.stringify(summary.fallbackReasons, null, 2));
console.log("\nSaved data/results/frozen-policy-results.json and .csv");
console.log("Saved data/reports/frozen-policy-summary.json");
