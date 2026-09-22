import type { DatabaseSync } from 'node:sqlite';

import { ArchiveDatabase } from './database.js';

export const DEFAULT_DETAIL_LIMIT = 50;
export const MAX_DETAIL_LIMIT = 500;

export interface DetailFilters {
  agent?: string;
  fromTurn?: number;
  toTurn?: number;
  outcome?: string;
  reason?: string;
  limit?: number;
}

export interface QueryPage<T> {
  rows: T[];
  limit: number;
  truncated: boolean;
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

function addDecimalStrings(left: string, right: string): string {
  const split = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
  };
  const a = split(left);
  const b = split(right);
  const scale = Math.max(a.scale, b.scale);
  const sum =
    a.digits * 10n ** BigInt(scale - a.scale) +
    b.digits * 10n ** BigInt(scale - b.scale);
  if (sum === 0n) return '0';
  if (scale === 0) return String(sum);
  const padded = String(sum).padStart(scale + 1, '0');
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
    .replace(/0+$/u, '')
    .replace(/\.$/u, '');
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
               COUNT(DISTINCT st.tick_number) AS archivedTicks,
               COUNT(DISTINCT a.agent_id) AS rosterSize,
               e.retention_complete AS retentionComplete,
               e.dropped_records AS droppedRecords,
               e.imported_at AS importedAt
        FROM experiments e
        LEFT JOIN swarm_ticks st ON st.experiment_id = e.id
        LEFT JOIN agents a ON a.experiment_id = e.id
        GROUP BY e.id
        ORDER BY e.started_at DESC, e.id ASC
        LIMIT ?
      `,
      )
      .all(limit + 1) as Array<Record<string, unknown>>;
    return page(rows, limit);
  }

  failures(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filters.agent !== undefined) {
      clauses.push('agent_id = ?');
      values.push(filters.agent);
    }
    if (filters.fromTurn !== undefined) {
      clauses.push('intended_turn_number >= ?');
      values.push(filters.fromTurn);
    }
    if (filters.toTurn !== undefined) {
      clauses.push('intended_turn_number <= ?');
      values.push(filters.toTurn);
    }
    if (filters.reason !== undefined) {
      clauses.push('failure_code = ?');
      values.push(filters.reason);
    }
    const rows = this.#db
      .prepare(
        `
        SELECT id, intended_turn_number AS turn, intended_tick_number AS tick,
               agent_id AS agent, kind, model_id AS model,
               failure_code AS code, failure_message AS message,
               validation_codes_json AS validationCodes, latency_ms AS latencyMs
        FROM provider_attempts
        WHERE experiment_id = ? AND failure_code IS NOT NULL
          ${clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY started_at ASC, id ASC
        LIMIT ?
      `,
      )
      .all(experimentId, ...values, limit + 1) as Array<
      Record<string, unknown>
    >;
    for (const row of rows)
      row.validationCodes = parseJson(row.validationCodes, []);
    return page(rows, limit);
  }

  providerAttempts(
    experimentId: string,
    filters: DetailFilters = {},
  ): QueryPage<Record<string, unknown>> {
    const limit = boundedLimit(filters.limit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filters.agent) {
      clauses.push('agent_id = ?');
      values.push(filters.agent);
    }
    if (filters.fromTurn !== undefined) {
      clauses.push('intended_turn_number >= ?');
      values.push(filters.fromTurn);
    }
    if (filters.toTurn !== undefined) {
      clauses.push('intended_turn_number <= ?');
      values.push(filters.toTurn);
    }
    if (filters.outcome) {
      clauses.push('outcome = ?');
      values.push(filters.outcome);
    }
    const rows = this.#db
      .prepare(
        `
        SELECT id, agent_id AS agent, intended_turn_number AS intendedTurn,
               intended_tick_number AS intendedTick, kind, started_at AS startedAt,
               completed_at AS completedAt, outcome, model_id AS model,
               reasoning_profile AS reasoning, provider, failure_code AS failureCode,
               reserved_credits AS reservedCredits,
               actual_cost_credits AS actualCostCredits
        FROM provider_attempts WHERE experiment_id = ?
          ${clauses.map((clause) => `AND ${clause}`).join('\n')}
        ORDER BY started_at ASC, id ASC LIMIT ?
      `,
      )
      .all(experimentId, ...values, limit + 1) as Array<
      Record<string, unknown>
    >;
    return page(rows, limit);
  }

  /** Zero's directive issuance and completion, derived from archived swarm ticks. */
  directives(experimentId: string): Record<string, unknown> {
    const rows = this.#db
      .prepare(
        'SELECT source_json AS source FROM swarm_ticks WHERE experiment_id = ? ORDER BY tick_number ASC',
      )
      .all(experimentId) as Array<{ source: string }>;
    let directivesIssued = 0;
    let directivesCompleted = 0;
    const missionCounts: Record<string, number> = {};
    for (const row of rows) {
      const tick = parseJson<Record<string, unknown>>(row.source, {});
      const plan = asObject(tick.plan);
      const planned = Array.isArray(plan?.directives) ? plan.directives : [];
      directivesIssued += planned.length;
      for (const directive of planned) {
        const mission = asObject(directive)?.mission;
        if (typeof mission === 'string')
          missionCounts[mission] = (missionCounts[mission] ?? 0) + 1;
      }
      const completed = Array.isArray(tick.completedDirectives)
        ? tick.completedDirectives
        : [];
      directivesCompleted += completed.length;
    }
    return {
      ticksWithPlans: rows.length,
      directivesIssued,
      directivesCompleted,
      missionCounts,
    };
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
    const ticks = this.#db
      .prepare(
        `
        WITH attempt_totals AS (
          SELECT intended_tick_number AS tick, COUNT(*) AS providerCallCount,
                 SUM(latency_ms) AS aggregateLatencyMs,
                 MAX(latency_ms) AS maximumLatencyMs,
                 ROUND(SUM(CAST(actual_cost_credits AS REAL)), 8) AS knownCostCredits,
                 SUM(actual_cost_credits IS NULL) AS attemptsWithUnknownCost
          FROM provider_attempts
          WHERE experiment_id = ? AND intended_tick_number IS NOT NULL
          GROUP BY intended_tick_number
        )
        SELECT st.tick_number AS tick, st.virtual_time AS virtualTime,
               st.plan_source AS planSource,
               COALESCE(a.providerCallCount, 0) AS providerCallCount,
               COALESCE(a.knownCostCredits, 0) AS knownCostCredits,
               COALESCE(a.attemptsWithUnknownCost, 0) AS attemptsWithUnknownCost,
               COALESCE(a.aggregateLatencyMs, 0) AS aggregateLatencyMs,
               COALESCE(a.maximumLatencyMs, 0) AS maximumLatencyMs
        FROM swarm_ticks st LEFT JOIN attempt_totals a ON a.tick = st.tick_number
        WHERE st.experiment_id = ?
        ORDER BY st.tick_number ASC LIMIT ?
      `,
      )
      .all(experimentId, experimentId, MAX_DETAIL_LIMIT);
    const usageByAgent = this.#db
      .prepare(
        `
        SELECT agent_id AS agent,
               COUNT(*) AS providerAttempts,
               SUM(latency_ms) AS latencyTotalMs,
               SUM(latency_ms IS NOT NULL) AS attemptsWithKnownLatency,
               ROUND(AVG(latency_ms), 2) AS averageLatencyMs,
               SUM(prompt_tokens) AS promptTokens,
               SUM(completion_tokens) AS completionTokens,
               SUM(total_tokens) AS totalTokens,
               ROUND(SUM(CAST(actual_cost_credits AS REAL)), 8) AS knownCostCredits,
               SUM(actual_cost_credits IS NULL) AS attemptsWithUnknownCost,
               SUM(CASE WHEN actual_cost_credits IS NULL THEN CAST(reserved_credits AS REAL) ELSE 0 END) AS reservedUnknownExposure
        FROM provider_attempts WHERE experiment_id = ?
        GROUP BY agent_id ORDER BY agent_id
      `,
      )
      .all(experimentId) as Array<Record<string, unknown>>;
    const usageAggregate = aggregateUsage(usageByAgent);
    const independentAttemptRows = this.#db
      .prepare(
        `SELECT agent_id AS agent, outcome, reserved_credits AS reservedCredits,
                actual_cost_credits AS actualCostCredits
         FROM provider_attempts WHERE experiment_id = ?
         ORDER BY started_at, id`,
      )
      .all(experimentId) as Array<Record<string, unknown>>;
    const attemptOutcomes = countBy(independentAttemptRows, 'outcome');
    const attemptOutcomesByAgent = [
      ...new Set(independentAttemptRows.map(({ agent }) => String(agent))),
    ].map((agent) => ({
      agent,
      outcomes: countBy(
        independentAttemptRows.filter((row) => row.agent === agent),
        'outcome',
      ),
    }));
    const exactKnownCostCredits = independentAttemptRows.reduce(
      (sum, row) =>
        row.actualCostCredits === null
          ? sum
          : addDecimalStrings(sum, String(row.actualCostCredits)),
      '0',
    );
    const exactReservedUnknownExposure = independentAttemptRows.reduce(
      (sum, row) =>
        row.actualCostCredits !== null
          ? sum
          : addDecimalStrings(sum, String(row.reservedCredits)),
      '0',
    );
    const promptTokenTrends = this.#db
      .prepare(
        `
        SELECT MIN(prompt_tokens) AS minPromptTokens,
               ROUND(AVG(prompt_tokens), 2) AS averagePromptTokens,
               MAX(prompt_tokens) AS maxPromptTokens
        FROM provider_attempts WHERE experiment_id = ?
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
    const directives = this.directives(experimentId);
    const sourceInconsistencies = parseJson<Array<Record<string, unknown>>>(
      experiment.metric_inconsistencies_json,
      [],
    );
    const missing: string[] = [];
    if (!Boolean(experiment.retention_complete))
      missing.push(
        `source retention is incomplete (${String(experiment.dropped_records)} dropped records)`,
      );
    if (!experiment.scenario_json)
      missing.push('scenario configuration absent');
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
        swarmPlannerContractVersion: experiment.decision_contract_version,
        observationContractVersion: experiment.observation_contract_version,
      },
      roster,
      sourceExports,
      ticks,
      directives,
      territory: {
        current: territoryRows.length > 0 ? territoryRows : sourceTerritory,
        changes: territoryChanges,
      },
      simulatedPlayer,
      usage: { aggregate: usageAggregate, byAgent: usageByAgent },
      providerAttempts: {
        total: independentAttemptRows.length,
        outcomes: attemptOutcomes,
        byAgent: attemptOutcomesByAgent,
        exactKnownCostCredits,
        exactReservedUnknownExposure,
        retention: parseJson(experiment.attempt_retention_json, null),
        accounting: parseJson(experiment.attempt_accounting_json, null),
      },
      promptTokenTrends,
      retention: {
        limit: experiment.retention_limit,
        totalCompletedTurns: experiment.total_completed_turns,
        retainedTurns: experiment.retained_turns,
        archivedTicks: ticks.length,
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
        perTick: 'total / archived swarm tick',
        perActiveAgent: 'total / agent with at least one provider attempt',
      },
      left,
      right,
      delta: metricDelta(left, right),
    };
  }
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
  providerAttempts: number;
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
      providerAttempts:
        aggregate.providerAttempts + Number(row.providerAttempts ?? 0),
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
      providerAttempts: 0,
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
    selection: 'ticks' | 'none' = 'none',
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
      return (
        agents?.mode === 'all' &&
        turns?.mode === 'entire-retained' &&
        outcomes.length === 4 &&
        actions.length === 4
      );
    });
  return {
    observations: includes(
      ['standard', 'full-safe'],
      'turnObservations',
      'ticks',
    ),
    metrics: includes(['minimal', 'standard', 'full-safe'], 'computedMetrics'),
    currentWorld: includes(['full-safe'], 'currentWorldState'),
    initialWorld: includes(['full-safe'], 'initialWorldState'),
  };
}

