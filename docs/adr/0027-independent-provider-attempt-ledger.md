# ADR 0027: Independent safe provider-attempt ledger

## Status

Accepted

## Decision

Schema-v11 experiment exports include a bounded, independent record for every
started provider call. A record is created before dispatch and finalized once
as completed, provider-error, cancelled, or timeout. It survives tick rollback
and is not derived from committed turns. The safe record contains attribution,
timing, sanitized provider usage/failure data, and canonical decimal-string
reservation and actual-cost values. It never contains prompts, raw responses,
headers, credentials, or private reasoning.

The in-memory ledger retains twice the configured experiment turn-retention
limit, accounting for the initial call plus one bounded automatic recovery per
turn. Its retention summary discloses total, retained, and dropped records.
Applying or resetting a scenario starts a new experiment and clears the ledger.

Archive schema v4 stores these records in `provider_attempts`, independently of
turn foreign keys. For v11, usage queries use this table as canonical and do not
add legacy `turn.modelAttempts`. Schema-v9 and v10 imports retain their existing
legacy behavior.

## Consequences

Cancelled and otherwise uncommitted paid work remains auditable, including a
zero-turn experiment. Repeated exports add attempt UUIDs idempotently. The
archive remains an analysis archive, not runtime persistence or crash recovery.
