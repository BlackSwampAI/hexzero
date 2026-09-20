# ADR 0032: Optional trail hunter pressure

## Status

Accepted for zero-swarm comparison experiments.

## Decision

World scenarios may opt into seeded `trail-hunter-v1` pressure while retaining
`casual-cleaner` for baseline comparisons. The world engine advances one
adjacent player step per interval, ranking infected cells as visible trail
evidence with deterministic seed ties. It does not route toward hidden agent
positions. On co-location, the engine can capture one agent. The captured
agent is removed immediately and its infected cells become abandoned. A
surviving agent can capture abandoned territory using the existing legal world
action.

The service selects active agents after the candidate player advance. Captured
agents receive no provider call or world action. The candidate commits with
the complete tick, and cancellation rolls it back. If the last agent is
captured, or Patient Zero is captured in zero-swarm mode, a player-only tick
commits a terminal status without dispatching providers.

Safe snapshots and exports retain the profile, movement/disinfection/capture
events, abandoned control, and terminal status. They do not expose provider
secrets. Replacements and capture cooldowns are separate work.

## Consequences

This pressure profile creates real survival outcomes in deterministic
experiments. Its search policy is intentionally simple; comparisons must not
claim that it models an optimal human player.
