# Testing

The suite has 26 unit/component test files and one Playwright E2E file. All
default tests are deterministic and offline; no default test or GitHub Actions
job contacts OpenRouter or TypeSafe. Real-provider tests are separately named,
explicitly opted into, and excluded from default CI. Tests are small behavior
tests colocated with the code they cover; large snapshots are avoided.

## Coverage

### World engine (`packages/world-engine`)

`index.test.ts` covers H3 movement (adjacent legal moves, non-adjacent
rejection, deterministic action enumeration), infection (open-cell infection,
repeated-infection rejection, persistence after the agent moves away), capture
(co-located trail-hunter capture, abandoned territory, engine-authority
transfer), simultaneous-tick determinism (shuffled resolution order, inclusive
virtual interval), D1 casual-cleaner behavior (seeded tie-breaking, occupied-
cell block), and trail-hunter routing (infection-evidence selection, hidden-
agent-position exclusion).

`scenario.test.ts` covers configurable world scenarios: default world
preservation, seeded casual-cleaner reproducibility, stable UUID-compatible
roster generation, spawn seeding, uniqueness enforcement, and infeasibility
rejection.

### Shared schemas (`packages/shared`)

`index.test.ts` covers the agent observation schema (bounded state-bearing
observation, control-gain/loss caps), the Patient Zero player-threat feed
(128-event cap with overflow metadata), engine contract identifiers (stability,
eight-agent/127-cell defaults), world snapshot validation (hex-control
invariants, out-of-world simulated player rejection), the Zero strategic
observation schema (bounded semantic worker threat fields, capture caps),
reasoning profiles (metadata-advertised effort ordering, Off exclusion for
mandatory reasoning, legacy-assignment defaults), and snapshot/export contracts
(state-only exports, complete API snapshot, unbounded-history rejection).

`reflex.test.ts` covers zero-swarm reflex contracts: compact opaque worker
observation acceptance, directive/choice-telemetry mismatch rejection, optional
bounded replan probability.

`scenario.test.ts` covers scenario contracts: virtual-tick bounds, temporary
limits, attempt and credit-admission bounds, request/preview/applied contract
validation, dynamic roster overflow rejection, Patient Zero requirement,
prompt-attribution exclusion from setup input, and archived-scenario null
preservation.

### Agent runtime (`packages/agent-runtime`)

`swarm-planner.test.ts` covers the OpenRouter swarm planner: repeatable
observation-derived plans, bounded worker and target choices mapped to
authoritative directives, completed-directive marking in the compact Zero
request, event-derived worker threat and capture context, unknown-choice
rejection, missing-directive reporting, deterministic-plan bounds checking,
ten-tick lifetime enforcement, invented-candidate and omitted-directive
rejection, overloaded-response retry, complete provider accounting (cost,
tokens, usage retention for invalid or unparseable plans, optional cost
omission), non-OK attempt attribution, cancellation safety, and secret/
observation-data exclusion from response metadata.

`typesafe-jev-reflex-provider.test.ts` covers the TypeSafe Jev reflex provider:
current-legal-candidate reuse across calls, pinned model and opaque criteria
dispatch, bounded capture-pressure projection (location and hunter data
excluded), absent-capture omission, malformed-response and out-of-candidates
rejection, missing/malformed Noul rejection, independent HTTP attempt accounting,
deadline enforcement, budget-denial stop, invalid-timeout rejection, cancellation
propagation. Also covers `ScriptedReflexProvider`: deterministic opaque
candidate selection, default replan probability of zero, API-key exclusion from
the request body.

`model-catalog.test.ts` covers the OpenRouter model catalog: compatible-model
sanitization, pricing parsing, tools/structured-output/reasoning independence,
malformed-entry skipping, cache TTL, stale fallback, and safe failure states.

### Experiment archive (`packages/experiment-archive`)

