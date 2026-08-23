# Security and trust boundaries

Public messages are untrusted claims visible to all agents and classified for future player visibility. Direct, alliance, and Zero messages are player-hidden. Only participants receive them in agent observations; the omniscient Private comms feed is restricted to World Lab operator contracts. Only the designated Patient Zero may send a Zero broadcast. Its sender role is authoritative but its strategy remains advisory. Messages never contain raw reasoning, pending decisions, credentials, player GPS, or fabricated threat evidence.

Patient Zero's global view is bounded to active agent identity/current cells,
allowlisted behavior attribution, territory/alliance totals, proposals, and
recent authoritative events. It never serializes the complete world, future
turn information, provider payloads, credentials, or live player GPS. Direct
range bypass is engine-authoritative and applies only when Patient Zero is one
endpoint; invalid channel/recipient combinations do not mutate state.
The diplomacy portion has roster-independent caps: at most 12 displayed legal
pairs, eight acceptable proposals, eight leave IDs, and eight prioritized
blocker examples, plus aggregate stable blocker counts and explicit truncation.

## Secrets and deployment

`OPENROUTER_API_KEY` is the only required OpenRouter environment value and is read only by the Game API process. It never enters catalog DTOs, assignments, exports, fixtures, browser responses, errors, or logs. The repository-root `.env` is ignored; `.env.example` contains only a placeholder.

The development API has no authentication, rate limiting, or spending guard. It binds to loopback and its CORS allowlist is limited to the documented local World Lab origins. Do not deploy its cost-incurring turn endpoint to unauthenticated public traffic.

## Model-provider isolation

Simultaneous ticks retain the same provider isolation. Every job receives a
schema-validated clone of its frozen observation, resolved model and reasoning
profile, abort signal, and the tick's shared deadline. Agent-authored output
cannot mutate the world directly or enter another same-tick observation.
Cancellation discards every result from the uncommitted tick.

OpenRouter receives one immutable structured observation and is instructed to return exactly one plain JSON object as text, containing a required world action plus at most one optional communication and one optional diplomacy intent. Its flat required fields use explicit empty-string and `none` sentinels. The runtime performs bounded extraction and conservative repair for wrappers such as code fences, surrounding prose, and trailing commas, then rejects missing text, unusable JSON, unknown fields, contradictory sentinels, or output truncation before the deterministic world engine validates all normalized components independently.

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
Engine-rejected normalized decisions are not retried. Manual Retry exists only
for legacy sequential/schema-v9 compatibility. Tick recovery is limited to one
bounded in-deadline automatic repair or transient retry; an unresolved decision
becomes a final attributed lost tick.

The model is explicitly instructed to return only one flat JSON decision with one concise visible summary and no hidden reasoning or chain-of-thought. Optional reasoning configuration always sets `exclude: true`; Provider default sends no reasoning instruction. Only numeric reasoning-token billing metadata is retained if OpenRouter reports it. The application stores no raw prompts, raw provider payloads, reasoning text, or private reasoning.

Agent-authored messages, personalities, summaries, scoreboards, alliance events, proposals, and natural-language alliance claims are bounded untrusted data. They appear only inside the immutable user observation, never the fixed system instruction. Direct eligibility is derived from the pre-action snapshot. Recipient/range, infection, controller-presence, alliance membership, proposal eligibility, system ID/color allocation, and capture validation remain authoritative in the world engine. Models cannot choose alliance IDs, colors, membership lists, or metadata. Only accepted typed diplomacy changes alliance state, and rejected components cannot partially mutate or corrupt one another. World Lab renders model text through React text nodes and never raw HTML.

Frozen observations expose only runtime-validated exact diplomacy IDs and
bounded stable blocker codes. Patient Zero's sparse global diplomacy summary
uses fixed caps, aggregate counts, deterministic priority, and explicit
truncation; it contains neither pending decisions nor future same-tick actions.
These affordances avoid a provider-controlled tool boundary; submitted
intents still pass authoritative engine validation during deterministic
resolution.

