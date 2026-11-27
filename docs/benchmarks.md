# Prood Performance Benchmarks & Measurement Conditions

PR 01 fixes the benchmark conditions and baseline transfer metrics so subsequent PRs can compare performance under identical rules.

## 1. Fixed Measurement Conditions

| Dimension | Standard Condition |
|---|---|
| Reference machine | Apple M3 Ultra (macOS arm64), Node.js v22.23.0; CI reference on GitHub-hosted `ubuntu-latest` (x64, Node.js 22) |
| Seed dataset (for Stage 1–2) | 2 workspaces, 4 projects (general + development, mixed visibility), 1,000 tasks across 5 statuses |
| Cache conditions | **Cold**: fresh browser context / cleared cache, newly opened DB connection. **Warm**: in-session navigation with cached shell assets |
| Databases | Measured separately on **SQLite** (local file with WAL) and **PostgreSQL** (Docker/service container) — never substituted for each other |

## 2. Measured Intervals

1. **Common Shell Transfer (`shell.js` + `shell.css`)**: Raw bytes and gzip level-9 bytes produced by `pnpm measure:shell`. Heavy feature modules (dashboard, knowledge, timeline, automation) must remain excluded from the shell bundle.
2. **Initial Task Display**: Time from navigation start / request initiation to first List render containing task rows (introduced in PR 08).
3. **Start Task Latency (`start_task`)**: Server + DB transaction round-trip time from MCP `start_task` request receipt to committed response (introduced in PR 10).
4. **Audit Delivery Delay**: Elapsed time from `outbox` commit timestamp to confirmed Retraced ingestion acknowledgment (introduced in PR 13).

## 3. Baseline Records

### PR 01 — Common Web Shell Baseline
Measured on 2026-11-27 (macOS arm64, Apple M3 Ultra, Node.js v22.23.0) after `pnpm build` via `pnpm measure:shell`:

- `shell.js`: `3,024` bytes raw (`1,309` bytes gzip level-9)
- `shell.css`: `1,340` bytes raw (`584` bytes gzip level-9)
- Total: `4,364` bytes raw (`1,893` bytes gzip level-9)
