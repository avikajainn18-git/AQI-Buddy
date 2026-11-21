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
  throw new Error("Dataset does not contain a records array.");
}

const startDate = dataset.requestedFrom.slice(0, 10);
const endDateExclusive = dataset.requestedTo.slice(0, 10);

const dates = [];
const cursor = new Date(`${startDate}T00:00:00Z`);
const end = new Date(`${endDateExclusive}T00:00:00Z`);

while (cursor < end) {
  dates.push(cursor.toISOString().slice(0, 10));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
}

const bySensor = new Map();

for (const row of dataset.records) {
  const id = String(row.sensorId);

  if (!bySensor.has(id)) {
    bySensor.set(id, []);
  }

  bySensor.get(id).push(row);
}

const dailyReport = [];
const stationReport = [];
const highReadings = [];

for (const [sensorId, rows] of bySensor) {
  const station = rows[0].station;
  const recordsByDate = new Map();

  const seenTimestamps = new Set();
  let duplicateCount = 0;
  let invalidTimestampCount = 0;
  let invalidValueCount = 0;
  let nonHourlyIntervalCount = 0;

  for (const row of rows) {
    const local = row.datetimeLocal;
    const utc = row.datetimeUtc;

    if (
      typeof local !== "string" ||
      !Number.isFinite(Date.parse(utc))
    ) {
      invalidTimestampCount++;
      continue;
    }

    const date = local.slice(0, 10);
    const hour = Number(local.slice(11, 13));

    if (
      !dates.includes(date) ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23
    ) {
      invalidTimestampCount++;
      continue;
    }

    const timestampKey = `${sensorId}:${utc}`;

    if (seenTimestamps.has(timestampKey)) {
      duplicateCount++;
    } else {
      seenTimestamps.add(timestampKey);
    }

    const startMs = Date.parse(local);
    const endMs = Date.parse(row.periodToLocal);

    if (
      !Number.isFinite(endMs) ||
      Math.abs(endMs - startMs - 3600000) > 1000
    ) {
      nonHourlyIntervalCount++;
    }

    const validValue =
      typeof row.pm25UgM3 === "number" &&
      Number.isFinite(row.pm25UgM3) &&
      row.pm25UgM3 >= 0 &&
      typeof row.units === "string" &&
      row.units.trim().length > 0;

    if (!validValue) {
      invalidValueCount++;
    }

    if (!recordsByDate.has(date)) {
      recordsByDate.set(date, new Map());
    }

    const hours = recordsByDate.get(date);

    if (!hours.has(hour)) {
      hours.set(hour, []);
    }

    hours.get(hour).push({
      ...row,
      validValue,
      timestampKey,
    });

    if (validValue && row.pm25UgM3 >= 500) {
      highReadings.push({
        station,
        sensorId: Number(sensorId),
        datetimeLocal: local,
        pm25UgM3: row.pm25UgM3,
        units: row.units,
        hasFlags: row.hasFlags,
      });
    }
  }

  let completeDays = 0;
  let daysAtLeast22Hours = 0;
  let daysAtLeast20Hours = 0;
  let daysBelow20Hours = 0;

  for (const date of dates) {
    const hours = recordsByDate.get(date) ?? new Map();
    let validHours = 0;
    const missingHours = [];

    for (let hour = 0; hour < 24; hour++) {
      const hourRows = hours.get(hour) ?? [];

      const hasValidRecord = hourRows.some(
        (row) => row.validValue,
      );

      if (hasValidRecord) {
        validHours++;
      } else {
        missingHours.push(hour);
      }
    }

    if (validHours === 24) completeDays++;
    if (validHours >= 22) daysAtLeast22Hours++;
    if (validHours >= 20) daysAtLeast20Hours++;
    if (validHours < 20) daysBelow20Hours++;

    dailyReport.push({
      station,
      sensorId: Number(sensorId),
      date,
      validHours,
      missingHours,
      coveragePercent: Number(
        ((validHours / 24) * 100).toFixed(1),
      ),
    });
  }

  stationReport.push({
    station,
    sensorId: Number(sensorId),
    records: rows.length,
    duplicateTimestamps: duplicateCount,
    invalidTimestamps: invalidTimestampCount,
    invalidValues: invalidValueCount,
    nonHourlyIntervals: nonHourlyIntervalCount,
    completeDays,
    daysAtLeast22Hours,
    daysAtLeast20Hours,
    daysBelow20Hours,
    totalDays: dates.length,
  });
}

stationReport.sort((a, b) => a.sensorId - b.sensorId);

highReadings.sort((a, b) => b.pm25UgM3 - a.pm25UgM3);

const report = {
  source: dataset.source,
  requestedFrom: dataset.requestedFrom,
  requestedTo: dataset.requestedTo,
  expectedDays: dates.length,
  stationSummary: stationReport,
  dailyCoverage: dailyReport,
  readingsAtLeast500UgM3: highReadings,
};

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "openaq-60d-daily-analysis.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log("\n=== DAILY COMPLETENESS BY STATION ===");

console.table(
  stationReport.map((s) => ({
    Station: s.station,
    Records: s.records,
    CompleteDays: s.completeDays,
    DaysAtLeast22Hours: s.daysAtLeast22Hours,
    DaysAtLeast20Hours: s.daysAtLeast20Hours,
    DaysBelow20Hours: s.daysBelow20Hours,
    DuplicateTimestamps: s.duplicateTimestamps,
    InvalidValues: s.invalidValues,
    NonHourlyIntervals: s.nonHourlyIntervals,
  })),
);

console.log("\n=== 20 HIGHEST READINGS AT OR ABOVE 500 µg/m³ ===");
console.table(highReadings.slice(0, 20));

console.log(
  "\nDetailed report saved to data/reports/openaq-60d-daily-analysis.json",
);