function comparisonMetrics(db: DatabaseSync, experimentId: string) {
  const ticks = db
    .prepare(
      'SELECT COUNT(*) AS count FROM swarm_ticks WHERE experiment_id = ?',
    )
    .get(experimentId) as { count: number };
  const attempts = db
    .prepare(
      `
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT agent_id) AS activeAgents,
             SUM(outcome = 'accepted') AS accepted,
             SUM(outcome = 'provider-error') AS failed,
             SUM(outcome IN ('operator-skipped', 'lost-tick')) AS lost
      FROM provider_attempts WHERE experiment_id = ?
    `,
    )
    .get(experimentId) as Record<string, unknown>;
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
  const tickCount = Number(ticks.count);
  const activeAgents = Number(attempts.activeAgents);
  const totalAttempts = Number(attempts.total);
  return {
    experimentId,
    absolute: {
      ticks: tickCount,
      activeAgents,
      providerAttempts: totalAttempts,
      accepted: Number(attempts.accepted),
      failed: Number(attempts.failed),
      lost: Number(attempts.lost),
      simulatedPlayerMovements: playerMetric('movements'),
      cellsDisinfected: playerMetric('cellsDisinfected'),
      blockedDisinfections: playerMetric('blockedDisinfections'),
    },
    normalized: {
      providerAttemptsPerTick: rate(totalAttempts, tickCount),
      providerAttemptsPerActiveAgent: rate(totalAttempts, activeAgents),
      acceptedPerTick: rate(Number(attempts.accepted), tickCount),
      failedOrLostPerTick: rate(
        Number(attempts.failed) + Number(attempts.lost),
        tickCount,
      ),
      cellsDisinfectedPerTick: rate(
        playerMetric('cellsDisinfected'),
        Number(simulatedPlayer.activeTicks ?? 0) || tickCount,
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
