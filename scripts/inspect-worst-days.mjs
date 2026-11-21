import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const dataset = JSON.parse(
  readFileSync(
    join(root, "data", "processed", "openaq-normalized-60d.json"),
    "utf8",
  ).replace(/^\uFEFF/, ""),
);

const cases = [
  { stationId: "12235187", date: "2026-10-12", recommended: "16:45" },
  { stationId: "12234787", date: "2026-10-12", recommended: "17:15" },
  { stationId: "12234720", date: "2026-10-08", recommended: "16:45" },
  { stationId: "12235187", date: "2026-10-31", recommended: "16:45" },
  { stationId: "12234787", date: "2026-10-30", recommended: "16:45" },
];

const report = [];

for (const testCase of cases) {
  const station = dataset.stations.find(
    (s) => String(s.stationId) === testCase.stationId,
  );

  if (!station) {
    console.log("Station not found:", testCase.stationId);
    continue;
  }

  const target = station.profiles.find(
    (p) => p.date === testCase.date,
  );

  if (!target) {
    console.log("Target date not found:", testCase);
    continue;
  }

  const targetDateMs = Date.parse(`${testCase.date}T00:00:00Z`);

  const history = station.profiles.filter((profile) => {
    const dateMs = Date.parse(`${profile.date}T00:00:00Z`);
    const daysBefore = (targetDateMs - dateMs) / 86_400_000;

    return daysBefore >= 1 && daysBefore <= 14;
  });

  const hourlyRows = [];

  for (let hour = 5; hour <= 20; hour++) {
    const historyValues = history
      .map((profile) => profile.hourlyPm25UgM3[hour])
      .filter(
        (value) =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0,
      );

    const historicalMean =
      historyValues.length > 0
        ? historyValues.reduce((sum, value) => sum + value, 0) /
          historyValues.length
        : null;

    const actual = target.hourlyPm25UgM3[hour];

    hourlyRows.push({
      station: station.stationName,
      date: testCase.date,
      hour: `${String(hour).padStart(2, "0")}:00`,
      actualPm25:
        typeof actual === "number" ? actual : null,
      previous14DayMean:
        historicalMean === null
          ? null
          : Number(historicalMean.toFixed(2)),
      historicalSamples: historyValues.length,
      differenceFromHistory:
        typeof actual === "number" && historicalMean !== null
          ? Number((actual - historicalMean).toFixed(2))
          : null,
      baselineExerciseHour: hour === 7,
      recommendedExerciseHours: (() => {
        const [hh, mm] = testCase.recommended.split(":").map(Number);
        const start = hh * 60 + mm;
        return (
          hour * 60 < start + 45 &&
          start < (hour + 1) * 60
        );
      })(),
    });
  }

  report.push({
    ...testCase,
    stationName: station.stationName,
    historicalDaysAvailable: history.length,
    hourlyRows,
  });
}

const outputDir = join(root, "data", "reports");
mkdirSync(outputDir, { recursive: true });

writeFileSync(
  join(outputDir, "worst-day-hourly-diagnostics.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);

for (const testCase of report) {
  console.log(
    `\n=== ${testCase.stationName} | ${testCase.date} | ` +
    `Exercise recommendation: ${testCase.recommended} ===`,
  );

  console.table(
    testCase.hourlyRows.map((row) => ({
      Hour: row.hour,
      Actual: row.actualPm25,
      Prior14DayMean: row.previous14DayMean,
      HistoryN: row.historicalSamples,
      Difference: row.differenceFromHistory,
      BaselineExercise: row.baselineExerciseHour ? "*" : "",
      RecommendedExercise: row.recommendedExerciseHours ? "*" : "",
    })),
  );
}

console.log("\nSaved diagnostics to data/reports/worst-day-hourly-diagnostics.json");