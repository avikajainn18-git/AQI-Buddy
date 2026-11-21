# AQI Buddy 

**Personal exposure-aware daily planning using air-quality data.**

AQI Buddy explores how outdoor activities can be scheduled around historical air-pollution patterns in Delhi-NCR. It uses hourly PM2.5 observations and backtesting to evaluate whether changing the timing of flexible activities may reduce estimated pollution exposure while keeping fixed commitments unchanged.

## Project goals

- Ingest and normalize hourly air-quality observations.
- Assess station-level data coverage and quality.
- Build historical baselines and evaluate scheduling policies.
- Compare policy performance using backtests and a separate date-period holdout evaluation.
- Preserve evaluation results and reports so model behavior and limitations can be inspected.

## Technology

- Next.js
- React
- TypeScript
- Vitest
- ESLint
- OpenAQ air-quality data

## Getting started

### Requirements

Install Node.js and npm.

### Install dependencies

```bash
npm install
```

### Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Available commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Build the Next.js application |
| `npm start` | Start the production server |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint |
| `npm run backtest` | Run the backtest script |
| `npx tsc --noEmit` | Check TypeScript types without emitting files |

## Data and evaluation

The `data/` directory contains raw and processed air-quality observations, backtest results, policy evaluation outputs, and reports.

Results are retrospective and depend on station coverage, historical data quality, and modeling assumptions. A holdout period can help assess performance on dates excluded from policy development, but it does not establish future real-world effectiveness.

Review the accompanying data sources, applicable usage terms, and report metadata before redistributing datasets.

## Limitations and responsible use

- Station readings may not represent conditions at an individual's exact location.
- Historical pollution patterns are not guaranteed to predict future conditions.
- Estimated exposure reduction is a proxy, not a direct measurement of personal exposure or health outcomes.
- AQI Buddy is an experimental planning tool, not medical advice or a substitute for official health guidance.

## Security

Keep API keys and other credentials in local environment variables. Never commit secrets to source control.

## Project status

AQI Buddy is under development. Evaluation outputs should be interpreted alongside their methodology, coverage checks, and limitations.
