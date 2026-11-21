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
const baselineResultsPath = join(root, "data", "results", "backtest-day-results-baseline.json");
const outputDir = join(root, "data", "results");
const reportDir = join(root, "data", "reports");

const GRID_MINUTES = 15;
const PLANNING_START_HOUR = 5;
const PLANNING_END_HOUR_EXCLUSIVE = 21;
const MIN_14_DAY_SAMPLES = 7;
const MIN_7_DAY_SAMPLES = 4;
const MIN_PREDICTED_TOTAL_GAIN_PERCENT = 10;
const HISTORY_VOTE_MIN_FRACTION = 0.70;
const HISTORY_VOTE_MIN_DAYS = 7;

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

interface BaselineResultRow {
  date: string;
  stationName: string;
  stationId: string;
}

type PolicyName =
  | "mean14"
  | "mean7"
  | "median14"
  | "median7"
  | "consensus14MeanMedian"
  | "historyVote70";

interface ScoreSummary {
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  shareAtLeast10Percent: number | null;
  harmfulCount: number;
  harmfulSharePercent: number | null;
}

interface PolicyDayResult {
  policy: PolicyName;
  date: string;
  stationId: string;
  stationName: string;
  baselineTotal: number;
  policyTotal: number;
  baselineFlexible: number;
  policyFlexible: number;
  totalReductionPercent: number | null;
  flexibleReductionPercent: number | null;
  predictedTotalReductionPercent: number | null;
  exerciseStartMinute: number;
  errandStartMinute: number;
  movedFromHabitual: boolean;
  fallbackReason: string | null;
  historyVoteDays: number | null;
  historyVoteFraction: number | null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
}

function isValidConcentration(value: unknown): value is number {
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

function isCompletePlanningWindow(values: (number | null)[]): boolean {
  if (values.length !== 24) return false;
  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    if (!isValidConcentration(values[hour])) return false;
  }
  return true;
}

function flexibleExposureIndex(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number {
  const starts = new Map(placements.map((placement) => [placement.activityId, placement.startMinute] as const));
  let total = 0;
  for (const activity of activities) {
    if (activity.kind !== "flexible") continue;
    const start = starts.get(activity.id);
    if (start === undefined) throw new Error(`Missing placement for ${activity.id}`);
    total += calculateActivityExposureIndex(activity, start, profile, config);
  }
  return total;
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
    if (
      error instanceof Error &&
      /^Missing or invalid PM2\.5 measurement for hour \d+\.$/.test(error.message)
    ) return null;
    throw error;
  }
}

function flexibleScoreOrNull(
  activities: Activity[],
  placements: SchedulePlacement[],
  profile: HourlyPm25Profile,
  config: ExposureModelConfig,
): number | null {
  try {
    return flexibleExposureIndex(activities, placements, profile, config);
  } catch (error) {
    if (
      error instanceof Error &&
      /^Missing or invalid PM2\.5 measurement for hour \d+\.$/.test(error.message)
    ) return null;
    throw error;
  }
}

function reductionPercent(baseline: number, alternative: number): number | null {
  if (!(baseline > 0)) return null;
  return ((baseline - alternative) / baseline) * 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return low === high ? sorted[low] : sorted[low] * (high - pos) + sorted[high] * (pos - low);
}

function summarize(values: (number | null)[]): ScoreSummary {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const harmful = valid.filter((value) => value < 0).length;
  return {
    n: valid.length,
    median: median(valid),
    p25: quantile(valid, 0.25),
    p75: quantile(valid, 0.75),
    min: valid.length ? Math.min(...valid) : null,
    max: valid.length ? Math.max(...valid) : null,
    mean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null,
    shareAtLeast10Percent: valid.length ? (100 * valid.filter((value) => value >= 10).length) / valid.length : null,
    harmfulCount: harmful,
    harmfulSharePercent: valid.length ? (100 * harmful) / valid.length : null,
  };
}

function aggregateProfile(
  target: ProfileRow,
  history: ProfileRow[],
  method: "mean" | "median",
  minimumSamples: number,
): { profile: HourlyPm25Profile | null; countsByHour: number[] } {
  const values: (number | null)[] = Array(24).fill(null);
  const countsByHour = Array(24).fill(0) as number[];

  for (let hour = PLANNING_START_HOUR; hour < PLANNING_END_HOUR_EXCLUSIVE; hour++) {
    const observations = history
      .map((profile) => profile.hourlyPm25UgM3[hour])
      .filter(isValidConcentration);
    countsByHour[hour] = observations.length;
    if (observations.length < minimumSamples) {
      return { profile: null, countsByHour };
    }
    if (method === "mean") {
      values[hour] = observations.reduce((sum, value) => sum + value, 0) / observations.length;
    } else {
      values[hour] = median(observations);
    }
  }

  return {
    profile: {
      ...asProfile(target, values),
      sourceName: `OpenAQ API v3: ${method} of previous ${history.length} calendar days`,
    },
    countsByHour,
  };
}

