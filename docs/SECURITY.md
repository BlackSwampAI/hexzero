# Security and trust boundaries

Simulated-player evidence is engine-authored. Agent observations may contain
bounded recent disinfection evidence but never the cleaner's live cell, route,
or future timing. World Lab is intentionally omniscient and may show those
details. Agent-authored text cannot create or modify player activity.
The optional trail hunter selects routes from visible infected cells only.
The engine checks co-location for capture after movement; it does not use hidden
agent positions as targets. Capture events and abandoned controllers are
authoritative state and are safe to export without exposing player routing
internals to agent providers.
Patient Zero alone additionally receives a bounded current-interval feed of
successful disinfections and occupied-cell blocks. Its named-agent attribution
is engine-authored; it contains no movement events, player ID,
live/current cleaner position, route, target, or future interval information.
Each event cell intentionally identifies the historical disinfection or
occupied-cell blocked-clean location and must not be interpreted as live GPS.
The cleaner-threat feed caps at the most recent 128 current-interval events
in chronological order with an authoritative total and explicit truncation.
Custom exports that omit recent control-change evidence clear both local and
Patient Zero global threat arrays. Per-event pressure context is engine-derived
from only the current and prior five ticks. The context contains counts and
tick bounds, not historical event arrays, cleaner movement, live position, or
inferred historical membership; removing feed events also removes their nested
rollups.

## Secrets and deployment

`TYPESAFE_API_KEY` is server-only for the zero-swarm reflex provider. Jev sees
compact semantic state and opaque candidate IDs. When current player pressure
captures a worker, Jev also receives a bounded structured capture-pressure
count and abandoned-cell counts from the worker's authorized capture alerts.
The outbound state omits H3 cell IDs, tick numbers, and hidden hunter routing;
the server retains directive targets and the action mapping. The key, raw
TypeSafe requests and responses, and provider error bodies never enter safe
telemetry, World Lab, archives, or exports. TypeSafe token usage is factual;
no monetary cost is inferred from it.
The second Jev question returns only a bounded yes probability in the same
request as the action choice. Code applies the replan threshold and stores a
structured signal; it grants no action or mutation authority. Reused directives
are checked against expiry, and Zero's physical action comes from current legal
engine affordances rather than an earlier plan's candidate ID.
Zero's local threat fields come from public disinfection effects and H3 geometry;
bounded capture context comes from public capture events. Neither projection
reads the hunter's selected target, planned route, or hidden state. Current
events are projected before worker decisions without being committed early.

In `zero-swarm-v1`, a separate OpenRouter planner (`swarm-planner-v2` contract)
receives bounded strategic facts and opaque legal Zero action IDs. The model
never sees raw H3 cell IDs or agent IDs: it receives pre-compiled semantic
options with opaque `optionId` labels per worker and a coarse `worldSummary`
in place of the raw cell list. The server maps each returned `optionId` to an
authorized `(mission, targetCell)` pair server-side. The service validates
every returned directive and action selection before worker dispatch. A rejected
plan causes an explicit deterministic fallback; it never grants world mutation
authority. Safe swarm tick records contain structured plans and outcomes, while
raw planner messages and responses remain server-private. Legacy social and
prose-memory cognition does not run in this mode.
The planner wire response contains only opaque `optionId` and Zero-action
choices. The server maps them to authorized agent/cell/action IDs and issues
directive IDs and lifetimes. Invalid outputs record only a bounded validation
category; they do not retain or echo the raw model response. When a worker has no unexpired directive from a
prior valid Zero plan, it uses deterministic legal local expansion without a
Jev request until planning recovers.

World Lab receives only configured booleans and adapter/model labels for the
swarm providers. It displays committed safe plan and reflex telemetry plus
server attempt totals; neither provider key nor raw request/response body is
included in the snapshot. An unavailable provider triggers the documented
deterministic fallback and remains visible as unavailable to the operator.

