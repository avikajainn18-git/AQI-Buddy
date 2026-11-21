import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const inputPath = join(
  root,
  "data",
  "raw",
  "openaq-hourly-60d-with-coverage.json",
);

const dataset = JSON.parse(
  readFileSync(inputPath, "utf8").replace(/^\uFEFF/, ""),
);

if (!Array.isArray(dataset.records)) {
  throw new Error("Dataset is missing its records array.");
}

const expectedHours = 1440;
const minimumCoverage = 75;

const startDate = dataset.requestedFrom.slice(0, 10);
const endDate = dataset.requestedTo.slice(0, 10);
const dates = [];

const cursor = new Date(`${startDate}T00:00:00Z`);
const end = new Date(`${endDate}T00:00:00Z`);

while (cursor < end) {
  dates.push(cursor.toISOString().slice(0, 10));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
}

function parseCoverage(row) {
  const expected = Number(row.expectedCount);
  const observed = Number(row.observedCount);

  if (
    !Number.isFinite(expected) ||
    !Number.isFinite(observed) ||
    expected <= 0 ||
    observed < 0 ||
    observed > expected
  ) {
    return null;
  }

  return {
    expected,
    observed,
    percent: (observed / expected) * 100,
  };
}

function isSupportedUnit(unit) {
  if (typeof unit !== "string") return false;

  const normalized = unit
    .replaceAll("Â", "")
    .replace(/\s+/g, "")
    .toLowerCase();

  return /^(µ|μ|u)g\/m(³|\^?3)$/.test(normalized);
}

function validConcentration(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function timestampDetails(row) {
  if (
    typeof row.datetimeLocal !== "string" ||
    typeof row.periodToLocal !== "string"
  ) {
    return null;
  }

  const startMs = Date.parse(row.datetimeLocal);
  const endMs = Date.parse(row.periodToLocal);

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs - startMs !== 3_600_000
  ) {
    return null;
  }

  // Hourly period start must be an exact local-hour boundary.
  if (!/T\d{2}:00:00/.test(row.datetimeLocal)) {
    return null;
  }

  return {
    date: row.datetimeLocal.slice(0, 10),
    hour: Number(row.datetimeLocal.slice(11, 13)),
  };
}

const stations = new Map();
const highReadings = [];

for (const row of dataset.records) {
  const id = String(row.sensorId);

  if (!stations.has(id)) {
    stations.set(id, {
      station: row.station,
      sensorId: Number(row.sensorId),
      records: [],
      invalidTimestampRecords: 0,
      invalidIntervals: 0,
      invalidValues: 0,
      unsupportedUnits: 0,
      flaggedRecords: 0,
      unknownFlagRecords: 0,
      missingCoverage: 0,
      lowCoverageRecords: 0,
      duplicateHours: 0,
      duplicateExtraRecords: 0,
      slots: new Map(),
    });
  }

  const station = stations.get(id);
  station.records.push(row);

  const coverage = parseCoverage(row);
  const time = timestampDetails(row);
  const concentrationOK = validConcentration(row.pm25UgM3);
  const unitsOK = isSupportedUnit(row.units);

  if (!time) {
    station.invalidTimestampRecords++;
    station.invalidIntervals++;
    continue;
  }

  if (!dates.includes(time.date)) continue;

  if (!concentrationOK) station.invalidValues++;
  if (!unitsOK) station.unsupportedUnits++;

  if (row.hasFlags === true) station.flaggedRecords++;
  if (row.hasFlags !== true && row.hasFlags !== false) {
    station.unknownFlagRecords++;
  }

  if (!coverage) {
    station.missingCoverage++;
  } else if (coverage.percent < minimumCoverage) {
    station.lowCoverageRecords++;
  }

  const key = `${time.date}T${String(time.hour).padStart(2, "0")}`;

  if (!station.slots.has(key)) {
    station.slots.set(key, []);
  }

  const basicValid =
    concentrationOK &&
    unitsOK &&
    row.hasFlags === false &&
    coverage !== null;

  const primaryValid =
    basicValid &&
    coverage.percent >= minimumCoverage;

  const strictValid =
    basicValid &&
    coverage.observed === coverage.expected;

  station.slots.get(key).push({
    date: time.date,
    hour: time.hour,
    concentration: row.pm25UgM3,
    primaryValid,
    strictValid,
    coveragePct: coverage?.percent ?? null,
  });

  if (concentrationOK && row.pm25UgM3 >= 500) {
    highReadings.push({
      station: row.station,
      sensorId: row.sensorId,
      datetimeLocal: row.datetimeLocal,
      pm25UgM3: row.pm25UgM3,
      observedCount: coverage?.observed ?? null,
      expectedCount: coverage?.expected ?? null,
      coveragePct: coverage
        ? Number(coverage.percent.toFixed(1))
        : null,
      hasFlags: row.hasFlags,
      primaryEligible: primaryValid,
    });
  }
}

