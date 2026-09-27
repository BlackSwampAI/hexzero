# ADR 0012: Agent awareness and private communications

## Status

Superseded by [ADR 0033](0033-retire-legacy-multi-agent-architecture.md) for
per-agent communication and social awareness. This ADR remains a historical
record; zero-swarm uses Agent Zero planning and bounded worker observations.

Agent decisions use `text-flat-json-v2` and the engine-owned `durable-influence-v2` objective. One optional communication intent is `public`, `direct`, or `alliance`. Public content is globally and future-player-visible; direct and alliance content is player-hidden and remains an untrusted claim.

This transport version is superseded by `text-flat-json-v3` in ADR 0013,
which adds the provider-neutral `zero` communication enum value without
changing the objective.

Direct-message eligibility uses H3 cell-center great-circle distance and scenario-owned `communicationRangeKm` (default 12 km), never H3 rings. Observations contain at most eight nearest in-range agents, while current allies remain position-visible regardless of distance. Alliance communication delivers to current members other than the sender and grants no numerical bonus.

The runtime remains sequential, so later turns may observe committed earlier messages. Future simultaneous ticks must build decisions from one frozen snapshot; same-tick messages are not visible until the following tick.