`OPENROUTER_API_KEY` is the only required OpenRouter environment value and is read only by the Game API process. It never enters catalog DTOs, assignments, exports, fixtures, browser responses, errors, or logs. The repository-root `.env` is ignored; `.env.example` contains only a placeholder.

The development API has no authentication, rate limiting, or provider-account balance enforcement. It does enforce server-owned per-experiment provider-attempt and conservative credit-admission ceilings configured by World Setup. Credit reservations bound admission exposure but cannot guarantee the upstream bill, especially when reported cost exceeds the operator's reservation. It binds to loopback and its CORS allowlist is limited to the documented local World Lab origins. Do not deploy its cost-incurring tick endpoint to unauthenticated public traffic.

The separate live comparison CLI requires an explicit provider-cost
acknowledgement and an operator-selected Zero model before it constructs live
providers. Each run has hard attempt and credit-admission caps. Its JSON report
contains only allowlisted scenario, world, decision, and usage metrics; no keys,
raw provider payloads, prompts, or private reasoning. OpenRouter's returned
cost is factual when present. Missing costs and TypeSafe monetary cost remain
unknown; the command never launches from default tests or CI.

## Model-provider isolation

Simultaneous ticks retain the same provider isolation. Every job receives a
schema-validated clone of its frozen observation, resolved model and reasoning
profile, abort signal, and the tick's shared deadline. Agent-authored output
cannot mutate the world directly or enter another same-tick observation.
Cancellation discards every result from the uncommitted tick.

When strategic replanning is required, the OpenRouter planner receives one bounded strategic observation and is instructed to return exactly one plain JSON object naming opaque worker and target choices plus a Zero-action selection. TypeSafe Jev receives a compact semantic observation with opaque legal candidate IDs per worker and returns a probability distribution over candidates; a second question in the same request returns an optional bounded replan probability. The runtime performs bounded extraction and conservative repair for wrappers such as code fences, surrounding prose, and trailing commas, then rejects missing text, unusable JSON, unknown fields, or output truncation before the deterministic world engine validates all resolved components independently.

The request uses the selected model, messages, `max_tokens`, `stream: false`, and at most one normalized reasoning object selected from sanitized model metadata. Provider default omits the object. Off is offered only for non-mandatory reasoning and sends `{ enabled: false, exclude: true }`; an advertised effort sends `{ enabled: true, effort, exclude: true }`. It deliberately sends no tools, `tool_choice`, `response_format`, `provider.require_parameters`, standalone `reasoning_effort`, or model-specific parameter. Model IDs are never inspected or special-cased. Transport/provider failures, unavailable-model/profile failures, text/JSON contract failures, and later simulation-rule rejection remain distinct safe outcomes. The adapter never silently substitutes a model or scripted behavior.

Explicit scripted mode bypasses repository `.env` loading entirely. This keeps deterministic browser validation offline and prevents test-provider processes from unnecessarily reading genuine-provider credentials; genuine mode retains the existing environment conventions.

## Location-search boundary

Tick recovery is server-owned and bounded to the existing at-most-one automatic
repair or transient retry inside the shared deadline. Lost ticks are final;
there is no browser-driven Retry/Skip or unattended recovery path.

Search runs only after explicit submission. Queries are trimmed to 120 characters, URL-encoded, receive no browser credentials, and are not logged by application code. The replaceable Nominatim adapter identifies the project, requests at most five results, limits upstream access to once per second per process, caches at most 100 normalized queries, times out after five seconds, and returns safe failures. `NOMINATIM_BASE_URL` replaces the upstream. Tests inject a fake; manual coordinates remain available.

Non-success OpenRouter bodies are read only up to a fixed bound. The adapter extracts a sanitized status, provider code/message, request ID, selected/resolved model, finish reasons, and latency, redacts credentials and observation strings, and discards the raw body. Those bounded fields may appear in the operator-facing failure record; raw bodies, prompts, responses, headers, and credentials never do.

