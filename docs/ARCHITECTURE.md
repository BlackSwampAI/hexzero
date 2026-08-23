# Architecture

## Simultaneous tick authority

Before the frozen agent snapshot, the optional seeded `casual-cleaner` advances
one deterministic virtual interval in the world engine. Its movement and
disinfection/block events remain an uncommitted candidate until the complete
agent tick commits, so cancellation cannot partially advance player pressure.
The engine targets visible infection rather than hidden agent positions;
positions are consulted only for authoritative co-located clean blocking.
Ordinary agents retain bounded own/nearby successful-clean evidence. The one
configured Patient Zero additionally receives a deterministic, current-interval
feed of successful cleans and occupied-cell blocks, capped at 128 entries with
truthful total/truncation metadata; overflow retains the most recent entries in
chronological order. Event cells are intentional historical clean/block
locations. The feed excludes movement and the cleaner's live/current position,
route, target, identity, and future-timing data.

The Game API owns an operator-triggered tick transaction. It freezes the world
and builds every observation before dispatching any model request. A
provider-neutral runtime dispatcher starts jobs concurrently with bounded
concurrency, resolved model/reasoning identity, immutable per-agent observation,
and one shared absolute deadline. Provider completion order is never resolution
order.

The simulation derives a reproducible per-tick agent order from the scenario
seed. The world engine then resolves all world actions, all communications using
the frozen pre-tick eligibility state, all diplomacy, and one proposal-expiration
pass. Only the complete candidate state and complete record group commit.
Cancellation aborts outstanding jobs and commits neither records, events, tick,
nor virtual time. The browser accelerates explicit tick requests; it does not
schedule authoritative work in the background.

## Persistent World Lab operator shell

World Lab owns one browser execution controller at the root of its client component. The controller centralizes authoritative snapshot reconciliation, mutation IDs, playback timing, bounded tick targets, and cancellation. Switching between the Live and Agents workspaces changes only the presented workspace; it does not unmount or duplicate the controller, its timer, or its in-flight request state.

The Live workspace is a grid of independently scrolling agent rail, map, contextual inspector, and bounded activity dock. Agent and hex selections select the corresponding semantic inspector tab, while Scoreboard and Run remain directly reachable. The Agents workspace reuses the same snapshot and existing server mutations for model, reasoning, personality, and strategy assignment. Roster replacement remains a World Setup operation that creates a replacement experiment rather than mutating the active roster mid-run.

Formal alliance experimentation preserves the existing one-way trust boundary:

```text
World Lab → Game API / simulation service → agent runtime → one decision
                                                        ↓
 snapshot / turn record ← independent world + communication + diplomacy validation
```

The Game API also owns one process-local experiment record. Each completed safe turn is captured once, independently from the browser snapshot, and server-side export levels filter that record without affecting provider requests.

Completed schema-v10 exports and compatible schema-v9 exports may cross a separate offline archive boundary into `packages/experiment-archive`. Node's built-in SQLite stores normalized immutable research records through versioned migrations, foreign keys, prepared statements, and transactional idempotent imports. This downstream observability archive is never consulted by tick execution and cannot recover, resume, or mutate the active world. Its bounded query service is application-independent so a future read-only MCP adapter can reuse it without exposing arbitrary SQL.

World Setup uses `world-scenario-v1`. Pure preview computes the actual H3 disk, exact count, summed cell area, deterministic roster/spawns, feasibility, and warnings. Apply recomputes and atomically replaces world and experiment state. Reset reconstructs the current scenario; the Toledo default preserves legacy starts. Explicit location search crosses a replaceable server-owned adapter with no autocomplete, a one-request-per-second Nominatim limit, bounded cache/timeout, normalized results, and OpenStreetMap attribution. Manual coordinates bypass that network boundary.

World Lab issues explicit ticks while Start or a bounded run is active. Provider recovery is contained inside each job's shared tick deadline. Lost ticks are final; the browser exposes no pending Retry/Skip or unattended-recovery loop.

## Applications

`apps/world-lab` is a Next.js App Router developer/admin surface. It fetches runtime-validated simulation snapshots through a local rewrite, controls one tick at a time, and updates MapLibre's existing H3 GeoJSON source without recreating the map. Agent markers are fully visible and use deterministic offsets when sharing cells.

