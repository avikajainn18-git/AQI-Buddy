import { describe, expect, it } from "vitest";
import { calculateActivityExposureIndex } from "./exposure";

import type {
  Activity,
  ExposureModelConfig,
  HourlyPm25Profile,
} from "./types";

// Synthetic values for testing arithmetic only.
// These are not our final scientific assumptions.
const testConfig: ExposureModelConfig = {
  modelVersion: "unit-test-only",
  intensityMultipliers: {
  sedentary: 1,
  light: 1,
  moderate: 1.5,
  high: 2,
},
  microenvironmentMultipliers: {
    indoor: 0.5,
    outdoor: 1,
  },
};

function makeProfile(
  values: (number | null)[] = Array(24).fill(10),
): HourlyPm25Profile {
  return {
    date: "2026-01-01",
    stationId: "test-station",
    stationName: "Test station",
    sourceName: "Synthetic test data",
    sourceUrl: "https://example.invalid/test-fixture",
    dataRetrievedAt: "2026-01-02T00:00:00.000Z",
    timezone: "Asia/Kolkata",
    hourlyPm25UgM3: values,
  };
}

const walk: Activity = {
  id: "walk",
  name: "Outdoor walk",
  kind: "flexible",
  durationMinutes: 60,
  earliestStartMinute: 360,
  latestStartMinute: 540,
  environment: "outdoor",
    intensity: "light",
  preferredStartMinute: 420,
};

describe("calculateActivityExposureIndex", () => {
  it("calculates exposure for a one-hour activity", () => {
    const result = calculateActivityExposureIndex(
      walk,
      420,
      makeProfile(),
      testConfig,
    );

    expect(result).toBe(600);
  });

  it("handles activities crossing an hourly boundary", () => {
    const values = Array(24).fill(10) as (number | null)[];
    values[7] = 10;
    values[8] = 20;

    const result = calculateActivityExposureIndex(
      walk,
      450,
      makeProfile(values),
      testConfig,
    );

    // 30 minutes × 10 + 30 minutes × 20
    expect(result).toBe(900);
  });

  it("applies configured intensity and indoor factors", () => {
    const indoorExercise: Activity = {
      ...walk,
      durationMinutes: 30,
      environment: "indoor",
      intensity: "high",
    };

    const result = calculateActivityExposureIndex(
      indoorExercise,
      480,
      makeProfile(),
      testConfig,
    );

    // 10 × 30 minutes × 2 × 0.5
    expect(result).toBe(300);
  });

  it("rejects missing hourly measurements", () => {
    const values = Array(24).fill(10) as (number | null)[];
    values[7] = null;

    expect(() =>
      calculateActivityExposureIndex(
        walk,
        420,
        makeProfile(values),
        testConfig,
      ),
    ).toThrow(/hour 7/);
  });

  it("rejects activities extending past midnight", () => {
    expect(() =>
      calculateActivityExposureIndex(
        walk,
        1410,
        makeProfile(),
        testConfig,
      ),
    ).toThrow(/past midnight/);
  });
});