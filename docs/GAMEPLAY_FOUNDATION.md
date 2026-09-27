# Gameplay Foundation

> **Delivery status (2026-08-23, updated for zero-swarm migration):** the
> simultaneous agent tick, deterministic virtual clock, shared-deadline
> dispatcher, phased resolution, schema-v13 experiment attribution, and the
> optional seeded D1 casual cleaner and trail-hunter-v1 simulated-player
> profiles are delivered. `zero-swarm-v1` is the only cognition architecture:
> one generative planner (Agent Zero, contract `swarm-planner-v2`) issues
> structured directives; workers resolve them via TypeSafe Jev reflex cognition.
> Personalities, agent-to-agent communication, formal alliances, per-worker
> goals, and prose memories are removed. Agent capture by the simulated
> trail-hunter exists; capture by real players, respawn, GPS authority, and
> background timing remain future work.

## Current Agent Zero planning slice

In the zero-swarm architecture Agent Zero makes an OpenRouter planning call on
tick 1, at scheduled five-tick reviews (ticks 6, 11, and so on), and when a
material replanning trigger occurs. Other ticks reuse the committed directives
without a planner call. Agent Zero issues a strategy summary and one structured
directive per worker. Workers resolve their directive via TypeSafe Jev reflex
cognition over enumerated legal-action candidates; deterministic selection is
the fallback when Jev is unavailable or its output fails validation. Agent
Zero is also a roster agent and selects its own legal physical action. The
server assigns directive IDs, target cells, and bounded lifetimes.
Current setup rejects a missing or null Agent Zero designation. Pre-swarm
exports (schema versions 9–11) are not readable by current code; schema
version 12 with `swarmArchitectureVersion: 'zero-swarm-v1'` is required.

> **Status: accepted product and roadmap direction, not an implementation claim.**
> This document records foundational decisions for future World Lab and Player
> Mode milestones. It does not mean these systems exist today, and it does not
> authorize implementing player mechanics before their roadmap milestone.

## How to read this document

- **Current behavior:** World Lab is an omniscient developer/admin surface with
  full agent visibility. The engine supports only `open` and `infected` cells
  and the small action set described below. Agents act on simultaneous global
  ticks with a deterministic virtual clock; `casual-cleaner` and
  `trail-hunter-v1` simulated-player profiles are available. The only cognition
  architecture is `zero-swarm-v1`. There is no Player Mode, GPS interaction,
  or autonomous server schedule.
- **Accepted foundational direction:** the simple action economy, distinct World
  Lab and Player Mode visibility, hidden simultaneous agent ticks, continuous
  player interaction, engine authority, and deterministic testing model are
  accepted foundational rules — some delivered, the rest guiding future work.
