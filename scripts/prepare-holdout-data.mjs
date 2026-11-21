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
  "openaq-hourly-holdout-with-coverage.json",
);

const dataset = JSON.parse(
  readFileSync(inputPath, "utf8").replace(/^\uFEFF/, ""),
);

if (!Array.isArray(dataset.records)) {
  throw new Error("Dataset is missing its records array.");
}

const PRIMARY_MIN_COVERAGE = 75;
const PLANNING_START_HOUR = 5;
const PLANNING_END_HOUR_EXCLUSIVE = 21;

const startDate = dataset.requestedFrom.slice(0, 10);
const endDateExclusive = dataset.requestedTo.slice(0, 10);

const dates = [];
const cursor = new Date(`${startDate}T00:00:00Z`);
const end = new Date(`${endDateExclusive}T00:00:00Z`);

while (cursor < end) {
  dates.push(cursor.toISOString().slice(0, 10));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
}

function isSupportedUnit(unit) {
  if (typeof unit !== "string") return false;

  const normalized = unit
    .replaceAll("Â", "")
    .replace(/\s+/g, "")
    .toLowerCase();

  return /^(µ|μ|u)g\/m(³|\^?3)$/.test(normalized);
}

function getCoverage(row) {
  if (
    typeof row.expectedCount !== "number" ||
    typeof row.observedCount !== "number" ||
    !Number.isFinite(row.expectedCount) ||
    !Number.isFinite(row.observedCount) ||
    row.expectedCount <= 0 ||
    row.observedCount < 0 ||
    row.observedCount > row.expectedCount
  ) {
    return null;
  }

  return {
    expected: row.expectedCount,
    observed: row.observedCount,
    percent: (row.observedCount / row.expectedCount) * 100,
  };
}

function parseTimestamp(row) {
  if (
    typeof row.datetimeLocal !== "string" ||
    typeof row.datetimeUtc !== "string"
  ) {
    return null;
  }

  const localDate = row.datetimeLocal.slice(0, 10);
  const hour = Number(row.datetimeLocal.slice(11, 13));

  if (
    !dates.includes(localDate) ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isFinite(Date.parse(row.datetimeUtc))
  ) {
    return null;
  }

  return {
    date: localDate,
    hour,
    key: `${localDate}T${String(hour).padStart(2, "0")}`,
  };
}

function getRowQuality(row) {
  const reasons = [];
  const coverage = getCoverage(row);

  const valueIsValid =
    typeof row.pm25UgM3 === "number" &&
    Number.isFinite(row.pm25UgM3) &&
    row.pm25UgM3 >= 0;

  if (!valueIsValid) reasons.push("invalid-concentration");

  if (!isSupportedUnit(row.units)) {
    reasons.push("unsupported-unit");
  }

  if (row.hasFlags !== false) {
    reasons.push(
      row.hasFlags === true ? "source-flagged" : "unknown-flag-status",
    );
  }

  if (!coverage) {
    reasons.push("missing-or-invalid-coverage");
  }

  const startMs = Date.parse(row.datetimeLocal);
  const endMs = Date.parse(row.periodToLocal);

  const intervalIsValid =
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    endMs - startMs === 60 * 60 * 1000 &&
    row.datetimeLocal.slice(11, 19).endsWith(":00:00");

  if (!intervalIsValid) reasons.push("invalid-hourly-interval");

  const baseValid = reasons.length === 0;

  const primaryValid =
    baseValid &&
    coverage.percent >= PRIMARY_MIN_COVERAGE;

  const strictValid =
    baseValid &&
    coverage.observed === coverage.expected;

  if (coverage && coverage.percent < PRIMARY_MIN_COVERAGE) {
    reasons.push("below-primary-coverage-threshold");
  }

  return {
    coverage,
    primaryValid,
    strictValid,
    reasons,
  };
}

const stationMap = new Map();

