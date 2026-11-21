import {
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function readJson(relativePath) {
  const path = join(root, relativePath);
  return JSON.parse(
    readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
  );
}

const dataset = readJson(
  "data/processed/openaq-normalized-60d.json",
);

const results = readJson(
  "data/results/backtest-day-results-baseline.json",
);

const MIN_HISTORY_VALUES = 7;
const LOOKBACK_DAYS = 14;
const EXERCISE_DURATION_MINUTES = 45;

function validNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function parseStartMinute(placement) {
  if (Number.isInteger(placement?.startMinute)) {
    return placement.startMinute;
  }

  const value = placement?.startTime;

  if (typeof value === "string") {
    const match = value.match(/^(\d{1,2}):(\d{2})$/);

    if (match) {
      return Number(match[1]) * 60 + Number(match[2]);
    }
  }

  return null;
}

function getExerciseStart(schedule) {
  if (!Array.isArray(schedule)) return null;

  const activity = schedule.find(
    (item) => item.activityId === "outdoor-exercise",
  );

  return parseStartMinute(activity);
}

function exposureForDuration(hourlyValues, startMinute, durationMinutes) {
  const endMinute = startMinute + durationMinutes;

  let score = 0;

  for (
    let hour = Math.floor(startMinute / 60);
    hour <= Math.floor((endMinute - 1) / 60);
    hour++
  ) {
    const concentration = hourlyValues[hour];

    if (!validNumber(concentration)) return null;

    const overlapStart = Math.max(startMinute, hour * 60);
    const overlapEnd = Math.min(endMinute, (hour + 1) * 60);

    score += concentration * (overlapEnd - overlapStart);
  }

  return score;
}

function percentile(values, p) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;

  return sorted[low] * (1 - fraction) + sorted[high] * fraction;
}

function summarize(values) {
  const valid = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  );

  return {
    n: valid.length,
    median: percentile(valid, 0.5),
    p25: percentile(valid, 0.25),
    p75: percentile(valid, 0.75),
    mean:
      valid.length > 0
        ? valid.reduce((sum, value) => sum + value, 0) / valid.length
        : null,
  };
}

const stationById = new Map(
  dataset.stations.map((station) => [
    String(station.stationId),
    station,
  ]),
);

const rows = [];
const hourlyErrors = [];

for (const result of results) {
  const station = stationById.get(String(result.stationId));

  if (!station) continue;

  const target = station.profiles.find(
    (profile) => profile.date === result.date,
  );

  if (!target) continue;

  const targetDateMs = Date.parse(`${result.date}T00:00:00Z`);

  const history = station.profiles.filter((profile) => {
    const dateMs = Date.parse(`${profile.date}T00:00:00Z`);
    const daysBefore = (targetDateMs - dateMs) / 86_400_000;

    return daysBefore >= 1 && daysBefore <= LOOKBACK_DAYS;
  });

  // The deployable policy may use only these historical observations.
  const predictedHourly = Array(24).fill(null);
  const historyCountByHour = Array(24).fill(0);

  for (let hour = 0; hour < 24; hour++) {
    const values = history
      .map((profile) => profile.hourlyPm25UgM3[hour])
      .filter(validNumber);

    historyCountByHour[hour] = values.length;

    if (values.length >= MIN_HISTORY_VALUES) {
      predictedHourly[hour] =
        values.reduce((sum, value) => sum + value, 0) /
        values.length;
    }

    if (
      hour >= 5 &&
      hour <= 20 &&
      values.length >= MIN_HISTORY_VALUES &&
      validNumber(target.hourlyPm25UgM3[hour])
    ) {
      hourlyErrors.push({
        station: station.stationName,
        date: result.date,
        hour,
        prediction: predictedHourly[hour],
        actual: target.hourlyPm25UgM3[hour],
        absoluteError: Math.abs(
          predictedHourly[hour] - target.hourlyPm25UgM3[hour],
        ),
      });
    }
  }

  const habitualStart = getExerciseStart(result.habitualSchedule);
  const recommendedStart = getExerciseStart(result.deployableSchedule);

  if (habitualStart === null || recommendedStart === null) continue;

  const predictedHabitual = exposureForDuration(
    predictedHourly,
    habitualStart,
    EXERCISE_DURATION_MINUTES,
  );

  const predictedRecommended = exposureForDuration(
    predictedHourly,
    recommendedStart,
    EXERCISE_DURATION_MINUTES,
  );

  const actualHabitual = exposureForDuration(
    target.hourlyPm25UgM3,
    habitualStart,
    EXERCISE_DURATION_MINUTES,
  );

  const actualRecommended = exposureForDuration(
    target.hourlyPm25UgM3,
    recommendedStart,
    EXERCISE_DURATION_MINUTES,
  );

  if (
    predictedHabitual === null ||
    predictedRecommended === null ||
    actualHabitual === null ||
    actualRecommended === null ||
    predictedHabitual <= 0 ||
    actualHabitual <= 0
  ) {
    continue;
  }

  const predictedReduction =
    ((predictedHabitual - predictedRecommended) /
      predictedHabitual) *
    100;

  const realizedReduction =
    ((actualHabitual - actualRecommended) / actualHabitual) * 100;

  rows.push({
    station: station.stationName,
    stationId: String(station.stationId),
    date: result.date,

    habitualStart,
    recommendedStart,

    predictedHabitualExposure: predictedHabitual,
    predictedRecommendedExposure: predictedRecommended,
    actualHabitualExposure: actualHabitual,
    actualRecommendedExposure: actualRecommended,

    predictedReductionPercent: predictedReduction,
    realizedReductionPercent: realizedReduction,

    predictedBenefit: predictedReduction > 0,
    realizedBenefit: realizedReduction > 0,

    harmfulRecommendation:
      predictedReduction > 0 && realizedReduction < 0,

    predictionErrorPercentagePoints:
      predictedReduction - realizedReduction,
  });
}

