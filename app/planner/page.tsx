"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
type Station = {
  stationId: string;
  stationName: string;
  area?: string;
  stationCoveragePercent?: number;
  dates: string[];
};

type Intensity = "sedentary" | "light" | "moderate" | "high";
type Environment = "indoor" | "outdoor";
type ActivityKind = "fixed" | "flexible";

type ActivityDraft = {
  id: string;
  name: string;
  kind: ActivityKind;
  durationMinutes: number;
  environment: Environment;
  intensity: Intensity;
  fixedStart: string;
  earliestStart: string;
  latestStart: string;
  preferredStart: string;
};

type Placement = {
  activityId: string;
  startMinute: number;
};

type PlanResult = {
  station: string;
  stationId: string;
  date: string;
  timezone: string;
  sourceName: string;
  sourceUrl: string;
  dataRetrievedAt: string;
  modelVersion: string;
  baselinePlacements: Placement[];
  optimizedPlacements: Placement[];
  baselineExposureIndex: number;
  optimizedExposureIndex: number;
  reductionPercent: number | null;
  completeSchedulesEvaluated: number;
  skippedCandidateSlotsMissingData: number;
  activities: {
    id: string;
    name: string;
    kind: ActivityKind;
    durationMinutes: number;
  }[];
  disclaimer: string;
};

const initialActivities: ActivityDraft[] = [
  {
    id: "walk",
    name: "Outdoor walk",
    kind: "flexible",
    durationMinutes: 45,
    environment: "outdoor",
    intensity: "moderate",
    fixedStart: "06:30",
    earliestStart: "06:00",
    latestStart: "08:00",
    preferredStart: "06:30",
  },
  {
    id: "class",
    name: "College / work",
    kind: "fixed",
    durationMinutes: 180,
    environment: "indoor",
    intensity: "sedentary",
    fixedStart: "09:00",
    earliestStart: "09:00",
    latestStart: "10:00",
    preferredStart: "09:00",
  },
  {
    id: "break",
    name: "Afternoon activity",
    kind: "flexible",
    durationMinutes: 30,
    environment: "outdoor",
    intensity: "light",
    fixedStart: "16:00",
    earliestStart: "14:00",
    latestStart: "18:00",
    preferredStart: "16:00",
  },
];

const fieldClass =
  "mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white focus:border-emerald-400 focus:outline-none";

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function toTime(minutes: number): string {
  const safeMinutes = Math.max(0, Math.min(1439, minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function formatIndex(value: number): string {
  return value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

export default function PlannerPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState("");
  const [date, setDate] = useState("");
  const [activities, setActivities] =
    useState<ActivityDraft[]>(initialActivities);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadStations() {
      try {
        const response = await fetch("/api/plan");
        const data = (await response.json()) as {
          stations?: Station[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(data.error ?? "Unable to load stations.");
        }

        const availableStations = data.stations ?? [];
        setStations(availableStations);

        if (availableStations.length > 0) {
          const first = availableStations[0];
          setStationId(first.stationId);
          setDate(first.dates[first.dates.length - 1] ?? "");
        } else {
          setError("No stations with complete daily readings were found.");
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to connect to the planner API."
        );
      } finally {
        setLoadingData(false);
      }
    }

    void loadStations();
  }, []);

  function updateActivity(
    id: string,
    patch: Partial<ActivityDraft>
  ) {
    setActivities((current) =>
      current.map((activity) =>
        activity.id === id ? { ...activity, ...patch } : activity
      )
    );
    setResult(null);
  }

  function addActivity() {
    if (activities.length >= 10) return;

    const id = `activity-${Date.now()}`;

    setActivities((current) => [
      ...current,
      {
        id,
        name: "New activity",
        kind: "flexible",
        durationMinutes: 30,
        environment: "outdoor",
        intensity: "light",
        fixedStart: "12:00",
        earliestStart: "10:00",
        latestStart: "17:00",
        preferredStart: "12:00",
      },
    ]);

    setResult(null);
  }

  function removeActivity(id: string) {
    setActivities((current) =>
      current.filter((activity) => activity.id !== id)
    );
    setResult(null);
  }

  async function generatePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);

    if (!stationId || !date) {
      setError("Choose a station and a date first.");
      return;
    }

    for (const activity of activities) {
      if (!activity.name.trim()) {
        setError("Every activity needs a name.");
        return;
      }

      if (
        !Number.isInteger(activity.durationMinutes) ||
        activity.durationMinutes < 1 ||
        activity.durationMinutes > 1440
      ) {
        setError(`Check the duration for ${activity.name}.`);
        return;
      }

      if (activity.kind === "flexible") {
        const earliest = toMinutes(activity.earliestStart);
        const latest = toMinutes(activity.latestStart);
        const preferred = toMinutes(activity.preferredStart);

        if (earliest > latest || preferred < earliest || preferred > latest) {
          setError(
            `Check the preferred start and time window for ${activity.name}.`
          );
          return;
        }
      }
    }

    const payloadActivities = activities.map((activity) => {
      const common = {
        id: activity.id,
        name: activity.name.trim(),
        durationMinutes: Number(activity.durationMinutes),
        environment: activity.environment,
        intensity: activity.intensity,
      };

      if (activity.kind === "fixed") {
        return {
          ...common,
          kind: "fixed" as const,
          startMinute: toMinutes(activity.fixedStart),
        };
      }

      return {
        ...common,
        kind: "flexible" as const,
        earliestStartMinute: toMinutes(activity.earliestStart),
        latestStartMinute: toMinutes(activity.latestStart),
        preferredStartMinute: toMinutes(activity.preferredStart),
      };
    });

    setPlanning(true);

    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stationId,
          date,
          activities: payloadActivities,
        }),
      });

      const data = (await response.json()) as PlanResult & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "The planner could not generate a schedule.");
      }

      setResult(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while generating the plan."
      );
    } finally {
      setPlanning(false);
    }
  }

  const selectedStation = stations.find(
    (station) => station.stationId === stationId
  );

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-10 text-white sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
  href="/"
  className="text-sm text-emerald-400 hover:text-emerald-300"
