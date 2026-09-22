# Architecture

## Zero-swarm execution

`zero-swarm-v1` is the sole cognition architecture. The service first advances
deterministic player pressure
into an uncommitted world candidate. Agent Zero plans on the first tick, every
five ticks, and when an expiry or material event requires review. Other ticks
reuse committed unexpired worker directives and compile a fresh legal Zero wait
action. After plan validation, each worker receives a compact local projection and engine-legal
physical actions as opaque candidates. Jev selects one candidate ID, which the
service maps to a world action for seeded engine resolution. One complete tick
commits atomically. Planner and worker failures use explicit deterministic
fallbacks; provider attempts survive world rollback. See ADRs 0028, 0029, and 0031.

The worker observation includes bounded, current capture alerts. The TypeSafe
request projects them as structured capture pressure without cell IDs or tick
numbers. The unused prose `relevantRecentFacts` field is removed; current
situation and legal candidate descriptions supply the relevant local facts.
For zero-swarm ticks, public disinfection events from the current simulated-player
advance join retained events before either Zero or workers observe pressure;
they enter committed history only after the tick succeeds. One shared geometry
rule classifies a disinfection at most one cell away as high pressure, two cells
away as rising pressure, and otherwise low pressure. Zero receives that local
classification and bounded direction/distance categories for each surviving
agent, plus recent observable captures. Disinfection pressure uses the current
and prior five ticks, capped at six events. A real Jev replan probability triggers
a worker request at 0.50 under rising or high pressure and at 0.80 under low
pressure; deterministic fallbacks cannot emit that signal.
Directive progress compares each worker's current cell with its position before
the prior tick's physical action. Reaching the directive target has its own
`at-target` observation status. Zero's worker status uses the same position
comparison, rather than treating any accepted world action as progress. The
existing deterministic replanning trigger for repeated waits is unchanged.
An `expand` directive completes only after its target is worker-controlled;
arriving on an open target is not completion. A `relocate` directive completes
when its worker reaches the target. A `reinforce` directive completes on arrival
at its target, which must be infected or adjacent to infection when issued. An
`evade` directive completes on arrival or when a worker that previously faced
high cleaning pressure leaves that pressure. `hold` persists until expiry or
another review trigger.
Completion triggers Zero review on the next tick. The strategic observation
identifies completed workers by safe `agentId` and server-issued `directiveId`.
New directives are validated against the authoritative pre-action world after
simulated-player pressure: non-hold missions need a target, expand requires an
open cell, relocation/reinforcement/evasion cannot target the worker's current
cell, and reinforcement needs an infected or adjacent frontier target. An
invalid plan falls back safely. A completed prior
directive is not reused during that fallback.
Zero planning follows provider-reported OpenRouter usage normalization,
including actual `usage.cost` when returned, and preserves that metadata when a
returned plan is rejected or a bounded non-success response contains usage.
Missing provider cost remains unknown.
World Lab distinguishes provider-reported cost from admission exposure. Each
attempt with unknown monetary cost, including TypeSafe Jev, retains its
configured per-attempt credit reserve in admission exposure. That reserve is
a conservative execution limit, not a measured charge or Jev cost estimate.
The OpenRouter planner asks Zero for bounded worker IDs, strategic target choice
IDs, mission, priority, risk, and its own legal action choice. Server code
materializes agent IDs, H3 targets, directive IDs, and five-tick lifetimes from
the frozen observation. Full valid plans remain accepted for compatibility,
but invalid output is classified into safe validation reasons without retaining
raw provider text. The selected Zero reasoning profile is sent to OpenRouter
with private reasoning excluded, and output is bounded.

When Zero has no unexpired directive for a worker, a failed planning attempt
gives that worker engine-legal deterministic local expansion without a Jev
call. This prevents repeated billed Jev waits under a failed planner while
retaining planner attempt telemetry.

Full all-agent exports and the archive retain safe plans, directives, action
choices, and factual provider usage. World Lab presents the swarm view: Zero
strategy, worker directives and Jev decisions, progress, replanning signals,
and provider usage. See ADR 0030.

Provider-attempt and credit-exposure admission are owned by `SimulationService`. Its ledger is
deliberately separate from deterministic world state and committed-turn
metrics: tick rollback cannot erase provider work that may already be billed.
Whole ticks reserve both capacities atomically. Started calls retain their
operator-configured credit reservation until known cost safely reconciles it;
unknown or cancelled calls retain exposure, and a reported reservation overage
stops future admission when a credit ceiling is enabled. These decimal-string totals are server authority, but
they do not enforce the upstream account balance. See ADRs 0025 and 0026.

