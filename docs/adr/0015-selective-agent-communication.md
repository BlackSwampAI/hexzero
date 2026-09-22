# ADR 0015: Selective agent communication

## Status

Accepted for the simultaneous-tick experiment foundation.

Superseded by ADR 0033.

## Context

The v3 flat decision contract allowed optional communication but did not give
all agents a sufficiently explicit standard for when silence is preferable.
Routine action narration and generic encouragement add volume without adding
decision-relevant information, especially when every active agent decides once
per tick. Patient Zero's specialized guidance alone did not establish a
universal policy.

## Decision

Advance the prompt and decision-contract attribution to
`text-flat-json-v4`. For ordinary agents and Patient Zero,
`communicationType: "none"` is the normal/default choice unless a message adds
new decision-relevant value. Useful messages include concrete requests or
replies, negotiation, warnings grounded in observed facts, materially changed
plans, border or conflict coordination, and coordinated targets or routes.

Agents must not narrate routine move, infect, capture, or wait actions; send
motivational filler; restate observations or decision summaries; or repeat an
unchanged plan without a response or material state change. Communication that
accompanies formal diplomacy adds terms or context rather than duplicating the
formal intent. When communication is useful, it remains concise and retains the
assigned personality and style.

The flat JSON fields, parsing, communication channels, range and visibility,
engine validation, trust/privacy rules, and Patient Zero authority do not
change. New scenarios, exports, and verification probes attribute v4. Schemas
continue to accept and preserve v3 attribution for legacy experiments and
archive imports. Schema v10 and `durable-influence-v2` do not change.

## Evaluation

Evaluate the policy with a same-model, same-scenario 10-tick comparison. Fewer
than 40 messages across 80 decisions and near-zero routine action narration are
useful diagnostic targets. They are not deterministic release gates and do not
constitute a claim of real-model compliance; deterministic tests cover only the
policy text, attribution, unchanged parsing, and v3 compatibility.

## Deferrals

This decision does not add engine cooldowns or rate limits, semantic content
classification or rejection, history-window reductions, UI/configuration
controls, channel/range/visibility changes, or tick-causality analytics work.
