# Roadmap

## Experimental Patient Zero coordinator

The current focused slice requires one normal physical agent, provides a
bounded global strategic summary, and adds private advisory Zero broadcasts
plus direct replies. It intentionally excludes extra movement/actions,
numerical bonuses, forced compliance, live player GPS, capture succession,
and simulated players. The coordinator participates in the same frozen-world,
simultaneous tick transaction as every other active agent.

Post-foundation milestone 0024 makes the designation mandatory for every new
or live scenario and replaces the roster-sized Patient Zero diplomacy expansion
with a deterministic fixed-cap sparse summary. Historical null attribution
remains readable. Proposal-outcome memory, Patient Zero analytics corrections,
and further communication tuning remain separate milestones.

Player development begins only after the agent milestones below demonstrate compelling behavior. Each milestone is intended to remain a focused pull request; do not implement ahead of the current milestone.

The [Gameplay Foundation](docs/GAMEPLAY_FOUNDATION.md) records accepted future
product direction, tunable experiment values, and explicit non-goals. It is not
an implementation claim and does not supersede this delivery order.

## PR 1 — Project foundation and CI

Create the permanent project structure, World Lab shell, initial H3 map, minimal world-domain boundaries, documentation, tests, and GitHub Actions.

## PR 2 — First visible LLM invasion

Produce the first video-worthy result:

- Approximately 5–10 genuine model-backed agents
- Visible markers on the real map
- Movement between adjacent hexes
- Infection of current hexes
- Start, pause, reset, single-turn, and playback-speed controls
- Clickable agents
- Agent inspector showing personality, observations, requested action, concise decision summary, validation result, and recent events
- No player systems

By the end of PR 2, a human must be able to watch real agents independently move around and infect the map.

Implementation scope: six fixed agent profiles, a 61-cell Toledo development world, server-owned in-memory round-robin turns, OpenRouter strict structured decisions, live World Lab controls/markers/inspector, and deterministic offline automation. Persistence, autonomous scheduling, messaging, and player systems remain explicitly out of scope.

## PR 3 — Personality Lab

Prompt/personality editing, presets, cloning, respawning, reproducible starting worlds, provider/model configuration, and cost visibility.

First focused slice: server-owned session personality editing for the six existing agents, five bounded presets, world reset that preserves active personality configuration, and a separate confirmed restore-default action. Persistence across process restarts, cloning, respawning, provider/model configuration, cost visibility, and social mechanics remain deferred to later focused slices or milestones.

Second focused slice: server-owned safe experiment telemetry, actual OpenRouter usage/cost visibility, filtered tiered JSON export, and automatic browser playback pause when all 61 development cells are infected. The active experiment retains 5,000 complete safe records independently of the 120-turn browser snapshot; reset creates a new experiment and process restart still loses all telemetry. Persistence, multiple stored experiments, upload/sharing, provider configuration, and budget enforcement remain deferred.

## PR 4 — Social agents

Range-limited messages, agent inboxes, relationship memories, communication visualization, cooperation, refusal, deception, and betrayal emerging through prompts rather than a large formal rules system.

First focused slice: messaging is one exclusive turn action to a single existing agent within inclusive H3 distance three. Accepted messages become bounded world events and supply at most six recent inbound/outbound communications to later observations. World Lab and safe experiment exports expose this event-derived context. Generic inboxes, persistent or semantic memory, relationships, group chat, automatic replies, and communication visualization remain deferred.

Second focused slice: every infected hex has one individual controller. Infect claims an open current hex and capture deterministically transfers an infected current hex from another agent only after that controller leaves it; controller presence defends against immediate capture and control ping-pong. Observations expose explicit capture eligibility, an authoritative six-agent territory scoreboard, and at most six event-derived relevant gains/losses. Mingle alone receives a social coalition-builder default so messaging remains deliberately exercised without becoming automatic. Telemetry and schema-v3 exports are victim-aware. Combat calculations, formal alliances, resources, territory bonuses, and post-infection autonomous conflict playback remain deferred.

Third focused slice: communication is decoupled from the world action while remaining inside the same provider decision and single inference. Each turn requires move, infect, capture, or wait and may also request one public world-chat message or one proximity-bound direct message. The two results are validated and recorded independently; direct eligibility uses the pre-action snapshot. Observations expose bounded public and private context, World Lab separates both results, and safe exports advance to schema v4 with public/direct and accepted/rejected communication filters. Independent social ticks, automatic replies, relationships, groups, moderation, persistence, and player chat remain deferred.

