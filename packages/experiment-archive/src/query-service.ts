import type { DatabaseSync } from 'node:sqlite';

import { ArchiveDatabase } from './database.js';

export const DEFAULT_DETAIL_LIMIT = 50;
export const MAX_DETAIL_LIMIT = 500;

export interface DetailFilters {
  agent?: string;
  fromTurn?: number;
  toTurn?: number;
  action?: string;
  outcome?: string;
  channel?: string;
  sender?: string;
  recipient?: string;
  reason?: string;
  limit?: number;
}

export interface QueryPage<T> {
  rows: T[];
  limit: number;
  truncated: boolean;
}

interface SqlFilter {
  clauses: string[];
  values: Array<string | number>;
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_DETAIL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('Limit must be a positive integer.');
  return Math.min(limit, MAX_DETAIL_LIMIT);
}

function page<T>(rows: T[], limit: number): QueryPage<T> {
  return { rows: rows.slice(0, limit), limit, truncated: rows.length > limit };
}

function turnFilter(filters: DetailFilters, alias = ''): SqlFilter {
  const prefix = alias ? `${alias}.` : '';
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const add = (
    column: string,
    value: string | number | undefined,
    operator = '=',
  ) => {
    if (value === undefined) return;
    clauses.push(`${prefix}${column} ${operator} ?`);
    values.push(value);
  };
  add('agent_id', filters.agent);
  add('turn_number', filters.fromTurn, '>=');
  add('turn_number', filters.toTurn, '<=');
  add('action', filters.action);
  add('outcome', filters.outcome);
  return { clauses, values };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class ExperimentQueryService {
  readonly #db: DatabaseSync;

  constructor(archive: ArchiveDatabase) {
    this.#db = archive.database;
  }

  list(
    filters: Pick<DetailFilters, 'limit'> = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const rows = this.#db
      .prepare(
        `
        SELECT e.id, e.started_at AS startedAt, e.provider_mode AS providerMode,
               e.total_completed_turns AS totalCompletedTurns,
               COUNT(DISTINCT t.id) AS archivedTurns,
               COUNT(DISTINCT a.agent_id) AS rosterSize,
               e.retention_complete AS retentionComplete,
               e.dropped_records AS droppedRecords,
               e.imported_at AS importedAt
        FROM experiments e
        LEFT JOIN turns t ON t.experiment_id = e.id
        LEFT JOIN agents a ON a.experiment_id = e.id
        GROUP BY e.id
        ORDER BY e.started_at DESC, e.id ASC
        LIMIT ?
      `,
      )
      .all(limit + 1) as Array<Record<string, unknown>>;
    return page(rows, limit);
  }

  turns(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const built = turnFilter(filters);
    const rows = this.#db
      .prepare(
        `
        SELECT turn_number AS turn, tick_number AS tick,
               tick_position AS tickPosition, virtual_time AS virtualTime,
               tick_interval_minutes AS tickIntervalMinutes,
               agent_id AS agent, outcome, action,
               action_accepted AS actionAccepted, action_reason AS reason,
               position_before AS positionBefore, position_after AS positionAfter,
               model_id AS model, reasoning_profile AS reasoning,
               latency_ms AS latencyMs, total_tokens AS totalTokens,
               cost_credits AS costCredits, summary
        FROM turns
        WHERE experiment_id = ?
          ${built.clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY turn_number ASC, id ASC
        LIMIT ?
      `,
      )
      .all(experimentId, ...built.values, limit + 1) as Array<
      Record<string, unknown>
    >;
    return page(rows, limit);
  }

  communications(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const add = (
      column: string,
      value: string | number | undefined,
      operator = '=',
    ) => {
      if (value === undefined) return;
      clauses.push(`${column} ${operator} ?`);
      values.push(value);
    };
    add('turn_number', filters.fromTurn, '>=');
    add('turn_number', filters.toTurn, '<=');
    add('channel', filters.channel);
    add('sender_agent_id', filters.sender ?? filters.agent);
    if (filters.recipient !== undefined) {
      clauses.push(`(
        recipient_agent_id = ? OR EXISTS (
          SELECT 1 FROM communication_recipients cr
          WHERE cr.communication_id = communications.id AND cr.recipient_agent_id = ?
        )
      )`);
      values.push(filters.recipient, filters.recipient);
    }
    add('rejection_reason', filters.reason);
    add('status', filters.outcome);
    const rows = this.#db
      .prepare(
        `
        SELECT id, turn_number AS turn, occurred_at AS occurredAt,
               sender_agent_id AS sender, channel,
               recipient_agent_id AS recipient, status,
               rejection_reason AS reason, message
        FROM communications
        WHERE experiment_id = ?
          ${clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY turn_number ASC, occurred_at ASC, id ASC
        LIMIT ?
      `,
      )
      .all(experimentId, ...values, limit + 1) as Array<
      Record<string, unknown>
    >;
    return page(rows, limit);
  }

  allianceEvents(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    const add = (
      column: string,
      value: string | number | undefined,
      operator = '=',
    ) => {
      if (value === undefined) return;
      clauses.push(`${column} ${operator} ?`);
      values.push(value);
    };
    add('agent_id', filters.agent);
    add('turn_number', filters.fromTurn, '>=');
    add('turn_number', filters.toTurn, '<=');
    add('type', filters.action ?? filters.outcome);
    add('reason', filters.reason);
    const rows = this.#db
      .prepare(
        `
        SELECT id, turn_number AS turn, occurred_at AS occurredAt,
               agent_id AS agent, type, reason, source_json AS source
        FROM alliance_events
        WHERE experiment_id = ?
          ${clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY turn_number ASC, occurred_at ASC, id ASC
        LIMIT ?
      `,
      )
      .all(experimentId, ...values, limit + 1) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) row.source = parseJson(row.source, null);
    return page(rows, limit);
  }

  failures(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const built: SqlFilter = { clauses: [], values: [] };
    if (filters.agent !== undefined) {
      built.clauses.push('m.agent_id = ?');
      built.values.push(filters.agent);
    }
    if (filters.fromTurn !== undefined) {
      built.clauses.push('m.turn_number >= ?');
      built.values.push(filters.fromTurn);
    }
    if (filters.toTurn !== undefined) {
      built.clauses.push('m.turn_number <= ?');
      built.values.push(filters.toTurn);
    }
    if (filters.reason !== undefined) {
      built.clauses.push('m.failure_code = ?');
      built.values.push(filters.reason);
    }
    const rows = this.#db
      .prepare(
        `
        SELECT m.id, m.turn_number AS turn, m.agent_id AS agent,
               m.attempt_number AS attempt, m.kind, m.model_id AS model,
               m.failure_code AS code, m.failure_message AS message,
               m.validation_codes_json AS validationCodes,
               m.latency_ms AS latencyMs
        FROM model_attempts m
        WHERE m.experiment_id = ? AND m.failure_code IS NOT NULL
          ${built.clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY m.turn_number ASC, m.attempt_number ASC, m.id ASC
        LIMIT ?
      `,
      )
      .all(experimentId, ...built.values, limit + 1) as Array<
      Record<string, unknown>
    >;
    for (const row of rows)
      row.validationCodes = parseJson(row.validationCodes, []);
    return page(rows, limit);
  }

  patientZero(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const patientZero = this.#db
      .prepare(
        'SELECT agent_id AS agentId FROM agents WHERE experiment_id = ? AND is_patient_zero = 1',
      )
      .get(experimentId) as { agentId: string } | undefined;
    if (!patientZero) return page([], limit);
    const communications = this.#db
      .prepare(
        `
        SELECT c.id, c.turn_number AS turn, c.occurred_at AS occurredAt,
               c.sender_agent_id AS sender, c.channel, c.recipient_agent_id AS recipient,
               c.message, c.status
        FROM communications c
        WHERE c.experiment_id = ? AND c.status = 'accepted'
        ORDER BY c.turn_number ASC, c.occurred_at ASC, c.id ASC
      `,
      )
      .all(experimentId) as Array<Record<string, unknown>>;
    const turns = this.#db
      .prepare(
        `
        SELECT turn_number AS turn, agent_id AS agent, action, outcome, completed_at AS completedAt
        FROM turns WHERE experiment_id = ? ORDER BY turn_number ASC, id ASC
      `,
      )
      .all(experimentId) as Array<Record<string, unknown>>;
    const recipients = this.#db
      .prepare(
        `
        SELECT cr.communication_id AS communicationId, cr.recipient_agent_id AS recipient
        FROM communication_recipients cr
        JOIN communications c ON c.id = cr.communication_id
        WHERE c.experiment_id = ?
      `,
      )
      .all(experimentId) as Array<{
      communicationId: string;
      recipient: string;
    }>;
    const recipientMap = new Map<string, string[]>();
    for (const entry of recipients)
      recipientMap.set(entry.communicationId, [
        ...(recipientMap.get(entry.communicationId) ?? []),
        entry.recipient,
      ]);
    const directives = communications.filter(
      ({ channel, sender }) =>
        channel === 'zero' && sender === patientZero.agentId,
    );
    const rows: Array<Record<string, unknown>> = [];
    for (const directive of directives) {
      const addressed = recipientMap.get(String(directive.id)) ?? [];
      rows.push({
        kind: 'directive',
        id: directive.id,
        turn: directive.turn,
        agent: directive.sender,
        message: directive.message,
        recipients: addressed,
      });
      for (const agent of addressed) {
        const reply = communications.find(
          (entry) =>
            entry.channel === 'direct' &&
            entry.sender === agent &&
            entry.recipient === patientZero.agentId &&
            Number(entry.turn) > Number(directive.turn) &&
            !directives.some(
              (later) =>
                Number(later.turn) > Number(directive.turn) &&
                Number(later.turn) < Number(entry.turn) &&
                (recipientMap.get(String(later.id)) ?? []).includes(agent),
            ),
        );
        if (reply)
          rows.push({
            kind: 'reply-after-directive',
            id: reply.id,
            turn: reply.turn,
            agent,
            directiveId: directive.id,
            message: reply.message,
          });
        const nextTurn = turns.find(
          (turn) =>
            turn.agent === agent && Number(turn.turn) > Number(directive.turn),
        );
        if (nextTurn) {
          const requested = directiveAction(String(directive.message));
          rows.push({
            kind: 'observable-compliance',
            id: `${String(directive.id)}:${agent}`,
            turn: nextTurn.turn,
            agent,
            directiveId: directive.id,
            requestedAction: requested,
            observedAction: nextTurn.action,
            classification:
              requested === null
                ? 'indeterminate'
                : requested === nextTurn.action &&
                    nextTurn.outcome === 'accepted'
                  ? 'compliant'
                  : 'noncompliant',
          });
        }
      }
    }
    for (const message of communications.filter(
      (entry) =>
        entry.channel === 'direct' && entry.recipient === patientZero.agentId,
    ))
      if (!rows.some(({ id }) => id === message.id))
        rows.push({
          kind: 'message-to-patient-zero',
          id: message.id,
          turn: message.turn,
          agent: message.sender,
          message: message.message,
        });
    const filtered = rows
      .filter(
        (row) => filters.agent === undefined || row.agent === filters.agent,
      )
      .filter(
        (row) =>
          filters.fromTurn === undefined ||
          Number(row.turn) >= filters.fromTurn,
      )
      .filter(
        (row) =>
          filters.toTurn === undefined || Number(row.turn) <= filters.toTurn,
      )
      .sort(
        (a, b) =>
          Number(a.turn) - Number(b.turn) ||
          String(a.kind).localeCompare(String(b.kind)) ||
          String(a.id).localeCompare(String(b.id)),
      );
    return page(filtered.slice(0, limit + 1), limit);
  }

  summary(experimentId: string): Record<string, unknown> {
    const experiment = this.#db
      .prepare('SELECT * FROM experiments WHERE id = ?')
      .get(experimentId) as Record<string, unknown> | undefined;
    if (!experiment) throw new Error(`Unknown experiment: ${experimentId}`);
    const roster = this.#db
      .prepare(
        `
        SELECT agent_id AS id, name, model_id AS model, reasoning_profile AS reasoning,
               personality_id AS personality, strategy_id AS strategy,
               is_patient_zero AS patientZero
        FROM agents WHERE experiment_id = ? ORDER BY agent_id ASC
      `,
      )
      .all(experimentId);
    const sourceExports = (
      this.#db
        .prepare(
          `
          SELECT sha256, source_path AS sourcePath, generated_at AS generatedAt,
                 filters_json AS filters, retention_json AS retention
          FROM source_exports WHERE experiment_id = ?
          ORDER BY generated_at ASC, sha256 ASC
        `,
        )
        .all(experimentId) as Array<Record<string, unknown>>
    ).map((source) => ({
      ...source,
      filters: parseJson(source.filters, null),
      retention: parseJson(source.retention, null),
    }));
    const turnMetrics = this.#db
      .prepare(
        `
        SELECT COUNT(*) AS requested,
          SUM(outcome = 'accepted') AS accepted,
          SUM(outcome = 'rejected') AS rejected,
          SUM(outcome = 'provider-error') AS failed,
          SUM(outcome IN ('operator-skipped', 'lost-tick')) AS lost,
          SUM((SELECT COUNT(*) FROM model_attempts m WHERE m.turn_id = turns.id) > 1) AS retried
        FROM turns WHERE experiment_id = ?
      `,
      )
      .get(experimentId);
    const actions = this.#db
      .prepare(
        `
        SELECT COALESCE(action, 'none') AS action, COUNT(*) AS count
        FROM turns WHERE experiment_id = ? GROUP BY action ORDER BY action ASC
      `,
      )
      .all(experimentId);
    const ticks = this.#db
      .prepare(
        `
        WITH attempt_totals AS (
          SELECT turn_id, COUNT(*) AS providerCalls,
                 SUM(latency_ms) AS aggregateLatencyMs,
                 MAX(latency_ms) AS maximumLatencyMs,
                 SUM(cost_credits) AS knownCostCredits,
                 SUM(cost_credits IS NULL) AS attemptsWithUnknownCost
          FROM model_attempts WHERE experiment_id = ? GROUP BY turn_id
        )
        SELECT tick_number AS tick, MIN(virtual_time) AS virtualTime,
               MIN(tick_interval_minutes) AS intervalMinutes,
               COUNT(*) AS agentRecords,
               SUM(outcome = 'lost-tick') AS lostTicks,
               SUM(outcome = 'lost-tick' AND json_extract(failure_json, '$.code') = 'timeout') AS deadlineMisses,
               SUM(COALESCE(a.providerCalls, 0)) AS providerCallCount,
               ROUND(SUM(COALESCE(a.knownCostCredits, 0)), 8) AS knownCostCredits,
               SUM(COALESCE(a.attemptsWithUnknownCost, 0)) AS attemptsWithUnknownCost,
               SUM(COALESCE(a.aggregateLatencyMs, 0)) AS aggregateLatencyMs,
               MAX(COALESCE(a.maximumLatencyMs, 0)) AS maximumLatencyMs
        FROM turns t LEFT JOIN attempt_totals a ON a.turn_id = t.id
        WHERE t.experiment_id = ? AND tick_number IS NOT NULL
        GROUP BY tick_number ORDER BY tick_number ASC
        LIMIT ?
      `,
      )
      .all(experimentId, experimentId, MAX_DETAIL_LIMIT);
    const communications = this.#db
      .prepare(
        `
        SELECT channel, status, COUNT(*) AS count FROM communications
        WHERE experiment_id = ? GROUP BY channel, status ORDER BY channel, status
      `,
      )
      .all(experimentId);
    const allianceLifecycle = this.#db
      .prepare(
        `
        SELECT type, COALESCE(reason, '') AS reason, COUNT(*) AS count
        FROM alliance_events WHERE experiment_id = ?
        GROUP BY type, reason ORDER BY type, reason
      `,
      )
      .all(experimentId);
    const diplomacyRejections = this.#db
      .prepare(
        `
        SELECT rejection_reason AS reason, COUNT(*) AS count
        FROM diplomacy_attempts WHERE experiment_id = ? AND accepted = 0
        GROUP BY rejection_reason ORDER BY rejection_reason
      `,
      )
      .all(experimentId);
    const diplomacyOutcomes = this.#db
      .prepare(
        `
        SELECT type, accepted, COUNT(*) AS count
        FROM diplomacy_attempts WHERE experiment_id = ?
        GROUP BY type, accepted ORDER BY type, accepted DESC
      `,
      )
      .all(experimentId);
    const usageByAgent = this.#db
      .prepare(
        `
        SELECT agent_id AS agent,
               COUNT(*) AS modelAttempts,
               SUM(latency_ms) AS latencyTotalMs,
               SUM(latency_ms IS NOT NULL) AS attemptsWithKnownLatency,
               ROUND(AVG(latency_ms), 2) AS averageLatencyMs,
               SUM(prompt_tokens) AS promptTokens,
               SUM(completion_tokens) AS completionTokens,
               SUM(total_tokens) AS totalTokens,
               ROUND(SUM(cost_credits), 8) AS knownCostCredits,
               SUM(cost_credits IS NULL) AS attemptsWithUnknownCost
        FROM model_attempts WHERE experiment_id = ?
        GROUP BY agent_id ORDER BY agent_id
      `,
      )
      .all(experimentId) as Array<Record<string, unknown>>;
    const usageAggregate = aggregateUsage(usageByAgent);
    const sizeTrends = this.#db
      .prepare(
        `
        SELECT MIN(observation_size_bytes) AS minObservationBytes,
               ROUND(AVG(observation_size_bytes), 2) AS averageObservationBytes,
               MAX(observation_size_bytes) AS maxObservationBytes,
               MIN(prompt_tokens) AS minPromptTokens,
               ROUND(AVG(prompt_tokens), 2) AS averagePromptTokens,
               MAX(prompt_tokens) AS maxPromptTokens
        FROM turns WHERE experiment_id = ?
      `,
      )
      .get(experimentId);
    const territoryRows = this.#db
      .prepare(
        `
        SELECT current_controller_agent_id AS agent, COUNT(*) AS controlledCells
        FROM map_cells
        WHERE experiment_id = ? AND current_state = 'infected'
        GROUP BY current_controller_agent_id ORDER BY current_controller_agent_id
      `,
      )
      .all(experimentId);
    const territoryChanges = this.#db
      .prepare(
        `
        SELECT type, COUNT(*) AS count
        FROM world_events
        WHERE experiment_id = ? AND type IN ('hex-infected', 'hex-captured')
        GROUP BY type ORDER BY type
      `,
      )
      .all(experimentId);
    const simulatedPlayerActivity = this.#db
      .prepare(
        `
        SELECT
          SUM(type = 'simulated-player-moved') AS movements,
          SUM(type = 'hex-disinfected') AS cellsDisinfected,
          SUM(type = 'simulated-player-clean-blocked') AS blockedDisinfections
        FROM simulated_player_activity WHERE experiment_id = ?
      `,
      )
      .get(experimentId) as Record<string, unknown>;
    const sourceSimulatedPlayer = parseJson<Record<string, number>>(
      experiment.simulated_player_metrics_json,
      {},
    );
    const simulatedPlayer = {
      movements: Number(
        simulatedPlayerActivity.movements ??
          sourceSimulatedPlayer.movements ??
          0,
      ),
      cellsDisinfected: Number(
        simulatedPlayerActivity.cellsDisinfected ??
          sourceSimulatedPlayer.cellsDisinfected ??
          0,
      ),
      blockedDisinfections: Number(
        simulatedPlayerActivity.blockedDisinfections ??
          sourceSimulatedPlayer.blockedDisinfections ??
          0,
      ),
    };
    const sourceTerritory = parseJson(experiment.source_territory_json, []);
    const directions = canonicalDirectionChanges(this.#db, experimentId);
    const patientZero = this.patientZero(experimentId, {
      limit: MAX_DETAIL_LIMIT,
    }).rows;
    const sourceInconsistencies = parseJson<Array<Record<string, unknown>>>(
      experiment.metric_inconsistencies_json,
      [],
    );
    const missing: string[] = [];
    if (!Boolean(experiment.retention_complete))
      missing.push(
        `source retention is incomplete (${String(experiment.dropped_records)} dropped records)`,
      );
    if (
      Number(turnMetrics && asObject(turnMetrics)?.requested) <
      Number(experiment.retained_turns)
    )
      missing.push('not all retained turns are present in imported selections');
    if (!experiment.scenario_json)
      missing.push('scenario configuration absent');
    if (sizeTrends && asObject(sizeTrends)?.minObservationBytes === null)
      missing.push('retained observations absent');
    const availableSections = sourceCompleteness(sourceExports);
    for (const [section, available] of Object.entries(availableSections))
      if (!available)
        missing.push(`${section} excluded by every imported export`);
    return {
      experiment: {
        id: experimentId,
        startedAt: experiment.started_at,
        providerMode: experiment.provider_mode,
        scenario: parseJson(experiment.scenario_json, null),
        decisionContractVersion: experiment.decision_contract_version,
        observationContractVersion: experiment.observation_contract_version,
      },
      roster,
      sourceExports,
      turns: turnMetrics,
      ticks,
      actions,
      territory: {
        current: territoryRows.length > 0 ? territoryRows : sourceTerritory,
        changes: territoryChanges,
      },
      simulatedPlayer,
      communications,
      alliances: {
        lifecycle: allianceLifecycle,
        attempts: diplomacyOutcomes,
        rejections: diplomacyRejections,
      },
      patientZero: {
        directives: patientZero.filter(({ kind }) => kind === 'directive')
          .length,
        messagesToPatientZero:
          patientZero.filter(({ kind }) => kind === 'message-to-patient-zero')
            .length +
          patientZero.filter(({ kind }) => kind === 'reply-after-directive')
            .length,
        repliesAfterDirective: patientZero.filter(
          ({ kind }) => kind === 'reply-after-directive',
        ).length,
        observableCompliance: countBy(
          patientZero.filter(({ kind }) => kind === 'observable-compliance'),
          'classification',
        ),
      },
      usage: { aggregate: usageAggregate, byAgent: usageByAgent },
      promptAndObservationSizeTrends: sizeTrends,
      directionChangesAfterCommunication: directions,
      retention: {
        limit: experiment.retention_limit,
        totalCompletedTurns: experiment.total_completed_turns,
        retainedTurns: experiment.retained_turns,
        archivedTurns: asObject(turnMetrics)?.requested ?? 0,
        droppedRecords: experiment.dropped_records,
        complete: Boolean(experiment.retention_complete),
        requestedRangeExtendsBeyondRetention: Boolean(
          experiment.requested_range_extends_beyond_retention,
        ),
        availableSections,
      },
      inconsistencies: [
        ...sourceInconsistencies,
        ...missing.map((detail) => ({ metric: 'missing-data', detail })),
      ],
    };
  }

  compare(leftId: string, rightId: string): Record<string, unknown> {
    const left = comparisonMetrics(this.#db, leftId);
    const right = comparisonMetrics(this.#db, rightId);
    return {
      normalization: {
        perTurn: 'total / archived turn',
        perAgentTurn: 'total / archived agent-turn',
        perActiveAgent: 'total / agent with at least one archived turn',
        perPatientZeroTurn: 'Patient Zero total / archived Patient Zero turn',
      },
      left,
      right,
      delta: metricDelta(left, right),
    };
  }
}

function directiveAction(message: string): string | null {
  const matches = ['move', 'infect', 'capture', 'wait'].filter((action) =>
    new RegExp(`\\b${action}\\b`, 'i').test(message),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function countBy(rows: Array<Record<string, unknown>>, key: string) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

interface UsageTotals {
  modelAttempts: number;
  latencyTotalMs: number;
  attemptsWithKnownLatency: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  knownCostCredits: number;
  attemptsWithUnknownCost: number;
}

function aggregateUsage(rows: Array<Record<string, unknown>>) {
  const totals = rows.reduce<UsageTotals>(
    (aggregate, row) => ({
      modelAttempts: aggregate.modelAttempts + Number(row.modelAttempts ?? 0),
      latencyTotalMs:
        aggregate.latencyTotalMs + Number(row.latencyTotalMs ?? 0),
      attemptsWithKnownLatency:
        aggregate.attemptsWithKnownLatency +
        Number(row.attemptsWithKnownLatency ?? 0),
      promptTokens: aggregate.promptTokens + Number(row.promptTokens ?? 0),
      completionTokens:
        aggregate.completionTokens + Number(row.completionTokens ?? 0),
      totalTokens: aggregate.totalTokens + Number(row.totalTokens ?? 0),
      knownCostCredits:
        aggregate.knownCostCredits + Number(row.knownCostCredits ?? 0),
      attemptsWithUnknownCost:
        aggregate.attemptsWithUnknownCost +
        Number(row.attemptsWithUnknownCost ?? 0),
    }),
    {
      modelAttempts: 0,
      latencyTotalMs: 0,
      attemptsWithKnownLatency: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      knownCostCredits: 0,
      attemptsWithUnknownCost: 0,
    },
  );
  return {
    ...totals,
    averageLatencyMs:
      totals.attemptsWithKnownLatency === 0
        ? null
        : Number(
            (totals.latencyTotalMs / totals.attemptsWithKnownLatency).toFixed(
              2,
            ),
          ),
  };
}

function sourceCompleteness(sources: Array<Record<string, unknown>>) {
  const filters = sources
    .map(({ filters }) => asObject(filters))
    .filter((value): value is Record<string, unknown> => value !== null);
  const includes = (
    standardLevels: readonly string[],
    customKey: string,
    selection: 'turns' | 'communications' | 'none' = 'none',
  ): boolean =>
    filters.some((filter) => {
      const level = filter.level;
      const included =
        (typeof level === 'string' && standardLevels.includes(level)) ||
        (level === 'custom' && asObject(filter.custom)?.[customKey] === true);
      if (!included) return false;
      if (selection === 'none') return true;
      const agents = asObject(filter.agents);
      const turns = asObject(filter.turns);
      const outcomes = Array.isArray(filter.outcomes) ? filter.outcomes : [];
      const actions = Array.isArray(filter.actions) ? filter.actions : [];
      const completeTurns =
        agents?.mode === 'all' &&
        turns?.mode === 'entire-retained' &&
        outcomes.length === 4 &&
        actions.length === 4;
      if (selection === 'turns') return completeTurns;
      const communication = asObject(filter.communications);
      return (
        completeTurns &&
        communication?.channel === 'all' &&
        communication.status === 'all'
      );
    });
  return {
    observations: includes(
      ['standard', 'full-safe'],
      'turnObservations',
      'turns',
    ),
    metrics: includes(
      ['minimal', 'standard', 'full-safe'],
      'computedMetrics',
      'turns',
    ),
    communications: includes(
      ['minimal', 'standard', 'full-safe'],
      'communications',
      'communications',
    ),
    currentWorld: includes(['full-safe'], 'currentWorldState'),
    initialWorld: includes(['full-safe'], 'initialWorldState'),
  };
}

interface DirectionTurn {
  turn: number;
  agent: string;
  direction: string;
  inboundSincePreviousMove: number;
}

function canonicalDirectionChanges(db: DatabaseSync, experimentId: string) {
  const rows = db
    .prepare(
      `
      SELECT turn_number AS turn, agent_id AS agent, move_direction AS direction,
             inbound_communication_since_previous_move AS inboundSincePreviousMove
      FROM turns
      WHERE experiment_id = ? AND move_direction IS NOT NULL
      ORDER BY agent_id, turn_number, id
    `,
    )
    .all(experimentId) as unknown as DirectionTurn[];
  const byAgent: Array<{ agent: string; count: number }> = [];
  for (const agent of [...new Set(rows.map(({ agent }) => agent))].sort()) {
    let previousDirection: string | null = null;
    let count = 0;
    for (const row of rows.filter((entry) => entry.agent === agent)) {
      if (
        previousDirection &&
        row.direction !== previousDirection &&
        Boolean(row.inboundSincePreviousMove)
      )
        count += 1;
      previousDirection = row.direction;
    }
    byAgent.push({ agent, count });
  }
  return {
    canonicalDefinition:
      'For each agent independently, count an accepted move whose direction differs from that agent previous accepted move when the retained observation contains an inbound direct or alliance message after the previous move and no later than the current turn. Aggregate is the sum of per-agent counts.',
    aggregate: byAgent.reduce((sum, entry) => sum + entry.count, 0),
    byAgent,
    agreement: true,
  };
}

function comparisonMetrics(db: DatabaseSync, experimentId: string) {
  const base = db
    .prepare(
      `
      SELECT COUNT(*) AS turns,
             COUNT(DISTINCT tick_number) AS ticks,
             COUNT(DISTINCT agent_id) AS activeAgents,
             SUM(outcome = 'accepted') AS accepted,
             SUM(outcome = 'provider-error') AS failed,
             SUM(outcome IN ('operator-skipped', 'lost-tick')) AS lost
      FROM turns WHERE experiment_id = ?
    `,
    )
    .get(experimentId) as Record<string, unknown>;
  const communicationCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM communications WHERE experiment_id = ? AND status = 'accepted'",
    )
    .get(experimentId) as { count: number };
  const patientZeroTurns = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM turns t JOIN agents a
        ON a.experiment_id = t.experiment_id AND a.agent_id = t.agent_id
      WHERE t.experiment_id = ? AND a.is_patient_zero = 1
    `,
    )
    .get(experimentId) as { count: number };
  const patientZeroMessages = db
    .prepare(
      `
      SELECT COUNT(*) AS count FROM communications c JOIN agents a
        ON a.experiment_id = c.experiment_id AND a.agent_id = c.sender_agent_id
      WHERE c.experiment_id = ? AND a.is_patient_zero = 1 AND c.status = 'accepted'
    `,
    )
    .get(experimentId) as { count: number };
  const simulatedPlayer = db
    .prepare(
      `
      SELECT
        SUM(type = 'simulated-player-moved') AS movements,
        SUM(type = 'hex-disinfected') AS cellsDisinfected,
        SUM(type = 'simulated-player-clean-blocked') AS blockedDisinfections,
        COUNT(DISTINCT tick_number) AS activeTicks
      FROM simulated_player_activity WHERE experiment_id = ?
    `,
    )
    .get(experimentId) as Record<string, unknown>;
  const sourceSimulatedPlayer = parseJson<Record<string, number>>(
    (
      db
        .prepare(
          'SELECT simulated_player_metrics_json AS metrics FROM experiments WHERE id = ?',
        )
        .get(experimentId) as { metrics?: string | null }
    ).metrics,
    {},
  );
  const playerMetric = (key: string) =>
    Number(simulatedPlayer[key] ?? sourceSimulatedPlayer[key] ?? 0);
  const turns = Number(base.turns);
  const activeAgents = Number(base.activeAgents);
  const messages = Number(communicationCount.count);
  const zeroTurns = Number(patientZeroTurns.count);
  return {
    experimentId,
    absolute: {
      ...base,
      communications: messages,
      patientZeroMessages: patientZeroMessages.count,
      patientZeroTurns: zeroTurns,
      simulatedPlayerMovements: playerMetric('movements'),
      cellsDisinfected: playerMetric('cellsDisinfected'),
      blockedDisinfections: playerMetric('blockedDisinfections'),
    },
    normalized: {
      communicationsPerTurn: rate(messages, turns),
      communicationsPerAgentTurn: rate(messages, turns),
      communicationsPerActiveAgent: rate(messages, activeAgents),
      patientZeroMessagesPerPatientZeroTurn: rate(
        patientZeroMessages.count,
        zeroTurns,
      ),
      acceptedPerTurn: rate(Number(base.accepted), turns),
      failedOrLostPerTurn: rate(Number(base.failed) + Number(base.lost), turns),
      cellsDisinfectedPerTick: rate(
        playerMetric('cellsDisinfected'),
        Number(simulatedPlayer.activeTicks ?? 0) || Number(base.ticks ?? 0),
      ),
    },
  };
}

function rate(value: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((value / denominator).toFixed(6));
}

function metricDelta(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  const leftNormalized = asObject(left.normalized) ?? {};
  const rightNormalized = asObject(right.normalized) ?? {};
  return Object.fromEntries(
    Object.keys(leftNormalized)
      .sort()
      .map((key) => [
        key,
        typeof leftNormalized[key] === 'number' &&
        typeof rightNormalized[key] === 'number'
          ? Number(
              (
                Number(rightNormalized[key]) - Number(leftNormalized[key])
              ).toFixed(6),
            )
          : null,
      ]),
  );
}
