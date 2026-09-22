# ADR 0030: Zero-swarm World Lab presentation

## Status

Accepted for PR C.

Superseded by ADR 0033 for its dual-mode (`cognitionMode`) presentation and
legacy agent/chat/diplomacy/personality/goal/memory views; World Lab now
presents only the zero-swarm view.

## Decision

World Lab selects its presentation from the scenario's explicit
`cognitionMode`. Legacy experiments keep the existing agent, chat, diplomacy,
personality, goal, and memory views. In `zero-swarm-v1`, the operator sees the
latest Agent Zero strategy, each worker's current directive and physical
action, Jev confidence and probability distribution, recent worker progress,
and provider usage. The swarm view reads committed `swarmTicks`, including
safe semantic worker situation buckets, and factual attempt accounting from
the Game API. It does not derive or display legacy turn metrics as swarm
outcomes.

The Agents workspace remains available for the designated Zero model.
Personality and strategy personality controls, worker generative model
assignments, chat, diplomacy, alliances, individual goals, and prose memories
are absent from the zero-swarm presentation. World Setup retains mode
selection while hiding irrelevant behavior assignment controls when the
selected mode is zero-swarm.

The snapshot exposes server-only provider availability as configured booleans,
adapter names, and the pinned reflex model name. It never exposes keys or raw
provider payloads. Missing provider credentials are visible to the operator;
they do not block a deterministic fallback tick. Zero's generative model is
the only model assignment required for zero-swarm readiness.

Swarm exports use the existing full-safe archive schema so retained swarm ticks
and provider attempts remain available for comparisons. That schema also
retains legacy configuration fields for compatibility; World Lab labels this
explicitly and does not use those fields to drive swarm execution.

## Consequences

The World Lab remains one production developer/admin surface with one
execution controller. The zero-swarm view is read-only telemetry; it grants
neither models nor the browser world mutation authority. Persistent directives
and event-driven replanning remain PR D.
