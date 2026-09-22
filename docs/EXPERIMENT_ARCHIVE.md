# Local experiment archive

> **Note:** this document predates the zero-swarm migration and still describes
> several removed legacy features (per-agent communications, diplomacy,
> alliances, and the schema-v9/v10/v11 compatibility described below). The
> archive now accepts only schema-v12 exports and rejects anything else; see
> ADR 0033. A full rewrite of this document is tracked separately.

The archive accepts only schema-v12 exports and rejects any other schema version outright.
Migration 2 adds nullable tick number, deterministic tick position, virtual
time, and interval columns. Bounded queries order tick-attributed records by
tick and tick position where exposed; the CLI still provides no arbitrary SQL
surface.
Migration 3 adds aggregate simulated-player metrics to experiments and the
`simulated_player_activity` table. Every metrics-bearing safe export preserves
movement/clean/block totals; Full Safe additionally preserves tick-attributed
activity without deriving player behavior from agent turns.

The experiment archive is a durable, local research surface for completed or partially retained exports. It does not participate in an active simulation: the Game API's in-memory engine remains authoritative, and an archive write cannot change an accepted game outcome. It imports schema-v12 JSON exports only; it is not crash recovery, restartable simulation state, or a scheduler.

## Storage and configuration

World Lab provides a manual import path after an operator explicitly generates
an export. Preview is optional. **Save to SQLite** sends that exact current
artifact; stale artifacts are disabled. The API reuses the transactional,
safe-field-scanned, idempotent importer, opens the configured archive lazily,
and closes the handle. It accepts no browser-selected path and never writes
automatically.

`@hexzero/experiment-archive` uses SQLite built into the pinned Node 24 runtime. Versioned migrations create strict tables with foreign keys and indexes. File-backed databases enable WAL and a five-second busy timeout; imports use prepared statements inside one transaction. Tests use in-memory or temporary databases.

The new default database is `.hexzero/experiments.sqlite`, an ignored development path. Resolution order is explicit `--db`, `HEXZERO_EXPERIMENT_DB`, legacy `AGENTBORNE_EXPERIMENT_DB`, an existing `.hexzero/experiments.sqlite`, an existing `.agentborne/experiments.sqlite`, then a new `.hexzero/experiments.sqlite`. Legacy selections emit a concise notice and open normally; no database is moved, overwritten, or recreated for branding.

For an optional manual migration, stop all Hex Zero processes, create the
`.hexzero` directory, copy `experiments.sqlite` and any matching `-wal` and
`-shm` sidecars from `.agentborne`, verify the copied archive opens, and only
then remove the legacy files if desired.

The schema normalizes experiments, source exports, agents, map cells, swarm ticks, provider attempts, world events, configuration changes, simulated-player activity, and research notes. Stable source IDs are retained; deterministic experiment/attempt IDs make imports idempotent. Source aggregate metrics remain audit evidence, while summaries derive canonical metrics from stored records.

Retention is never silently upgraded. A filtered import, missing optional observation, or truncated source remains visible as incomplete or missing data. Import validates the complete export and rejects prohibited credential/private-reasoning fields before beginning its transaction. Persistence errors roll back and surface explicitly.

## Commands

```bash
pnpm experiment:db import ./exports/run.json
pnpm experiment:db list
pnpm experiment:db summary <experiment-id>
pnpm experiment:db compare <experiment-id-a> <experiment-id-b>
pnpm experiment:db provider-attempts <experiment-id>
pnpm experiment:db failures <experiment-id> --reason invalid-json
```

Commands support `--format table|json|markdown`; table is the concise default. Detail queries default to 50 rows and clamp limits to 500. Filters are exact, ordering is deterministic, and arbitrary SQL is not exposed.

Summary covers scenario/roster attribution, outcomes, action distribution, territory, provider attempt/attempt-accounting usage, size trends, retention, and inconsistencies. Comparison reports absolute totals plus per-tick and per-active-agent rates.

## Curated notes

```bash
pnpm experiment:db notes import ./notes/design-review.md \
  --type decision --status accepted --tag communication \
  --provenance "design review 2026-08-20" --experiment <experiment-id>
pnpm experiment:db notes search "Patient Zero reply" --status accepted
pnpm experiment:db notes list --type experiment-finding --experiment <experiment-id>
```

Types are `transcript`, `observation`, `hypothesis`, `decision`, `implementation-note`, and `experiment-finding`. Statuses are `proposed`, `accepted`, `rejected`, `deferred`, and `superseded`. Repeat `--tag` and `--experiment` for several values. `--supersedes <note-id>` links the replacement and marks the old note superseded. FTS5 indexes title, body, and tags; exact structured filters apply before relevance. Results prominently include status and provenance.

## Compact context for local Codex

Prefer bounded Markdown or JSON over a multi-megabyte export:

```bash
pnpm experiment:db summary <experiment-id> --format markdown
pnpm experiment:db patient-zero <experiment-id> --limit 30 --format markdown
pnpm experiment:db failures <experiment-id> --limit 20 --format json
pnpm experiment:db notes search "communication hypothesis" --status accepted --limit 10 --format markdown
```

Example comparison workflow:

```bash
pnpm experiment:db import ./exports/run-a.json
pnpm experiment:db import ./exports/run-b.json
pnpm experiment:db summary <run-a-id> --format markdown
pnpm experiment:db patient-zero <run-a-id> --limit 40 --format markdown
pnpm experiment:db compare <run-a-id> <run-b-id> --format markdown
```

## Privacy and future adapters

The archive stores only schema-validated safe export fields and curated notes. It rejects recognizable credential material and prohibited raw/private reasoning keys. It does not store fixed prompts, raw provider bodies, authorization headers, private chain-of-thought, or provider credentials. Agent messages and notes remain untrusted research data.

MCP and embeddings are deferred because bounded local retrieval solves the immediate need without a network/tool authorization surface or derived semantic store. `ExperimentQueryService` and `ResearchNoteService` are the future extension point for a read-only MCP adapter; write/import authority remains outside that adapter.

# Provider attempts

Archive schema v4 stores `providerAttempts` independently. Use
`pnpm experiment:db provider-attempts <experiment-id>` to inspect committed and
uncommitted provider work. Monetary values round-trip as canonical TEXT. This
ledger is canonical for every current (schema-v12) export, which always
carries independent attempt accounting. The SQLite archive is for analysis
and is not active runtime recovery.

Archive schema v5 adds `swarm_ticks` for safe committed zero-swarm plans,
directives, physical action results, and worker choice telemetry. Full
all-agent exports carry these records. Provider attempts remain in the
independent v4 ledger, including attempts from cancelled or rolled-back
swarm ticks.

## Zero-swarm comparisons

The archive preserves safe schema-v12 swarm tick records and independent
provider attempts, but its `compare` command is not the same-scenario,
per-tick swarm harness. Use `pnpm compare:offline` for the reproducible
zero-swarm-vs-deterministic-workers fixture report. The runner does not
import, write, or modify this archive. See
[Zero-swarm offline comparison](ZERO_SWARM_COMPARISON.md).