function startsById(placements: SchedulePlacement[]): Map<string, number> {
  return new Map(placements.map((placement) => [placement.activityId, placement.startMinute] as const));
}

function sameFlexiblePlacements(a: SchedulePlacement[], b: SchedulePlacement[], activities: Activity[]): boolean {
  const aStarts = startsById(a);
  const bStarts = startsById(b);
  return activities
    .filter((activity) => activity.kind === "flexible")
    .every((activity) => aStarts.get(activity.id) === bStarts.get(activity.id));
}

function exerciseAndErrandStarts(placements: SchedulePlacement[]): { exercise: number; errand: number } {
  const starts = startsById(placements);
  const exercise = starts.get("outdoor-exercise");
  const errand = starts.get("outdoor-errand");
  if (exercise === undefined || errand === undefined) throw new Error("Scenario must include exercise and errand.");
  return { exercise, errand };
}


function makeCandidate(
  method: "mean" | "median",
  windowDays: 7 | 14,
  target: ProfileRow,
  history: ProfileRow[],
): { plan: ReturnType<typeof optimizeSchedule> | null; predictedGain: number | null; forecast: HourlyPm25Profile | null; countsByHour: number[] } {
  const minSamples = windowDays === 7 ? MIN_7_DAY_SAMPLES : MIN_14_DAY_SAMPLES;
  const built = aggregateProfile(target, history, method, minSamples);
  if (!built.profile) return { plan: null, predictedGain: null, forecast: null, countsByHour: built.countsByHour };
  const plan = optimizeSchedule(STUDENT_WEEKDAY_ACTIVITIES, built.profile, BASELINE_MODEL_CONFIG, { slotMinutes: GRID_MINUTES });
  return {
    plan,
    predictedGain: plan.reductionPercent,
    forecast: built.profile,
    countsByHour: built.countsByHour,
  };
}

const dataset = readJson<Dataset>(normalizedPath);
const primaryRows = readJson<BaselineResultRow[]>(baselineResultsPath);
const stationById = new Map(dataset.stations.map((station) => [String(station.stationId), station] as const));

const results: PolicyDayResult[] = [];
const candidateNames: PolicyName[] = ["mean14", "mean7", "median14", "median7", "consensus14MeanMedian", "historyVote70"];
const fallbackCounts = new Map<PolicyName, Map<string, number>>();
for (const name of candidateNames) fallbackCounts.set(name, new Map());