- **Tunable through World Lab:** values collected in
  [Tunable values](#tunable-values-not-settled-mechanics) remain experiment and
  balancing parameters rather than locked production constants.
- **Deferred or rejected initially:** mechanics collected in
  [Initial non-goals](#initial-non-goals) are outside the initial design unless
  later evidence and an explicit roadmap change justify them.

## Product goal

Hex Zero should remain mechanically simple. Replayability should emerge from
real geography, hidden agent locations, visible infection trails, persistent
24/7 agent activity, swarm planning strategy and directive execution, and
human intervention.

The intended player loop is:

> Explore the real world, clean visible outbreaks, unexpectedly discover a hidden agent, and capture it before its next unseen action while the infection continues spreading around the clock.

Avoid health systems, combat statistics, inventories, crafting, structures,
resources, and large action menus unless future testing proves they are
necessary.

## Two runtime perspectives

### World Lab

World Lab remains an omniscient developer and operator surface. It may expose all agent positions, decisions, observations, telemetry, virtual timing, and simulated-player activity required to test and diagnose the system.

### Player Mode

Player Mode is deliberately non-omniscient:

- Players can see infected territory.
- Players cannot normally see agent positions.
- An agent is revealed only when the server verifies that the player and agent occupy the same H3 cell after a brief accurate-location stability window.
- Player Mode never receives or displays the exact next agent-tick time.
- Resolved territory changes may allow an attentive player to infer that a tick occurred, but not precisely when the next one will occur.

Fog of war is therefore a future Player Mode rule, not a change to the
repository's current deliberate full-visibility contract. World Lab retains
complete visibility into agents, decisions, telemetry, simulated players, and
virtual timing.

## Time model

Player interactions occur continuously in real time. Agents act on server-authoritative global ticks.

- Freeze the pressure-adjusted candidate state for the tick.
- Build Agent Zero's strategic observation and worker observations from that
  same state.
- Call Agent Zero when a strategic replan is required, then request worker
  reflex choices sequentially under the shared tick deadline.
- Use deterministic fallbacks when planning or reflex calls fail; no worker
  sees another worker's same-tick choice.
- Resolve the selected actions in seeded order and commit the tick atomically.
- Each explicit tick advances the deterministic virtual clock by a hidden seeded interval, initially tunable between 5 and 10 minutes; no background scheduler exists yet.
- The exact schedule remains server-only. Player Mode must not receive or display
  `nextTickAt`, a countdown, progress ring, or equivalent timing information.

World Lab may accelerate this virtual clock for experiments while preserving event ordering.

## Agent objective and action economy

The initial action set remains intentionally small:

- Move to an adjacent eligible cell.
- Infect the current open cell.
- Capture eligible abandoned hostile infection.
- Wait.

The engine remains the sole authority for action availability and consequences. Prompts must not invent mechanics or override validation.

The engine-owned objective layer should communicate the following intent:

> You are a persistent autonomous infection agent in a shared geographic world. Expand and retain as much infected territory as possible while preserving your active presence. Human players can see infected territory and disinfect it in real time. They cannot normally see you unless they enter your current hex, but if they discover you, they may capture you immediately. Infecting territory grows your influence but may reveal a trail toward your position. Moving without infecting can conceal your route, but hiding indefinitely does not accomplish your objective. Balance expansion, survival, territorial defense, and deception using only the currently available actions.

The prompt layers have distinct responsibilities:

- **Objective** defines durable success and is engine-owned.
- **Directive** carries mission, target cell, priority, and risk tolerance from Agent Zero to each worker.
- **Observation** supplies bounded authoritative facts and exact legal actions.

The player-threat portion must be capability-gated until player or simulated-player mechanics exist. Agents should never receive fabricated nearby-player evidence merely because the prompt says players exist.

### Why the environment matters more than prompt wording

Without player pressure, infecting whenever possible and moving otherwise is the
dominant policy. Better prompting can change destinations and reactions, but
prompt wording alone cannot create meaningful strategy or a reason to sacrifice
expansion.

Player cleaning, capture, visible trails, territory-loss notifications, and
hidden locations create the missing tradeoffs without requiring more agent
actions:

- Infect now for growth but leave a visible trail.
- Move silently for multiple ticks to obscure position.
- Protect valuable territory by remaining nearby.
- Investigate recent losses or flee the likely player location.

Hiding indefinitely is not success; survival preserves the ability to pursue influence.

## Bounded agent observations

Agent Zero receives the bounded strategic observation needed to assign
directives, including current roster, strategic targets, territory and
simulated-player pressure. Each worker receives its directive, current legal
actions, a compact local world projection, and bounded local pressure facts.
The server does not add chat, per-worker goals, prose memory, diplomacy, or
future movement predictions. No runtime agent receives real-player GPS or raw
private reasoning.

## Real-time player interactions

GPS determines travel state automatically. Players do not repeatedly select Travel, Wait, or Monitor modes.

### Discovery and capture

1. The server continuously derives the player's current H3 cell from recent accurate GPS.
2. After a short stability window, an agent occupying that cell becomes visible to that player.
3. Player Mode presents a prominent **Capture** action.
4. On submission, the server atomically revalidates both positions and eligibility.
5. If capture commits before agent movement resolves, the agent is removed and its pending decision is discarded.
6. If movement commits first, capture returns `Agent escaped`.
7. With multiple players, the first valid atomic capture wins.

Capture initially has no health, dice, inventory, combat minigame, or repeated attack sequence. Finding the hidden agent is the challenge.

Agents do not receive real-time proximity warnings. A surviving agent may learn about a co-located or recently observed player through its next authoritative observation.

### Disinfection

1. A player enters an infected cell at an eligible speed.
2. Accurate GPS remains stable for a brief dwell.
3. The player presses **Disinfect**.
4. A short initial progress window, expected to be approximately 3–5 seconds, begins.
5. The server revalidates location, speed, infection state, and eligibility at commit.
6. The cell becomes open and uncontrolled.
7. The affected agent receives a bounded territory-loss notification.

An active hostile agent occupying the cell initially blocks disinfection until it leaves or is captured. Capture takes precedence if both interactions become available.

### Anti-abuse baseline

Driving between areas is allowed; interacting while moving too quickly is not. The server should enforce:

- Recent accurate GPS.
- Server-derived H3 membership.
- A short entry/stability dwell.
- An interaction speed threshold.
- Atomic position and state revalidation.
- Impossible-travel detection.
- One successful clean per infected state.
- Bounded interaction rate limits.

There is no manual travel-state control and no requirement to stop an unrelated player action every time GPS crosses a cell boundary.

## Capture consequences and population maintenance

Once real or deterministic simulated capture exists, every surviving agent receives a bounded authoritative capture alert regardless of distance. It may identify the captured agent, capture cell, time/tick, and newly abandoned territory. It must not expose the capturing player's identity, live GPS, route, or continued presence. No capture alerts are generated before capture capability exists.

When an agent is captured:

- The agent is removed immediately.
- Any unresolved decision is discarded.
- Its territory remains infected but becomes abandoned.
- Its lifetime telemetry is finalized.
- A replacement spawns after a configurable cooldown at a valid location sufficiently separated from the capturing player.
- The configured active-agent population is restored.

This preserves a persistent world without granting agents health or extra lives.

## Alliances

Formal alliances, diplomacy, and agent communication were removed by ADR 0033.
They are not current behavior or a deferred feature. Reconsidering them
requires an explicit new product decision and roadmap change. Historical design
rationale remains in ADRs 0008 and 0016.

## Deterministic simulated players

World Lab needs credible opposition before agent survival behavior can be evaluated. Simulated players should be deterministic engine-controlled actors, not additional LLMs.

Initial profiles:

- **Casual cleaner** travels toward nearby visible infection and cleans opportunistically.
- **Trail hunter** follows the freshest connected infection trail and searches for its source.
- **Area defender** patrols a configured region and removes infection appearing inside it.

Slice D1 implements only zero-or-one **Casual cleaner**. It moves at most one
adjacent H3 cell per explicit interval toward visible infection, uses its seed
for stable tie-breaking, and attempts at most one disinfection. An occupied
infected cell blocks cleaning. The trail hunter described below is also
implemented; the area-defender profile remains deferred.

The optional `trail-hunter-v1` profile
routes from visible infected cells without using hidden agent positions as
targets. Co-location can capture an agent, immediately remove it, and leave its
territory infected but abandoned. If this removes the last agent, or removes
Patient Zero from a zero-swarm experiment, the run records a terminal outcome.
Replacement spawning remains a later population-maintenance milestone.

Slice D1.1 adds no cleaner mechanics. Agent Zero receives a
current-interval-only global feed of authoritative successful disinfections and
occupied-cell blocked-clean encounters. Entries identify the affected or
blocking agent, are deterministically ordered, and are capped at 128 with
explicit totals and truncation; overflow retains the most recent events in
chronological order. Event cells identify the historical disinfection or
blocked-clean location; live player position, movement, route, target,
identity, future timing, and extra model calls remain excluded.

Agent Zero treats blocked cleans as successful historical defenses, not a
reason to vacate, and successful disinfections as confirmed historical losses,
not live cleaner sightings. Because directives arrive on a later tick, Zero
must not issue event-cell chase or evacuation tactics. Zero should issue a
directive only when pressure materially changes a named recommendation, avoids
repeated unchanged directives, and may retain a bounded meaningful pattern
rather than acting on every event.

D1.2 adds a compact six-tick rollup to each displayed current event so Agent
Zero can distinguish isolated from repeated subject pressure. It includes
subject event/category totals and consecutive affected ticks. The rollup
includes the current event and excludes movement and older events. An isolated
event normally warrants no directive, although a strategically meaningful first
loss may justify one. Repeated subject pressure strongly favors one new
actionable directive after checking recent Zero plan summaries for equivalent
unchanged strategy.

Scenario configuration should include simulated-player count, profile mix, travel characteristics, cleaning aggressiveness, search persistence, and seed.

Simulated players follow the same information and interaction rules intended for real players:

- They see infection but not hidden agent coordinates.
- They move and interact during the continuous interval between agent ticks.
- They discover agents only through valid co-location.
- They obey dwell, speed, range, and atomic validation rules.
- They cannot inspect agent directives, pending decisions, or future tick timing.

An accelerated World Lab interval should conceptually execute as follows:

1. Agents occupy positions committed by the previous tick.
2. Simulated players travel and interact along a virtual timeline.
3. Disinfections and captures commit immediately when valid.
4. Captured agents are removed and territory losses are recorded.
5. At the hidden boundary, surviving agents receive the updated frozen snapshot.
6. Their decisions are requested concurrently and resolve simultaneously.
7. A new hidden interval begins.

Using identical scenario and player seeds provides comparable pressure across model experiments.

## World Lab scenario configuration

The next scenario-building milestone should expose:

- Map center or searched location.
- H3 resolution.
- Radius in H3 rings.
- Estimated physical area and exact cell count.
- Agent count and explicit add/remove controls.
- Seeded bulk agent generation.
- Spawn seed and minimum separation.
- Agent Zero model and reasoning assignment.
- Simulated-player configuration when that capability lands.
- A preview before replacing the active experiment.

Suggested initial cell-count presets are 37, 127, 469, 1,261, and 4,921, with a
guarded custom value. Map extent and H3 resolution remain separate controls. For
the same physical area, each finer H3 resolution produces approximately seven
times as many cells, so World Lab must preview and cap the resulting render and
state cost before generation.

Roster and topology changes initially create a new experiment. Mid-experiment removal remains a later explicit operator intervention because it affects territory, pending work, and telemetry semantics.

Every experiment export should preserve the complete initial scenario configuration, including topology, resolution, cell count, seeds, roster, behavior assignments, model assignments, enabled capabilities, prompt version, and simulated-player configuration.

## Simultaneous decision dispatch

Simultaneous gameplay semantics do not depend on provider batch support. The
Game API owns tick execution. Each tick may include one Agent Zero planning
call when strategic replanning is required, followed by one sequential TypeSafe
Jev reflex call per worker. Workers use the same pre-action world state, and
their actions resolve in deterministic order. The engine remains authoritative.

1. Advance simulated-player pressure into an uncommitted candidate.
2. Determine whether Agent Zero must replan; reuse valid directives otherwise.
3. Reserve the required provider-attempt capacity before any provider call.
4. Call Agent Zero if needed, then call Jev sequentially for each worker.
5. Use deterministic fallbacks for planner or worker failures.
6. Resolve actions in seeded order and commit the complete tick atomically.

Provider recovery stays within the tick deadline. Cancellation or failure before
commit leaves world state unchanged, while already-started provider attempts
remain in the independent attempt ledger.

## Evaluation telemetry

World Lab should make the new behavior measurable. Swarm-tick records carry
the plan source (`zero-llm`, `directive-reuse`, or `deterministic-fallback`),
replan reasons, per-worker directive and action results, Jev confidence scores,
and provider attempt outcomes. Useful aggregate and derived metrics include:

- Territory gained, lost, retained, and abandoned.
- Territory per active lifetime.
- Time and ticks survived.
- Captures by model and simulated-player profile.
- Consecutive silent moves before infection.
- Direction changes after infection or nearby loss.
- Responses to disinfection events.
- Player encounters and escapes.
- Directive completion and expiry rates per mission type.
- Replan frequency and reasons.
- Worker Jev confidence distribution.
- Simulated-player distance traveled, cells cleaned, and captures.
- Decision latency and deadline misses.
- Provider attempt counts and outcomes (success, timeout, failure) per role.
- Token usage and cost per tick (planning call vs. total).

Telemetry must continue to exclude raw provider output and private
chain-of-thought.

## Delivery order

The intended sequence is:

1. Configurable map scale, H3 resolution, and agent roster. **Implemented in the World Lab scenario milestone.**
2. Goal-oriented prompt revision and versioned scenario attribution. **Implemented as `durable-influence-v1` without player-survival language.**
3. Simultaneous agent ticks with a provider-neutral dispatcher and virtual clock. **Implemented. Zero-swarm migration retired the legacy per-agent architecture; `zero-swarm-v1` with Agent Zero planning and TypeSafe Jev reflex workers is the sole cognition architecture. No background scheduling or Player Mode timing exposure.**
4. Deterministic real-time simulated players and threat observations. **D1 and
   D1.1 deliver one seeded casual cleaner, bounded local evidence, and the
   Agent Zero current-interval global feed; `trail-hunter-v1` is also
   delivered. Broader Player Mode remains future work.**
5. Comparative unattended World Lab experiments.
6. Real GPS Player Mode using the already-tested capture and disinfection rules.
7. Optional OpenRouter asynchronous batches and local multi-endpoint optimization where measurements justify them.

Survival language should become active only alongside genuine simulated or real player pressure.

## Initial non-goals

Do not initially add:

- Health, damage, weapons, or combat calculations.
- Resources, inventories, structures, crafting, or terrain bonuses.
- Manual Travel, Wait, or Monitor modes for players.
- A visible player-facing tick countdown.
- Real-time agent warnings that a player is approaching.
- Omniscient simulated players.
- Multiple movement actions per tick solely to compensate for human travel speed.
- Alliances, alliance stat bonuses, or shared lives. Alliances were built and
  removed by ADR 0033; their return requires a new product decision.
- LLM-controlled simulated players.

## Tunable values, not settled mechanics

World Lab experiments should determine:

- Production H3 resolution and map footprint.
- Hidden tick interval distribution within the initial 5–10 minute range.
- GPS accuracy, dwell, and interaction-speed thresholds.
- Disinfection duration.
- Respawn cooldown and minimum player separation.
- Agent-to-cell and simulated-player-to-agent density.
- Observation window sizes.
- Provider concurrency and tick decision deadlines.
- The balance between expansion score, retained territory, inactivity, and capture penalties.

These values remain visibly separate from the accepted rules above. They are
configuration and balancing questions, not permission to change the core
real-time-player, hidden-simultaneous-agent foundation without an explicit
product decision.