for (const row of dataset.records) {
  const id = String(row.sensorId);

  if (!stationMap.has(id)) {
    stationMap.set(id, {
      sensorId: Number(row.sensorId),
      stationName: row.station,
      area: row.area,
      rows: [],
      slots: new Map(),
      invalidTimestampRecords: 0,
    });
  }

  const station = stationMap.get(id);
  station.rows.push(row);

  const timestamp = parseTimestamp(row);

  if (!timestamp) {
    station.invalidTimestampRecords++;
    continue;
  }

  if (!station.slots.has(timestamp.key)) {
    station.slots.set(timestamp.key, []);
  }

  station.slots.get(timestamp.key).push({
    row,
    timestamp,
  });
}

const stations = [];
const stationSummaries = [];
const dailySummaries = [];

for (const station of stationMap.values()) {
  const profiles = [];
  let duplicateSlots = 0;
  let duplicateExtraRecords = 0;
  let primaryValidHours = 0;
  let strictValidHours = 0;

  for (const date of dates) {
    const primaryValues = Array(24).fill(null);
    const strictValues = Array(24).fill(null);
    const coveragePercent = Array(24).fill(null);
    const observedCounts = Array(24).fill(null);
    const expectedCounts = Array(24).fill(null);
    const flaggedByHour = Array(24).fill(null);
    const qualityReasons = Array.from({ length: 24 }, () => [
      "missing-record",
    ]);

    for (let hour = 0; hour < 24; hour++) {
      const key = `${date}T${String(hour).padStart(2, "0")}`;
      const slotRows = station.slots.get(key) ?? [];

      if (slotRows.length === 0) continue;

      if (slotRows.length > 1) {
        duplicateSlots++;
        duplicateExtraRecords += slotRows.length - 1;
        qualityReasons[hour] = ["duplicate-hourly-records"];
        continue;
      }

      const { row } = slotRows[0];
      const quality = getRowQuality(row);

      coveragePercent[hour] = quality.coverage?.percent ?? null;
      observedCounts[hour] = quality.coverage?.observed ?? null;
      expectedCounts[hour] = quality.coverage?.expected ?? null;
      flaggedByHour[hour] =
        typeof row.hasFlags === "boolean" ? row.hasFlags : null;
      qualityReasons[hour] = quality.reasons;

      if (quality.primaryValid) {
        primaryValues[hour] = row.pm25UgM3;
        primaryValidHours++;
      }

      if (quality.strictValid) {
        strictValues[hour] = row.pm25UgM3;
        strictValidHours++;
      }
    }

    const primaryHoursForDay = primaryValues.filter(
      (value) => value !== null,
    ).length;

    const strictHoursForDay = strictValues.filter(
      (value) => value !== null,
    ).length;

    const primaryPlanningHours = primaryValues
      .slice(PLANNING_START_HOUR, PLANNING_END_HOUR_EXCLUSIVE)
      .filter((value) => value !== null)
      .length;

    const strictPlanningHours = strictValues
      .slice(PLANNING_START_HOUR, PLANNING_END_HOUR_EXCLUSIVE)
      .filter((value) => value !== null)
      .length;

    dailySummaries.push({
      station: station.stationName,
      sensorId: station.sensorId,
      date,
      primaryValidHours: primaryHoursForDay,
      strictValidHours: strictHoursForDay,
      primaryPlanningHours,
      strictPlanningHours,
      primaryPlanningWindowComplete:
        primaryPlanningHours ===
        PLANNING_END_HOUR_EXCLUSIVE - PLANNING_START_HOUR,
      strictPlanningWindowComplete:
        strictPlanningHours ===
        PLANNING_END_HOUR_EXCLUSIVE - PLANNING_START_HOUR,
    });

    profiles.push({
      date,
      stationId: String(station.sensorId),
      stationName: station.stationName,
      sourceName: "OpenAQ API v3",
      sourceUrl:
        `https://api.openaq.org/v3/sensors/${station.sensorId}/hours`,
      dataRetrievedAt: dataset.retrievedAt,
      timezone: "Asia/Kolkata",
      hourlyPm25UgM3: primaryValues,
      strictHourlyPm25UgM3: strictValues,
      hourlyCoveragePercent: coveragePercent,
      observedCounts,
      expectedCounts,
      hasFlags: flaggedByHour,
      qualityReasons,
    });
  }

  const stationCoveragePercent = Number(
    ((primaryValidHours / (dates.length * 24)) * 100).toFixed(1),
  );

  const strictStationCoveragePercent = Number(
    ((strictValidHours / (dates.length * 24)) * 100).toFixed(1),
  );

  const daysAtLeast22Hours = dailySummaries.filter(
    (day) =>
      day.sensorId === station.sensorId &&
      day.primaryValidHours >= 22,
  ).length;

  const planningWindowEligibleDays = dailySummaries.filter(
    (day) =>
      day.sensorId === station.sensorId &&
      day.primaryPlanningWindowComplete,
  ).length;

  const stationSummary = {
    station: station.stationName,
    sensorId: station.sensorId,
    returnedRecords: station.rows.length,
    invalidTimestampRecords: station.invalidTimestampRecords,
    duplicateSlots,
    duplicateExtraRecords,
    primaryValidHours,
    strictValidHours,
    stationCoveragePercent,
    strictStationCoveragePercent,
    daysAtLeast22Hours,
    planningWindowEligibleDays,
    primaryStationEligible: stationCoveragePercent >= 75,
    totalDays: dates.length,
  };

  stationSummaries.push(stationSummary);

  stations.push({
    stationName: station.stationName,
    stationId: String(station.sensorId),
    area: station.area,
    sourceName: "OpenAQ API v3",
    sourceUrl:
      `https://api.openaq.org/v3/sensors/${station.sensorId}/hours`,
    dataRetrievedAt: dataset.retrievedAt,
    timezone: "Asia/Kolkata",
    stationCoveragePercent,
    strictStationCoveragePercent,
    primaryStationEligible: stationCoveragePercent >= 75,
    profiles,
  });
}

