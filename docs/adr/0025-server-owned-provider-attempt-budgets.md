# ADR 0025: Server-owned provider-attempt budgets

## Status

Accepted.

## Decision

Every applied World Setup carries `execution-limits-v1`. Its provider-attempt
limit defaults to 1,000, may be explicitly unlimited, and is enforced by the
Game API rather than by browser playback controls.

The Simulation Service keeps an experiment-scoped attempt ledger outside the
transactional world state. A simultaneous tick reserves one initial permit per
active agent before it advances the candidate player state or dispatches any
model request. Insufficient capacity rejects the whole tick. A reservation is
started only immediately before a real provider call; queued jobs that never
dispatch release their unused reservations. Automatic repairs and transport
retries acquire their own permits immediately before calling the provider.

Started attempts are finalized exactly once. Cancellation and world rollback
do not refund provider work. Safe provider usage contributes known cost;
missing cost is counted as unknown rather than zero. Model catalog and
compatibility probes are not experiment attempts. Reset and applying World
Setup create a new ledger; ordinary model, personality, and behavior changes
do not.

## Consequences

The browser cannot silently run beyond the configured attempt allowance, and
the operator can distinguish provider work from committed-turn metrics. ADR
0026 complements this with conservative credit admission reservations. Durable
attempt records and safe-export/SQLite ledger changes remain deferred to O2b-2.
