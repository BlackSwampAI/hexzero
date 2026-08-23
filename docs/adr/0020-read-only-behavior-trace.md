# ADR 0020: Read-only agent Behavior Trace

- Status: Accepted
- Date: 2026-08-23

## Decision

World Lab displays a bounded Behavior Trace for the selected agent from the six newest retained per-agent `AgentTurnRecord` values. When available, derivation also reads the immediately preceding retained record for that agent solely as the comparison baseline for the oldest displayed record; the baseline is not displayed as a seventh trace record. Each displayed record places consecutive observation changes, newly retained communication and board evidence, legal world-action affordances, the chosen action and direction, repeated or changed action patterns, component outcomes, and goal/memory continuity in one navigable view.

The derivation runs entirely in the browser over already validated snapshot data. It changes no prompt, provider response, API schema, engine rule, simulation state, telemetry retention, or export document. Existing map selection may highlight an observed, chosen, or evidence cell without changing the active inspector or making a server request.

Model-authored summaries are labeled as self-reported context, not proof that a message or board event caused a decision. The trace shows correlation and available evidence only. Agent-authored message, goal, memory, and summary text remains untrusted and is rendered as ordinary escaped text.

## Boundaries

This slice does not add causal scoring, semantic classification, extra inference, prompt changes, communication suppression, experiment orchestration, simulated players, player mechanics, new world events, persistent UI state, or longer server retention.

## Consequences

Operators can inspect whether behavior changes after visible evidence before a player simulator introduces new authority. The long Agent inspector gains compact section navigation, and focused tests can verify derivation and highlighting deterministically without provider or map-network access.