const stationReport = [];
const dailyReport = [];

for (const station of stations.values()) {
  const validPrimarySlots = new Set();
  const validStrictSlots = new Set();

  let dailyCompleteDays = 0;
  let dailyAtLeast22 = 0;
  let dailyAtLeast20 = 0;

  for (const [key, rows] of station.slots) {
    if (rows.length > 1) {
      station.duplicateHours++;
      station.duplicateExtraRecords += rows.length - 1;
      continue;
    }

    const row = rows[0];

    if (row.primaryValid) validPrimarySlots.add(key);
    if (row.strictValid) validStrictSlots.add(key);
  }

  for (const date of dates) {
    let primaryHours = 0;
    let strictHours = 0;

    for (let hour = 0; hour < 24; hour++) {
      const key = `${date}T${String(hour).padStart(2, "0")}`;

      if (validPrimarySlots.has(key)) primaryHours++;
      if (validStrictSlots.has(key)) strictHours++;
    }

    if (primaryHours === 24) dailyCompleteDays++;
    if (primaryHours >= 22) dailyAtLeast22++;
    if (primaryHours >= 20) dailyAtLeast20++;

    dailyReport.push({
      station: station.station,
      sensorId: station.sensorId,
      date,
      primaryValidHours: primaryHours,
      strictValidHours: strictHours,
      primaryCoveragePct: Number(
        ((primaryHours / 24) * 100).toFixed(1),
      ),
    });
  }

  stationReport.push({
    station: station.station,
    sensorId: station.sensorId,
    returnedRecords: station.records.length,
    expectedHours,
    uniquePrimaryHours: validPrimarySlots.size,
    primaryCoveragePct: Number(
      ((validPrimarySlots.size / expectedHours) * 100).toFixed(1),
    ),
    uniqueStrictHours: validStrictSlots.size,
    strictCoveragePct: Number(
      ((validStrictSlots.size / expectedHours) * 100).toFixed(1),
    ),
    duplicateHours: station.duplicateHours,
    duplicateExtraRecords: station.duplicateExtraRecords,
    invalidTimestampRecords: station.invalidTimestampRecords,
    invalidValues: station.invalidValues,
    unsupportedUnits: station.unsupportedUnits,
    flaggedRecords: station.flaggedRecords,
    unknownFlagRecords: station.unknownFlagRecords,
    missingCoverageMetadata: station.missingCoverage,
    recordsBelow75Pct: station.lowCoverageRecords,
    daysAtLeast22PrimaryHours: dailyAtLeast22,
    daysAtLeast20PrimaryHours: dailyAtLeast20,
    completePrimaryDays: dailyCompleteDays,
    totalDays: dates.length,
  });
}

stationReport.sort((a, b) => a.sensorId - b.sensorId);
highReadings.sort((a, b) => b.pm25UgM3 - a.pm25UgM3);

const report = {
  source: dataset.source,
  requestedFrom: dataset.requestedFrom,
  requestedTo: dataset.requestedTo,
  generatedAt: new Date().toISOString(),
  provisionalPrimaryCoverageThreshold: minimumCoverage,
  strictCoverageThreshold: 100,
  expectedHoursPerStation: expectedHours,
  stationSummary: stationReport,
  dailyCoverage: dailyReport,
  readingsAtLeast500UgM3: highReadings,
};

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "openaq-60d-coverage-analysis.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log("\n=== STATION COVERAGE ===");
console.table(
  stationReport.map((s) => ({
    Station: s.station,
    Records: s.returnedRecords,
    PrimaryHours: s.uniquePrimaryHours,
    PrimaryCoveragePct: s.primaryCoveragePct,
    StrictCoveragePct: s.strictCoveragePct,
    Duplicates: s.duplicateHours,
    InvalidValues: s.invalidValues,
    Flags: s.flaggedRecords,
    UnknownFlags: s.unknownFlagRecords,
    DaysAtLeast22h: s.daysAtLeast22PrimaryHours,
  })),
);

console.log("\n=== HIGHEST READINGS AT OR ABOVE 500 µg/m³ ===");
console.table(highReadings.slice(0, 15));

console.log(
  "\nFull report saved to data/reports/openaq-60d-coverage-analysis.json",
);