Fourth focused slice: expand the Toledo development world to 127 cells and eight fixed agents, add engine-authoritative formal proposal/accept/leave alliances, deterministic effective territory colors, alliance-aware capture blocking, bounded alliance observations/events/telemetry, schema-v5 exports, and an exact browser-owned run-to-turn-200 experiment. Individual control remains authoritative, all decision components share one inference, and persistence, server scheduling, leadership, generic relationships, resources, and combat remain deferred.

Fifth focused slice: replace environment-selected models with a server-owned capability-filtered OpenRouter catalog, experiment-level global and per-agent assignments, schema-v6 assignment preservation, usage visibility, and a map-first operator layout with bounded collapsible activity. Model families remain irrelevant to compatibility; persistence, authentication, spending controls, and live catalog persistence remain deferred.

Sixth focused slice: harden each logical model turn with engine-derived legal-action affordances, at most one bounded automatic contract repair or transient transport retry inside the existing shared 75-second deadline, complete schema-v7 attempt accounting, exact one-call manual Retry, mutation idempotency, and browser reconciliation after ambiguous proxy failures. The universal text/flat-JSON contract remains the portability layer; engine-rejected game decisions are never automatically retried.

Seventh focused slice: polish the production World Lab with newest-first bounded public chat, browser-local follow-turn inspection, a shared accessible responsive dialog shell for model assignment and export, and stable complete headers in the collapsible communication dock. Simulation behavior, provider execution, API contracts, telemetry, and export documents remain unchanged.

Eighth focused slice: add versioned objective/personality/strategy prompt layers, reproducible seeded behavior assignment, engine-derived diplomacy affordances, specific safe validation detail codes, a cohesive Agent Controller, and behavior-attributed safe telemetry. Behavior locks after the experiment begins; arbitrary prompts and mid-experiment reassignment remain deferred.

Ninth focused slice: consolidate World Lab controls into one responsive command navbar, add browser-session absolute run targets through turn 1,000, make export generation explicitly artifact-based, unify model-option presentation, synchronize effective alliance colors across activity surfaces, and adopt a tokenless dark basemap plus semantic dark chrome. Simulation rules, model decisions, retry behavior, telemetry meaning, and export contents remain unchanged.

Tenth focused slice: add versioned configurable World Lab scenarios, actual H3 geometry preview, deterministic 1–32-agent rosters and separated spawns, current-scenario reset, a replaceable location-search boundary, `durable-influence-v1` attribution, and schema-v9 exports.

Temporary experiment hardening adds explicitly opted-in browser-lifetime unattended recovery with one to three one-call retries and one attributed skip. It does not replace the future server-owned scheduler or simultaneous-tick recovery policy.

Eleventh focused slice: redesign World Lab as a persistent long-running experiment operator workspace with a single execution controller, Live and Agents workspaces, a compact agent rail, contextual Scoreboard/Agent/Hex/Run inspection, and a bounded tabbed activity dock. This reorganizes existing authoritative configuration and telemetry without adding gameplay mechanics or persistent run storage.

Twelfth focused slice: add scenario-owned physical communication range, private alliance communications, bounded nearby awareness, deterministic legal-move ordering variety, neutral unaffiliated presentation, and operator-only private-communication observability without adding world actions or player mechanics.

## Pre-PR 5 — Simultaneous tick experiment foundation

Replace sequential agent turns with operator-driven simultaneous ticks. Every
active agent observes one frozen pre-tick snapshot, provider jobs dispatch
concurrently under a shared deadline, and the engine resolves a seeded order in
world-action, communication, and diplomacy phases before one proposal-expiry
pass. A deterministic virtual clock advances 5–10 configurable minutes per
committed tick. Individual provider failures become final attributed lost ticks;
cancellation commits nothing. Schema-v10 exports and the local archive retain
explicit tick attribution and complete tick groups. Background scheduling,
restart persistence, simulated players, threats, and Player Mode remain deferred.

## PR 5 — Goals and memory

Slice A delivers bounded per-agent strategic goals with deterministic revision semantics, safe attribution, and World Lab inspection. Slice B adds an eight-entry compact self-authored memory ledger in the same inference. Semantic/vector memory, embeddings, retrieval/ranking, relationship scores, shared alliance memory, restart persistence, and extra inference calls remain deferred.

Pre-PR-5 observability slice: add a local append-only SQLite experiment archive, transactional schema-v9 export import, bounded human/Codex queries, normalized comparisons, and FTS-searchable curated notes. The in-memory engine remains authoritative. Crash recovery, restartable simulation state, MCP, embeddings, vector search, and a database browser remain deferred.

Persistent short- and long-term objectives, compact memories, plan revision, summaries, and longer simulation runs.

## PR 6 — Persistent autonomous world

Scheduled turns, snapshots, replay, retries, idempotency, budgets, failure recovery, and operation without the World Lab browser being open.

Player development begins only after these agent milestones demonstrate compelling behavior.