>
  ← Back to AQI Buddy
</Link>

        <header className="mb-8 mt-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">
            Your daily planner
          </p>
          <h1 className="mt-3 text-4xl font-bold sm:text-5xl">
            Find a better time for your activities.
          </h1>
          <p className="mt-4 max-w-2xl leading-7 text-slate-300">
            Use historical hourly PM2.5 readings to compare your original
            schedule with a schedule proposed by the AQI Buddy optimizer.
          </p>
        </header>

        <form onSubmit={generatePlan} className="space-y-8">
          <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-semibold">1. Choose your data</h2>

            {loadingData ? (
              <p className="mt-4 text-slate-300">
                Loading available stations and dates…
              </p>
            ) : (
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <label className="text-sm text-slate-300">
                  Monitoring station
                  <select
                    className={fieldClass}
                    value={stationId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      const station = stations.find(
                        (item) => item.stationId === nextId
                      );
                      setStationId(nextId);
                      setDate(
                        station?.dates[station.dates.length - 1] ?? ""
                      );
                      setResult(null);
                    }}
                    required
                  >
                    {stations.map((station) => (
                      <option key={station.stationId} value={station.stationId}>
                        {station.stationName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-slate-300">
                  Historical date
                  <select
                    className={fieldClass}
                    value={date}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setResult(null);
                    }}
                    required
                  >
                    {(selectedStation?.dates ?? []).map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {selectedStation && (
              <p className="mt-4 text-sm leading-6 text-slate-400">
                Station coverage reported for the dataset:{" "}
                {selectedStation.stationCoveragePercent != null
                  ? `${selectedStation.stationCoveragePercent}%`
                  : "not available"}
                . This describes overall station coverage, not a guarantee
                that every hour on the selected date is complete.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">2. Add your activities</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Fixed activities stay in place. Flexible activities can move
                  within their specified time windows.
                </p>
              </div>

              <button
                type="button"
                onClick={addActivity}
                disabled={activities.length >= 10}
                className="rounded-lg border border-emerald-400/50 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-40"
              >
                + Add activity
              </button>
            </div>

            <div className="mt-6 space-y-5">
              {activities.map((activity, index) => (
                <article
                  key={activity.id}
                  className="rounded-xl border border-white/10 bg-slate-900/70 p-5"
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h3 className="font-semibold">
                      Activity {index + 1}
                    </h3>

                    {activities.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeActivity(activity.id)}
                        className="text-sm text-rose-300 hover:text-rose-200"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="text-sm text-slate-300">
                      Activity name
                      <input
                        className={fieldClass}
                        value={activity.name}
                        maxLength={80}
                        onChange={(event) =>
                          updateActivity(activity.id, {
                            name: event.target.value,
                          })
                        }
                        required
                      />
                    </label>

                    <label className="text-sm text-slate-300">
                      Scheduling
                      <select
                        className={fieldClass}
                        value={activity.kind}
                        onChange={(event) =>
                          updateActivity(activity.id, {
                            kind: event.target.value as ActivityKind,
                          })
                        }
                      >
                        <option value="fixed">Fixed commitment</option>
                        <option value="flexible">Flexible timing</option>
                      </select>
                    </label>

                    <label className="text-sm text-slate-300">
                      Duration (minutes)
                      <input
                        className={fieldClass}
                        type="number"
                        min="1"
                        max="1440"
                        value={activity.durationMinutes}
                        onChange={(event) =>
                          updateActivity(activity.id, {
                            durationMinutes: Number(event.target.value),
                          })
                        }
                        required
                      />
                    </label>

                    <label className="text-sm text-slate-300">
                      Environment
                      <select
                        className={fieldClass}
                        value={activity.environment}
                        onChange={(event) =>
                          updateActivity(activity.id, {
                            environment: event.target.value as Environment,
                          })
                        }
                      >
                        <option value="outdoor">Outdoor</option>
                        <option value="indoor">Indoor</option>
                      </select>
                    </label>

                    <label className="text-sm text-slate-300">
                      Activity intensity
                      <select
                        className={fieldClass}
                        value={activity.intensity}
                        onChange={(event) =>
                          updateActivity(activity.id, {
                            intensity: event.target.value as Intensity,
                          })
                        }
                      >
                        <option value="sedentary">Sedentary</option>
                        <option value="light">Light</option>
                        <option value="moderate">Moderate</option>
                        <option value="high">High</option>
                      </select>
                    </label>

                    {activity.kind === "fixed" ? (
                      <label className="text-sm text-slate-300">
                        Fixed start time
                        <input
                          className={fieldClass}
                          type="time"
                          value={activity.fixedStart}
                          onChange={(event) =>
                            updateActivity(activity.id, {
                              fixedStart: event.target.value,
                            })
                          }
                          required
                        />
                      </label>
                    ) : (
                      <>
                        <label className="text-sm text-slate-300">
                          Earliest start
                          <input
                            className={fieldClass}
                            type="time"
                            value={activity.earliestStart}
                            onChange={(event) =>
                              updateActivity(activity.id, {
                                earliestStart: event.target.value,
                              })
                            }
                            required
                          />
                        </label>

                        <label className="text-sm text-slate-300">
                          Latest start
                          <input
                            className={fieldClass}
                            type="time"
                            value={activity.latestStart}
                            onChange={(event) =>
                              updateActivity(activity.id, {
                                latestStart: event.target.value,
                              })
                            }
                            required
                          />
                        </label>

                        <label className="text-sm text-slate-300">
                          Usual start time
                          <input
                            className={fieldClass}
                            type="time"
                            value={activity.preferredStart}
                            onChange={(event) =>
                              updateActivity(activity.id, {
                                preferredStart: event.target.value,
                              })
                            }
                            required
                          />
                        </label>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loadingData || planning || stations.length === 0}
            className="w-full rounded-xl bg-emerald-400 px-6 py-4 font-bold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {planning ? "Optimizing your schedule…" : "Generate my schedule →"}
          </button>
        </form>

        {result && (
          <section className="mt-10 space-y-6">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">
                Optimization results
              </p>
              <h2 className="mt-2 text-3xl font-bold">
                Your schedule comparison
              </h2>
              <p className="mt-3 text-sm text-slate-400">
                {result.station} · {result.date} · Historical data
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <p className="text-sm text-slate-400">
                  Original relative exposure index
                </p>
                <p className="mt-3 text-3xl font-bold">
                  {formatIndex(result.baselineExposureIndex)}
                </p>
              </div>

              <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-6">
                <p className="text-sm text-slate-400">
                  Proposed relative exposure index
                </p>
                <p className="mt-3 text-3xl font-bold text-emerald-300">
                  {formatIndex(result.optimizedExposureIndex)}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <h3 className="text-lg font-semibold">Schedule by activity</h3>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="text-slate-400">
                    <tr className="border-b border-white/10">
                      <th className="py-3 pr-4">Activity</th>
                      <th className="py-3 pr-4">Original start</th>
                      <th className="py-3 pr-4">Proposed start</th>
                      <th className="py-3">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.activities.map((activity) => {
                      const baseline = result.baselinePlacements.find(
                        (item) => item.activityId === activity.id
                      );
                      const optimized = result.optimizedPlacements.find(
                        (item) => item.activityId === activity.id
                      );

                      return (
                        <tr
                          key={activity.id}
                          className="border-b border-white/5"
                        >
                          <td className="py-4 pr-4 font-medium">
                            {activity.name}
                          </td>
                          <td className="py-4 pr-4">
                            {baseline
                              ? toTime(baseline.startMinute)
                              : "—"}
                          </td>
                          <td className="py-4 pr-4 text-emerald-300">
                            {optimized
                              ? toTime(optimized.startMinute)
                              : "—"}
                          </td>
                          <td className="py-4">
                            {activity.kind === "fixed" ? "Fixed" : "Flexible"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <h3 className="font-semibold">What the model calculated</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                {result.reductionPercent === null
                  ? "The original exposure index is zero, so a percentage change cannot be calculated."
                  : `Estimated index change: ${result.reductionPercent.toFixed(2)}%. A positive value means the model's proposed schedule has a lower index; a negative value means it has a higher index.`}
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                The optimizer evaluated {result.completeSchedulesEvaluated}{" "}
                complete feasible schedule(s). It skipped{" "}
                {result.skippedCandidateSlotsMissingData} candidate start slot(s)
                because required hourly PM2.5 data was missing.
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Model: {result.modelVersion}
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Source:{" "}
                <a
                  href={result.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-emerald-300 underline"
                >
                  {result.sourceName}
                </a>
              </p>
              <p className="mt-4 text-sm leading-6 text-amber-200">
                {result.disclaimer}
              </p>
            </div>
          </section>
        )}

        <footer className="mt-12 border-t border-white/10 pt-6 text-xs leading-6 text-slate-500">
          AQI Buddy · Research prototype · Historical readings are not live
          measurements. Estimated relative exposure indices are experimental,
          not medical advice or a guarantee of real-world outcomes.
        </footer>
      </div>
    </main>
  );
}