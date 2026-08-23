# Hex Zero

Hex Zero is an agent-first geographic experiment. A configurable roster of model-backed agents moves, infects, captures contested territory, communicates, and conducts formal alliance diplomacy while the World Lab exposes every safe decision record.

Every new or live scenario designates one roster agent as the Patient Zero
coordinator; the deterministic default is the first default-roster agent.
The role receives bounded global strategic information and can send private
advisory directives, but remains subject to the same movement and world-action
rules as every other agent. The universal flat provider contract is
`text-flat-json-v8`; the capability-gated objective is `durable-influence-v3`.
Without simulated-player pressure it uses a v2-compatible objective and never
fabricates player threats. For every
agent, including Patient Zero, no message is the normal choice unless a message
adds new decision-relevant value; routine action narration and filler are
explicitly discouraged.

Agents may also maintain one bounded, model-authored strategic goal across
ticks. Goal revisions share the single flat provider response, are independently
validated, and grant no world authority. Active goals are experiment-local,
in-memory state and are cleared by reset or process restart.

Each agent also has a process-local ledger of at most eight concise self-authored
memories. One keep, remember, revise, or forget request shares the existing
inference and is validated independently; memories are untrusted recollections
and grant no world authority.

World Lab derives a bounded read-only Behavior Trace from retained turn records.
It places observation changes, communication and board evidence, legal choices,
chosen actions, action-pattern changes, and goal/memory continuity together while
labeling model summaries as self-reported rather than proof of causation.

## Workspace

| Path                          | Responsibility                                                   |
| ----------------------------- | ---------------------------------------------------------------- |
| `apps/world-lab`              | Next.js developer/admin map, controls, inspector, and event log  |
| `apps/game-api`               | Hono HTTP boundary and in-memory simulation service              |
| `packages/world-engine`       | Pure world validation and consequence application                |
| `packages/agent-runtime`      | OpenRouter provider boundary and explicit scripted testing seams |
| `packages/shared`             | Runtime-validated schemas and inferred domain types              |
| `packages/experiment-archive` | Durable SQLite imports and bounded research queries              |

## Local development

Requirements are Node.js 24.18.0 and pnpm 11.21.0. Copy the example environment file to the repository-root `.env`, replace only the placeholder key, install dependencies, and start both applications:

