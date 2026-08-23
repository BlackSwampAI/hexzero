# ADR 0019: Bounded agent compact memory

- Status: Accepted
- Date: 2026-08-23

## Decision

The Game API owns one process-local memory ledger per active agent, capped at eight canonical entries. Each entry contains a server-issued stable ID, bounded self-authored text, and authoritative creation and revision tick attribution. In the same single flat provider response as the ordinary decision, each completed agent requests exactly one `keep`, `remember`, `revise`, or `forget` operation.

Memory validation is independent from world action, communication, diplomacy, and goal validation. Capacity and missing-ID failures use stable safe codes, preserve the prior ledger, and do not reject sibling components. Simultaneous observations use frozen pre-tick ledgers and commit completed operations atomically with the tick. Cancellation, lost ticks, provider errors, and skipped turns commit no memory mutation.

The provider contract advances to `text-flat-json-v8`, while v3 through v7 attribution remains readable. Memory text is untrusted subordinate observation data, never authoritative world fact or higher-priority instruction. Schema-v10 records and exports may include memory requests, results, and current ledgers. Reset and new scenarios clear memory; configuration changes preserve it; process restart loses it.

## Exclusions

This decision does not add semantic or vector memory, embeddings, retrieval or ranking, relationship or trust scores, shared or alliance memory, restart persistence, database restoration, scheduling, extra inference, raw prompts, provider payloads, private chain-of-thought, or player mechanics.

## Consequences

World Lab exposes a read-only ledger and latest operation result. The deterministic world engine remains unchanged. The experiment archive accepts additive safe fields but does not yet normalize memory analytics or restore active state.
