# ADR 0018: Bounded agent goal state

- Status: Accepted
- Date: 2026-08-23

## Decision

The Game API owns one optional, bounded strategic goal for each active agent. A goal contains concise long-term, short-term, and plan summaries plus authoritative establishment and revision tick attribution. The model requests exactly one `establish`, `keep`, `revise`, `complete`, or `abandon` operation in the same flat response and inference as its ordinary decision.

Goal updates are independent of world-action, communication, and diplomacy validation. A semantically unavailable operation receives a stable safe rejection and preserves the prior goal without rejecting an otherwise valid world action. Simultaneous observations use the frozen pre-tick goal state; completed decisions commit deterministically with the tick. Cancellation, lost ticks, provider errors, and skipped turns commit no goal update.

The universal provider contract advances to `text-flat-json-v7`; v3 through v6 attribution remains readable. Prior goal text is untrusted observation data, never a system instruction. Safe schema-v10 records and exports may include requested revisions, results, and current goal state. Active goals remain process-local and reset with the experiment.

## Boundaries

Goals grant no engine authority, action, mechanical bonus, shared alliance ownership, or extra inference. This slice does not add compact or semantic memory, embeddings, relationship scores, shared alliance goals, restart persistence, background scheduling, simulated players, or player mechanics.

## Consequences

World Lab can inspect current goals and the latest operation result. The deterministic world engine remains unchanged. Historical exports remain importable, and the SQLite archive may ignore the additive goal fields until normalized goal analytics are deliberately designed.
