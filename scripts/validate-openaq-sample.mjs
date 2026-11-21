import {
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const inputPath = join(
  root,
  "data",
  "raw",
  "openaq-hourly-60d.json",
);

const raw = readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const dataset = JSON.parse(raw);

if (!Array.isArray(dataset.records)) {
  throw new Error("Expected a records array in the dataset JSON.");
}

const expectedHours = Math.round(
  (
    Date.parse(dataset.requestedTo) -
    Date.parse(dataset.requestedFrom)
  ) / 3_600_000,
);

if (!Number.isFinite(expectedHours) || expectedHours <= 0) {
  throw new Error("Invalid requested time range in dataset metadata.");
}

const groups = new Map();

for (const record of dataset.records) {
  const key = String(record.sensorId);

  if (!groups.has(key)) {
    groups.set(key, []);
  }

  groups.get(key).push(record);
}

function median(values) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const report = {
  datasetName: dataset.datasetName,
  source: dataset.source,
  requestedFrom: dataset.requestedFrom,
  requestedTo: dataset.requestedTo,
  expectedHours,
  generatedAt: new Date().toISOString(),
  stations: [],
};

for (const [sensorId, rows] of groups) {
  const parsed = rows.map((row) => ({
    ...row,
    timestampMs: Date.parse(row.datetimeUtc),
  }));

  const invalidTimestamps = parsed.filter(
    (row) => !Number.isFinite(row.timestampMs),
  );

  const timestamped = parsed
    .filter((row) => Number.isFinite(row.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const timestampCounts = new Map();

  for (const row of timestamped) {
    timestampCounts.set(
      row.timestampMs,
      (timestampCounts.get(row.timestampMs) ?? 0) + 1,
    );
  }

  const uniqueTimestamps = [...timestampCounts.keys()].sort(
    (a, b) => a - b,
  );

  const duplicateRecords = timestamped.length - uniqueTimestamps.length;

  const validValues = timestamped.filter(
    (row) =>
      typeof row.pm25UgM3 === "number" &&
      Number.isFinite(row.pm25UgM3) &&
      row.pm25UgM3 >= 0,
  );

  const negativeValues = timestamped.filter(
    (row) =>
      typeof row.pm25UgM3 === "number" &&
      Number.isFinite(row.pm25UgM3) &&
      row.pm25UgM3 < 0,
  );

  const nullOrInvalidValues = timestamped.filter(
    (row) =>
      typeof row.pm25UgM3 !== "number" ||
      !Number.isFinite(row.pm25UgM3),
  );

  const missingUnit = timestamped.filter(
    (row) =>
      typeof row.units !== "string" ||
      row.units.trim() === "",
  );

  const flaggedRecords = timestamped.filter(
    (row) => row.hasFlags === true,
  );

  const validUniqueHours = new Set(
  validValues.map((row) => row.timestampMs),
    ).size;
    const concentrations = validValues.map(
  (row) => row.pm25UgM3,
);

  const mean = concentrations.length
    ? concentrations.reduce((sum, value) => sum + value, 0) /
      concentrations.length
    : null;

  let gapCount = 0;
  let missingHoursBetweenRecords = 0;
  let nonHourlyIntervals = 0;

  for (let i = 1; i < uniqueTimestamps.length; i++) {
    const diff =
      (uniqueTimestamps[i] - uniqueTimestamps[i - 1]) /
      3_600_000;

    if (diff > 1.001) {
      gapCount++;
      missingHoursBetweenRecords += Math.max(
        0,
        Math.round(diff) - 1,
      );
    }

    if (Math.abs(diff - Math.round(diff)) > 0.001) {
      nonHourlyIntervals++;
    }
  }

  const duplicateExamples = [...timestampCounts.entries()]
    .filter(([, count]) => count > 1)
    .slice(0, 5)
    .map(([timestampMs, count]) => ({
      timestampUtc: new Date(timestampMs).toISOString(),
      records: count,
    }));

  const sampleTimestamps = timestamped.length
    ? {
        firstThreeLocal: timestamped
          .slice(0, 3)
          .map((row) => row.datetimeLocal),
        lastThreeLocal: timestamped
          .slice(-3)
          .map((row) => row.datetimeLocal),
      }
    : null;

  report.stations.push({
    station: rows[0].station,
    area: rows[0].area,
    sensorId: Number(sensorId),
    returnedRecords: rows.length,
    uniqueTimestamps: uniqueTimestamps.length,
    duplicateRecords,
    invalidTimestamps: invalidTimestamps.length,
    validNonNegativeValues: validValues.length,
    negativeValues: negativeValues.length,
    nullOrInvalidValues: nullOrInvalidValues.length,
      missingUnit,
    validUniqueHours,
    distinctUnitStrings: [
      ...new Set(rows.map((row) => row.units)),
    ],
    flaggedRecords: flaggedRecords.length,
    expectedHours,
    coveragePercent: Number(
  ((validUniqueHours / expectedHours) * 100).toFixed(1),
),
    gapsBetweenRecords: gapCount,
    missingHoursBetweenRecords,
    nonHourlyIntervals,
    minPm25: concentrations.length
      ? Math.min(...concentrations)
      : null,
    medianPm25: median(concentrations),
    meanPm25: mean,
    maxPm25: concentrations.length
      ? Math.max(...concentrations)
      : null,
    firstTimestampLocal: timestamped[0]?.datetimeLocal ?? null,
    lastTimestampLocal:
      timestamped.at(-1)?.datetimeLocal ?? null,
    sampleTimestamps,
    duplicateExamples,
  });
}

const outputDirectory = join(root, "data", "reports");
mkdirSync(outputDirectory, { recursive: true });

const reportPath = join(
  outputDirectory,
  "openaq-60d-quality-report.json",
);

writeFileSync(
  reportPath,
  JSON.stringify(report, null, 2),
  "utf8",
);

console.table(
  report.stations.map((station) => ({
    Station: station.station,
    SensorId: station.sensorId,
    Records: station.returnedRecords,
    UniqueHours: station.uniqueTimestamps,
    CoveragePct: station.coveragePercent,
    Duplicates: station.duplicateRecords,
    InvalidValues: station.nullOrInvalidValues,
    Negative: station.negativeValues,
    Flagged: station.flaggedRecords,
    Gaps: station.gapsBetweenRecords,
    MissingHours: station.missingHoursBetweenRecords,
    Min: station.minPm25,
    Median: station.medianPm25,
    Max: station.maxPm25,
  })),
);

console.log(`\nFull report saved to: ${reportPath}`);   