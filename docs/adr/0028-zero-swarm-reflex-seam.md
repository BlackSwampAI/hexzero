# ADR 0028: Zero-swarm reflex seam

## Status

Accepted for PR A. Two-stage production tick orchestration remains PR B.

## Decision

Scenarios carry `cognitionMode`, with `legacy-multi-agent` as the compatibility
default and `zero-swarm-v1` as the explicit experimental mode. Historical
scenario, snapshot, and export data without the field parse as legacy. The
current production tick keeps its legacy behavior; selecting zero-swarm for a
production tick fails explicitly until the Agent Zero planner exists.

The world engine exposes a pure enumeration of currently legal physical
actions. The Game API turns these into bounded, semantic descriptions with
opaque IDs, retains the ID-to-action map on the server, and projects only a
compact local observation. A `ReflexProvider` chooses one ID. The engine still
validates and resolves the mapped physical action. Directives convey intent
only and give neither Zero nor Jev mutation authority. The reflex path carries
no chat, diplomacy, personality, goal, or memory fields.

The TypeSafe adapter uses direct HTTP and pins `jev-1.13.0`. Its outbound
projection omits H3 IDs and tick numbers. It validates the response and rejects
IDs outside the offered candidate set. Calls obey an
absolute deadline and at most one retry for 429 or 529 within that deadline.
Worker request failure produces a deterministic wait decision. Operator
cancellation remains cancellation rather than an ordinary worker failure.

Each HTTP attempt, including one retry after 429 or 529, enters the server-owned
accounting ledger before dispatch and finalizes independently of world commit.
Safe bounded choice probabilities,
confidence, token counts, model, directive attribution, and cognition source
may be retained. TypeSafe usage does not provide an authoritative monetary
cost, so its attempt records leave actual cost unset. No request body, raw
response, credential, or private reasoning enters snapshots or exports.

## Consequences

The isolated reflex path can be tested through the real engine without
changing legacy tick behavior. PR B will connect the planner and all workers
to one atomic two-stage tick, including its cancellation and rollback rules.
