# ADR 0023: Bounded Patient Zero cleaner feed

## Status

Accepted for Slice D1.1.

## Decision

The existing single Patient Zero receives an engine-authored global cleaner
feed inside its global observation view. The feed contains only successful
disinfections and occupied-cell blocked-clean encounters from the current
virtual interval. Entries include safe event/cell/time data plus the affected
or blocking agent and current alliance attribution when available.

Events use deterministic chronological ordering. Only the most recent 128 are
displayed, accompanied by the authoritative total and explicit truncation.
Event cells are historical disinfection/block locations, not live player GPS.
Ordinary agents retain their
existing local evidence. Patient Zero's global feed excludes cleaner movement,
live/current position, route, target, identity, and future timing. Tick cancellation
still discards the entire candidate player interval and every derived
observation.

The runtime treats an occupied-cell block as successful historical defense and
a disinfection as historical loss, never a live cleaner sighting. Later-tick
directives must not chase or evacuate from an event cell alone. Patient Zero
communicates only for materially changed named recommendations, avoids repeated
unchanged warnings, prefers named alliance reinforcement after sustained
pressure, and may retain one bounded pattern rather than logging every event.
Communication remains optional and preserves the no-filler rule. Behavior
Trace shows local and global cleaner evidence while
deduplicating an event visible through both paths. Safe observation exports and
SQLite `observation_json` retain the feed; custom exports that exclude recent
control changes clear its event array.

## Consequences

No cleaner movement, disinfection, scheduling, decision-output, or SQLite
schema contract changes. Regional coordinators, assignment, additional
coordinator types, new communication channels, and extra model calls remain
deferred.
