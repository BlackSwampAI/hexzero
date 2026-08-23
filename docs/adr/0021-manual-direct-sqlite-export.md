# ADR 0021: Manual direct SQLite export

- Status: Accepted
- Date: 2026-08-23

## Decision

World Lab offers **Save to SQLite** only after the operator explicitly generates
an export. Preview remains optional. Saving submits that exact schema-validated
document, and changed options make the artifact stale until regenerated.

The Game API runtime-validates one narrow request, lazily opens the configured
archive, delegates to `ArchiveDatabase` and `importExperimentExport`, and closes
the handle. Its bounded response contains the experiment ID, import counts, and
idempotency indicator. The browser cannot choose a path or provide SQL.

## Consequences

Direct saves inherit safe-field scanning, transactions, rollback, and stable
idempotency. Ordinary startup does not create an archive. The archive remains
downstream observability and cannot restore or mutate the active simulation.

## Boundaries

This adds no automatic persistence, scheduler, schema migration, export-version
change, MCP, arbitrary SQL/path, provider or prompt change, engine change, or
simulation recovery.
