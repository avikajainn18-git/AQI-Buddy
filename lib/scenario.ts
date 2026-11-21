import type { Activity } from "./types";

/**
 * AQI Buddy Round 1 fixed weekday scenario.
 *
 * Times are minutes after midnight.
 * This is a hypothetical test scenario, not observed user data.
 */
export const STUDENT_WEEKDAY_ACTIVITIES: Activity[] = [
  {
    id: "outdoor-exercise",
    name: "Outdoor exercise",
    kind: "flexible",
    durationMinutes: 45,
    earliestStartMinute: 330, // 05:30
    latestStartMinute: 1215, // 20:15
    preferredStartMinute: 420, // Original routine: 07:00
    environment: "outdoor",
    intensity: "high",
  },
  {
    id: "morning-prep",
    name: "Breakfast and preparation",
    kind: "fixed",
    startMinute: 465, // 07:45
    durationMinutes: 30,
    environment: "indoor",
    intensity: "sedentary",
  },
  {
    id: "commute-to-campus",
    name: "Commute to college",
    kind: "fixed",
    startMinute: 495, // 08:15
    durationMinutes: 45,
    environment: "outdoor",
    intensity: "light",
  },
  {
    id: "college-classes",
    name: "College classes",
    kind: "fixed",
    startMinute: 540, // 09:00
    durationMinutes: 420, // Until 16:00
    environment: "indoor",
    intensity: "sedentary",
  },
  {
    id: "commute-home",
    name: "Commute home",
    kind: "fixed",
    startMinute: 960, // 16:00
    durationMinutes: 45,
    environment: "outdoor",
    intensity: "light",
  },
  {
    id: "outdoor-errand",
    name: "Outdoor market errand",
    kind: "flexible",
    durationMinutes: 30,
    earliestStartMinute: 1005, // 16:45
    latestStartMinute: 1230, // 20:30
    preferredStartMinute: 1080, // Original routine: 18:00
    environment: "outdoor",
    intensity: "light",
  },
];

export const STUDENT_SCENARIO_ASSUMPTIONS = {
  name: "Delhi-NCR college student's weekday",
  flexibleActivityCount: 2,
  totalActivityCount: 6,

  timeGridMinutes: 15,

  // The test horizon runs from 05:00 through 20:59.
  planningStartMinute: 300,
  planningEndMinute: 1260,

  // Fixed activities cannot be moved.
  preserveFixedCommitments: true,

  // Activities cannot overlap.
  allowActivityOverlap: false,

  limitations: [
    "This is a hypothetical weekday, not a measured personal diary.",
    "Commutes are simplified as outdoor exposure.",
    "The errand is modelled as an outdoor market activity.",
    "Travel time changes and route-level exposure are not modelled.",
    "The indoor multiplier and activity-intensity factors are assumptions.",
  ],
} as const;