import {
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function loadResults(filename) {
  const path = join(root, "data", "results", filename);
  const data = JSON.parse(
    readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
  );

  if (!Array.isArray(data)) {
    throw new Error(`${filename} must contain a results array.`);
  }

  return data;
}

const primary = loadResults("backtest-day-results-baseline.json");
const strict = loadResults("backtest-day-results-baseline-strict.json");

function key(row) {
  return `${row.stationId}|${row.date}`;
}

const primaryByKey = new Map(primary.map((row) => [key(row), row]));
const strictByKey = new Map(strict.map((row) => [key(row), row]));

const matched = [];

for (const [id, primaryRow] of primaryByKey) {
  const strictRow = strictByKey.get(id);

  if (strictRow) {
    matched.push({
      stationId: primaryRow.stationId,
      stationName: primaryRow.stationName,
      date: primaryRow.date,
      primaryTotal: primaryRow.deployableTotalReductionPercent,
      strictTotal: strictRow.deployableTotalReductionPercent,
      primaryFlexible: primaryRow.deployableFlexibleReductionPercent,
      strictFlexible: strictRow.deployableFlexibleReductionPercent,
    });
  }
}

function summarize(values) {
  const valid = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value),
  ).sort((a, b) => a - b);

  if (valid.length === 0) {
    return { n: 0 };
  }

  const quantile = (p) => {
    const position = (valid.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;

    return valid[lower] * (1 - fraction) + valid[upper] * fraction;
  };

  return {
    n: valid.length,
    median: quantile(0.5),
    p25: quantile(0.25),
    p75: quantile(0.75),
    min: valid[0],
    max: valid[valid.length - 1],
    shareAtLeast10Percent:
      100 * valid.filter((value) => value >= 10).length / valid.length,
  };
}

const summary = {
  primaryStationDays: primary.length,
  strictStationDays: strict.length,
  matchedStationDays: matched.length,
  primaryOnlyStationDays: primary.filter(
    (row) => !strictByKey.has(key(row)),
  ).length,
  strictOnlyStationDays: strict.filter(
    (row) => !primaryByKey.has(key(row)),
  ).length,
  matchedPrimaryTotal: summarize(matched.map((row) => row.primaryTotal)),
  matchedStrictTotal: summarize(matched.map((row) => row.strictTotal)),
  matchedPrimaryFlexible: summarize(
    matched.map((row) => row.primaryFlexible),
  ),
  matchedStrictFlexible: summarize(
    matched.map((row) => row.strictFlexible),
  ),
};

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "matched-primary-strict-comparison.json"),
  JSON.stringify({ summary, matched }, null, 2),
  "utf8",
);

console.log("\n=== MATCHED PRIMARY VS STRICT ===");
console.log(JSON.stringify(summary, null, 2));
console.log("\nSaved detailed results to:");
console.log("data/reports/matched-primary-strict-comparison.json");