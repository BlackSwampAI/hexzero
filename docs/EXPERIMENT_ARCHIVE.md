# Local experiment archive

The archive accepts current schema-v10 exports and legacy schema-v9 exports.
Schema-v10 may add safe goal revision/result and current-goal fields. Current archive imports validate and preserve compatibility while normalized goal analytics remain deferred; the archive never restores active goal state.
Schema-v10 may also include compact memory requests, results, and current ledgers. The archive accepts these additive fields observationally but does not normalize, rank, retrieve, or restore memory.
Migration 2 adds nullable tick number, deterministic tick position, virtual
time, and interval columns so legacy rows remain valid. Schema-v10 lost-tick
outcomes are preserved as source outcomes; canonical summaries continue to be
derived from normalized rows and remain distinct from source metrics. Bounded
queries order tick-attributed records by tick and tick position where exposed;
the CLI still provides no arbitrary SQL surface.
Legacy scenarios with a null Patient Zero designation remain valid historical
records. They retain null attribution and Patient Zero queries return no
coordinator activity; current live setup requirements do not rewrite them.

The experiment archive is a durable, local research surface for completed or partially retained exports. It does not participate in an active simulation: the Game API's in-memory engine remains authoritative, and an archive write cannot change an accepted game outcome. It imports schema-v10 and compatible schema-v9 JSON exports; it is not crash recovery, restartable simulation state, or a scheduler.

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

The schema normalizes experiments, source exports, roster/assignments, topology, turns, model attempts, communications and recipients, diplomacy attempts, alliance events, world events, configuration changes, and research notes. Stable source IDs are retained; deterministic experiment/turn/attempt IDs make imports idempotent. Source aggregate metrics remain audit evidence, while summaries derive canonical metrics from stored records.

Retention is never silently upgraded. A filtered import, missing optional observation, or truncated source remains visible as incomplete or missing data. Import validates the complete export and rejects prohibited credential/private-reasoning fields before beginning its transaction. Persistence errors roll back and surface explicitly.

## Commands

```bash
pnpm experiment:db import ./exports/run.json
pnpm experiment:db list
pnpm experiment:db summary <experiment-id>
pnpm experiment:db compare <experiment-id-a> <experiment-id-b>
pnpm experiment:db turns <experiment-id> --agent <agent-id> --from-turn 40 --to-turn 80
pnpm experiment:db communications <experiment-id> --channel direct --recipient <agent-id>
pnpm experiment:db alliance-events <experiment-id> --reason expired
pnpm experiment:db patient-zero <experiment-id> --from-turn 1 --to-turn 100
pnpm experiment:db failures <experiment-id> --reason invalid-json
```

Commands support `--format table|json|markdown`; table is the concise default. Detail queries default to 50 rows and clamp limits to 500. Filters are exact, ordering is deterministic, and arbitrary SQL is not exposed.

Summary covers scenario/roster attribution, outcomes and retries, action distribution, territory, communication channels, alliance lifecycle/rejections, Patient Zero behavior, usage, size trends, retention, and inconsistencies. Comparison reports absolute totals plus per-turn, per-agent-turn, per-active-agent, and per-Patient-Zero-turn rates.

`directionChangesAfterCommunication` has one canonical definition: for each agent independently, count an accepted move whose direction differs from that agent's previous accepted move when the retained observation contains an inbound direct or alliance message after the previous move and no later than the current turn. Aggregate is exactly the sum of per-agent counts. Original imported values remain unchanged in source-metric audit JSON, and disagreements are reported.

Patient Zero output distinguishes:

- `message-to-patient-zero`: an accepted direct message without a qualifying earlier directive.
- `reply-after-directive`: an accepted direct message after a Zero directive addressed to that sender and before a later directive to that sender.
- `observable-compliance`: the next archived action when the directive contains exactly one unambiguous action word (`move`, `infect`, `capture`, or `wait`). Other directives are `indeterminate`.

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
