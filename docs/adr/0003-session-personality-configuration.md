# ADR 0003: Server-owned session personality configuration

- Status: Accepted
- Date: 2026-08-14
- Status: Superseded by ADR 0033

## Context

The first focused PR 3 slice needs immediately editable agent personalities without changing authoritative game rules or losing simulation progress. Active configuration and the observation recorded for a completed turn can legitimately differ after an edit.

## Decision

The Game API's in-memory `SimulationService` owns the six active personality values. A narrow endpoint runtime-validates and updates one agent, and another restores all six development defaults. The browser updates only from validated server responses. Both mutations use the same overlap lock as turns and reset, so configuration cannot change while a provider is deciding from an observation.

World reset reconstructs the deterministic starting cells, open/infected state, empty histories, cursor, and completed-turn count while reapplying the six active personality values. Restoring defaults changes only personality values and preserves all world and turn progress. Completed turn records and their copied observations are never rewritten.

Editable personality text is bounded, untrusted, subordinate context inside the user observation. The fixed provider system instructions and world-engine validation remain authoritative; personality text cannot add actions or weaken rules.

## Consequences

The Personality Lab can compare behavior without coupling configuration experiments to world reset. A current personality may differ visibly from the latest historical observation until the selected agent acts again. Session configuration is lost on process restart.

Persistence, databases, cloning, deletion, respawning, starting-cell changes, provider/model configuration, API-key management, cost visibility, agent-authored personality mutation, and all messaging or social mechanics remain deferred.
