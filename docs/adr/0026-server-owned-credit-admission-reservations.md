# ADR 0026: Server-owned credit admission reservations

## Status

Accepted.

## Decision

Active World Setup uses `execution-limits-v2`, adding an optional experiment
credit limit and a required positive per-attempt credit reservation. The Game
API atomically admits a simultaneous tick only when both provider-attempt and
reserved-credit capacity cover every initial call. Repairs and retries acquire
both capacities immediately before dispatch.

Starting a call converts its reservation into committed exposure. A known final
cost replaces that reservation, releasing any unused amount. An in-flight,
cancelled, or finalized unknown-cost call retains the full reservation because
provider work may already be billable. Unstarted reservations are released.
When reported cost exceeds its reservation, the actual cost is incorporated
and the overage is reported. Future admission stops when a credit ceiling is
enabled; unlimited-credit experiments retain the overage for visibility.

Decimal strings and integer arithmetic are authoritative at this boundary.
Catalog prices are estimates and cannot authoritatively predict routing,
reasoning, cache, retry, or final token charges. OpenRouter `max_price` filters
eligible unit prices; it is not a total request or account-spend cap and is not
used here.

## Consequences

This is a conservative server admission/exposure ceiling, not enforcement of
the upstream provider account balance or a guarantee that the provider bill
cannot exceed it. The operator must choose a reservation large enough for a
single call. With a credit ceiling enabled, a reservation overrun fails closed
for later calls but cannot undo an already-incurred charge.

Archived `execution-limits-v1` scenarios remain readable and do not silently
gain a monetary limit. Active setup emits only v2. O2b-2 will add the independent
started-attempt ledger to safe exports and SQLite; this decision changes only
live experiment accounting.