function incrementFallback(policy: PolicyName, reason: string): void {
  const map = fallbackCounts.get(policy)!;
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

for (const cohortRow of primaryRows) {
  const station = stationById.get(String(cohortRow.stationId));
  if (!station) continue;
  const profiles = [...station.profiles].sort((a, b) => a.date.localeCompare(b.date));
  const index = profiles.findIndex((profile) => profile.date === cohortRow.date);
  if (index < 14) continue;
  const target = profiles[index];
  if (!isCompletePlanningWindow(target.hourlyPm25UgM3)) continue;
  const previous14 = profiles.slice(index - 14, index);
  const previous7 = profiles.slice(index - 7, index);

  const actual = asProfile(target);
  const actualOracle = optimizeSchedule(STUDENT_WEEKDAY_ACTIVITIES, actual, BASELINE_MODEL_CONFIG, { slotMinutes: GRID_MINUTES });
  const habitualPlacements = actualOracle.baselinePlacements;
  const habitualTotal = calculatePlanExposureIndex(STUDENT_WEEKDAY_ACTIVITIES, habitualPlacements, actual, BASELINE_MODEL_CONFIG);
  const habitualFlexible = flexibleExposureIndex(STUDENT_WEEKDAY_ACTIVITIES, habitualPlacements, actual, BASELINE_MODEL_CONFIG);

  const mean14 = makeCandidate("mean", 14, target, previous14);
  const mean7 = makeCandidate("mean", 7, target, previous7);
  const median14 = makeCandidate("median", 14, target, previous14);
  const median7 = makeCandidate("median", 7, target, previous7);

  const candidatePlans: Record<PolicyName, { placements: SchedulePlacement[]; predictedGain: number | null; fallbackReason: string | null; historyVoteDays: number | null; historyVoteFraction: number | null }> = {
    mean14: { placements: mean14.plan?.optimizedPlacements ?? habitualPlacements, predictedGain: mean14.predictedGain, fallbackReason: mean14.plan ? null : "insufficient-14-day-mean-history", historyVoteDays: null, historyVoteFraction: null },
    mean7: { placements: mean7.plan?.optimizedPlacements ?? habitualPlacements, predictedGain: mean7.predictedGain, fallbackReason: mean7.plan ? null : "insufficient-7-day-mean-history", historyVoteDays: null, historyVoteFraction: null },
    median14: { placements: median14.plan?.optimizedPlacements ?? habitualPlacements, predictedGain: median14.predictedGain, fallbackReason: median14.plan ? null : "insufficient-14-day-median-history", historyVoteDays: null, historyVoteFraction: null },
    median7: { placements: median7.plan?.optimizedPlacements ?? habitualPlacements, predictedGain: median7.predictedGain, fallbackReason: median7.plan ? null : "insufficient-7-day-median-history", historyVoteDays: null, historyVoteFraction: null },
    consensus14MeanMedian: { placements: habitualPlacements, predictedGain: mean14.predictedGain, fallbackReason: null, historyVoteDays: null, historyVoteFraction: null },
    historyVote70: { placements: habitualPlacements, predictedGain: mean14.predictedGain, fallbackReason: null, historyVoteDays: null, historyVoteFraction: null },
  };

  // Consensus policy: only move when 7-day and 14-day means and the 14-day median
  // agree on both flexible activity start times and the 14-day mean predicts >=10% gain.
  if (!mean14.plan || !mean7.plan || !median14.plan) {
    candidatePlans.consensus14MeanMedian.fallbackReason = "insufficient-forecast-profile";
    incrementFallback("consensus14MeanMedian", "insufficient-forecast-profile");
  } else if (
    !sameFlexiblePlacements(mean14.plan.optimizedPlacements, mean7.plan.optimizedPlacements, STUDENT_WEEKDAY_ACTIVITIES) ||
    !sameFlexiblePlacements(mean14.plan.optimizedPlacements, median14.plan.optimizedPlacements, STUDENT_WEEKDAY_ACTIVITIES)
  ) {
    candidatePlans.consensus14MeanMedian.fallbackReason = "forecast-methods-disagree";
    incrementFallback("consensus14MeanMedian", "forecast-methods-disagree");
  } else if ((mean14.predictedGain ?? 0) < MIN_PREDICTED_TOTAL_GAIN_PERCENT) {
    candidatePlans.consensus14MeanMedian.fallbackReason = "predicted-benefit-below-10-percent";
    incrementFallback("consensus14MeanMedian", "predicted-benefit-below-10-percent");
  } else {
    candidatePlans.consensus14MeanMedian.placements = mean14.plan.optimizedPlacements;
  }

  // Historical-consistency policy: use the 14-day mean candidate only if at least
  // 70% of sufficiently observed days in the lookback also score it better than habitual.
  if (!mean14.plan || (mean14.predictedGain ?? 0) < MIN_PREDICTED_TOTAL_GAIN_PERCENT) {
    candidatePlans.historyVote70.fallbackReason = !mean14.plan
      ? "insufficient-14-day-mean-history"
      : "predicted-benefit-below-10-percent";
    incrementFallback("historyVote70", candidatePlans.historyVote70.fallbackReason!);
  } else {
    let comparableDays = 0;
    let winningDays = 0;
    for (const historical of previous14) {
      const historyProfile = asProfile(historical);
      const baseScore = planScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, habitualPlacements, historyProfile, BASELINE_MODEL_CONFIG);
      const candidateScore = planScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, mean14.plan.optimizedPlacements, historyProfile, BASELINE_MODEL_CONFIG);
      if (baseScore === null || candidateScore === null) continue;
      comparableDays++;
      if (candidateScore < baseScore) winningDays++;
    }
    const fraction = comparableDays > 0 ? winningDays / comparableDays : null;
    candidatePlans.historyVote70.historyVoteDays = comparableDays;
    candidatePlans.historyVote70.historyVoteFraction = fraction;
    if (comparableDays < HISTORY_VOTE_MIN_DAYS) {
      candidatePlans.historyVote70.fallbackReason = "insufficient-comparable-history-days";
      incrementFallback("historyVote70", "insufficient-comparable-history-days");
    } else if ((fraction ?? 0) < HISTORY_VOTE_MIN_FRACTION) {
      candidatePlans.historyVote70.fallbackReason = "historical-benefit-not-consistent";
      incrementFallback("historyVote70", "historical-benefit-not-consistent");
    } else {
      candidatePlans.historyVote70.placements = mean14.plan.optimizedPlacements;
    }
  }

  for (const policy of candidateNames) {
    const candidate = candidatePlans[policy];
    const total = planScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, candidate.placements, actual, BASELINE_MODEL_CONFIG);
    const flexible = flexibleScoreOrNull(STUDENT_WEEKDAY_ACTIVITIES, candidate.placements, actual, BASELINE_MODEL_CONFIG);
    if (total === null || flexible === null) continue;

    if (candidate.fallbackReason && policy !== "consensus14MeanMedian" && policy !== "historyVote70") {
      incrementFallback(policy, candidate.fallbackReason);
    }

    const starts = exerciseAndErrandStarts(candidate.placements);
    results.push({
      policy,
      date: target.date,
      stationId: station.stationId,
      stationName: station.stationName,
      baselineTotal: habitualTotal,
      policyTotal: total,
      baselineFlexible: habitualFlexible,
      policyFlexible: flexible,
      totalReductionPercent: reductionPercent(habitualTotal, total),
      flexibleReductionPercent: reductionPercent(habitualFlexible, flexible),
      predictedTotalReductionPercent: candidate.predictedGain,
      exerciseStartMinute: starts.exercise,
      errandStartMinute: starts.errand,
      movedFromHabitual: starts.exercise !== 420 || starts.errand !== 1080,
      fallbackReason: candidate.fallbackReason,
      historyVoteDays: candidate.historyVoteDays,
      historyVoteFraction: candidate.historyVoteFraction,
    });
  }
}

