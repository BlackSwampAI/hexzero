# Hex Zero

Hex Zero is an agent-first geographic experiment. A configurable roster of model-backed agents moves, infects, and captures territory on a real H3 map while the World Lab exposes every safe decision record. Full agent visibility is deliberate; there is no fog of war.

`zero-swarm-v1` is the sole cognition architecture. Workers make reflex decisions each active worker tick. Agent Zero makes one OpenRouter planning call only when strategic replanning is required (for example, after roster changes, directive completions, or elevated pressure), under the versioned contract `swarm-planner-v2`; otherwise the last valid directive set is reused with no planner call. Each plan carries a strategy summary and a per-worker directive set. Worker nodes resolve their directives with TypeSafe Jev reflex cognition, choosing among enumerated `action_N` candidates with a probability distribution and a confidence value, over the deterministic H3 world engine.

Directives carry: identifier, agent identifier, mission (`expand` | `hold` | `relocate` | `reinforce` | `evade`), a nullable target cell, priority (`low` | `normal` | `high`), risk tolerance (`low` | `medium` | `high`), issue and expiry ticks, and an optional note of at most 160 characters. When no replan is triggered, the previous plan's directives are reused without a planning call. Replans are triggered by: `initial`, `periodic-review`, `directive-complete`, `directive-expired`, `worker-request`, `worker-stalled`, `territory-loss`, `high-pressure`, `player-disinfection`, and `roster-changed`.

Cognition sources are `zero-llm` (Agent Zero via OpenRouter), `jev-reflex` (TypeSafe Jev via the TypeSafe API), and `deterministic-fallback`. Routing summary: Agent Zero → OpenRouter; Workers → TypeSafe Jev API. The deterministic-worker baseline—workers that resolve directives without a model call—is retained as the ablation control that isolates what Jev's reflex calls contribute, not as a second production architecture.

The capability-gated objective version is `durable-influence-v3`. Without simulated-player pressure, scenarios use a `durable-influence-v2`-compatible objective.

## Workspace

| Path                          | Responsibility                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/world-lab`              | Next.js developer/admin map, controls, inspector, and event log                             |
| `apps/game-api`               | Hono HTTP boundary and in-memory simulation service                                         |
| `packages/world-engine`       | Pure world validation and consequence application                                           |
| `packages/agent-runtime`      | OpenRouter planner, TypeSafe Jev reflex provider, model catalog, and scripted testing seams |
| `packages/shared`             | Runtime-validated schemas and inferred domain types                                         |
| `packages/experiment-archive` | Durable SQLite imports and bounded research queries                                         |

## Local development

Requirements are Node.js 24.18.0 and pnpm 11.21.0. Copy the example environment file to the repository-root `.env`, replace only the placeholder key, install dependencies, and start both applications:

```bash
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY and TYPESAFE_API_KEY.
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

For deterministic local automation, `pnpm dev:test-provider` sets
`HEXZERO_PROVIDER=scripted`. `HEXZERO_EXPERIMENT_DB` overrides the local
experiment archive path.

Open the World Lab at <http://localhost:3000>. The Game API binds to <http://127.0.0.1:8787>; Next.js narrowly proxies `/api/game/*` to it. `OPENROUTER_API_KEY` (Agent Zero) and `TYPESAFE_API_KEY` (Jev workers) are both required for real runs. Select a compatible model for Agent Zero in World Lab. Each assignment may use the provider's default reasoning behavior, disable optional reasoning, or select only an effort advertised by that model's catalog metadata. The Jev worker model is pinned server-side and shown as system information.

Each tick makes one Jev reflex call per active worker; an Agent Zero planning call is made only when strategic replanning is required and may incur an OpenRouter charge plus at most one in-deadline repair or transient-retry charge. TypeSafe monetary cost is not reported. All workers observe the same frozen pre-tick world; valid decisions resolve together while an individual provider failure is retained as that worker's final lost tick. Start is deliberately disabled when the server has no key. This development API has no authentication or provider-account balance enforcement. Its experiment-scoped attempt and credit-admission limits are operator safeguards, not an upstream billing guarantee, so it is not suitable for unauthenticated public deployment.

State is held only in the Game API process. The API captures one active safe experiment with bounded complete tick groups while the browser snapshot remains bounded without splitting a tick. The sole export format is schema version 13, which carries `swarmArchitectureVersion: 'zero-swarm-v1'`, an independent safe bounded provider-attempt ledger including work that did not produce a committed turn, and tick attribution. Pre-swarm exports (schema versions 9–12) are not readable by current code; inspecting them requires checking out a Git revision predating the zero-swarm migration. The Agent Zero model assignment and reasoning profile may be changed between ticks. A saved slug absent from the current compatible catalog is preserved and blocks execution until explicitly replaced. Agent Zero returns one structured plan under `swarm-planner-v2`; each Jev worker returns a candidate choice with a probability distribution and confidence value. The runtime extracts and conservatively repairs JSON before strict local schemas and the world engine apply authoritative validation.

