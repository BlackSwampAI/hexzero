# ADR 0021: Manual direct SQLite export

- Status: Accepted
- Date: 2026-08-23

## Decision

World Lab offers **Save to SQLite** only after the operator explicitly generates
an export. Preview remains optional. Saving submits a compact request containing
the export filters, generation timestamp, and SHA-256 digest. The Game API
deterministically regenerates the schema-validated document and archives it only
when its digest matches the exact browser-generated artifact. Changed options or
experiment state make the artifact stale until regenerated.

The Game API runtime-validates one narrow request, lazily opens the configured
archive, delegates to `ArchiveDatabase` and `importExperimentExport`, and closes
the handle. Its bounded response contains the experiment ID, import counts, and
idempotency indicator. The browser cannot choose a path or provide SQL.
The compact request stays below the framework proxy's bounded request-body
limit even when the generated Full Safe artifact is large.

## Consequences

Direct saves inherit safe-field scanning, transactions, rollback, and stable
idempotency. Ordinary startup does not create an archive. The archive remains
downstream observability and cannot restore or mutate the active simulation.

## Boundaries

This adds no automatic persistence, scheduler, schema migration, export-version
change, MCP, arbitrary SQL/path, provider or prompt change, engine change, or
simulation recovery.
