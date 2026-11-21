import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const apiKey = process.env.OPENAQ_API_KEY;

if (!apiKey) {
  throw new Error(
    "OPENAQ_API_KEY is missing. Load it in the terminal first.",
  );
}

const sensors = [
  { id: 12234787, station: "R K Puram, Delhi", area: "Delhi" },
  { id: 12234796, station: "Punjabi Bagh, Delhi", area: "Delhi" },
  { id: 12235187, station: "Sector 125, Noida", area: "Noida" },
  { id: 12234720, station: "Sector 62, Noida", area: "Noida" },
  { id: 14258988, station: "Vikas Sadan, Gurugram", area: "Gurugram" },
];

const from = "2026-07-10T00:00:00+05:30";
const to = "2026-09-22T00:00:00+05:30";
const limit = 1000;
const retrievedAt = new Date().toISOString();
const allRecords = [];

for (const sensor of sensors) {
  console.log(`Downloading ${sensor.station}...`);

  let page = 1;

  while (true) {
    const url = new URL(
      `https://api.openaq.org/v3/sensors/${sensor.id}/hours`,
    );

    url.searchParams.set("datetime_from", from);
    url.searchParams.set("datetime_to", to);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey },
    });

    if (!response.ok) {
      throw new Error(
        `OpenAQ request failed for ${sensor.station}: ` +
        `${response.status} ${response.statusText}`,
      );
    }

    const payload = await response.json();
    const batch = payload.results ?? [];

    for (const item of batch) {
      const period = item.period;
      const coverage = item.coverage;

      allRecords.push({
        station: sensor.station,
        area: sensor.area,
        sensorId: sensor.id,

        datetimeLocal: period?.datetimeFrom?.local ?? null,
        datetimeUtc: period?.datetimeFrom?.utc ?? null,
        periodToLocal: period?.datetimeTo?.local ?? null,
        periodToUtc: period?.datetimeTo?.utc ?? null,
        interval: period?.interval ?? null,

        pm25UgM3: item.value ?? null,
        units: item.parameter?.units ?? null,

        expectedCount: coverage?.expectedCount ?? null,
        observedCount: coverage?.observedCount ?? null,
        expectedInterval: coverage?.expectedInterval ?? null,
        observedInterval: coverage?.observedInterval ?? null,
        percentCoverage: coverage?.percentCoverage ?? null,

        hasFlags: item.flagInfo?.hasFlags ?? null,
        source: "OpenAQ API v3",
        sourceUrl:
          `https://api.openaq.org/v3/sensors/${sensor.id}/hours`,
        retrievedAt,
      });
    }

    console.log(`  Page ${page}: ${batch.length} records`);

    if (batch.length < limit) break;

    page += 1;

    if (page > 10) {
      throw new Error("Unexpected pagination. Stopping safely.");
    }
  }
}

allRecords.sort(
  (a, b) =>
    a.sensorId - b.sensorId ||
    Date.parse(a.datetimeUtc) - Date.parse(b.datetimeUtc),
);

const outputDirectory = join(process.cwd(), "data", "raw");
mkdirSync(outputDirectory, { recursive: true });

const outputPath = join(
  outputDirectory,
  "openaq-hourly-holdout-with-coverage.json",
);

const dataset = {
  datasetName: "AQI Buddy 60-day hourly PM2.5 dataset",
  source: "OpenAQ API v3",
  timezone: "Asia/Kolkata",
  requestedFrom: from,
  requestedTo: to,
  retrievedAt,
  sensorCount: sensors.length,
expectedHoursPerSensor: 1776,
  qualityRule: {
    primaryMinimumCoveragePercent: 75,
    strictSensitivityCoveragePercent: 100,
    excludeFlaggedRecords: true,
    rejectNegativeOrInvalidConcentrations: true,
  },
  records: allRecords,
};

writeFileSync(
  outputPath,
  JSON.stringify(dataset, null, 2),
  "utf8",
);

console.log(`\nSaved ${allRecords.length} records.`);
console.log(`File: ${outputPath}`);