Its command navbar is the single persistent application-control row. Browser-session run-target selection remains client orchestration and preserves absolute tick semantics; execution and reconciliation still consume authoritative API snapshots. Global and per-agent selectors share one deduplicating, case-insensitive model-option builder. Current alliance membership is the first UI color authority for map, roster, chat, and log accents, followed by retained effective color, base agent color, and a neutral fallback.

The default basemap is tokenless CARTO Dark Matter with OpenStreetMap and CARTO attribution. Deterministic tests inspect its configuration and mocked MapLibre H3 sources without requesting external tiles.

World Lab derives a six-record, newest-first Behavior Trace entirely from the
bounded `AgentTurnRecord` snapshot already returned by the Game API. The trace
compares consecutive observations for the selected agent, separates newly
retained communication and board evidence, displays legal action affordances
beside the selected action, and labels repeated or changed action patterns.
Model summaries remain explicitly self-reported evidence rather than causal
proof. Cell highlighting reuses browser selection state and creates no server
mutation, new telemetry, retention, provider field, or world authority.

Communication resolves against the authoritative pre-action snapshot. Public chat is globally observable and future-player-visible. Direct messages use H3-center great-circle distance and the scenario's bounded kilometer range. Alliance messages are private to current members regardless of distance. World Lab may inspect private traffic; player-facing contracts must not include that omniscient feed. Equivalent legal moves are ordered reproducibly from world seed, stable agent ID, and logical turn without process randomness.

`apps/game-api` is a Hono service bound conservatively to loopback. Its single in-memory `SimulationService` owns the development session, monotonic completed-turn count, turn cursor, bounded histories, per-agent strategic goals and compact memory ledgers, and overlap lock. Goals and memories are not part of world-engine `Agent` ownership and grant no engine authority. It exposes:

- `GET /api/simulation` — current authoritative snapshot
- `POST /api/simulation/tick` — one simultaneous decision opportunity for every active roster agent
- `POST /api/simulation/tick/cancel` — atomically abort the active tick
- `POST /api/simulation/turn`, `/turn/retry`, `/turn/skip`, and unattended turn variants — legacy sequential/schema-v9 compatibility only; they cannot mix with committed ticks
- `POST /api/simulation/turn/cancel` — legacy cancellation alias
- `POST /api/simulation/reset` — deterministic reset, rejected while a turn is active
- `POST /api/simulation/agents/:agentId/personality` — trim, validate, and replace one active personality
- `POST /api/simulation/personalities/restore-defaults` — restore all eight milestone personality directives without resetting progress
- `POST /api/simulation/experiment/export/preview` — validate filters and report subset size, retention, cost, and approximate sharing tokens
- `POST /api/simulation/experiment/export` — construct one schema-versioned safe JSON document
- `POST /api/simulation/experiment/export/archive` — manually import the exact
  generated safe document into the configured local SQLite archive
- `GET /api/simulation/models` — return the cached, sanitized compatible model catalog
- `POST /api/simulation/models/refresh` — explicitly refresh that catalog
- `POST /api/simulation/models/verify` — make one explicit, non-mutating compatibility probe
- `POST /api/simulation/experiment/models` — replace the unlocked global/per-agent assignment
- `POST /api/simulation/experiment/import` — restore model assignments from a validated export

The legacy `GET /api/development-world` and `GET /health` endpoints remain for low-level diagnostics.

The Game API is authoritative for session personality configuration. World reset reconstructs deterministic positions, 127 open cells, empty alliances/proposals/events/metrics, cursor, and completed-turn count, then reapplies the eight current personality values. Restoring defaults changes only those values. Both personality mutations are rejected while the service's turn lock is active.

## Tick flow

Every current applied scenario designates one Patient Zero coordinator. The service
adds a bounded global strategic view only to that agent's immutable
observation; other observations retain their local/alliance bounds. The engine
alone authorizes player-hidden Zero broadcasts and Patient-Zero-endpoint direct
range bypass. Patient Zero receives no extra movement, action, infection,
capture, ownership, or alliance authority. Every agent observation is built
from one frozen pre-tick snapshot.

