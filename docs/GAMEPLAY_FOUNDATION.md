# Gameplay Foundation

> **Delivery status (2026-08-23):** the pre-PR5 simultaneous agent tick,
> deterministic virtual clock, shared-deadline dispatcher, phased resolution,
> schema-v10 experiment attribution, and the optional seeded D1 casual cleaner
> are delivered as an operator-driven foundation. Real Player Mode, capture,
> respawn, GPS authority, and background timing remain future work.

## Current experimental Patient Zero slice

One scenario roster agent must coordinate global infection strategy through a
bounded authoritative overview, private advisory directives, and ordinary
direct replies. The role changes information and communication only: it has no
extra movement or world-action power, cannot force compliance, cannot see live
player GPS, and does not implement capture succession. It operates under the
simultaneous tick model under the same movement and world-action limits.
Current setup rejects a missing, null, or unknown designation. Historical
exports created when the role was optional remain truthful and readable.

> **Status: accepted product and roadmap direction, not an implementation claim.**
> This document records foundational decisions for future World Lab and Player
> Mode milestones. It does not mean these systems exist today, and it does not
> authorize implementing player mechanics before their roadmap milestone.

## How to read this document

- **Current behavior:** World Lab is an omniscient developer/admin surface; the
  development world has full agent visibility and advances one agent at a time.
  The current engine supports only `open` and `infected` cells and the small
  action set described below. There is no Player Mode, GPS interaction,
  autonomous server schedule, simultaneous global tick, or simulated-player
  pressure yet.
- **Accepted foundational direction:** the simple action economy, distinct World
  Lab and Player Mode visibility, hidden simultaneous agent ticks, continuous
  player interaction, engine authority, and deterministic testing model are
  accepted future rules.