`archive.test.ts` covers schema-v12-only enforcement: swarm-native provenance
archival, idempotent import, query service, credential-like-data rejection before
persistence, unknown-architecture-version rejection, and non-v12 schema
rejection.

### Game API (`apps/game-api`)

`app.test.ts` covers the API boundary: repeatable swarm-native scripted
providers, health and swarm-setup contracts, atomic swarm tick through the public
endpoint, and absence of legacy sequential-turn routes.

`simulation-service.test.ts` covers core tick execution: committing Zero
directives and worker reflex actions in one tick, and reset without retained
ticks.

`simulation-service.swarm.test.ts` covers full swarm tick scenarios using
scripted providers: conservative and elevated-pressure replan thresholds,
current-tick disinfection escalation into the next Zero replan, terminal
player-only tick on trail-hunter capture of Patient Zero, worker removal before
planning on player capture, unique attempt turn numbers after capture, schema-
valid API response without legacy turn records, frozen-facts ordering and
physical-action engine resolution, first-plan failure with one billed Zero
attempt and deterministic local expansion, directive reuse for four ticks
followed by replanning on the fifth, worker replan request, retained-directive
expiry, at-target and advancing-toward-target Zero reporting, reuse-tick
reservation release on cancellation, simulated-player event export, failed-Jev
wait fallback, cancellation without committed world, relocate completion and
completed-directive identification, and expand completion only after
worker control.

`reflex-execution.test.ts` covers the reflex execution seam: scripted end-to-
end execution through planner and reflex seams, directive candidate choice and
engine resolution, at-target reporting, four-entry capture-alert cap, immediate
pressure from public disinfection without player-state exposure, completed
provider attempt retention without committed state, malformed-response wait
fallback, fabricated-attribution and partial-probability rejection, and two-
attempt retention after a transient retry.

`swarm-directives.test.ts` covers directive semantics: expand completion only
after worker-controlled target, relocate and reinforce completion on arrival,
evade completion on arrival or after leaving high pressure, non-completing hold
behavior, infected-target rejection, and missing/already-satisfied/incoherent-
target rejection on issue.

`swarm-pressure.test.ts` covers pressure classification: one-cell, two-cell,
and distant public-disinfection classification; five-tick history retention;
old-event expiry before pressure derivation; deduplication and cap.

`attempt-accounting.test.ts` covers credit admission: atomic reservation and
finalization, unused-reservation release, unlimited capacity, decimal input
canonicalization, exact decimal admission with known-cost refund and unknown-
cost exposure retention, atomic rejection with in-flight coverage, overage
fail-closed, unlimited-capacity overage, independent finalized and in-flight
records, and mutation guard on validation failure.

`swarm-comparison.test.ts` covers the offline comparison harness:
byte-for-byte reproducibility for the same deterministic inputs, and Jev-worker
versus deterministic-worker-baseline comparison. The deterministic-worker
baseline is retained as the ablation control isolating Jev's contribution; it
is not a second production architecture.

`live-swarm-comparison.test.ts` covers the live comparison admission guard:
confirmation requirement before provider construction, fixed live-experiment
cap enforcement, and matched seeded inputs with Jev calls omitted in the
deterministic control.

`live-swarm-comparison-cli.test.ts` covers the CLI admission guard: refusal
without cost acknowledgement, model requirement after acknowledgement, saved-
report summary without acknowledgement or providers, unsafe-text rejection in
hand-edited reports, bounded-input defaults and oversized-input rejection, and
separate survival/territory/stall/replan/cost metrics in summaries.

`swarm-diagnostics-cli.test.ts` covers the diagnostic projection: stationary-
swarm summary showing no player pressure and fallback actions.

`geographic-direction.test.ts` covers H3 bearing calculations: clockwise sector
boundaries with north wraparound, initial bearings across longitude wraparound,
and same-cell/same-coordinate rejection.

### World Lab (`apps/world-lab`)

