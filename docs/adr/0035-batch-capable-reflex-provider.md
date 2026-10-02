# ADR 0035: Batch-capable reflex execution

## Status

Proposed for the local PR 3 change.

## Context

Workers already observe one unchanged candidate world and resolve actions
together in seeded order. Awaiting each Jev call serially is not required for
world correctness or accounting. A future native batch endpoint needs stable
worker attribution and honest shared billing before it can replace individual
transport. This change supplies that seam; it adds no production batch provider.

## Decision

`ReflexProvider.decide` remains supported. Optional `decideBatch` accepts one
bounded group of observations and returns envelopes keyed by worker `agentId`.
The service compiles all observations and keeps each opaque-choice action map
before dispatch. The individual adapter uses an explicit integer cap from 1
through 8; `SimulationService.reflexConcurrencyLimit` defaults to 1. Production
Jev remains at that default. Changing its production cap is a separate rollout
decision, not a planner policy change.

For individual caps above 1, available retry capacity is reserved after Zero
planning and assigned to a fixed prefix of the worker input order. Each job
may consume one initial slot and at most one assigned retry slot. Slots are
never reassigned during the tick, so scarce admission capacity cannot be won
by the fastest response. The anonymous reservation counter holds enough slots
for every unstarted initial even if eligible retries start first. Cap 1 retains
the existing sequential retry admission policy. Unused retry slots are released.

Results are validated against each worker's own directive and action table.
Out-of-order envelopes are mapped by ID. Unknown workers are ignored; missing,
malformed, or failed items produce an attributed deterministic wait only for
that worker. Duplicate IDs invalidate that worker even if one duplicate is
valid. A transport failure affects the dispatched group. No result may select
another worker's candidates. The engine resolves choices in the existing seeded
order, independently of provider completion order.

Response arrays are bounded at 64 envelopes. Non-array or oversized responses
fail the dispatched group safely; the per-worker isolation policy applies
within that bound. Concurrent individual selection with accounting requires
initial permits reserved for every input before retry slots are earmarked.

Cancellation and the absolute tick deadline stop dispatch, settle pending
selection promptly even if a provider ignores abort, and close started attempts
once. Unstarted reservations are released without attempt records. Late
results, retries, or finalization callbacks cannot mutate the world or rewrite
closed accounting. Deadline expiry rolls back the tick; a provider failure
before the deadline retains the existing worker fallback policy. Failed Zero
planning still reuses eligible directives and uses deterministic local expansion
without a reflex call for workers with no reusable directive.

One native batch HTTP dispatch consumes one permit and records one charge.
`ProviderAttemptRecord.batch` holds a batch ID and ordered worker/turn members;
retries share the batch ID but receive separate dispatch records. Required
`agentId` and `intendedTurnNumber` fields are the first member's storage anchor,
not individual billing attribution. The batch record carries aggregate reported
usage and cost exactly once; individual tick decisions omit token counts when
item usage is unknown. Batch transport completion does not claim that every
worker result was valid. Individual outcomes remain in worker tick records.

Exports advance to schema 14 because attempt scope and optional worker usage
change meaning. A selected-worker export includes a participating shared batch
with its full membership and full shared charge. Aggregate metrics count it
once; per-agent cost/usage metrics exclude shared batches. Archive records keep
membership in the source JSON and per-agent cost summaries exclude shared
charges. Earlier export versions require an older Git revision.

## Consequences

Jev needs no batch endpoint, and existing individual providers remain compatible.
Tests use deferred promises and fake clocks, not latency comparisons or paid
providers. Provider output remains untrusted schema-validated data. Credentials,
raw bodies, prompts, and private reasoning remain outside telemetry. The
deterministic engine, strategic options, planning cadence, and player behavior
are unchanged.