- **Tunable through World Lab:** values collected in
  [Tunable values](#tunable-values-not-settled-mechanics) remain experiment and
  balancing parameters rather than locked production constants.
- **Deferred or rejected initially:** mechanics collected in
  [Initial non-goals](#initial-non-goals) are outside the initial design unless
  later evidence and an explicit roadmap change justify them.

## Product goal

Hex Zero should remain mechanically simple. Replayability should emerge from
real geography, hidden agent locations, visible infection trails, persistent
24/7 agent activity, model personalities and strategies, alliances and
communication, and human intervention.

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

- Freeze one authoritative snapshot for all surviving agents.
- Build every surviving agent's observation from that same snapshot.
- Request decisions concurrently under a shared bounded deadline.
- No agent sees another agent's decision from the same tick.
- Missing, malformed, or late decisions become final attributed lost ticks after the one permitted in-deadline repair or transient retry is exhausted.
- Valid decisions resolve simultaneously and deterministically.
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
- Optionally send one public or range-limited direct communication and submit one
  eligible formal diplomacy intent alongside the world action.

The engine remains the sole authority for action availability and consequences. Prompts must not invent mechanics or override validation.

The engine-owned objective layer should communicate the following intent:

> You are a persistent autonomous infection agent in a shared geographic world. Expand and retain as much infected territory as possible while preserving your active presence. Human players can see infected territory and disinfect it in real time. They cannot normally see you unless they enter your current hex, but if they discover you, they may capture you immediately. Infecting territory grows your influence but may reveal a trail toward your position. Moving without infecting can conceal your route, but hiding indefinitely does not accomplish your objective. Balance expansion, survival, territorial defense, diplomacy, and deception using only the currently available actions.

The prompt layers have distinct responsibilities:

- **Objective** defines durable success and is engine-owned.
- **Personality** controls communication style and temperament.
- **Strategy** biases choices without prescribing a fixed action loop.
- **Observation** supplies bounded authoritative facts and exact legal actions.

The player-threat portion must be capability-gated until player or simulated-player mechanics exist. Agents should never receive fabricated nearby-player evidence merely because the prompt says players exist.

### Why the environment matters more than prompt wording

Without player pressure, infecting whenever possible and moving otherwise is the
dominant policy. Better prompting can change destinations, communication,
alliances, and reactions, but prompt wording alone cannot create meaningful
strategy or a reason to sacrifice expansion.

Player cleaning, capture, visible trails, territory-loss notifications, and
hidden locations create the missing tradeoffs without requiring more agent
actions:

- Infect now for growth but leave a visible trail.
- Move silently for multiple ticks to obscure position.
- Protect valuable territory by remaining nearby.
- Investigate recent losses or flee the likely player location.
- Warn allies, coordinate routes, or create a distraction.

Hiding indefinitely is not success; survival preserves the ability to pursue influence.

## Bounded agent knowledge and memory

Agents know that human opposition exists, but receive only engine-produced evidence. Useful structured memory includes:

- Current strategic intent.
- A bounded history of the agent's own actions and outcomes.
- Recent cells gained and lost.
- Nearby disinfection patterns.
- Current alliance membership and relevant proposals.
- Exact formal-diplomacy affordances derived from frozen pre-action positions.
  Proposal creation uses the scenario `communicationRangeKm`; Patient Zero's
  direct-message range bypass does not bypass formal diplomacy range.
- Allied warnings and captures.
- Last-known player encounters with age and location.
- Explicit priority notifications for nearby territory loss.

Examples of legitimate observations include:

- `You lost cell X four minutes ago.`
- `Three cells southwest of you were disinfected recently.`
- `An allied agent was captured near cell Y.`
- `A player was last observed in your cell one tick ago.`

Agents must not receive live player GPS, future player routes, an omniscient
global player-location list, exact next-tick timing, raw private reasoning or
chain-of-thought, or another agent's unresolved decision.

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

Once real or deterministic simulated capture exists, every surviving agent receives a bounded authoritative capture alert regardless of distance. It may identify the captured agent, capture cell, time/tick, alliance, and newly abandoned territory. It must not expose the capturing player's identity, live GPS, route, or continued presence. No capture alerts are generated before capture capability exists.

When an agent is captured:

- The agent is removed immediately.
- Any unresolved decision is discarded.
- Its territory remains infected but becomes abandoned.
- Its lifetime telemetry is finalized.
- A replacement spawns after a configurable cooldown at a valid location sufficiently separated from the capturing player.
- The replacement may receive a new seeded personality and strategy assignment.
- The configured active-agent population is restored.

This preserves a persistent world without granting agents health or extra lives.

## Alliances

Alliances should initially improve survival through information rather than numerical combat bonuses.

Potential alliance benefits include:

- Shared last-known player cells and observation age.
- Nearby territory-disturbance warnings.
- Capture notifications.
- Coordinated expansion directions.
- Reduced competition for the same cells.

Allies do not initially receive health, damage, extra lives, shared ownership, or automatic rescue mechanics.

## Deterministic simulated players

World Lab needs credible opposition before agent survival behavior can be evaluated. Simulated players should be deterministic engine-controlled actors, not additional LLMs.

Initial profiles:

- **Casual cleaner** travels toward nearby visible infection and cleans opportunistically.
- **Trail hunter** follows the freshest connected infection trail and searches for its source.
- **Area defender** patrols a configured region and removes infection appearing inside it.

Slice D1 implements only zero-or-one **Casual cleaner**. It moves at most one
adjacent H3 cell per explicit interval toward visible infection, uses its seed
for stable tie-breaking, and attempts at most one disinfection. An occupied
infected cell blocks cleaning. Other profiles and capture remain deferred.

Scenario configuration should include simulated-player count, profile mix, travel characteristics, cleaning aggressiveness, search persistence, and seed.

Simulated players follow the same information and interaction rules intended for real players:

- They see infection but not hidden agent coordinates.
- They move and interact during the continuous interval between agent ticks.
- They discover agents only through valid co-location.
- They obey dwell, speed, range, and atomic validation rules.
- They cannot inspect private messages, pending decisions, or future tick timing.

An accelerated World Lab interval should conceptually execute as follows:

1. Agents occupy positions committed by the previous tick.
2. Simulated players travel and interact along a virtual timeline.
3. Disinfections and captures commit immediately when valid.
4. Captured agents are removed and territory losses are recorded.
5. At the hidden boundary, surviving agents receive the updated frozen snapshot.
6. Their decisions are requested concurrently and resolve simultaneously.
7. A new hidden interval begins.

Using identical scenario and player seeds provides comparable pressure across model, personality, and strategy experiments.

## World Lab scenario configuration

The next scenario-building milestone should expose:

- Map center or searched location.
- H3 resolution.
- Radius in H3 rings.
- Estimated physical area and exact cell count.
- Agent count and explicit add/remove controls.
- Seeded bulk agent generation.
- Spawn seed and minimum separation.
- Global and per-agent model/reasoning assignment.
- Global and per-agent personality/strategy assignment.
- Simulated-player configuration when that capability lands.
- A preview before replacing the active experiment.

Suggested initial cell-count presets are 37, 127, 469, 1,261, and 4,921, with a
guarded custom value. Map extent and H3 resolution remain separate controls. For
the same physical area, each finer H3 resolution produces approximately seven
times as many cells, so World Lab must preview and cap the resulting render and
state cost before generation.

Roster and topology changes initially create a new experiment. Mid-experiment removal remains a later explicit operator intervention because it affects territory, alliances, pending work, and telemetry semantics.

Every experiment export should preserve the complete initial scenario configuration, including topology, resolution, cell count, seeds, roster, behavior assignments, model assignments, enabled capabilities, prompt version, and simulated-player configuration.

## Simultaneous decision dispatch

Simultaneous gameplay semantics must not depend on one inference provider's batch feature. The simulation service should own a provider-neutral decision dispatcher:

1. Freeze the authoritative snapshot.
2. Build visibility-filtered observations.
3. Group requests by resolved provider, model, and reasoning profile.
4. Dispatch through the configured transport under bounded concurrency.
5. Preserve one shared tick deadline and per-agent result identity.
6. Retry only against the saved observation.
7. Convert unfinished decisions to lost turns.
8. Resolve accepted decisions in deterministic engine order.

Expected transports include:

- Concurrent ordinary OpenRouter requests for live experiments.
- Optional asynchronous OpenRouter batches after measured latency proves suitable.
- Independent concurrent OpenAI-compatible calls to local vLLM endpoints, allowing each server to schedule its own work.
- Deterministic offline providers for tests.

Models assigned to different endpoints or profiles may complete independently; the engine waits only until the shared deadline before resolving the tick.

## Evaluation telemetry

World Lab should make the new behavior measurable. Useful aggregate and per-agent metrics include:

- Territory gained, lost, retained, and abandoned.
- Territory per active lifetime.
- Time and ticks survived.
- Captures by model, personality, strategy, and simulated-player profile.
- Consecutive silent moves before infection.
- Direction changes after infection or nearby loss.
- Responses to disinfection and allied warnings.
- Player encounters and escapes.
- Alliance warnings and downstream reactions.
- Simulated-player distance traveled, cells cleaned, and captures.
- Decision latency and deadline misses.
- Automatic repair/transport attempts and final lost-tick results.
- Token usage and cost per tick.

Telemetry must continue to exclude raw provider output and private
chain-of-thought.

## Delivery order

The intended sequence is:

1. Configurable map scale, H3 resolution, and agent roster. **Implemented in the World Lab scenario milestone.**
2. Goal-oriented prompt revision and versioned scenario attribution. **Implemented as `durable-influence-v1` without player-survival language.**
3. Simultaneous agent ticks with a provider-neutral dispatcher and virtual clock. **Implemented as the pre-PR5 experiment foundation without background scheduling or Player Mode timing exposure.**
4. Deterministic real-time simulated players and threat observations.
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
- Alliance stat bonuses or shared lives.
- LLM-controlled simulated players.

## Tunable values, not settled mechanics

World Lab experiments should determine:

- Production H3 resolution and map footprint.
- Hidden tick interval distribution within the initial 5–10 minute range.
- GPS accuracy, dwell, and interaction-speed thresholds.
- Disinfection duration.
- Respawn cooldown and minimum player separation.
- Agent-to-cell and simulated-player-to-agent density.
- Observation and memory window sizes.
- Provider concurrency and tick decision deadlines.
- The balance between expansion score, retained territory, inactivity, and capture penalties.

These values remain visibly separate from the accepted rules above. They are
configuration and balancing questions, not permission to change the core
real-time-player, hidden-simultaneous-agent foundation without an explicit
product decision.