`swarm-view.test.tsx` covers swarm telemetry panels: inactive pressure/action/
failure summary, Zero fallback and worker reflex telemetry without social labels,
provider-cost versus admission-exposure separation, completed worker directives
in strategy and activity telemetry, empty-state before first committed tick,
fallback worker actions and failures visible without Jev telemetry, and
reused-directive and structured-replan-request display.

`world-lab.test.tsx` covers the swarm workspace: fixed swarm architecture and
Agent Zero model readiness, fresh swarm setup without an architecture selector,
tick commit, reset, exact-tick-cap execution without overlapping requests,
cancellation reconciliation, full-safe export preview before export actions,
model console showing one Agent Zero planner row and no per-agent override
controls, and export dialog without agent/turn/level/outcome/action filters.

`model-options.test.ts` covers shared model options: deduplication and identical
ordering for global and per-agent options, identifier-before-name ordering, and
price-metadata preservation.

`ui-color.test.ts` covers agent color resolution: own-color resolution and
neutral fallback for unknown agents.

`world-map-config.test.ts` covers dark basemap configuration: tokenless CARTO
Dark Matter tiles with complete attribution.

### Playwright E2E (`tests/e2e/world-lab.spec.ts`)

Two tests: the long swarm-activity log scrolls inside the fixed-height bottom
dock; and a deterministic scripted swarm tick commits and exports safe
telemetry without an OpenRouter request.

## Scripted and deterministic seams

`HEXZERO_PROVIDER=scripted` (via `pnpm dev:test-provider`) activates the
scripted path for both applications: the server does not load `.env` and genuine
provider credentials are never read. Unit and integration tests instantiate
`ScriptedSwarmPlannerProvider` (`plannerMode: 'scripted-swarm-test'`) and
`ScriptedReflexProvider` (`reflexMode: 'scripted-reflex-test'`) directly; no
tests use real providers.

The deterministic-worker baseline (workers that resolve directives without a
model call) is retained alongside Jev as the ablation control. Both
`pnpm compare:offline` (offline, no provider, no archive write) and
`pnpm compare:live` (paid, explicit acknowledgement required) compare only
the Jev and deterministic-worker variants. `pnpm diagnose:swarm` summarizes a
running local Game API snapshot without provider calls, keys, prompts, or raw
responses.

## Owner validation sequence

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm validate
pnpm exec playwright install chromium  # only if Chromium is not already installed
pnpm test:e2e
```

`pnpm validate` aggregates formatting check, lint, type checking, unit and
integration tests, and builds (`pnpm format:check && pnpm lint && pnpm typecheck
&& pnpm test && pnpm build`). `pnpm test:e2e` runs Playwright separately. Its
web server starts both applications with `HEXZERO_PROVIDER=scripted`; that
variable is never an implicit OpenRouter fallback.

The repository owner runs local validation. Coding agents write tests and
inspect GitHub CI but do not run local formatting, linting, type checking,
tests, builds, Playwright, or real-provider calls unless explicitly asked.

## Real-provider smoke

World Lab offers an explicit "Test Agent Zero planner" probe. It uses the production
planner contract and selected reasoning profile, does not advance or mutate the
world, may incur a small charge, and is cached by model plus profile plus
contract version. It is never invoked by deterministic validation or CI.

The live comparison command (`pnpm compare:live`) is a separately paid
experiment requiring an explicit provider-cost acknowledgement and an
operator-selected Zero model before constructing live providers. Each run has
hard attempt and credit-admission caps. Its JSON report contains only
allowlisted scenario, world, decision, and usage metrics; no keys, raw provider
payloads, prompts, or private reasoning. It never launches from default tests,
Playwright, or CI.

## Safe provider-attempt records

Offline tests cover attempt success, failure, cancellation, timeout, retry,
retention, export filtering, and archive idempotency. Real-provider calls remain
explicit opt-in smoke tests and are excluded from default CI.