Patient Zero's global diplomacy context is a fixed-cap sparse summary of
authoritative eligible pairs, acceptable proposals, leave availability,
aggregate blocker counts, and prioritized blocker examples. Deterministic
counts and truncation flags preserve global shape without a roster-sized
feasibility expansion. Historical exports may retain a null designation, but
that read compatibility never creates a coordinator-free live scenario.

The universal `text-flat-json-v8` prompt makes `communicationType: "none"` the
normal choice for ordinary agents and Patient Zero unless a message adds new
decision-relevant value. Concrete requests or replies, negotiation,
observed-fact warnings, changed plans, border/conflict coordination, and
coordinated targets or routes are useful categories. Routine action narration,
motivational filler, observation/summary restatement, and unchanged-plan
repetition are prohibited prompt behaviors. Messages accompanying formal
diplomacy add terms or context instead of duplicating the formal intent. Useful
messages retain the assigned personality and style, and all existing channel,
trust, privacy, and Patient Zero authority rules remain unchanged. This is
provider guidance, not engine semantic classification, rejection, or throttling.

Recoverable provider, parsing, and schema failures may consume the one automatic
retry inside the shared deadline. An unresolved decision becomes an attributed
final lost tick. Ordinary engine-authoritative action rejection remains a
completed `rejected` outcome and does not affect sibling components.

For a new logical turn, the service owns one 75-second deadline and permits at
most two provider calls: initial plus either one contract repair or one transient
transport retry. Both calls receive the same immutable observation, resolved
model, and reasoning profile. Repair prompts are fresh universal flat-JSON
requests containing only allowlisted validation codes; raw invalid output is
discarded. Structurally normalized decisions enter the normal engine path once,
and engine rejection is never an automatic retry condition.

The development world is a deterministic H3 resolution-nine radius-six disk
(127 cells) around Toledo with eight fixed profiles and unique perimeter starts.
Every active agent receives one decision opportunity per tick. Each provider
call asks for one flat JSON object containing a required world action, zero or
one communication, and zero or one diplomacy intent (`propose-alliance`,
`accept-alliance`, or `leave-alliance`). Required sentinel-bearing fields
normalize into the internal unions before existing Zod and engine validation.
There are no background inference calls or automatic replies.

Names, colors, stable IDs, and starting cells remain fixed. Personality text is mutable session configuration, but each observation copies the active value at turn start. Completed observations and turn records remain immutable, so a newly edited active personality can intentionally differ from the latest historical observation until that agent acts again.

The engine alone accepts or rejects all components and creates events. The
service applies every world action, then every communication using frozen
pre-tick eligibility, then diplomacy, then one proposal-expiry pass. Each
rejected component leaves the others intact. Missing text, unusable JSON,
contradictory fields, timeouts, and truncated output produce a lost tick for
that agent while valid siblings resolve. Operator cancellation aborts all
active requests and commits no world, events, records, tick, or virtual time.

## Formal alliance state

World state supports every feasible partition of the active roster into
alliances and bounded pending proposals. Alliance and proposal IDs are
system-generated typed UUIDs. Each alliance contains two agents through the
entire active roster, and each agent belongs to at most one alliance. The engine
uses deterministic accessible display colors and may reuse the palette; display
identity is never a gameplay capacity rule. A proposal records proposer,
recipient, both participants' alliance attribution at creation,
the globally unique originating record ordinal, and tick authority. Created at
tick `N`, it expires at tick `N + 2` without inference; legacy schema-v9 turn
fields retain their two-roster-round lifetime. The one expiry pass is attributed
to the final record in deterministic resolution order so its safe telemetry is
not lost.

Free agents may form an alliance with another free agent or request entry by
proposing to a member of an existing alliance. Allied agents may invite a free
agent. Recipient-only acceptance either forms a two-agent alliance or admits
the unaffiliated participant into the recorded unchanged alliance.
Alliance-to-alliance merging remains invalid. Membership changes invalidate
impossible proposals. Departure is unilateral; an agent may later request or
accept membership elsewhere. Individual hex control never changes, and an
alliance dissolves below two members.

