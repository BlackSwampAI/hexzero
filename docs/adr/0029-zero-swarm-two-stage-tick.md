# ADR 0029: Zero-swarm two-stage tick

## Status

Accepted for PR B.

## Decision

`zero-swarm-v1` executes one Agent Zero planning call before any worker reflex
call. The service freezes the authoritative pre-tick state, advances optional
deterministic player pressure into an uncommitted candidate, and constructs
Zero's strategic observation from that candidate. Zero receives engine-derived
legal physical actions identified by opaque IDs and a bounded target-cell
allowlist. Its plan must contain one directive for each worker and one legal
Zero action ID. The service validates exact roster coverage, target membership,
and directive timing before use.

Each worker receives only its directive, compact local facts, and
engine-derived legal candidates. Jev selects an opaque candidate ID; the
service maps it to the physical action and the world engine validates and
resolves it. Zero and worker actions resolve in the existing seeded tick order.
The service commits the complete world, time, player events, plan, and worker
records atomically. The legacy tick remains on its existing path.

A worker request failure resolves to an engine-legal wait and records
`deterministic-fallback`. A planning failure reuses valid unexpired directives
when possible, otherwise creates neutral directives; Zero waits in either
case. Cancellation rolls back the candidate world and tick record. Started
OpenRouter and TypeSafe attempts remain in the independent attempt ledger even
if the world does not commit.

Swarm ticks have their own safe telemetry rather than synthetic legacy agent
turn records. Full, all-agent exports include these records; the SQLite archive
stores them separately. No raw provider body, prompt, credential, private
reasoning, personality, chat, diplomacy, goal, or prose-memory operation
participates in the zero-swarm tick.

## Consequences

Agent Zero currently plans every tick. Persistent directives and event-driven
replanning are deferred to PR D. World Lab presentation changes are deferred
to PR C.
