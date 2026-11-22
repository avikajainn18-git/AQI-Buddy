import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <nav className="flex items-center justify-between border-b border-white/10 px-6 py-5 sm:px-10">
        <Link
          href="/"
          className="text-2xl font-bold text-emerald-400"
        >
          AQI Buddy
        </Link>

        <span className="text-sm text-slate-400">
          Delhi-NCR · Air-aware planning
        </span>
      </nav>

      <section className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-emerald-400">
          Breathe smarter. Plan better.
        </p>

        <h1 className="max-w-4xl text-5xl font-bold leading-tight sm:text-7xl">
          Make room for cleaner-air moments.
        </h1>

        <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-300">
          Explore how changing the timing of flexible activities may
          reduce estimated PM2.5 exposure while keeping fixed
          commitments in place.
        </p>

        <div className="mt-10 flex flex-wrap gap-4">
          <Link
            href="/planner"
            className="rounded-xl bg-emerald-400 px-6 py-4 font-bold text-slate-950 transition hover:bg-emerald-300"
          >
            Try the Planner →
          </Link>

          <a
            href="#how-it-works"
            className="rounded-xl border border-white/20 px-6 py-4 font-semibold text-white transition hover:bg-white/5"
          >
            How it works
          </a>
        </div>

        <div
          id="how-it-works"
          className="mt-20 grid gap-5 sm:grid-cols-2"
        >
          <article className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm text-emerald-400">01 / DATA</p>
            <h2 className="mt-3 text-2xl font-semibold">
              Historical air quality
            </h2>
            <p className="mt-3 leading-7 text-slate-300">
              Uses hourly PM2.5 profiles from monitoring stations
              around Delhi-NCR. These readings are historical, not live.
            </p>
          </article>

          <article className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm text-emerald-400">02 / PLANNING</p>
            <h2 className="mt-3 text-2xl font-semibold">
              Flexible scheduling
            </h2>
            <p className="mt-3 leading-7 text-slate-300">
              Compares an original daily schedule with a feasible
              schedule proposed by the exposure-aware optimizer.
            </p>
          </article>
        </div>

        <div className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-6">
          <h2 className="font-semibold text-amber-200">
            Research prototype
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Estimated exposure changes are experimental model outputs,
            not validated personal-dose predictions, medical advice,
            or guarantees of lower real-world exposure.
          </p>
        </div>
      </section>

      <footer className="border-t border-white/10 px-6 py-6 text-center text-sm text-slate-500">
        AQI Buddy · HealthTech & Social Impact
      </footer>
    </main>
  );
}