Each frozen observation contains engine-/service-authored diplomacy affordances:
exact proposal recipient IDs, acceptable proposal IDs, leave availability, and
compact stable blocker codes for a bounded set of unavailable targets. Patient
Zero receives a fixed-cap sparse global summary: total eligible pair and
acceptable-proposal counts, at most 12 displayed pairs, eight proposal IDs,
eight leave IDs, stable blocker totals, prioritized examples, and explicit
truncation. It receives no pending decisions or free-form pair matrix and may
recommend only displayed IDs. Eligible pairs use deterministic round-robin
proposer coverage with a tick-based rotation so the fixed display budget does
not permanently favor low-sorting agent IDs. The model copies listed IDs into
the same flat response. Provider
tools are not used: a tool round trip would add another
inference boundary and tokens while duplicating deterministic engine knowledge;
no measured token saving is claimed.

Formal proposal creation uses the scenario `communicationRangeKm` against
frozen pre-action positions. Same-tick movement cannot make a target newly
eligible. Patient Zero's direct-message endpoint bypass is limited to direct
communication and never bypasses formal diplomacy range.

Public communication is visible to every agent without a range check. Direct communication authoritatively trims and bounds text, requires a distinct existing recipient, and accepts inclusive pre-action H3 distances 0–3. Moving closer in the same decision cannot change eligibility. Accepted communications enter the bounded world-event stream; rejected attempts remain safe structured turn telemetry with a reason, sender, channel, recipient when applicable, nullable computed distance, timestamp, event ID, and trimmed text. No raw provider response is retained.

Snapshots keep the newest 120 turn records and 120 world events. Observations expose controller/alliance/effective-color data for current and adjacent cells, up to seven other agents, an eight-entry individual scoreboard, active alliance totals and member contributions, relevant proposals, at most eight chronological alliance events, six control changes, 12 public messages, and six relevant direct messages. These are bounded event-derived views, and all model-authored text remains untrusted subordinate context.

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

Metrics and filtering are deterministic Game API responsibilities. Schema v10 adds mandatory tick attribution, first-class lost ticks, and per-tick summaries. `modelAttempts` is canonical for provider-call, latency, token, and cost totals so repairs and transient retries are not undercounted. Tick-native and unstarted tick-default experiments export v10; retained sequential experiments remain v9 and cannot mix execution modes. The Game API retains its documented older safe-import support for model configuration.