The offline comparison harness runs zero-swarm (Jev workers) and
deterministic-worker fixtures against the same seeded scenario and player
pressure, then emits JSON per-tick samples and aggregates. It is a read-only
research runner: it creates no live providers, reads no provider key, and does
not write to the experiment archive. Archive comparison remains useful for safe
completed exports, but does not substitute for the same-scenario swarm harness.
See [Zero-swarm offline comparison](ZERO_SWARM_COMPARISON.md).

The separately opted-in live comparison runs real OpenRouter Agent Zero with
either Jev workers or a deterministic legal-candidate worker policy, using
identical scenario inputs and the same Zero model for both variants. It keeps
the production planning cadence and engine resolution, and reports safe
per-tick observations alongside the independent provider-attempt ledger. See
[Live swarm comparison](LIVE_SWARM_COMPARISON.md).

## Simultaneous tick authority

Before the frozen agent snapshot, the optional seeded simulated-player profile
advances one deterministic virtual interval in the world engine. The baseline
`casual-cleaner` retains its movement and blocked-clean behavior. The optional
`trail-hunter-v1` routes from visible infection and can capture an agent only
when they share a cell. Capture removes the agent, leaves its infected cells
abandoned, and changes the active roster before provider dispatch. If no agents
remain, or Agent Zero is captured, the player-only tick
commits a terminal outcome. Player events remain an uncommitted candidate until
the tick commits, so cancellation cannot partially advance pressure.
Ordinary workers retain bounded own/nearby successful-clean evidence. Agent
Zero additionally receives a deterministic, current-interval
feed of successful cleans and occupied-cell blocks, capped at 128 entries with
truthful total/truncation metadata; overflow retains the most recent entries in
chronological order. Event cells are intentional historical clean/block
locations. The feed excludes movement and the cleaner's live/current position,
route, target, identity, and future-timing data.
Each displayed event carries a fixed six-tick, engine-derived pressure context
for its subject: subject totals/category counts/consecutive affected ticks.
The event list remains current-interval-only; no historical event array is added.
The rollup reads committed prior intervals from the dedicated simulated-player
event history and combines them with only the current tick's uncommitted
candidate cleaner events. It does not depend on the smaller general world-event
display buffer, and candidate events enter dedicated history only when the whole
tick commits.

The Game API owns an operator-triggered tick transaction. It builds Zero's
strategic observation from the frozen candidate world and dispatches the single
planning call; worker reflex calls follow sequentially, each receiving an
immutable compiled local observation. All calls share one absolute deadline.

The simulation derives a reproducible per-tick agent order from the scenario
seed. The world engine then resolves all world actions in that order. Only the
complete candidate state and complete record group commit. Cancellation aborts
outstanding jobs and commits neither records, events, tick, nor virtual time.
The browser accelerates explicit tick requests; it does not schedule
authoritative work in the background.

## Persistent World Lab operator shell

World Lab owns one browser execution controller at the root of its client component. The controller centralizes authoritative snapshot reconciliation, mutation IDs, playback timing, bounded tick targets, and cancellation. Switching between the Live and Agents workspaces changes only the presented workspace; it does not unmount or duplicate the controller, its timer, or its in-flight request state.

The Live workspace is a grid of independently scrolling agent rail, map, contextual inspector, and bounded activity dock. Agent and hex selections select the corresponding semantic inspector tab, while Scoreboard and Run remain directly reachable. The Agents workspace selects the Agent Zero model and reasoning profile; the server-pinned Jev model is shown as runtime information. Roster replacement remains a World Setup operation that creates a replacement experiment rather than mutating the active roster mid-run.

The Game API also owns one process-local experiment record. Each completed safe swarm tick is captured once, independently from the browser snapshot, and server-side export filters apply without affecting provider requests.

Schema-v12 exports may cross a separate offline archive boundary into `packages/experiment-archive`. Node's built-in SQLite stores normalized immutable research records through versioned migrations, foreign keys, prepared statements, and transactional idempotent imports. This downstream observability archive is never consulted by tick execution and cannot recover, resume, or mutate the active world. Its bounded query service is application-independent so a future read-only MCP adapter can reuse it without exposing arbitrary SQL.

