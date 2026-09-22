# ADR 0007: Decouple communication from world actions

- Status: Accepted
- Date: 2026-08-14
- Status: Superseded by ADR 0033

## Context

The first social slice modeled a nearby direct message as one of five mutually exclusive turn actions. That kept the initial authority boundary small, but it forced agents to choose between acting in the world and speaking. It also made action rejection, communication rejection, telemetry, and export semantics unnecessarily inseparable.

The next social slice needs agents to communicate while continuing to move, infect, capture, or wait, without increasing provider calls or adding an autonomous social scheduler. Public world chat is also needed alongside private proximity-bound direct messages.

## Decision

One provider inference returns one strict decision containing:

- one required `worldAction`: move, infect, capture, or wait;
- zero or one optional `communication`: public text, or direct text plus recipient ID; and
- one concise visible summary.

The simulation service captures the pre-action world state, applies the world action, and evaluates communication against that captured state. The world engine validates the two components independently. A rejected component cannot cancel an accepted component. Accepted events are appended in deterministic world-action-then-communication order and both results remain associated with the same turn and provider metadata. A wholly malformed provider response uses the existing provider-failure path and applies neither component.

Public messages have global visibility. Direct messages require a distinct existing recipient within inclusive H3 distance three at the start of the turn. Same-cell distance zero remains valid. Moving closer during the same decision does not make a direct message eligible.

The first decoupled version permits only one optional communication per inference. This keeps the structured output bounded, prevents message arrays from dominating prompts and telemetry, and preserves a clear one-decision/one-action/at-most-one-message audit record.

Observations expose chronological bounded context: the latest 12 public messages and latest six direct messages involving the acting agent. All message text is trimmed to 1–280 characters, treated as untrusted subordinate context, rendered as plain text, and excluded from higher-priority prompt construction.

Telemetry and schema-v4 exports record world-action and communication requests/results separately. Selected-agent public exports include only selected-authored public messages; direct exports include conversations where a selected agent is sender or recipient and exclude unrelated direct conversations.

## Consequences

- Agents can act and communicate with one provider call per turn.
- Public and direct communication have distinct visibility, metrics, UI, and export filtering.
- Independent rejection is explicit and auditable.
- Direct-message proximity cannot be bypassed by same-decision movement.
- Reset clears public/direct histories and metrics while preserving active personality configuration.
- Existing provider configuration and model selection remain provider-agnostic and unchanged.

## Deferred

Independent social ticks are deferred because they would add model calls, scheduling, retry, budget, and causal-ordering concerns before persistent autonomous operation exists. Automatic replies, background inference, multiple messages per decision, alliances, teams, trust scores, diplomacy mechanics, threads, groups, user chat, moderation, persistence, and communication cooldowns remain out of scope.
