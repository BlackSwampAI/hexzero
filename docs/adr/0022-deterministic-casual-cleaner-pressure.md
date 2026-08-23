# ADR 0022: Deterministic casual-cleaner pressure

## Status

Accepted for Slice D1.

## Decision

World scenarios may configure zero or one seeded simulated player with the
`casual-cleaner` profile. The cleaner is deterministic world-engine authority,
not an LLM agent and not an agent world action.

For each explicit tick, the engine advances one virtual player interval before
freezing agent observations. It sees infected cells only, moves at most one
adjacent H3 cell toward the nearest infection using seeded stable tie-breaking,
then attempts at most one clean. A successful clean makes the cell open and
uncontrolled. Any agent occupying the cell blocks the clean. These changes
commit atomically with the tick; cancellation commits none of them.

World Lab may display live cleaner position. Agent observations never do. They
contain at most six recent clean events: territory loss is always visible to
the affected controller, while other evidence is limited to two H3 steps. The
player-threat objective is capability-gated.

## Consequences

Safe exports preserve configuration, activity, and movement/clean/block
metrics; SQLite uses `simulated_player_activity`. Existing scenarios default to
disabled. Capture, removal/respawn, GPS/anti-abuse, multiple players, other
profiles, and background scheduling are deferred.