Export previews report exact serialized UTF-8 bytes and a model-agnostic `ceil(bytes / 4)` approximate AI-input-token estimate. Compact JSON is the default for AI sharing; Pretty JSON remains available for human review, and preview estimates reflect the selected serialization. This is a sharing-budget aid, not tokenizer output or a billing guarantee. Exports exclude fixed prompts, raw provider payloads, credentials, authorization headers, private reasoning, and unbounded diagnostics.

World Setup also configures server-owned provider-attempt and conservative
credit-admission limits. The per-attempt credit reservation bounds admission
exposure using exact decimal accounting; it is not an upstream provider-account
spending cap or billing guarantee.
Provider-attempt records contain only bounded sanitized attribution, usage, and
failure fields; prompts, raw responses, credentials, and private reasoning are
excluded.

## Opt-in real-provider checks

Two surfaces make genuine provider requests, and neither runs in default tests
or CI. World Lab's **Test Agent Zero planner** button sends exactly one bounded,
non-mutating request using the Agent Zero planner contract and selected
reasoning profile; it may incur a small charge and is cached by model, profile,
and contract version. `pnpm compare:live` runs the paid Jev-versus-deterministic-worker
comparison, which requires an explicit provider-cost acknowledgement and an
operator-selected Zero model, and enforces hard attempt and credit-admission
caps. Both read `OPENROUTER_API_KEY` from the repository-root `.env`; `pnpm compare:live` also requires `TYPESAFE_API_KEY`.

## Development map source

The compatible default centers on Toledo, Ohio (`41.6528, -83.5379`) at H3 resolution 9 and renders the same deterministic radius-six disk of exactly 127 cells with eight fixed perimeter starts. World Setup previews and applies resolution 8–11 scenarios with 1–32 agents, radius at most 40, and at most 5,000 actual generated cells. It may optionally add one seeded deterministic simulated player, using the `casual-cleaner` or `trail-hunter-v1` profile. MapLibre uses CARTO Dark Matter's tokenless raster tiles with `© OpenStreetMap contributors © CARTO` attribution.

Combat systems, real-player GPS/capture, restartable world persistence, and autonomous scheduling remain deferred.

When every development cell is infected, World Lab automatically pauses
playback and disables Start to avoid accidental provider calls. Reset and export
remain available, and Single tick remains an explicitly manual diagnostic
action.

World Lab provides browser-owned absolute tick targets of **5, 10, 25, 50,
and 100**. The session-selected target defaults to 25. A bounded run pauses at
the authoritative tick target, on cancellation, or when the world is fully
infected. There is no background scheduler.

The persistent operator shell keeps execution controls, run target, playback speed, current tick, known cost, and run state visible while switching between Live and Agents workspaces. Live centers the map between an independently scrolling agent rail and semantic Scoreboard, Agent, Hex, and Run inspector tabs; a bounded activity dock separates events and safe failure/recovery records. Agent configuration uses the same mounted execution controller and existing server-authoritative mutations, so workspace switching cannot duplicate or interrupt playback. Infrequent and destructive operations remain in the accessible overflow menu. Blackberry/teal/mint/celadon/vanilla semantic tokens define the dark application chrome without replacing domain-owned agent colors.

The agent roster defaults to browser-local **Follow latest** behavior: after a
tick the inspector follows the last record in deterministic resolution order.
Selecting an agent manually disables following without hiding the roster's
textual Latest marker; the preference remains in that browser and is never
exported. The event log is a newest-first bounded feed, and the shared Model and Export dialogs keep their headers/actions fixed while their bodies scroll within the viewport.

See [Testing](docs/TESTING.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), the accepted future [Gameplay Foundation](docs/GAMEPLAY_FOUNDATION.md), and the [Roadmap](ROADMAP.md).

Schema-v13 exports can be imported into an ignored local SQLite archive and queried without repeatedly loading full JSON artifacts. See [Local experiment archive](docs/EXPERIMENT_ARCHIVE.md).
After Generate export, World Lab can also save that exact current validated
artifact to the configured local archive with **Save to SQLite**. Preview
remains an optional estimate and does not gate generation or saving.
The action is manual and idempotent; changed options require regeneration.

## Rename compatibility

Hex Zero was formerly named Agentborne. Workspace packages now use the
`@hexzero/*` namespace, and the repository URL will be
`https://github.com/BlackSwampAI/hexzero` after the external repository rename.
Existing environments may continue using `AGENTBORNE_PROVIDER` and
`AGENTBORNE_EXPERIMENT_DB`; the corresponding `HEXZERO_` variable takes
precedence, and selecting a legacy alias emits a value-free deprecation notice.

New archives default to `.hexzero/experiments.sqlite`. When that file does not
exist, an existing `.agentborne/experiments.sqlite` is opened in place with a
migration notice; Hex Zero never moves or overwrites it automatically. To
migrate manually, stop every Hex Zero process, create `.hexzero`, copy the
legacy database (including any `-wal` and `-shm` sidecars if present), verify
the copy opens, and only then remove the legacy files if desired.

New downloads use `hexzero-experiment-`. A legacy
`agentborne-experiment-*.json` filename is not itself a barrier to import, but
its contents must be schema version 13; the schema-v9 artifacts that name
generally accompanies are rejected like any other pre-swarm export. Browser-owned
settings stored under legacy `agentborne` keys are schema-validated and copied
once to the new `hexzero` keys.
