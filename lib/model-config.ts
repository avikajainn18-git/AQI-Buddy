import type { ExposureModelConfig } from "./types";

const sedentaryMean = 0.0042;
const sedentary95th = 0.0065;

export const BASELINE_MODEL_CONFIG: ExposureModelConfig = {
  modelVersion: "aqi-buddy-v1-epa-mean-neutral-indoor",

  // Relative inhalation-rate multipliers.
  // All rates are normalised to the sedentary mean rate.
  intensityMultipliers: {
    sedentary: sedentaryMean / sedentaryMean,
    light: 0.012 / sedentaryMean,
    moderate: 0.026 / sedentaryMean,
    high: 0.050 / sedentaryMean,
  },

  // Neutral baseline: indoor concentration is assumed equal
  // to outdoor concentration unless a sensitivity scenario is used.
  microenvironmentMultipliers: {
    indoor: 1.0,
    outdoor: 1.0,
  },
};

export const SENSITIVITY_MODEL_CONFIGS: Record<
  "indoorLow" | "indoorHigh" | "higherVentilation",
  ExposureModelConfig
> = {
  indoorLow: {
    ...BASELINE_MODEL_CONFIG,
    modelVersion: "aqi-buddy-v1-indoor-io-063",
    microenvironmentMultipliers: {
      indoor: 0.63,
      outdoor: 1.0,
    },
  },

  indoorHigh: {
    ...BASELINE_MODEL_CONFIG,
    modelVersion: "aqi-buddy-v1-indoor-io-217",
    microenvironmentMultipliers: {
      indoor: 2.17,
      outdoor: 1.0,
    },
  },

  higherVentilation: {
    ...BASELINE_MODEL_CONFIG,
    modelVersion: "aqi-buddy-v1-epa-95th-rates",
    intensityMultipliers: {
      sedentary: sedentary95th / sedentary95th,
      light: 0.016 / sedentary95th,
      moderate: 0.038 / sedentary95th,
      high: 0.076 / sedentary95th,
    },
  },
};

export const MODEL_ASSUMPTIONS = {
  exposureOutput:
    "Relative exposure index, not a validated personal dose or medical-risk prediction.",

  inhalationRateSource: {
    name: "U.S. EPA Exposure Factors Handbook",
    table: "Table 6-2: Recommended Short-Term Exposure Values for Inhalation",
    url: "https://www.epa.gov/system/files/documents/2025-01/efh-chapter06_508.pdf",
    ageGroup: "21 to under 31 years",
    ratesMeanM3PerMinute: {
      sedentary: 0.0042,
      light: 0.012,
      moderate: 0.026,
      high: 0.050,
    },
    rates95thM3PerMinute: {
      sedentary: 0.0065,
      light: 0.016,
      moderate: 0.038,
      high: 0.076,
    },
    interpretation:
      "U.S. reference rates used to derive relative activity multipliers, not an India-specific personal ventilation estimate.",
  },

  indoorOutdoorSource: {
    name: "IIT Delhi, Monitoring of Air Quality in Urban Indoors in Delhi",
    table: "Table 18: Indoor-outdoor ratios in selected microenvironments",
    url: "https://cerca.iitd.ac.in/app/assets/Research/Completed/MONITORING%20OF%20AIR%20QUALITY%20IN%20URBAN%20INDOORS%20IN%20DELHI.pdf",
    observedCollegePm25Ratios: [0.63, 0.78, 1.10, 1.12, 1.65, 2.17],
    baselineIndoorMultiplier: 1.0,
    sensitivityRange: [0.63, 2.17],
    interpretation:
      "Small, non-random sample from selected Delhi colleges. Used as a sensitivity range, not a universal indoor infiltration factor.",
  },
} as const;