World Setup uses `world-scenario-v1`. Pure preview computes the actual H3 disk, exact count, summed cell area, deterministic roster/spawns, feasibility, and warnings. Apply recomputes and atomically replaces world and experiment state. Reset reconstructs the current scenario; the Toledo default preserves legacy starts. Explicit location search crosses a replaceable server-owned adapter with no autocomplete, a one-request-per-second Nominatim limit, bounded cache/timeout, normalized results, and OpenStreetMap attribution. Manual coordinates bypass that network boundary.

World Lab issues explicit ticks while Start or a bounded run is active. Provider recovery is contained inside each job's shared tick deadline. Lost ticks are final; the browser exposes no pending Retry/Skip or unattended-recovery loop.

## Applications

`apps/world-lab` is a Next.js App Router developer/admin surface. It fetches runtime-validated simulation snapshots through a local rewrite, controls one tick at a time, and updates MapLibre's existing H3 GeoJSON source without recreating the map. Agent markers are fully visible and use deterministic offsets when sharing cells.

Its command navbar is the single persistent application-control row. Browser-session run-target selection remains client orchestration and preserves absolute tick semantics; execution and reconciliation still consume authoritative API snapshots. Agent color uses retained effective color, base agent color, and a neutral fallback.

The default basemap is tokenless CARTO Dark Matter with OpenStreetMap and CARTO attribution. Deterministic tests inspect its configuration and mocked MapLibre H3 sources without requesting external tiles.

Equivalent legal moves are ordered reproducibly from world seed, stable agent ID, and logical turn without process randomness. Their six-value compass labels are derived independently from the geographic initial bearing between H3 cell centers using equal 60-degree sectors; H3 traversal order never determines direction.

`apps/game-api` is a Hono service bound conservatively to loopback. Its single in-memory `SimulationService` owns the development session, monotonic completed-tick count, bounded histories, and overlap lock. It exposes:

- `GET /api/simulation` — current authoritative snapshot
- `POST /api/simulation/tick` — one atomic swarm tick: plan, dispatch directives, resolve via Jev, apply world actions
- `POST /api/simulation/tick/cancel` — atomically abort the active tick
- `POST /api/simulation/reset` — deterministic reset, rejected while a tick is active
- `POST /api/simulation/experiment/setup/preview` — compute H3 disk, roster/spawns, feasibility, and warnings without applying
- `GET /api/simulation/experiment/setup/default` — return the default world-setup request
- `POST /api/simulation/experiment/setup` — atomically replace world and experiment state
- `POST /api/simulation/experiment/setup/roster/generate` — generate a deterministic roster
- `POST /api/simulation/experiment/setup/location-search` — resolve a location query via the Nominatim adapter
- `POST /api/simulation/experiment/export/preview` — validate filters and report subset size, retention, and cost
- `POST /api/simulation/experiment/export` — construct one schema-v12 safe JSON document
- `POST /api/simulation/experiment/export/archive` — import the exact generated safe document into the configured local SQLite archive
- `GET /api/simulation/models` — return the cached, sanitized compatible model catalog
- `POST /api/simulation/models/refresh` — explicitly refresh that catalog
- `POST /api/simulation/models/verify` — make one explicit, non-mutating compatibility probe against `swarm-planner-v1`
- `POST /api/simulation/experiment/models` — replace the Agent Zero model assignment

The `GET /api/development-world` and `GET /health` endpoints remain for low-level diagnostics.

World reset reconstructs deterministic positions, 127 open cells, empty events and metrics, and a new experiment, and is rejected while a tick is active.

## Tick flow

Agent Zero is the generative planner for the roster; every applied scenario
designates one roster agent for the role through `patientZeroAgentId`, which
World Lab badges HEX-0. One OpenRouter call per
tick, under the `swarm-planner-v1` contract, produces a strategy summary,
per-worker directives, and Agent Zero's own action candidate. Workers resolve
their directives with TypeSafe Jev reflex cognition; Agent Zero receives no
extra movement, action, infection, capture, or ownership authority beyond the
action candidate it selects like any other agent.

The authoritative world's newest 120 events remain a bounded operator/display
feed. Agent observations do not depend on that mixed feed for their promised
factual windows. The Game API separately retains bounded movement, action,
control-change, and capture ledgers. These ledgers accept only newly committed
engine events: ticks carry the complete untrimmed event batch into commit and
ingest it once after the final cancellation check while separately capping the
display feed. World reset and applied World Setup reinitialize the ledgers;
model configuration changes preserve them.