World Lab personality edits are also untrusted, bounded text. The Game API trims and runtime-validates them before changing the authoritative session, and rejects changes during active model execution. The runtime supplies the active personality only inside the immutable observation as subordinate behavioral context. It is never interpolated into the fixed system instruction and cannot grant actions, weaken engine validation, request secrets, or authorize prompt/reasoning disclosure. React renders active and historical personality text as text rather than HTML.

Personality mutation errors use typed, generic response bodies. They do not expose raw prompts, provider responses, credentials, diagnostics, stack traces, or internal service details. There is still no authentication or persistence; these endpoints remain limited to the loopback development surface.

Behavior profile IDs are allowlisted at every boundary and resolve only to application-owned registry fragments. Imports cannot supply profile prompt text. The prompt explicitly separates untrusted chat invitations from engine-authoritative formal proposal IDs, and exact legal diplomacy IDs are derived from current state. Seed values select registry entries only and are never interpreted as prompt text.

## Experiment telemetry and exports

Tick failures retain only sanitized diagnostics, model/reasoning selections,
timestamps, and the safe frozen observation. A resolved lost tick is final and
has no manual retry/skip path. Raw provider responses, reasoning text,
credentials, and authorization headers are not retained.

The Game API captures only schema-validated safe observations, requested world actions, optional communication and diplomacy intents, separate result records, visible concise summaries, bounded message text, typed alliance events, sanitized rejected attempts, bounded provider failures, and normalized usage metadata. Malformed identifiers use nullable or absent sanitized representations; raw provider output is never retained. It never records or exports API keys, authorization data, fixed or hidden prompts, raw provider request/response bodies, private chain-of-thought, hidden analysis, secrets, or unbounded diagnostics. Historical records are cloned and immutable.

Export requests, agent IDs, levels, ranges, outcome/world-action filters, communication channel/status filters, and Custom dependencies are runtime-validated. Filtering and metrics remain server-owned. Schema v10 requires complete tick attribution and canonical safe per-tick summaries derived from all model attempts; schema-v9 remains the legacy sequential export format and documented older safe imports remain supported by the Game API. Selected-agent exports use sender/recipient-aware communication filtering and direct multi-agent relevance for proposals and membership changes; unrelated direct messages and rejected diplomacy are excluded. Reset clears communications, alliances, proposals, alliance events, and their metrics while preserving active personality values and unlocking preserved assignments for the new experiment.

Actual cost is accepted only from OpenRouter's safe `usage.cost`. Missing cost is unknown, never zero; scripted-test providers explicitly report zero. The active Game API still has no authentication, budget enforcement, restartable persistence, provider-management endpoint, upload, or sharing link. The loopback-only boundary remains mandatory.

The offline experiment archive adds local persistence only for complete schema-validated safe exports and explicitly curated Markdown notes. Imports scan for prohibited credential/private-reasoning fields and recognizable credential values before a transaction begins; failures roll back. Both the canonical `.hexzero/` and compatible legacy `.agentborne/` database locations are ignored. The CLI exposes bounded typed queries, not arbitrary SQL, and adds no MCP, embedding, vector-store, or network-listener surface.

## Reporting

This is a private repository. Report suspected vulnerabilities privately to the repository owners rather than opening a public issue.

## Agent goal text

Strategic goals and revision reasons are bounded, agent-authored, untrusted data. They are supplied only inside immutable user-observation data, never interpolated into system instructions. The contract requests concise visible summaries and prohibits private chain-of-thought. Goal operations grant no engine authority and cannot bypass world, communication, or diplomacy validation.

## Compact memory text

Compact memories are bounded self-authored recollections, not authoritative facts. They remain subordinate observation data and are never interpolated into system instructions. Memory may not retain raw prompts, provider payloads, credentials, or private chain-of-thought. Server-issued IDs and tick attribution are authoritative; memory prose is not.