```bash
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY.
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

For deterministic local automation, `pnpm dev:test-provider` sets
`HEXZERO_PROVIDER=scripted`. `HEXZERO_EXPERIMENT_DB` overrides the local
experiment archive path.

Open the World Lab at <http://localhost:3000>. The Game API binds to <http://127.0.0.1:8787>; Next.js narrowly proxies `/api/game/*` to it. `OPENROUTER_API_KEY` is the only required OpenRouter environment value. Select a compatible global model in World Lab, then optionally override individual agents. Each assignment may use the provider's default reasoning behavior, disable optional reasoning, or select only an effort advertised by that model's catalog metadata.

Each Single tick or completed playback interval requests every active agent and
may incur an initial third-party OpenRouter charge plus at most one in-deadline
repair or transient-retry charge per agent. All agents observe the
same frozen pre-tick world; valid decisions resolve together while an individual
provider failure is retained as that agent's final lost tick. Start is
deliberately disabled when the server has no key. This development API has no
authentication or cost controls and is not suitable for an unauthenticated
public deployment.

State is held only in the Game API process. The API captures one active safe
experiment with bounded complete tick groups while the browser snapshot remains
bounded without splitting a tick. Schema-v10 exports add tick number, resolution
position, virtual time, interval, and lost-tick attribution; schema-v9 archive
imports remain supported. Model and reasoning-profile assignments may be changed
between ticks; behavior locks after tick one. A saved slug absent from the
current compatible catalog is preserved and blocks execution until explicitly
replaced. Every provider decision is one plain-text response containing a
required flat JSON object with one world action, at most one communication, and
at most one formal diplomacy intent. The runtime extracts and conservatively
repairs JSON before strict local schemas and the world engine apply authoritative
validation.

Export previews report exact serialized UTF-8 bytes and a model-agnostic `ceil(bytes / 4)` approximate AI-input-token estimate. Compact JSON is the default for AI sharing; Pretty JSON remains available for human review, and preview estimates reflect the selected serialization. This is a sharing-budget aid, not tokenizer output or a billing guarantee. Exports exclude fixed prompts, raw provider payloads, credentials, authorization headers, private reasoning, and unbounded diagnostics.

## Opt-in real-provider smoke

The smoke command performs exactly one bounded real decision request and validates it. It is never part of default tests or CI:

```bash
pnpm smoke:openrouter -- <compatible-model-slug> [initial|stateful]
```

The command reads only `OPENROUTER_API_KEY` from the repository-root `.env`; its model slug is an explicit command argument. Values in that file override stale exported values for the smoke process.

## Development map source

The compatible default centers on Toledo, Ohio (`41.6528, -83.5379`) at H3 resolution 9 and renders the same deterministic radius-six disk of exactly 127 cells with eight fixed perimeter starts. World Setup previews and applies resolution 8–11 scenarios with 1–32 agents, radius at most 40, at most 5,000 actual generated cells, and a 12 km default physical communication range. It may optionally add one seeded deterministic casual cleaner. Legacy exports preserve their authoritative objective attribution. MapLibre uses CARTO Dark Matter's tokenless raster tiles with `© OpenStreetMap contributors © CARTO` attribution.

Alliance leadership, merging, custom metadata, combat systems, relationship
scores, group chat, real-player GPS/capture, restartable world persistence, and
autonomous scheduling remain deferred.

Formal alliances may grow to the entire configured roster and active worlds may
use every feasible roster partition. Accessible alliance colors are
deterministic presentation and may be reused; they are not an engine capacity
rule. Free agents may form a new alliance, allied members may invite a free
agent, and a free agent may request entry from an allied recipient. Frozen
observations supply exact legal diplomacy IDs and bounded blocker codes so the
same single model request does not need provider tools or infer engine rules.
Patient Zero receives a fixed-cap sparse global diplomacy summary rather than a
per-agent feasibility expansion. Counts and explicit truncation describe
omitted options, while recommendations may use only displayed authoritative
agent and proposal IDs. Legacy archived experiments without a Patient Zero
remain readable and retain their historical null attribution.

When every development cell is infected, World Lab automatically pauses
playback and disables Start to avoid accidental provider calls. Reset and export
remain available, and Single tick remains an explicitly manual diagnostic
action.

World Lab provides browser-owned absolute tick targets of **5, 10, 25, 50,
and 100**. The session-selected target defaults to 25. A bounded run pauses at
the authoritative tick target, on cancellation, or when the world is fully
infected. There is no background scheduler.

The persistent operator shell keeps execution controls, run target, playback speed, current tick, known cost, and run state visible while switching between Live and Agents workspaces. Live centers the map between an independently scrolling agent rail and semantic Scoreboard, Agent, Hex, and Run inspector tabs; a bounded activity dock separates public chat, events, and safe failure/recovery records. Agent configuration uses the same mounted execution controller and existing server-authoritative mutations, so workspace switching cannot duplicate or interrupt playback. Infrequent and destructive operations remain in the accessible overflow menu. Blackberry/teal/mint/celadon/vanilla semantic tokens define the dark application chrome without replacing domain-owned agent and alliance colors.

The agent roster defaults to browser-local **Follow latest** behavior: after a
tick the inspector follows the last record in deterministic resolution order.
Selecting an agent manually disables following without hiding the roster's
textual Latest marker; the preference remains in that browser and is never
exported. Public world chat and the event log are newest-first bounded feeds,
and the shared Model and Export dialogs keep their headers/actions fixed while
their bodies scroll within the viewport.

See [Testing](docs/TESTING.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), the accepted future [Gameplay Foundation](docs/GAMEPLAY_FOUNDATION.md), and the [Roadmap](ROADMAP.md).

Completed schema-v10 exports and legacy schema-v9 exports can be imported into
an ignored local SQLite archive and queried without repeatedly loading full JSON
artifacts. See [Local experiment archive](docs/EXPERIMENT_ARCHIVE.md).
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

New downloads use `hexzero-experiment-`. Existing
`agentborne-experiment-*.json` files and their schema-v9 contents remain
importable unchanged. Browser-owned settings stored under legacy `agentborne`
keys are schema-validated and copied once to the new `hexzero` keys.