The development world is a deterministic H3 resolution-nine radius-six disk
(127 cells) around Toledo with eight fixed profiles and unique perimeter starts.
Names, colors, stable IDs, and starting cells remain fixed.

One tick executes as follows:

1. **Simulated-player advance.** The configured player profile advances one
   deterministic virtual interval over the pre-tick world state, producing an
   uncommitted candidate. If Zero is captured or no roster agents remain the
   service commits a player-only terminal tick and returns.

2. **Replan determination.** The service evaluates replan reasons
   (`initial`, `periodic-review`, `directive-complete`, `directive-expired`,
   `worker-request`, `worker-stalled`, `territory-loss`, `high-pressure`,
   `player-disinfection`, `roster-changed`). No reasons means the prior
   directives are valid; Zero's action is recompiled from existing candidates
   without a provider call (`directive-reuse`).

3. **Provider-attempt reservation.** When replanning, the tick reserves one
   Zero planning attempt plus one Jev attempt per worker. Insufficient capacity
   stops the tick before any provider call.

4. **Zero planning.** The service builds Zero's strategic observation from the
   frozen candidate world — including pressure events, completed directives, and
   legal Zero action candidates — then calls Agent Zero via the OpenRouter
   `swarm-planner-v1` contract. Zero returns a strategy summary, per-worker
   directives, and its own action candidate ID. On failure the service falls
   back to a deterministic plan; the planner attempt is still recorded.

5. **Worker reflex dispatch (sequential).** For each worker in seeded order:
   compile a local observation with the assigned directive and history; call
   TypeSafe Jev; Jev selects one opaque action candidate ID with a probability
   distribution and confidence. If the worker lacks an unexpired directive under
   a failed planner, the service substitutes deterministic local expansion
   without a Jev call.

6. **World resolution.** The engine applies Zero's action and each worker's
   mapped action in the seeded per-tick order. The engine is the sole authority;
   it accepts or rejects each action independently.

7. **Atomic commit.** World state, tick record (plan, directives, Jev
   decisions, action results), and virtual time advance together. Provider
   attempts survive world rollback. Operator cancellation before this point
   commits nothing.

## Experiment telemetry and export

World Lab archive writes remain downstream and manual. The browser submits the
current export filters, generation timestamp, and SHA-256 digest rather than
re-uploading a potentially large document through the UI proxy. The Game API
deterministically regenerates the schema-validated document, rejects it if its
digest differs from the exact browser-generated artifact, lazily opens the
configured archive only after that check, delegates the transactional,
idempotent import to `packages/experiment-archive`, and closes the handle. The
archive never becomes simulation authority.

The active experiment has a runtime-validated UUID, start time, versioned authoritative scenario and ordered initial roster, immutable configuration events, initial world, and up to 5,000 complete safe turns. The browser snapshot and world-event list remain capped at 120. Reset creates a new experiment from the current scenario and clears telemetry/cost; no previous experiments survive reset or process restart.

Metrics and filtering are deterministic Game API responsibilities. The live
snapshot's experiment metrics use the same derivation as an all-agents,
entire-retained export over the retained swarm ticks, so World Lab and exported
metrics cannot drift apart. Movement-pattern metrics walk each agent's accepted
moves separately, classifying each step with `geographicDirectionBetweenCells`;
aggregates sum direction counts and revisits and report the longest
single-agent streak. All exports
use schema version 12, which carries `swarmArchitectureVersion: "zero-swarm-v1"`
and independent provider-attempt accounting unconditionally. Pre-swarm exports
(schema versions 9, 10, and 11) are rejected outright; there is no migration
path. The provider-attempt ledger is canonical for attempt counts, latency,
token, and cost totals.