## Prompt and reasoning data

New logical turns may use one automatic repair or transient transport retry,
but never both, and all calls share the original 75-second deadline. A
corrective request contains the same authoritative observation plus only
allowlisted validation codes; it never contains the raw invalid response, raw
Zod issues, stack traces, provider bodies, or copied diagnostic text.
Engine-rejected normalized decisions are not retried. Tick recovery is limited
to one bounded in-deadline automatic repair or transient retry; an unresolved
decision becomes a final attributed lost tick.

The model is explicitly instructed to return only one flat JSON decision with one concise visible summary and no hidden reasoning or chain-of-thought. Optional reasoning configuration always sets `exclude: true`; Provider default sends no reasoning instruction. Only numeric reasoning-token billing metadata is retained if OpenRouter reports it. The application stores no raw prompts, raw provider payloads, reasoning text, or private reasoning.

Agent Zero's strategy summary and directive notes (at most 160 characters each)
and Jev's structured reflex output are bounded, agent-authored, untrusted data.
They appear only inside the immutable user observation, never the fixed system
instruction. There is no agent chat, diplomacy text, or memory prose. The engine
validates every world action, infection, and capture before committing state;
agent-authored outputs cannot grant engine authority, weaken validation, or
authorize prompt or reasoning disclosure. World Lab renders model text through
React text nodes and never raw HTML.

## Experiment telemetry and exports

Tick failures retain only sanitized diagnostics, model/reasoning selections,
timestamps, and the safe frozen observation. A resolved lost tick is final and
has no manual retry/skip path. Raw provider responses, reasoning text,
credentials, and authorization headers are not retained.

The Game API captures only schema-validated safe observations, requested world actions, separate result records, visible concise summaries, sanitized rejected attempts, bounded provider failures, and normalized usage metadata. Malformed identifiers use nullable or absent sanitized representations; raw provider output is never retained. It never records or exports API keys, authorization data, fixed or hidden prompts, raw provider request/response bodies, private chain-of-thought, hidden analysis, secrets, or unbounded diagnostics. Historical records are cloned and immutable.

Export requests, agent IDs, levels, ranges, and Custom dependencies are
runtime-validated. Filtering and metrics remain server-owned. The export schema
is exclusively version 12; exports carrying schema version 9, 10, or 11 are
rejected outright with no migration path. Reset clears swarm tick history and
metrics while unlocking preserved roster assignments for the new experiment.

Actual cost is accepted only from OpenRouter's safe `usage.cost`. Missing cost is unknown, never zero; scripted-test providers explicitly report zero. The active Game API enforces experiment-scoped attempt and conservative credit-admission ceilings, but has no authentication, provider-account balance enforcement, restartable persistence, provider-management endpoint, upload, or sharing link. Credit admission is not an upstream billing guarantee. The loopback-only boundary remains mandatory.

The offline experiment archive adds local persistence only for complete schema-validated safe exports and explicitly curated Markdown notes. Imports scan for prohibited credential/private-reasoning fields and recognizable credential values before a transaction begins; failures roll back. The canonical `.hexzero/` database location is never exposed to callers. The CLI exposes bounded typed queries, not arbitrary SQL, and adds no MCP, embedding, vector-store, or network-listener surface.

World Lab may manually submit only the exact current generated export artifact
to a narrow archive endpoint. The browser cannot supply a database path or SQL.
The endpoint returns bounded counts and an experiment ID, never the resolved
filesystem path, and uses safe invalid-artifact, rejection, and persistence
errors without underlying diagnostics.

## Reporting

This is a private repository. Report suspected vulnerabilities privately to the repository owners rather than opening a public issue.

## Safe provider-attempt records

Attempt records may contain sanitized provider metadata and bounded failures,
but never prompts, raw requests/responses, headers, credentials, or private
reasoning. They do not grant authority over world state.