stationSummaries.sort((a, b) => a.sensorId - b.sensorId);
stations.sort((a, b) => Number(a.stationId) - Number(b.stationId));

const prepared = {
  datasetName: "AQI Buddy normalised hourly PM2.5 profiles",
  source: dataset.source,
  timezone: "Asia/Kolkata",
  requestedFrom: dataset.requestedFrom,
  requestedTo: dataset.requestedTo,
  generatedAt: new Date().toISOString(),
  rules: {
    primaryMinimumSourceCoveragePercent: PRIMARY_MIN_COVERAGE,
    strictSourceCoveragePercent: 100,
    primaryMinimumStationCoveragePercent: 75,
    planningStartHour: PLANNING_START_HOUR,
    planningEndHourExclusive: PLANNING_END_HOUR_EXCLUSIVE,
    invalidConcentrationsRejected: true,
    flaggedOrUnknownFlagRecordsRejected: true,
    duplicateSlotsRejected: true,
    missingHoursRepresentedAsNull: true,
  },
  stations,
};

const outputDir = join(root, "data", "processed");
mkdirSync(outputDir, { recursive: true });

const outputPath = join(
  outputDir,
  "openaq-normalized-holdout.json",
);

writeFileSync(
  outputPath,
  JSON.stringify(prepared, null, 2),
  "utf8",
);

const report = {
  generatedAt: new Date().toISOString(),
  requestedFrom: dataset.requestedFrom,
  requestedTo: dataset.requestedTo,
  stationSummary: stationSummaries,
  dailyCoverage: dailySummaries,
};

const reportsDir = join(root, "data", "reports");
mkdirSync(reportsDir, { recursive: true });

writeFileSync(
  join(reportsDir, "openaq-holdout-normalization-report.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log("\n=== NORMALISED DATA SUMMARY ===");

console.table(
  stationSummaries.map((s) => ({
    Station: s.station,
    Records: s.returnedRecords,
    PrimaryCoveragePct: s.stationCoveragePercent,
    StrictCoveragePct: s.strictStationCoveragePercent,
    DuplicateSlots: s.duplicateSlots,
    InvalidTimestampRecords: s.invalidTimestampRecords,
    DaysAtLeast22h: s.daysAtLeast22Hours,
    PlanningWindowEligibleDays: s.planningWindowEligibleDays,
    PrimaryStationEligible: s.primaryStationEligible,
  })),
);

console.log(`\nSaved normalised data to: ${outputPath}`);
console.log(
  "Saved report to: data/reports/openaq-normalization-report.json",
);