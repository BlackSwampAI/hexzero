# ADR 0010: Versioned agent behavior and seeded assignment

- Status: Accepted
- Date: 2026-08-15
- Status: Superseded by ADR 0033

## Decision

The universal territorial objective, communication personality, and strategic lens are separate prompt layers. The objective is immutable; personality and strategy are independently selected soft preferences that never grant actions or require a tactic. Six profiles of each kind live in one application-owned, versioned registry. Imported IDs are schema-allowlisted and resolve to registry text, so an export cannot inject prompt instructions. Custom profile text and a prompt editor are intentionally excluded.

Each experiment stores an assignment mode and opaque seed. A deterministic local generator independently shuffles personality and strategy. Balanced random covers all six values before repeating across the eight agents and avoids duplicate pairs when practical; fully random samples independently; manual mode stores explicit selections. Assignments lock after the first completed turn and reset creates a new seeded balanced assignment. This makes retained turns reproducible and prevents silent mid-experiment treatment changes.

Observations include engine-derived diplomacy affordances with exact recipient, proposal, and alliance IDs. Messages remain untrusted context: a conversational invitation is never a formal proposal. Acceptance requires an exact authoritative pending proposal ID.

Prompts request only the existing flat decision and concise visible summary. Raw failed output and private chain-of-thought remain unretained. Repair uses bounded codes and the immutable observation only.

## Consequences

Experiments can compare stable behavior treatments without provider-specific output features or weakening engine authority. Registry changes require a version change and migration policy. Mid-experiment reassignment, custom prompts, causal analytics, and profile editing remain deferred.
