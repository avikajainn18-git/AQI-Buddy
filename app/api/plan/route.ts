
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optimizeSchedule } from "../../../lib/optimizer";
import { BASELINE_MODEL_CONFIG } from "../../../lib/model-config";
import type {
  Activity,
  HourlyPm25Profile,
} from "../../../lib/types";



type StoredStation = {
  stationId: string;
  stationName: string;
  area?: string;
  stationCoveragePercent?: number;
  profiles: HourlyPm25Profile[];
};

type Dataset = {
  stations: StoredStation[];
};

async function loadDataset(): Promise<Dataset> {
  const filePath = join(
    process.cwd(),
    "data",
    "processed",
    "openaq-normalized-60d.json"
  );

  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as Dataset;
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCompleteProfile(
  profile: HourlyPm25Profile
): boolean {
  return (
    Array.isArray(profile.hourlyPm25UgM3) &&
    profile.hourlyPm25UgM3.length === 24 &&
    profile.hourlyPm25UgM3.every(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
    )
  );
}

function isActivity(value: unknown): value is Activity {
  if (!isRecord(value)) return false;

  const commonFieldsAreValid =
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    Number.isInteger(value.durationMinutes) &&
    (value.durationMinutes as number) > 0 &&
    (value.durationMinutes as number) <= 1440 &&
    (value.environment === "indoor" ||
      value.environment === "outdoor") &&
    ["sedentary", "light", "moderate", "high"].includes(
      String(value.intensity)
    );

  if (!commonFieldsAreValid) return false;

  if (value.kind === "fixed") {
    return (
      Number.isInteger(value.startMinute) &&
      (value.startMinute as number) >= 0 &&
      (value.startMinute as number) +
        (value.durationMinutes as number) <= 1440
    );
  }

  if (value.kind === "flexible") {
    return (
      Number.isInteger(value.earliestStartMinute) &&
      Number.isInteger(value.latestStartMinute) &&
      Number.isInteger(value.preferredStartMinute) &&
      (value.earliestStartMinute as number) >= 0 &&
      (value.latestStartMinute as number) >=
        (value.earliestStartMinute as number) &&
      (value.latestStartMinute as number) +
        (value.durationMinutes as number) <= 1440 &&
      (value.preferredStartMinute as number) >=
        (value.earliestStartMinute as number) &&
      (value.preferredStartMinute as number) <=
        (value.latestStartMinute as number)
    );
  }

  return false;
}

export async function GET() {
  try {
    const dataset = await loadDataset();

    const stations = dataset.stations
      .map((station) => ({
        stationId: station.stationId,
        stationName: station.stationName,
        area: station.area,
        stationCoveragePercent:
          station.stationCoveragePercent,
        dates: station.profiles
          .filter(isCompleteProfile)
          .map((profile) => profile.date)
          .sort(),
      }))
      .filter((station) => station.dates.length > 0);

    return NextResponse.json({ stations });
  } catch (error) {
    console.error("Unable to load AQI Buddy data:", error);

    return NextResponse.json(
      { error: "Unable to load the historical PM2.5 dataset." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    if (
      !isRecord(body) ||
      typeof body.stationId !== "string" ||
      typeof body.date !== "string" ||
      !Array.isArray(body.activities) ||
      body.activities.length === 0 ||
      body.activities.length > 10 ||
      !body.activities.every(isActivity)
    ) {
      return NextResponse.json(
        { error: "Choose a station, date, and 1 to 10 valid activities." },
        { status: 400 }
      );
    }

    const activities: Activity[] = body.activities;
    const dataset = await loadDataset();

    const station = dataset.stations.find(
      (item) => item.stationId === body.stationId
    );

    if (!station) {
      return NextResponse.json(
        { error: "The selected station was not found." },
        { status: 404 }
      );
    }

    const profile = station.profiles.find(
      (item) => item.date === body.date
    );

    if (!profile || !isCompleteProfile(profile)) {
      return NextResponse.json(
        {
          error:
            "This date does not have 24 valid hourly readings. Choose another date.",
        },
        { status: 422 }
      );
    }

    const result = optimizeSchedule(
      activities,
      profile,
      BASELINE_MODEL_CONFIG
    );

    return NextResponse.json({
      station: station.stationName,
      stationId: station.stationId,
      date: profile.date,
      timezone: profile.timezone,
      sourceName: profile.sourceName,
      sourceUrl: profile.sourceUrl,
      dataRetrievedAt: profile.dataRetrievedAt,
      modelVersion: BASELINE_MODEL_CONFIG.modelVersion,
      baselinePlacements: result.baselinePlacements,
      optimizedPlacements: result.optimizedPlacements,
      baselineExposureIndex: result.baselineExposureIndex,
      optimizedExposureIndex: result.optimizedExposureIndex,
      reductionPercent: result.reductionPercent,
      completeSchedulesEvaluated:
        result.completeSchedulesEvaluated,
      skippedCandidateSlotsMissingData:
        result.skippedCandidateSlotsMissingData,
      activities,
      disclaimer:
        "Historical-data research estimate, not live air quality, a validated personal dose, or medical advice. Lower estimated exposure is not guaranteed in real-world conditions.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to calculate the schedule.";

    return NextResponse.json(
      { error: message },
      { status: 422 }
    );
  }
}