const absoluteErrors = hourlyErrors.map(
  (row) => row.absoluteError,
);

const forecastErrorByHour = [];

for (let hour = 5; hour <= 20; hour++) {
  const matching = hourlyErrors.filter((row) => row.hour === hour);

  forecastErrorByHour.push({
    hour,
    samples: matching.length,
    meanAbsoluteError:
      matching.length > 0
        ? matching.reduce(
            (sum, row) => sum + row.absoluteError,
            0,
          ) / matching.length
        : null,
  });
}

const harmful = rows
  .filter((row) => row.harmfulRecommendation)
  .sort(
    (a, b) => a.realizedReductionPercent - b.realizedReductionPercent,
  );

const report = {
  method: {
    lookbackDays: LOOKBACK_DAYS,
    minimumHistoricalValuesPerHour: MIN_HISTORY_VALUES,
    exerciseDurationMinutes: EXERCISE_DURATION_MINUTES,
    note:
      "This analysis evaluates the exercise time choice. Concentration × minutes is used because exercise intensity and environment are identical in both compared periods.",
  },

  sampleSize: rows.length,

  hourlyForecastError: {
    sampleCount: hourlyErrors.length,
    meanAbsoluteError: summarize(absoluteErrors).mean,
    medianAbsoluteError: percentile(absoluteErrors, 0.5),
    byHour: forecastErrorByHour,
  },

  predictedExerciseReductionPercent: summarize(
    rows.map((row) => row.predictedReductionPercent),
  ),

  realizedExerciseReductionPercent: summarize(
    rows.map((row) => row.realizedReductionPercent),
  ),

  harmfulRecommendations: {
    count: harmful.length,
    sharePercent:
      rows.length > 0 ? (100 * harmful.length) / rows.length : null,
  },

  directionAgreementPercent:
    rows.length > 0
      ? (100 *
          rows.filter(
            (row) =>
              row.predictedBenefit === row.realizedBenefit,
          ).length) /
        rows.length
      : null,

  harmfulExamples: harmful.slice(0, 15),
  stationDayResults: rows,
};

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "policy-prediction-skill.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log("\n=== PREDICTION SKILL SUMMARY ===");
console.log(JSON.stringify({
  sampleSize: report.sampleSize,
  hourlyForecastError: report.hourlyForecastError,
  predictedExerciseReductionPercent:
    report.predictedExerciseReductionPercent,
  realizedExerciseReductionPercent:
    report.realizedExerciseReductionPercent,
  harmfulRecommendations: report.harmfulRecommendations,
  directionAgreementPercent: report.directionAgreementPercent,
}, null, 2));

console.log("\n=== WORST HARMFUL RECOMMENDATIONS ===");
console.table(
  report.harmfulExamples.slice(0, 10).map((row) => ({
    Station: row.station,
    Date: row.date,
    PredictedReductionPct:
      Number(row.predictedReductionPercent.toFixed(2)),
    RealizedReductionPct:
      Number(row.realizedReductionPercent.toFixed(2)),
    HabitualStart:
      `${String(Math.floor(row.habitualStart / 60)).padStart(2, "0")}:` +
      `${String(row.habitualStart % 60).padStart(2, "0")}`,
    RecommendedStart:
      `${String(Math.floor(row.recommendedStart / 60)).padStart(2, "0")}:` +
      `${String(row.recommendedStart % 60).padStart(2, "0")}`,
  })),
);

console.log("\nSaved report to data/reports/policy-prediction-skill.json");