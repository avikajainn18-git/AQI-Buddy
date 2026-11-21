import { describe, expect, it } from "vitest";
import { optimizeSchedule } from "./optimizer";

import type {
  Activity,
  ExposureModelConfig,
  HourlyPm25Profile,
} from "./types";

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

function makeProfile(): HourlyPm25Profile {
  const values: (number | null)[] = Array(24).fill(10);

  // Synthetic values to make the best slot predictable.
  values[6] = 60;
  values[7] = 40;
  values[8] = 5;

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

const classActivity: Activity = {
  id: "class",
  name: "College class",
  kind: "fixed",
  startMinute: 540, // 9:00 AM
  durationMinutes: 60,
  environment: "indoor",
  intensity: "sedentary",
};

const walkActivity: Activity = {
  id: "walk",
  name: "Outdoor walk",
  kind: "flexible",
  earliestStartMinute: 360, // 6:00 AM
  latestStartMinute: 480, // 8:00 AM
  preferredStartMinute: 360, // Original routine: 6:00 AM
  durationMinutes: 60,
  environment: "outdoor",
  intensity: "light",
};

describe("optimizeSchedule", () => {
  it("preserves fixed commitments and finds a lower-exposure slot", () => {
    const result = optimizeSchedule(
      [classActivity, walkActivity],
      makeProfile(),
      testConfig,
    );

    const optimizedClass = result.optimizedPlacements.find(
      (placement) => placement.activityId === "class",
    );

    const optimizedWalk = result.optimizedPlacements.find(
      (placement) => placement.activityId === "walk",
    );

    // The fixed class must remain at 9:00 AM.
    expect(optimizedClass?.startMinute).toBe(540);

    // The walk can end at 9:00 AM without overlapping the class.
    expect(optimizedWalk?.startMinute).toBe(480);

    expect(result.optimizedExposureIndex).toBeLessThan(
      result.baselineExposureIndex,
    );

    expect(result.completeSchedulesEvaluated).toBeGreaterThan(0);
  });

  it("rejects an overlapping original schedule", () => {
    const overlappingWalk: Activity = {
      ...walkActivity,
      earliestStartMinute: 540,
      latestStartMinute: 600,
      preferredStartMinute: 540,
      durationMinutes: 30,
    };

    expect(() =>
      optimizeSchedule(
        [classActivity, overlappingWalk],
        makeProfile(),
        testConfig,
      ),
    ).toThrow(/overlap/i);
  });
});