The agent runtime follows [OpenRouter's usage-accounting contract](https://openrouter.ai/docs/cookbook/administration/usage-accounting) and normalizes optional non-streaming usage fields: prompt, completion, total, reasoning, cached-read, cache-write tokens, and actual `usage.cost` as `costCredits`. It never derives price from a table. Safe usage already returned with a billable response is retained on later decision JSON/schema failure; network and HTTP failures without usage remain unknown. Scripted providers explicitly report zero tokens and zero cost.

## Packages

`packages/shared` owns centralized scenario limits and all public schemas, including model capabilities, swarm directives, metrics, and schema-v12 swarm tick exports. Other-agent observations remain deterministically capped at seven for larger rosters. Types are inferred from Zod.

`packages/world-engine` remains deterministic and has no model, HTTP, UI, storage, or credential dependency. It validates world actions independently. Direct proximity is derived from a separately supplied pre-action state.

`packages/agent-runtime` contains the OpenRouter swarm planner, the TypeSafe Jev reflex adapter, and the server-only catalog client. The planner contract (`swarm-planner-v1`) requires text input/output, chat completions, `max_tokens`, non-streaming operation, and at least 16,384 context tokens. The centralized floor covers the bounded complete observation and fixed prompt while reserving a 4,096-token completion ceiling for the JSON decision. Catalog requests use matching server filters, then locally validate every entry. Inference requests deliberately omit tools, `tool_choice`, `response_format`, and `provider.require_parameters`. Provider-default reasoning omits `reasoning`; Off sends `{ enabled: false, exclude: true }`; an advertised effort sends `{ enabled: true, effort, exclude: true }`. No model-family logic, allowlist, compatibility flag, or model default exists.

The catalog has an eight-second timeout and five-minute in-memory TTL. A successful response replaces the cache. A timeout, transport/HTTP failure, or malformed response retains the last successful catalog and marks it stale with a safe error; without a prior success it returns an empty error state. Manual refresh bypasses TTL while coalescing concurrent refreshes.

Agent Zero resolves its model from the global assignment before each planning call, including its reasoning profile. Assignments may change while playback is paused and no provider/reset mutation is active. Each change is exported with timestamp, scope, prior/new slug, prior/new reasoning profile, and the first globally unique record ordinal at which it is effective; tick execution applies the configuration to the next committed tick group. No unavailable model/profile or missing model is substituted.

The centralized 75-second provider abort timeout covers the complete response lifecycle, including body reading, response decoding, bounded JSON extraction/repair, normalization, and schema validation, and is cleared after every outcome. The same AbortController supports an explicit non-tick-consuming operator cancellation. Safe records expose only bounded status/code/message/request ID/model/finish-reason/latency/usage fields. Scripted providers are explicit deterministic seams selected only by tests or `HEXZERO_PROVIDER=scripted`; there is no automatic fallback. Manual probes use the `swarm-planner-v1` contract and selected reasoning profile, never mutate or advance the world, may incur a small charge, and are cached only for the current server session by model ID, reasoning profile, and contract version.

The deadline is shared across the planning call and all worker reflex calls in one tick rather than renewed per call. Tick browser mutations carry bounded client operation IDs and repeated delivery is coalesced server-side. When a proxy connection resets or a response is otherwise lost, World Lab clears its local guard, refetches the authoritative snapshot, and shows a height-stable reconciling state while polling an active tick. It never resubmits merely because a response was ambiguous.

Attempt aggregation is field-wise: known prompt, completion, total, reasoning,
cache-read, and cache-write values remain visible even when another attempt has
no usage metadata. Completeness and unknown-token-attempt counts prevent partial
totals from appearing complete. Known cost remains an exact sum; unknown cost is
reported separately by provider attempt and by distinct logical turn. Missing or
unusable 429 `Retry-After` metadata uses a centralized 1.5-second fallback only
when it fits the original deadline, and the active cancellation signal aborts
the wait.

The rationale and deferrals are recorded in [ADR 0002](adr/0002-first-visible-llm-invasion.md).
Experiment capture and export semantics are recorded in [ADR 0004](adr/0004-server-owned-experiment-telemetry.md).
Manual direct SQLite archival of a generated artifact is recorded in
[ADR 0021](adr/0021-manual-direct-sqlite-export.md).
Contested control, capture, and territory authority are recorded in [ADR 0006](adr/0006-contested-hex-control.md).
Capability-driven model discovery is recorded in [ADR 0009](adr/0009-capability-driven-model-catalog.md).
The zero-swarm architecture, retirement of legacy cognition, and export schema 12 are recorded in [ADR 0033](adr/0033-retire-legacy-multi-agent-architecture.md).

Structural provider failures retain the broad compatibility code plus bounded details in attempt telemetry and safe exports. Well-formed unavailable IDs remain engine-authoritative rejections and are not retried.

## Provider-attempt accounting

Provider work has an independent bounded lifecycle ledger. Schema-v12 exports
and archive-v4 preserve safe attempt records even when no world tick commits.
