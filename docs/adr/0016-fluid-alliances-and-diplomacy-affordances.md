# ADR 0016: Fluid alliances and authoritative diplomacy affordances

## Status

Accepted. This supersedes ADR 0008's fixed eight-member and four-active-alliance
limits while preserving its ownership, privacy, and telemetry decisions.

Superseded by ADR 0033.

## Context

The former eight-member cap had no gameplay justification, and requiring a
unique entry from a four-color display palette accidentally made presentation a
world-engine capacity rule. Models were also asked to infer proposal legality
from prose and partial observations even though range, membership, proposal
state, and simultaneous resolution are deterministic engine concerns.

## Decision

An alliance may contain the entire active roster. Active state supports every
feasible roster partition, retains one alliance per agent, and assigns or reuses
deterministic accessible display colors without making color uniqueness a rule.

A free agent may propose to another free agent or request to join an allied
recipient's existing alliance. An allied agent may invite a free recipient.
Acceptance admits the unaffiliated participant to the recorded unchanged
alliance. Alliance-to-alliance merging remains invalid. Leaving is unilateral,
and a former member may later join or request another alliance.

Every ordinary frozen observation carries exact legal proposal target IDs,
acceptable proposal IDs, leave availability, and compact bounded blocker data.
Patient Zero's per-agent feasibility shape is superseded by ADR 0017's fixed-cap
sparse coordinator summary. It receives no private reasoning, pending
decisions, future same-tick actions, or unbounded pair matrix and may recommend
only displayed eligible IDs. Resolution remains authoritative and may reject an
intent when an earlier deterministic same-tick intent changes membership or
proposal state.

Formal proposal creation uses the scenario `communicationRangeKm` and frozen
pre-action positions. Patient Zero's direct-message range bypass does not apply
to formal diplomacy.

The provider still receives one prompt and returns one flat structured response.
No provider tool call is added: tools would require another boundary and token
payload to retrieve facts already deterministically available before the call.
This rationale does not claim measured token savings.

The immutable prompt and observation guidance advance to
`text-flat-json-v5`, superseding v4 prompt treatment while preserving its
selective-communication policy and unchanged flat wire fields.

## Compatibility and deferrals

The existing flat wire fields, decision-contract v3/v4 compatibility, export
schema v9/v10, archived records, and legacy proposals remain readable. The new
nested recipient-alliance attribution defaults safely for old proposals.

Leadership, voting, kicking, ranks, custom alliance metadata, and
alliance-to-alliance merging remain deferred.
