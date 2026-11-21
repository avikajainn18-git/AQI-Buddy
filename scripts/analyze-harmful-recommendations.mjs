import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function load(filename) {
  return JSON.parse(
    readFileSync(
      join(root, "data", "results", filename),
      "utf8",
    ).replace(/^\uFEFF/, ""),
  );
}

const primary = load("backtest-day-results-baseline.json");
const strict = load("backtest-day-results-baseline-strict.json");

function key(row) {
  return `${row.stationId}|${row.date}`;
}

const strictByKey = new Map(strict.map((row) => [key(row), row]));

const worst = primary
  .filter(
    (row) =>
      typeof row.deployableTotalReductionPercent === "number" &&
      Number.isFinite(row.deployableTotalReductionPercent),
  )
  .sort(
    (a, b) =>
      a.deployableTotalReductionPercent -
      b.deployableTotalReductionPercent,
  )
  .slice(0, 15);

function findExercise(schedule) {
  return schedule?.find(
    (activity) =>
      activity.activityId === "outdoor-exercise",
  );
}

const rows = worst.map((row) => {
  const strictRow = strictByKey.get(key(row));
  const habitualExercise = findExercise(row.habitualSchedule);
  const deployableExercise = findExercise(row.deployableSchedule);

  return {
    station: row.stationName,
    date: row.date,

    primaryTotalReductionPct:
      row.deployableTotalReductionPercent,

    strictTotalReductionPct:
      strictRow?.deployableTotalReductionPercent ?? null,

    primaryFlexibleReductionPct:
      row.deployableFlexibleReductionPercent,

    habitualExerciseTime:
      habitualExercise?.startTime ?? "unknown",

    recommendedExerciseTime:
      deployableExercise?.startTime ?? "unknown",

    habitualExercisePeriod:
      row.habitualExercisePeriod,

    deployableExercisePeriod:
      row.deployableExercisePeriod,
  };
});

console.log("\n=== 15 WORST DEPLOYABLE RECOMMENDATIONS ===");
console.table(
  rows.map((row) => ({
    Station: row.station,
    Date: row.date,
    PrimaryTotalPct: Number(
      row.primaryTotalReductionPct.toFixed(2),
    ),
    StrictTotalPct:
      row.strictTotalReductionPct === null
        ? null
        : Number(row.strictTotalReductionPct.toFixed(2)),
    FlexiblePct: Number(
      row.primaryFlexibleReductionPct.toFixed(2),
    ),
    OriginalExercise: row.habitualExerciseTime,
    RecommendedExercise: row.recommendedExerciseTime,
  })),
);

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "harmful-recommendations-analysis.json"),
  JSON.stringify(rows, null, 2),
  "utf8",
);

console.log(
  "\nFull report saved to data/reports/harmful-recommendations-analysis.json",
);