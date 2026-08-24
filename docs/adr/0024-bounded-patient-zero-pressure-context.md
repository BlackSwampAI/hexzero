# ADR 0024: Bounded Patient Zero pressure context

## Status

Accepted for Slice D1.2.

## Decision

Every displayed current-interval Patient Zero cleaner event carries a compact
engine-authored six-tick pressure context for that event's affected or blocking
agent. The context reports window bounds, subject totals split by disinfection
and blocked clean, and consecutive affected ticks ending at the current tick.
When the subject is currently allied, it also reports the same totals across
the alliance's current members; unaffiliated subjects receive null alliance
counts. Current membership is used deliberately without reconstructing
historical membership.

Only authoritative `hex-disinfected` and `simulated-player-clean-blocked`
events inside the window count. Movement and older events never count. The
current event must be represented. Runtime schemas enforce arithmetic, window,
minimum/current-event, consecutive, and alliance pairing constraints. Legacy
D1.1 events may omit the additive context, while the live service always emits
it for nonempty feeds.

Patient Zero uses the rollup to distinguish isolated from sustained pressure.
A strategically meaningful first loss may justify a directive, while repeated
subject or current-alliance pressure strongly favors one new actionable
hold/reinforce/redundancy/reclaim/redirect recommendation. Equivalent recent
Zero advice suppresses repetition; communication is never mandatory.

## Consequences

The current-interval event cap, cleaner mechanics, observation audience,
provider count, decision contract, and SQLite schema do not change. Safe
observation JSON naturally retains nested context; custom redaction removes it
with the event. No broad historical feed or live cleaner location is introduced.