The agent runtime follows [OpenRouter's usage-accounting contract](https://openrouter.ai/docs/cookbook/administration/usage-accounting) and normalizes optional non-streaming usage fields: prompt, completion, total, reasoning, cached-read, cache-write tokens, and actual `usage.cost` as `costCredits`. It never derives price from a table. Safe usage already returned with a billable response is retained on later decision JSON/schema failure; network and HTTP failures without usage remain unknown. Scripted providers explicitly report zero tokens and zero cost.

## Packages

`packages/shared` owns centralized scenario limits and all public schemas, including model capabilities, behavior assignments, alliances, metrics, schema-v10 tick exports, and genuine legacy schema-v9 exports. Other-agent observations remain deterministically capped at seven for larger rosters. Types are inferred from Zod.

`packages/world-engine` remains deterministic and has no model, HTTP, UI, storage, or credential dependency. It validates world action, communication, and diplomacy independently and is the sole alliance mutation authority. Direct proximity is derived from a separately supplied pre-action state.

`packages/agent-runtime` contains the OpenRouter adapter and server-only catalog client. The universal contract requires text input/output, chat completions, `max_tokens`, non-streaming operation, and at least 16,384 context tokens. The centralized floor covers the bounded complete observation and fixed prompt while reserving a 4,096-token completion ceiling for the JSON decision. Catalog requests use matching server filters, then locally validate every entry. Inference requests deliberately omit tools, `tool_choice`, `response_format`, and `provider.require_parameters`. Provider-default reasoning omits `reasoning`; Off sends `{ enabled: false, exclude: true }`; an advertised effort sends `{ enabled: true, effort, exclude: true }`. No model-family logic, allowlist, compatibility flag, or model default exists.

The catalog has an eight-second timeout and five-minute in-memory TTL. A successful response replaces the cache. A timeout, transport/HTTP failure, or malformed response retains the last successful catalog and marks it stale with a safe error; without a prior success it returns an empty error state. Manual refresh bypasses TTL while coalescing concurrent refreshes.

Every agent resolves an explicit global assignment or per-agent override before execution, including its reasoning profile. The acting agent's resolved slug and profile are passed to its request. Assignments may change while playback is paused and no provider/reset mutation is active. Each change is exported with timestamp, scope, prior/new slug, prior/new reasoning profile, and the first globally unique record ordinal at which it is effective; tick execution applies the configuration to the next committed tick group. No unavailable model/profile or missing model is substituted.

The centralized 75-second provider abort timeout covers the complete response lifecycle, including body reading, response decoding, bounded JSON extraction/repair, normalization, and schema validation, and is cleared after every outcome. The same AbortController supports an explicit non-turn-consuming operator cancellation. Safe records expose only bounded status/code/message/request ID/model/finish-reason/latency/usage fields. Scripted providers are explicit deterministic seams selected only by tests or `HEXZERO_PROVIDER=scripted`; there is no automatic fallback. Manual probes use the exact text/flat-JSON contract and selected reasoning profile, never mutate or advance the world, may incur a small charge, and are cached only for the current server session by model ID, reasoning profile, and contract version.

The deadline is shared by both permitted automatic attempts rather than renewed
per call. Tick browser mutations carry bounded client operation IDs and repeated
delivery is coalesced server-side; Turn and Retry retain that behavior only for
legacy sequential API compatibility. When a proxy connection resets or a
response is otherwise lost, World Lab clears its local guard, refetches the
authoritative snapshot, and shows a height-stable reconciling state while polling
an active tick. It never resubmits merely because a response was ambiguous.

Attempt aggregation is field-wise: known prompt, completion, total, reasoning,
cache-read, and cache-write values remain visible even when another attempt has
no usage metadata. Completeness and unknown-token-attempt counts prevent partial
totals from appearing complete. Known cost remains an exact sum; unknown cost is
reported separately by provider attempt and by distinct logical turn. Missing or
unusable 429 `Retry-After` metadata uses a centralized 1.5-second fallback only
when it fits the original deadline, and the active cancellation signal aborts
the wait.

The rationale and deferrals are recorded in [ADR 0002](adr/0002-first-visible-llm-invasion.md).
Personality ownership and reset semantics are recorded in [ADR 0003](adr/0003-session-personality-configuration.md).
Experiment capture and export semantics are recorded in [ADR 0004](adr/0004-server-owned-experiment-telemetry.md).
Manual direct SQLite archival of a generated artifact is recorded in
[ADR 0021](adr/0021-manual-direct-sqlite-export.md).
Nearby-message authority, observation bounds, and export selection semantics are recorded in [ADR 0005](adr/0005-nearby-agent-messaging.md).
Contested control, capture, territory authority, and schema-v3 selection semantics are recorded in [ADR 0006](adr/0006-contested-hex-control.md).
Decoupled communication and schema-v4 selection semantics are recorded in [ADR 0007](adr/0007-decoupled-world-communication.md).
Selective agent communication and `text-flat-json-v4` attribution are recorded in [ADR 0015](adr/0015-selective-agent-communication.md).
Formal alliances, the expanded experiment, and schema-v5 semantics are recorded in [ADR 0008](adr/0008-formal-alliances-experiment.md).
Fluid alliance capacity, join requests, and authoritative diplomacy affordances supersede its fixed-size/color-capacity rules in [ADR 0016](adr/0016-fluid-alliances-and-diplomacy-affordances.md).
Capability-driven model discovery and experiment assignments are recorded in [ADR 0009](adr/0009-capability-driven-model-catalog.md).
Versioned behavior profiles, seeded assignment, and authoritative diplomacy affordances are recorded in [ADR 0010](adr/0010-versioned-agent-behavior.md).

Behavior configuration is experiment-owned and includes registry version 1, assignment mode, seed, and one allowlisted personality/strategy pair per agent. Balanced random is the safe default. Reset creates a new experiment and deterministic assignment from its seed; the first completed turn locks behavior. Every retained turn copies its effective assignment, while model and reasoning changes retain their existing between-request semantics.

Schema-v8 computed metrics include complete personality, strategy, observed personality/strategy-combination, and agent breakdowns derived from the same filtered retained turns and attempt records as the aggregate. Logical-turn, provider-call, failure, recovery, token, and cost counters therefore remain attributable without storing reasoning. Structural provider failures retain the broad compatibility code plus bounded details such as missing proposal IDs and contradictory diplomacy recipient fields in attempt telemetry and safe exports. Well-formed unavailable IDs remain engine-authoritative rejections and are not retried.