const policySummaries = candidateNames.map((policy) => {
  const rows = results.filter((row) => row.policy === policy);
  return {
    policy,
    n: rows.length,
    totalReduction: summarize(rows.map((row) => row.totalReductionPercent)),
    flexibleReduction: summarize(rows.map((row) => row.flexibleReductionPercent)),
    movedFromHabitualCount: rows.filter((row) => row.movedFromHabitual).length,
    movedFromHabitualPercent: rows.length ? 100 * rows.filter((row) => row.movedFromHabitual).length / rows.length : null,
    fallbackReasons: Object.fromEntries(fallbackCounts.get(policy)!),
    harmfulRecommendationCount: rows.filter((row) => (row.flexibleReductionPercent ?? 0) < 0).length,
  };
});

mkdirSync(outputDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });
writeFileSync(join(outputDir, "policy-comparison-results.json"), JSON.stringify(results, null, 2), "utf8");
writeFileSync(join(outputDir, "policy-comparison-results.csv"), [
  Object.keys(results[0] ?? {}).join(","),
  ...results.map((row) => Object.values(row).map((value) => value === null || value === undefined ? "" : String(value).includes(",") ? `"${String(value).replaceAll('"', '""')}"` : String(value)).join(",")),
].join("\n"), "utf8");
writeFileSync(join(reportDir, "policy-comparison-summary.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  baselineCohortStationDays: primaryRows.length,
  policies: policySummaries,
  methodology: {
    mean14: "Mean hourly concentration over the previous 14 calendar days; minimum 7 valid historical values per hour.",
    mean7: "Mean hourly concentration over the previous 7 calendar days; minimum 4 valid historical values per hour.",
    median14: "Median hourly concentration over the previous 14 calendar days; minimum 7 valid historical values per hour.",
    median7: "Median hourly concentration over the previous 7 calendar days; minimum 4 valid historical values per hour.",
    consensus14MeanMedian: `Use 14-day mean plan only when 7-day mean and 14-day median choose the same starts for all flexible activities and the 14-day mean predicts at least ${MIN_PREDICTED_TOTAL_GAIN_PERCENT}% total reduction; otherwise keep habitual schedule.`,
    historyVote70: `Use 14-day mean plan only when its predicted total gain is at least ${MIN_PREDICTED_TOTAL_GAIN_PERCENT}% and it scores better than habitual on at least ${HISTORY_VOTE_MIN_FRACTION * 100}% of at least ${HISTORY_VOTE_MIN_DAYS} comparable prior days; otherwise keep habitual schedule.`,
    cohort: "Reuses station-days from the previously saved primary baseline run, to compare policies on the same set when historical profiles are available.",
    caveat: "This tests historical-profile heuristics, not a true meteorological forecast. Policies and thresholds should be treated as a prespecified exploratory comparison, not tuned repeatedly against a final held-out test set.",
  },
}, null, 2), "utf8");

console.log("\n=== DEPLOYABLE POLICY COMPARISON ===");
console.table(policySummaries.map((summary) => ({
  Policy: summary.policy,
  N: summary.n,
  MedianTotalReductionPct: summary.totalReduction.median === null ? null : Number(summary.totalReduction.median.toFixed(2)),
  MedianFlexibleReductionPct: summary.flexibleReduction.median === null ? null : Number(summary.flexibleReduction.median.toFixed(2)),
  TotalDaysAtLeast10Pct: summary.totalReduction.shareAtLeast10Percent === null ? null : Number(summary.totalReduction.shareAtLeast10Percent.toFixed(1)),
  HarmfulFlexibleDays: summary.harmfulRecommendationCount,
  ShiftedDays: summary.movedFromHabitualCount,
  FallbackReasons: JSON.stringify(summary.fallbackReasons),
})));
console.log("\nSaved data/results/policy-comparison-results.json and .csv");
console.log("Saved data/reports/policy-comparison-summary.json");
