# ADR 0034 – Semantic strategic options for Agent Zero (`swarm-planner-v2`)

**Status:** Accepted  
**Date:** 2026-09-22

## Context

Under `swarm-planner-v1`, the model request contained the full global target
list and agent positions. The concrete mechanism: retained directive targets +
agent positions + all world hexes sorted lexicographically were concatenated,
sliced to a hard cap of 80 entries, and the full `cells` array was serialized
into every request. The `agents` array carried raw UUID agent IDs.

Evidence from a 20-agent / ~469-cell / 10-tick real-provider run:

- Input tokens reached ~15,000–16,000 per planning call.
- ~140 of ~183 worker decisions were `hold`; only ~43 were `expand`.
- Final infection was ~22 of 469 cells — near-zero territory gain despite 10
  ticks of planning.
- Zero's strategy summaries described expansion while the actual directives
  assigned `hold` to most workers; the model could not reliably reason about
  which cells were reachable or strategically useful from raw H3 strings.

Lexicographic slicing meant strategically important frontier cells that happened
to sort after index 80 were silently omitted, biasing every plan toward cells
near the top of the H3 index regardless of direction or proximity.

This produces several problems:

1. **Prompt size grows linearly with world size.** Coordinate strings dominate
   the token budget before any semantic content appears.
2. **Lexicographic truncation.** The 80-entry slice reflects H3 sort order, not
   strategic relevance; frontier cells in certain directions are invisible.
3. **Model reasoning over raw geometry.** Models cannot reliably reason about
   hexagonal adjacency from opaque H3 strings. Semantic descriptions (direction,
   distance, territory relation) produce better plans.
4. **Agent ID leakage.** Passing agent UUIDs into model context is unnecessary
   and widens the surface for prompt-injection reflection.

## Decision

Introduce a deterministic server-side **semantic option compiler**
(`compileStrategicOptions`) that runs before each Zero planning call. The
compiler produces a bounded, per-worker `StrategicOption[]` with:

- An opaque `optionId` (`w<n>_o<n>`) — the only handle the model sees.
- Semantic fields: `mission`, `direction`, `distance`, `targetState`,
  `territoryRelation`, `pressureAtTarget`, `pressureEffect`, `crowding`,
  `continuesActiveDirective`, `description` (max 160 chars, no raw IDs).
- No `targetCell` in the model request; the server holds the authoritative
  `optionId → (mission, targetCell)` mapping.

The observation also replaces the raw cell list with a coarse `worldSummary`
with fields `totalCells`, `openCells`, `swarmInfectedCells`,
`abandonedInfectedCells`, and `openFrontierCells`.

Contract version → `'swarm-planner-v2'`; export `schemaVersion` → `13`.
No import compatibility layer for earlier exports (v12 and below); legacy
archives require the pre-migration Git revision.

### Option generation rules

| Priority         | Mission         | Cap    | Condition                                     |
| ---------------- | --------------- | ------ | --------------------------------------------- |
| 0 (always)       | hold            | 1      | always present, targetCell=null               |
| 1 (always)       | continue-active | 1      | retained directive still valid                |
| 2 under pressure | evade           | ≤2     | pressure within radius 3                      |
| 3 under pressure | reinforce       | ≤1     | abandoned cell exists or rising/high pressure |
| 4/2 by pressure  | expand          | ≤3     | open cells found; sector-diversified          |
| 5/3 by pressure  | relocate        | **≤1** | crowded or no open cell within radius 2       |
| Total            | —               | **≤8** | priority-aware; hold+continue always kept     |

Expand candidates are scanned within radius 4 of the worker first; the scan
widens to world-wide only when no open cells exist within that radius. Sector
diversification (one expand per 60-degree direction) prevents clustering. A
greedy `claimed` set across workers penalises repeated top targets.

Every non-hold compiled option is run through `swarmDirectiveIssue()` as a
final filter, so the server can never offer an option that would cause
`#assertSwarmPlan` to reject the plan.

### Wire contract

- `compactPlanSchema` response: `{workerId, optionId, priority, riskTolerance}`
  (mission and targetCell removed; optionId resolves both server-side)

## Consequences

**Positive:**

- Model prompt shrinks: the v2 user message for 20 workers / 469 cells
  (worldSummary + 20 workers × ≤8 semantic options, no raw coordinates)
  measures ~28 KB vs the v1 equivalent (full 469-cell `cells` array + 20 agent
  UUIDs + 80-entry `strategicTargetCells`) at ~37 KB.
  `strategic-options.test.ts` asserts `v2Bytes < v1Bytes` for this fixture.
- Lexicographic truncation is impossible: options are selected by score and
  sector, not coordinate sort order.
- Agent IDs never enter the model context.
- Offered options are pre-validated via `swarmDirectiveIssue`, so server-side
  assertion is a subset check rather than a re-validation.
- Diversity is enforced: in the 20-worker/radius-12 fixture, ≥70% of workers
  have distinct top-expand targets (greedy deconfliction) and ≥2 distinct
  direction sectors are represented (typically 3 in this fixture, as workers
  at ring-12 all expand inward).

**Neutral / trade-offs:**

- The server must compile options before every Zero call (bounded cost: O(W × C)
  where W = workers, C ≤ gridDisk(4) = 127 cells per worker in the default
  world).
- `hold` options now have `targetCell=null`. The `workerStatus='at-target'`
  condition was extended to also fire on `mission==='hold' && targetCell===null`,
  preserving the existing semantic that a holding worker is on-target.

**Negative:**

- The compiler is a new layer that must be kept aligned with `swarmDirectiveIssue`
  semantics. The final-filter ensures consistency but adds per-option validation.
