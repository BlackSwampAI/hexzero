import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  experimentExportDocumentSchema,
  type ExperimentExportDocument,
} from '@hexzero/shared';

import {
  ArchiveDatabase,
  ArchivePersistenceError,
  archiveInvocationRoot,
} from './database.js';

export interface ImportReport {
  experimentId: string;
  sourceSha256: string;
  inserted: number;
  existing: number;
  skipped: number;
  rejected: number;
}

export class ExperimentImportError extends Error {
  readonly report: Omit<ImportReport, 'experimentId' | 'sourceSha256'>;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExperimentImportError';
    this.report = { inserted: 0, existing: 0, skipped: 0, rejected: 1 };
  }
}

const prohibitedKey =
  /^(authorization|cookie|api[-_]?key|secret|password|raw[-_]?(reasoning|response|request)|chain[-_]?of[-_]?thought|private[-_]?reasoning)$/i;
const credentialValue = /\b(?:sk-or-v1|sk-proj|Bearer\s+[A-Za-z0-9._~-]{16,})/i;

export function assertSafeArchiveValue(value: unknown, path = '$'): void {
  if (typeof value === 'string' && credentialValue.test(value))
    throw new ExperimentImportError(
      `Credential-like content is prohibited at ${path}.`,
    );
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeArchiveValue(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (prohibitedKey.test(key))
      throw new ExperimentImportError(
        `Prohibited private or credential field at ${path}.${key}.`,
      );
    assertSafeArchiveValue(entry, `${path}.${key}`);
  }
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function stableId(...parts: readonly unknown[]): string {
  return createHash('sha256')
    .update(parts.map((part) => String(part)).join('\u001f'))
    .digest('hex');
}

function readExport(input: string | ExperimentExportDocument): {
  document: ExperimentExportDocument;
  sourceText: string;
  sourcePath: string;
} {
  try {
    if (typeof input !== 'string') {
      assertSafeArchiveValue(input);
      const document = experimentExportDocumentSchema.parse(input);
      return {
        document,
        sourceText: JSON.stringify(input),
        sourcePath: '<memory>',
      };
    }
    const sourcePath = resolve(archiveInvocationRoot(), input);
    const sourceText = readFileSync(sourcePath, 'utf8');
    const parsed: unknown = JSON.parse(sourceText);
    assertSafeArchiveValue(parsed);
    const document = experimentExportDocumentSchema.parse(parsed);
    return { document, sourceText, sourcePath };
  } catch (error) {
    if (error instanceof ExperimentImportError) throw error;
    throw new ExperimentImportError(
      `Export validation failed${typeof input === 'string' ? ` for ${input}` : ''}; nothing was imported.`,
      error,
    );
  }
}

function runInsert(
  statement: ReturnType<ArchiveDatabase['database']['prepare']>,
  values: readonly (string | number | null)[],
  report: ImportReport,
): void {
  const result = statement.run(...values);
  if (result.changes > 0) report.inserted += 1;
  else report.existing += 1;
}

export function importExperimentExport(
  archive: ArchiveDatabase,
  input: string | ExperimentExportDocument,
): ImportReport {
  // Parse the entire document and inspect it for prohibited data before BEGIN.
  const { document, sourceText, sourcePath } = readExport(input);
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex');
  const experimentId = document.experiment.id;
  const report: ImportReport = {
    experimentId,
    sourceSha256,
    inserted: 0,
    existing: 0,
    skipped: 0,
    rejected: 0,
  };

  try {
    return archive.transaction(() => {
      const db = archive.database;
      const alreadyImported = db
        .prepare('SELECT 1 AS found FROM source_exports WHERE sha256 = ?')
        .get(sourceSha256);
      if (alreadyImported) {
        report.existing += 1;
        return report;
      }

      const scenario = document.experiment.scenario;
      const experimentInsert = db.prepare(`
        INSERT OR IGNORE INTO experiments(
          id, schema_version, started_at, provider_mode, imported_at,
          scenario_json, model_configuration_json,
          objective_version, decision_contract_version, observation_contract_version,
          retention_limit, total_completed_turns, retained_turns,
          first_retained_turn, last_retained_turn, dropped_records,
          retention_complete, requested_range_extends_beyond_retention,
          source_metrics_json, source_territory_json,
          metric_inconsistencies_json, attempt_retention_json, attempt_accounting_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      runInsert(
        experimentInsert,
        [
          experimentId,
          document.schemaVersion,
          document.experiment.startedAt,
          document.experiment.providerMode,
          archive.clock().toISOString(),
          json(scenario),
          json(document.experiment.modelConfiguration),
          scenario?.objectiveVersion ?? null,
          document.experiment.swarmPlannerContractVersion,
          `experiment-export-schema-v${document.schemaVersion}`,
          document.retention.limit,
          document.retention.totalCompletedTurns,
          document.retention.retainedTurns,
          document.retention.firstRetainedTurn ?? null,
          document.retention.lastRetainedTurn ?? null,
          document.retention.droppedRecords,
          Number(document.retention.complete),
          Number(document.retention.requestedRangeExtendsBeyondRetention),
          json(document.metrics),
          json(document.currentTerritory),
          json([])!,
          json(document.attemptRetention),
          json(document.attemptAccounting),
        ],
        report,
      );

      // A later, broader export may fill immutable source metadata omitted by an earlier filtered export.
      db.prepare(
        `
        UPDATE experiments SET
          schema_version = MAX(schema_version, ?),
          observation_contract_version = CASE
            WHEN schema_version < ? THEN ?
            ELSE observation_contract_version
          END,
          scenario_json = COALESCE(scenario_json, ?),
          model_configuration_json = COALESCE(model_configuration_json, ?),
          objective_version = COALESCE(objective_version, ?),
          source_metrics_json = COALESCE(?, source_metrics_json),
          source_territory_json = COALESCE(?, source_territory_json),
          simulated_player_metrics_json = COALESCE(?, simulated_player_metrics_json),
          attempt_retention_json = CASE
            WHEN ? IS NULL THEN attempt_retention_json
            WHEN attempt_retention_json IS NULL
              OR json_extract(?, '$.totalStartedAttempts') > json_extract(attempt_retention_json, '$.totalStartedAttempts')
              OR (json_extract(?, '$.totalStartedAttempts') = json_extract(attempt_retention_json, '$.totalStartedAttempts')
                  AND json_extract(?, '$.retainedAttempts') >= json_extract(attempt_retention_json, '$.retainedAttempts'))
            THEN ? ELSE attempt_retention_json END,
          attempt_accounting_json = CASE
            WHEN ? IS NULL THEN attempt_accounting_json
            WHEN attempt_accounting_json IS NULL
              OR json_extract(?, '$.attemptsStarted') > json_extract(attempt_accounting_json, '$.attemptsStarted')
              OR (json_extract(?, '$.attemptsStarted') = json_extract(attempt_accounting_json, '$.attemptsStarted')
                  AND json_extract(?, '$.attemptsFinalized') >= json_extract(attempt_accounting_json, '$.attemptsFinalized'))
            THEN ? ELSE attempt_accounting_json END,
          retention_limit = MAX(retention_limit, ?),
          total_completed_turns = MAX(total_completed_turns, ?),
          retained_turns = MAX(retained_turns, ?),
          dropped_records = MAX(dropped_records, ?),
          retention_complete = retention_complete AND ?,
          requested_range_extends_beyond_retention = requested_range_extends_beyond_retention OR ?
        WHERE id = ?
      `,
      ).run(
        document.schemaVersion,
        document.schemaVersion,
        `experiment-export-schema-v${document.schemaVersion}`,
        json(scenario),
        json(document.experiment.modelConfiguration),
        scenario?.objectiveVersion ?? null,
        json(document.metrics),
        json(document.currentTerritory),
        json(document.simulatedPlayerMetrics),
        json(document.attemptRetention),
        json(document.attemptRetention),
        json(document.attemptRetention),
        json(document.attemptRetention),
        json(document.attemptRetention),
        json(document.attemptAccounting),
        json(document.attemptAccounting),
        json(document.attemptAccounting),
        json(document.attemptAccounting),
        json(document.attemptAccounting),
        document.retention.limit,
        document.retention.totalCompletedTurns,
        document.retention.retainedTurns,
        document.retention.droppedRecords,
        Number(document.retention.complete),
        Number(document.retention.requestedRangeExtendsBeyondRetention),
        experimentId,
      );

      const sourceInsert = db.prepare(`
        INSERT INTO source_exports(
          sha256, experiment_id, source_path, generated_at, imported_at,
          filters_json, selection_json, source_metrics_json, retention_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      runInsert(
        sourceInsert,
        [
          sourceSha256,
          experimentId,
          sourcePath,
          document.generatedAt,
          archive.clock().toISOString(),
          json(document.filters)!,
          json(document.selection)!,
          json(document.metrics),
          json(document.retention)!,
        ],
        report,
      );

      importAgents(archive, document, report);
      importMap(archive, document, report);
      importSwarmTicks(archive, document, report);
      importProviderAttempts(archive, document, report);
      importWorldEvents(archive, document, report);
      importSimulatedPlayerActivity(archive, document, report);
      importConfigurationEvents(archive, document, report);
      return report;
    });
  } catch (error) {
    if (error instanceof ExperimentImportError) throw error;
    if (error instanceof ArchivePersistenceError)
      throw new ExperimentImportError(
        `Archive persistence failed for experiment ${experimentId}; the import was rolled back.`,
        error,
      );
    throw error;
  }
}

function importSwarmTicks(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO swarm_ticks(
      experiment_id, tick_number, virtual_time, plan_source, source_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const tick of document.swarmTicks ?? [])
    runInsert(
      statement,
      [
        document.experiment.id,
        tick.tickNumber,
        tick.virtualTime,
        tick.planSource,
        json(tick)!,
      ],
      report,
    );
}

function importAgents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO agents(
      experiment_id, agent_id, name, color, model_id, reasoning_profile,
      is_patient_zero, initial_agent_json, current_agent_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const models = document.experiment.modelConfiguration;
  const initial = new Map(
    document.experiment.initialAgents?.map((agent) => [agent.id, agent]),
  );
  const current = new Map(
    document.currentWorld?.agents.map((agent) => [agent.id, agent]),
  );
  const profiles = new Map<
    ExperimentExportDocument['agents'][number]['id'],
    {
      id: ExperimentExportDocument['agents'][number]['id'];
      name: string;
      color: string;
      currentCell?: string;
    }
  >();
  document.experiment.scenario?.roster.forEach((agent, index) =>
    profiles.set(agent.id, {
      ...agent,
      currentCell: document.experiment.scenario?.startingCells[index],
    }),
  );
  for (const agent of document.agents)
    profiles.set(agent.id, { ...(profiles.get(agent.id) ?? {}), ...agent });
  for (const agent of profiles.values()) {
    const override = models?.overrides.find(
      ({ agentId }) => agentId === agent.id,
    );
    runInsert(
      statement,
      [
        document.experiment.id,
        agent.id,
        agent.name,
        agent.color,
        override?.modelId ?? models?.globalModelId ?? null,
        override?.reasoningProfile ?? models?.globalReasoningProfile ?? null,
        Number(document.experiment.scenario?.patientZeroAgentId === agent.id),
        json(initial.get(agent.id)),
        json(current.get(agent.id)),
      ],
      report,
    );
  }
}

function importMap(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const initial = new Map(
    document.initialWorld?.hexes.map((hex) => [hex.cell, hex]),
  );
  const current = new Map(
    document.currentWorld?.hexes.map((hex) => [hex.cell, hex]),
  );
  const ids = [...new Set([...initial.keys(), ...current.keys()])];
  if (ids.length === 0) {
    report.skipped += 1;
    return;
  }
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO map_cells(
      experiment_id, cell_id, ordinal, initial_state, initial_controller_agent_id,
      current_state, current_controller_agent_id, initial_json, current_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  ids.forEach((cellId, ordinal) => {
    const before = initial.get(cellId);
    const after = current.get(cellId);
    runInsert(
      statement,
      [
        document.experiment.id,
        cellId,
        ordinal,
        before?.state ?? null,
        before?.state === 'infected' ? before.controllerAgentId : null,
        after?.state ?? null,
        after?.state === 'infected' ? after.controllerAgentId : null,
        json(before),
        json(after),
      ],
      report,
    );
  });
}

function importProviderAttempts(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  if (document.schemaVersion !== 11) return;
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO provider_attempts(
      id, experiment_id, agent_id, intended_turn_number, intended_tick_number,
      kind, started_at, completed_at, outcome, model_id, reasoning_profile,
      provider, failure_code, failure_message, validation_codes_json,
      latency_ms, prompt_tokens, completion_tokens, total_tokens,
      reasoning_tokens, cached_read_tokens, cache_write_tokens,
      reserved_credits, actual_cost_credits, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      completed_at = excluded.completed_at,
      outcome = excluded.outcome,
      provider = excluded.provider,
      failure_code = excluded.failure_code,
      failure_message = excluded.failure_message,
      validation_codes_json = excluded.validation_codes_json,
      latency_ms = excluded.latency_ms,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      total_tokens = excluded.total_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      cached_read_tokens = excluded.cached_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      actual_cost_credits = excluded.actual_cost_credits,
      source_json = excluded.source_json
    WHERE provider_attempts.outcome = 'in-flight'
      AND excluded.outcome <> 'in-flight'
  `);
  for (const attempt of document.providerAttempts ?? []) {
    const provider = attempt.provider;
    runInsert(
      statement,
      [
        attempt.id,
        document.experiment.id,
        attempt.agentId,
        attempt.intendedTurnNumber,
        attempt.intendedTickNumber ?? null,
        attempt.kind,
        attempt.startedAt,
        attempt.completedAt ?? null,
        attempt.outcome,
        attempt.modelId,
        attempt.reasoningProfile,
        provider?.provider ?? null,
        attempt.failure?.code ?? null,
        attempt.failure?.message ?? null,
        json(attempt.failure?.validationCodes),
        provider?.latencyMs ?? attempt.failure?.latencyMs ?? null,
        provider?.promptTokens ?? null,
        provider?.completionTokens ?? null,
        provider?.totalTokens ?? null,
        provider?.reasoningTokens ?? null,
        provider?.cachedReadTokens ?? null,
        provider?.cacheWriteTokens ?? null,
        attempt.reservedCredits,
        attempt.actualCostCredits ?? null,
        json(attempt)!,
      ],
      report,
    );
  }
}

/**
 * Agent-caused world events (movement, infection, capture, waiting) are
 * attributed to the swarm tick that produced them. Zero's own action and
 * each worker's action can both yield an event; control changes carry their
 * own originating-tick number and are folded in for good measure.
 */
function importWorldEvents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO world_events(
      id, experiment_id, tick_number, occurred_at, agent_id, type,
      cell_id, previous_controller_agent_id, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const events = new Map<
    string,
    {
      event: Extract<
        NonNullable<ExperimentExportDocument['worldEvents']>[number],
        { agentId: unknown }
      >;
      tick: number;
    }
  >();
  for (const tick of document.swarmTicks ?? []) {
    const zeroEvent = tick.zeroActionResult;
    if (zeroEvent?.accepted && 'agentId' in zeroEvent.event)
      events.set(zeroEvent.event.id, {
        event: zeroEvent.event,
        tick: tick.tickNumber,
      });
    for (const worker of tick.workers) {
      const result = worker.actionResult;
      if (result?.accepted && 'agentId' in result.event)
        events.set(result.event.id, {
          event: result.event,
          tick: tick.tickNumber,
        });
    }
  }
  for (const change of document.controlChanges ?? [])
    events.set(change.id, { event: change, tick: change.originatingTurn });
  for (const { event, tick } of events.values())
    runInsert(
      statement,
      [
        event.id,
        document.experiment.id,
        tick,
        event.occurredAt,
        event.agentId,
        event.type,
        'cell' in event ? event.cell : null,
        'previousControllerAgentId' in event
          ? event.previousControllerAgentId
          : null,
        json(event)!,
      ],
      report,
    );
}

function importSimulatedPlayerActivity(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO simulated_player_activity(
      id, experiment_id, tick_number, occurred_at, profile, type,
      from_cell_id, to_cell_id, cell_id, previous_controller_agent_id,
      blocking_agent_id, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of document.worldEvents ?? []) {
    if (!('profile' in event) || !('originatingTick' in event)) continue;
    runInsert(
      statement,
      [
        event.id,
        document.experiment.id,
        event.originatingTick,
        event.occurredAt,
        event.profile,
        event.type,
        'fromCell' in event ? event.fromCell : null,
        'toCell' in event ? event.toCell : null,
        'cell' in event ? event.cell : null,
        'previousControllerAgentId' in event
          ? event.previousControllerAgentId
          : null,
        'blockingAgentId' in event ? event.blockingAgentId : null,
        json(event)!,
      ],
      report,
    );
  }
}

function importConfigurationEvents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO configuration_events(
      id, experiment_id, occurred_at, type, agent_id, effective_turn, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of document.configurationEvents ?? []) {
    const id = stableId(
      document.experiment.id,
      event.type,
      event.timestamp,
      event.agentId ?? '',
      json(event),
    );
    runInsert(
      statement,
      [
        id,
        document.experiment.id,
        event.timestamp,
        event.type,
        event.agentId ?? null,
        event.effectiveTurn,
        json(event)!,
      ],
      report,
    );
  }
}
