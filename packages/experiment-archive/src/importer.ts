import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  experimentExportDocumentSchema,
  exportedCommunicationSchema,
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

function sourceMetricInconsistencies(document: ExperimentExportDocument) {
  const metrics = document.metrics;
  if (!metrics) return [];
  const perAgent = metrics.byAgent.reduce(
    (sum, entry) => sum + entry.metrics.directionChangesAfterCommunication,
    0,
  );
  return metrics.aggregate.directionChangesAfterCommunication === perAgent
    ? []
    : [
        {
          metric: 'directionChangesAfterCommunication',
          aggregate: metrics.aggregate.directionChangesAfterCommunication,
          perAgentSum: perAgent,
          canonical:
            'sum of per-agent chronological direction changes after an observed inbound direct or alliance communication since that agent previous move',
        },
      ];
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
          scenario_json, model_configuration_json, behavior_configuration_json,
          objective_version, decision_contract_version, observation_contract_version,
          retention_limit, total_completed_turns, retained_turns,
          first_retained_turn, last_retained_turn, dropped_records,
          retention_complete, requested_range_extends_beyond_retention,
          source_metrics_json, source_territory_json, source_alliances_json,
          metric_inconsistencies_json
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
          json(document.experiment.behaviorConfiguration),
          scenario?.objectiveVersion ?? null,
          document.experiment.decisionContractVersion,
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
          json(document.currentAlliances),
          json(sourceMetricInconsistencies(document))!,
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
          behavior_configuration_json = COALESCE(behavior_configuration_json, ?),
          objective_version = COALESCE(objective_version, ?),
          source_metrics_json = COALESCE(?, source_metrics_json),
          source_territory_json = COALESCE(?, source_territory_json),
          source_alliances_json = COALESCE(?, source_alliances_json),
          simulated_player_metrics_json = COALESCE(?, simulated_player_metrics_json),
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
        json(document.experiment.behaviorConfiguration),
        scenario?.objectiveVersion ?? null,
        json(document.metrics),
        json(document.currentTerritory),
        json(document.currentAlliances),
        json(document.simulatedPlayerMetrics),
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
      importTurns(archive, document, report);
      importCommunications(archive, document, report);
      importAllianceEvents(archive, document, report);
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

function importAgents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO agents(
      experiment_id, agent_id, name, color, model_id, reasoning_profile,
      personality_id, strategy_id, personality, is_patient_zero,
      initial_agent_json, current_agent_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const behavior = new Map(
    document.experiment.behaviorConfiguration?.assignments.map((entry) => [
      entry.agentId,
      entry,
    ]),
  );
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
      personality?: string;
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
    const assignment = behavior.get(agent.id);
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
        assignment?.personalityId ?? null,
        assignment?.strategyId ?? null,
        agent.personality ?? initial.get(agent.id)?.personality ?? null,
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

function importTurns(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const movement = movementAttribution(document);
  const turnStatement = archive.database.prepare(`
    INSERT OR IGNORE INTO turns(
      id, experiment_id, turn_number, tick_number, tick_position,
      virtual_time, tick_interval_minutes, agent_id, started_at, completed_at,
      outcome, action, action_accepted, action_reason, summary,
      world_action_summary, communication_summary, diplomacy_summary,
      position_before, position_after, move_direction,
      inbound_communication_since_previous_move, model_id, reasoning_profile,
      personality_id, strategy_id, latency_ms, prompt_tokens,
      completion_tokens, total_tokens, reasoning_tokens, cached_read_tokens,
      cache_write_tokens, cost_credits, observation_size_bytes,
      observation_json, world_action_json, world_action_result_json,
      communication_result_json, diplomacy_result_json, failure_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const attemptStatement = archive.database.prepare(`
    INSERT OR IGNORE INTO model_attempts(
      id, turn_id, experiment_id, turn_number, agent_id, attempt_number,
      kind, started_at, completed_at, model_id, reasoning_profile, accepted,
      failure_code, failure_message, validation_codes_json, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, reasoning_tokens,
      cached_read_tokens, cache_write_tokens, cost_credits
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const diplomacyStatement = archive.database.prepare(`
    INSERT OR IGNORE INTO diplomacy_attempts(
      id, experiment_id, turn_number, agent_id, type, recipient_agent_id,
      proposal_id, accepted, rejection_reason, rejection_details, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const turn of document.turns) {
    const turnId = `${document.experiment.id}:turn:${turn.turnNumber}`;
    const result = turn.worldActionResult;
    const positionBefore = turn.observation?.currentCell?.cell ?? null;
    const positionAfter =
      result?.accepted && result.event.type === 'agent-moved'
        ? result.event.toCell
        : positionBefore;
    const provider = turn.provider;
    const lastAttempt = turn.modelAttempts.at(-1);
    const movementEntry = movement.get(turn.turnNumber);
    runInsert(
      turnStatement,
      [
        turnId,
        document.experiment.id,
        turn.turnNumber,
        turn.tickNumber ?? null,
        turn.tickPosition ?? null,
        turn.virtualTime ?? null,
        turn.tickIntervalMinutes ?? null,
        turn.agentId,
        turn.startedAt,
        turn.completedAt,
        turn.outcome,
        turn.worldAction?.type ?? null,
        result ? Number(result.accepted) : null,
        result && !result.accepted ? result.reason : null,
        turn.summary ?? null,
        turn.worldActionSummary ?? null,
        turn.communicationSummary ?? null,
        turn.diplomacySummary ?? null,
        positionBefore,
        positionAfter,
        movementEntry?.direction ?? null,
        movementEntry === undefined
          ? null
          : Number(movementEntry.inboundSincePreviousMove),
        provider?.model ?? lastAttempt?.modelId ?? null,
        lastAttempt?.reasoningProfile ?? null,
        turn.behavior?.personalityId ?? null,
        turn.behavior?.strategyId ?? null,
        provider?.latencyMs ?? null,
        provider?.promptTokens ?? null,
        provider?.completionTokens ?? null,
        provider?.totalTokens ?? null,
        provider?.reasoningTokens ?? null,
        provider?.cachedReadTokens ?? null,
        provider?.cacheWriteTokens ?? null,
        provider?.costCredits ?? null,
        turn.observation
          ? Buffer.byteLength(JSON.stringify(turn.observation))
          : null,
        json(turn.observation),
        json(turn.worldAction),
        json(turn.worldActionResult),
        json(turn.communicationResult),
        json(turn.diplomacyResult),
        json(turn.failure),
      ],
      report,
    );
    if (!turn.observation) report.skipped += 1;

    for (const attempt of turn.modelAttempts) {
      const attemptProvider = attempt.provider;
      runInsert(
        attemptStatement,
        [
          `${turnId}:attempt:${attempt.attemptNumber}`,
          turnId,
          document.experiment.id,
          turn.turnNumber,
          turn.agentId,
          attempt.attemptNumber,
          attempt.kind,
          attempt.startedAt,
          attempt.completedAt,
          attempt.modelId,
          attempt.reasoningProfile,
          Number(!attempt.failure),
          attempt.failure?.code ?? null,
          attempt.failure?.message ?? null,
          json(attempt.failure?.validationCodes),
          attemptProvider?.latencyMs ?? attempt.failure?.latencyMs ?? null,
          attemptProvider?.promptTokens ?? null,
          attemptProvider?.completionTokens ?? null,
          attemptProvider?.totalTokens ?? null,
          attemptProvider?.reasoningTokens ?? null,
          attemptProvider?.cachedReadTokens ?? null,
          attemptProvider?.cacheWriteTokens ?? null,
          attemptProvider?.costCredits ?? null,
        ],
        report,
      );
    }

    const diplomacy = turn.diplomacyResult;
    if (diplomacy?.requested) {
      const value = diplomacy.accepted ? diplomacy.intent : diplomacy.attempt;
      runInsert(
        diplomacyStatement,
        [
          `${turnId}:diplomacy`,
          document.experiment.id,
          turn.turnNumber,
          turn.agentId,
          value.type,
          'recipientId' in value ? (value.recipientId ?? null) : null,
          'proposalId' in value ? (value.proposalId ?? null) : null,
          Number(diplomacy.accepted),
          diplomacy.accepted ? null : diplomacy.reason,
          diplomacy.accepted ? null : diplomacy.details,
          json(diplomacy)!,
        ],
        report,
      );
    }
  }
}

function movementAttribution(document: ExperimentExportDocument) {
  const result = new Map<
    number,
    { direction: string; inboundSincePreviousMove: boolean }
  >();
  for (const actingAgentId of [
    ...new Set(document.turns.map(({ agentId }) => agentId)),
  ]) {
    let previousMoveAt: string | undefined;
    for (const turn of document.turns
      .filter(({ agentId }) => agentId === actingAgentId)
      .toSorted((left, right) => left.turnNumber - right.turnNumber)) {
      if (
        turn.outcome !== 'accepted' ||
        turn.worldActionResult?.accepted !== true ||
        turn.worldActionResult.event.type !== 'agent-moved'
      )
        continue;
      const destination = turn.worldActionResult.event.toCell;
      const option = turn.observation?.actionAvailability?.moveOptions.find(
        ({ targetCell }) => targetCell === destination,
      );
      if (!option) continue;
      const messages = [
        ...(turn.observation?.recentDirectMessages ?? []),
        ...(turn.observation?.recentAllianceMessages ?? []),
      ];
      const inboundSincePreviousMove =
        previousMoveAt !== undefined &&
        messages.some((message) => {
          const inbound =
            ('direction' in message && message.direction === 'inbound') ||
            ('senderId' in message && message.senderId !== turn.agentId);
          return (
            inbound &&
            message.occurredAt > previousMoveAt! &&
            message.occurredAt <= turn.completedAt
          );
        });
      result.set(turn.turnNumber, {
        direction: option.direction,
        inboundSincePreviousMove,
      });
      previousMoveAt = turn.completedAt;
    }
  }
  return result;
}

function derivedCommunications(document: ExperimentExportDocument) {
  const byId = new Map(
    (document.communications ?? []).map((entry) => [entry.id, entry]),
  );
  for (const turn of document.turns) {
    const result = turn.communicationResult;
    if (!result?.requested) continue;
    const source = result.accepted ? result.event : result.attempt;
    if (byId.has(source.id)) continue;
    byId.set(
      source.id,
      exportedCommunicationSchema.parse({
        id: source.id,
        agentId: source.agentId,
        channel: source.channel,
        ...('recipientId' in source ? { recipientId: source.recipientId } : {}),
        ...('recipientIds' in source
          ? { recipientIds: source.recipientIds }
          : {}),
        message: source.message,
        ...('distance' in source ? { distance: source.distance } : {}),
        occurredAt: source.occurredAt,
        originatingTurn: turn.turnNumber,
        status: result.accepted ? 'accepted' : 'rejected',
        ...(!result.accepted
          ? { rejectionReason: result.reason, rejectionDetails: result.details }
          : {}),
      }),
    );
  }
  return [...byId.values()];
}

function importCommunications(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO communications(
      id, experiment_id, turn_number, sender_agent_id, channel,
      recipient_agent_id, message, distance, occurred_at, status,
      rejection_reason, rejection_details, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recipientStatement = archive.database.prepare(
    'INSERT OR IGNORE INTO communication_recipients(communication_id, recipient_agent_id) VALUES (?, ?)',
  );
  for (const communication of derivedCommunications(document)) {
    runInsert(
      statement,
      [
        communication.id,
        document.experiment.id,
        communication.originatingTurn,
        communication.agentId,
        communication.channel,
        communication.recipientId ?? null,
        communication.message,
        communication.distance ?? null,
        communication.occurredAt,
        communication.status,
        communication.rejectionReason ?? null,
        communication.rejectionDetails ?? null,
        json(communication)!,
      ],
      report,
    );
    for (const recipientId of communication.recipientIds ?? [])
      runInsert(recipientStatement, [communication.id, recipientId], report);
  }
}

function importAllianceEvents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO alliance_events(
      id, experiment_id, turn_number, occurred_at, agent_id, type, reason, source_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const events = new Map(
    (document.allianceEvents ?? []).map((event) => [event.id, event]),
  );
  for (const turn of document.turns)
    if (turn.diplomacyResult?.requested && turn.diplomacyResult.accepted)
      for (const event of turn.diplomacyResult.events)
        events.set(event.id, event);
  for (const event of events.values())
    runInsert(
      statement,
      [
        event.id,
        document.experiment.id,
        event.turnNumber,
        event.occurredAt,
        event.agentId,
        event.type,
        'reason' in event ? event.reason : null,
        json(event)!,
      ],
      report,
    );
}

function importWorldEvents(
  archive: ArchiveDatabase,
  document: ExperimentExportDocument,
  report: ImportReport,
): void {
  const statement = archive.database.prepare(`
    INSERT OR IGNORE INTO world_events(
      id, experiment_id, turn_number, occurred_at, agent_id, type,
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
      turn: number;
    }
  >();
  for (const event of document.worldEvents ?? []) {
    if (!('agentId' in event)) continue;
    const originatingTurn = document.turns.find(
      (candidate) =>
        candidate.worldActionResult?.accepted &&
        candidate.worldActionResult.event.id === event.id,
    )?.turnNumber;
    if (originatingTurn) events.set(event.id, { event, turn: originatingTurn });
  }
  for (const event of document.controlChanges ?? [])
    events.set(event.id, { event, turn: event.originatingTurn });
  for (const turn of document.turns) {
    const result = turn.worldActionResult;
    if (result?.accepted)
      events.set(result.event.id, {
        event: result.event,
        turn: turn.turnNumber,
      });
  }
  for (const { event, turn } of events.values())
    runInsert(
      statement,
      [
        event.id,
        document.experiment.id,
        turn,
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
    const type =
      'type' in event ? event.type : `personality-${event.operation}`;
    const id = stableId(
      document.experiment.id,
      type,
      event.timestamp,
      'agentId' in event ? event.agentId : '',
      json(event),
    );
    runInsert(
      statement,
      [
        id,
        document.experiment.id,
        event.timestamp,
        type,
        'agentId' in event ? (event.agentId ?? null) : null,
        'effectiveTurn' in event ? event.effectiveTurn : null,
        json(event)!,
      ],
      report,
    );
  }
}
