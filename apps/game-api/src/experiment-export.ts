import {
  SWARM_PLANNER_CONTRACT_VERSION,
  experimentExportDocumentSchema,
  experimentExportPreviewSchema,
  experimentExportRequestSchema,
  experimentMetricsSchema,
  type Agent,
  type AgentId,
  type AppliedScenario,
  type ExperimentAttemptAccounting,
  type ExperimentConfigurationEvent,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentExportRequest,
  type ExperimentExportWorldState,
  type ExperimentId,
  type ExperimentMetrics,
  type ExperimentModelConfiguration,
  type ExperimentTickSummary,
  type ExportedControlChange,
  type ProviderAttemptRecord,
  type ProviderAttemptRetention,
  type SimulatedPlayerEvent,
  type SwarmTickRecord,
  type WorldAction,
  type WorldActionResult,
  type WorldSnapshot,
} from '@hexzero/shared';

export interface ExperimentSource {
  schemaVersion: 9 | 10 | 11;
  id: ExperimentId;
  startedAt: string;
  providerMode: 'openrouter' | 'scripted-test';
  retentionLimit: number;
  totalCompletedTicks: number;
  initialAgents: readonly Agent[];
  currentAgents: readonly Agent[];
  configurationEvents: readonly ExperimentConfigurationEvent[];
  initialWorld: WorldSnapshot;
  currentWorld: WorldSnapshot;
  modelConfiguration: ExperimentModelConfiguration;
  scenario: AppliedScenario;
  swarmTicks?: readonly SwarmTickRecord[];
  simulatedPlayerEvents: readonly SimulatedPlayerEvent[];
  providerAttempts?: readonly ProviderAttemptRecord[];
  attemptRetention?: ProviderAttemptRetention;
  attemptAccounting?: ExperimentAttemptAccounting;
}

export class ExperimentExportValidationError extends Error {
  constructor(
    readonly code: 'invalid_export' | 'unknown_agent' | 'records_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ExperimentExportValidationError';
  }
}

/** One resolved (accepted or rejected) world-action decision from a committed swarm tick. */
interface ResolvedWorldAction {
  tickNumber: number;
  agentId: AgentId;
  action: WorldAction;
  actionResult: WorldActionResult;
}

const metricTokenFields = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'reasoningTokens',
  'cachedReadTokens',
  'cacheWriteTokens',
] as const;

function resolvedActionsFromTicks(
  ticks: readonly SwarmTickRecord[],
  zeroAgentId: AgentId,
): ResolvedWorldAction[] {
  const resolved: ResolvedWorldAction[] = [];
  for (const tick of ticks) {
    if (tick.zeroAction && tick.zeroActionResult)
      resolved.push({
        tickNumber: tick.tickNumber,
        agentId: zeroAgentId,
        action: tick.zeroAction,
        actionResult: tick.zeroActionResult,
      });
    for (const worker of tick.workers)
      if (worker.action && worker.actionResult)
        resolved.push({
          tickNumber: tick.tickNumber,
          agentId: worker.agentId,
          action: worker.action,
          actionResult: worker.actionResult,
        });
  }
  return resolved;
}

function selectTickNumbers(
  source: ExperimentSource,
  request: ExperimentExportRequest,
): Set<number> | 'all' {
  if (request.turns.mode === 'entire-retained') return 'all';
  const allTicks = (source.swarmTicks ?? []).map(
    ({ tickNumber }) => tickNumber,
  );
  if (request.turns.mode === 'range') {
    const { fromTurn, toTurn } = request.turns;
    return new Set(allTicks.filter((n) => n >= fromTurn && n <= toTurn));
  }
  return new Set(allTicks.slice(-request.turns.count));
}

function requestFilteredActions(
  source: ExperimentSource,
  request: ExperimentExportRequest,
  tickNumbers: Set<number> | 'all',
): ResolvedWorldAction[] {
  const zeroAgentId = source.scenario.patientZeroAgentId;
  const all = resolvedActionsFromTicks(source.swarmTicks ?? [], zeroAgentId);
  return all.filter(
    ({ tickNumber, action, actionResult }) =>
      request.outcomes.includes(
        actionResult.accepted ? 'accepted' : 'rejected',
      ) &&
      request.actions.includes(action.type) &&
      (tickNumbers === 'all' || tickNumbers.has(tickNumber)),
  );
}

export function createExperimentExport(
  source: ExperimentSource,
  requestInput: unknown,
  generatedAt: string,
): ExperimentExportDocument {
  const parsed = experimentExportRequestSchema.safeParse(requestInput);
  if (!parsed.success) {
    throw new ExperimentExportValidationError(
      'invalid_export',
      'The export filters are invalid.',
    );
  }
  const request = parsed.data;
  const selectedAgentIds = resolveAgentIds(source, request);
  const selectedSet = new Set<AgentId>(selectedAgentIds);
  const tickNumbers = selectTickNumbers(source, request);
  const requestFiltered = requestFilteredActions(source, request, tickNumbers);
  const agentFiltered = requestFiltered.filter(({ agentId }) =>
    selectedSet.has(agentId),
  );
  const controlChanges = filterControlChanges(
    requestFiltered,
    request,
    selectedSet,
  );
  const providerAttempts = filterProviderAttempts(
    source,
    selectedSet,
    tickNumbers,
  );
  const retainedTicks = source.swarmTicks?.length ?? 0;
  const firstRetainedTick = source.swarmTicks?.[0]?.tickNumber;
  const lastRetainedTick = source.swarmTicks?.at(-1)?.tickNumber;
  const droppedRecords = source.totalCompletedTicks - retainedTicks;
  const retention = {
    limit: source.retentionLimit,
    totalCompletedTurns: source.totalCompletedTicks,
    retainedTurns: retainedTicks,
    firstRetainedTurn: firstRetainedTick,
    lastRetainedTurn: lastRetainedTick,
    droppedRecords,
    complete: droppedRecords === 0,
    requestedRangeExtendsBeyondRetention: rangeExtendsBeyondRetention(
      request,
      source,
      firstRetainedTick,
      lastRetainedTick,
    ),
  };
  const include = inclusionsFor(request);
  const exportedSwarmTicks: SwarmTickRecord[] | undefined =
    source.scenario.swarmArchitectureVersion === 'zero-swarm-v1' &&
    request.agents.mode === 'all' &&
    request.turns.mode === 'entire-retained'
      ? [...structuredClone(source.swarmTicks ?? [])]
      : undefined;
  const simulatedPlayerEventsIncluded = source.simulatedPlayerEvents.filter(
    (event) =>
      (request.agents.mode === 'all' &&
        request.turns.mode === 'entire-retained') ||
      (event.type === 'simulated-player-agent-captured' &&
        selectedSet.has(event.capturedAgentId)),
  );
  const currentAgentsById = new Map(
    source.currentAgents.map((agent) => [agent.id, agent]),
  );
  const initialAgentsById = new Map(
    source.initialAgents.map((agent) => [agent.id, agent]),
  );
  const selectedAgents = selectedAgentIds
    .map(
      (agentId) =>
        currentAgentsById.get(agentId) ?? initialAgentsById.get(agentId),
    )
    .filter((agent): agent is Agent => agent !== undefined)
    .map((agent) => structuredClone(agent));
  const document: ExperimentExportDocument = {
    schemaVersion: source.schemaVersion,
    generatedAt,
    experiment: {
      id: source.id,
      startedAt: source.startedAt,
      providerMode: source.providerMode,
      swarmPlannerContractVersion: SWARM_PLANNER_CONTRACT_VERSION,
      modelConfiguration: structuredClone(source.modelConfiguration),
      scenario: structuredClone(source.scenario),
      ...(request.level === 'full-safe'
        ? { initialAgents: structuredClone([...source.initialAgents]) }
        : {}),
    },
    retention,
    filters: structuredClone(request),
    selection: {
      selectedAgentIds,
      ...(source.schemaVersion === 10 || source.schemaVersion === 11
        ? {
            matchingTickCount:
              exportedSwarmTicks?.length ??
              new Set(agentFiltered.map(({ tickNumber }) => tickNumber)).size,
          }
        : {}),
      ...(exportedSwarmTicks
        ? { matchingSwarmTickCount: exportedSwarmTicks.length }
        : {}),
      matchingControlChangeCount: controlChanges.length,
      ...(source.schemaVersion === 11
        ? { matchingProviderAttemptCount: providerAttempts.length }
        : {}),
      matchingSimulatedPlayerEventCount: simulatedPlayerEventsIncluded.length,
    },
    agents: selectedAgents,
    configurationEvents: source.configurationEvents
      .filter(
        (event) =>
          event.scope === 'global' ||
          (event.agentId !== undefined && selectedSet.has(event.agentId)),
      )
      .map((event) => structuredClone(event)),
    ...(include.metrics
      ? {
          metrics: calculateExperimentMetrics(
            agentFiltered,
            selectedAgentIds,
            providerAttempts,
            controlChanges,
          ),
          currentTerritory: currentTerritory(
            source.currentWorld,
            source.currentAgents,
          ),
          simulatedPlayerMetrics: source.currentWorld.simulatedPlayer
            ?.metrics ?? {
            movements: 0,
            cellsDisinfected: 0,
            blockedDisinfections: 0,
          },
        }
      : {}),
    ...(include.initialWorld
      ? { initialWorld: exportWorldState(source.initialWorld) }
      : {}),
    ...(include.currentWorld
      ? { currentWorld: exportWorldState(source.currentWorld) }
      : {}),
    ...(request.level === 'full-safe'
      ? {
          worldEvents: [
            ...agentFiltered.flatMap(({ actionResult }) =>
              actionResult.accepted &&
              actionResult.event.type !== 'hex-captured'
                ? [structuredClone(actionResult.event)]
                : [],
            ),
            ...simulatedPlayerEventsIncluded,
          ],
        }
      : {}),
    ...(include.controlChanges
      ? { controlChanges: structuredClone(controlChanges) }
      : {}),
    ...(exportedSwarmTicks ? { swarmTicks: exportedSwarmTicks } : {}),
    ...(source.schemaVersion === 10 || source.schemaVersion === 11
      ? {
          tickSummaries: summarizeTicks(
            (source.swarmTicks ?? []).filter(
              (tick) =>
                tickNumbers === 'all' || tickNumbers.has(tick.tickNumber),
            ),
            providerAttempts,
          ),
        }
      : {}),
    ...(source.schemaVersion === 11
      ? {
          providerAttempts,
          attemptRetention: {
            ...source.attemptRetention!,
            requestedRangeExtendsBeyondRetention:
              source.attemptRetention!.droppedRecords > 0,
          },
          attemptAccounting: source.attemptAccounting!,
        }
      : {}),
  };
  return experimentExportDocumentSchema.parse(document);
}

function exportWorldState(world: WorldSnapshot): ExperimentExportWorldState {
  return {
    generatedAt: world.generatedAt,
    hexes: structuredClone(world.hexes),
    agents: structuredClone(world.agents),
    simulatedPlayer: structuredClone(world.simulatedPlayer),
  };
}

function currentTerritory(world: WorldSnapshot, agents: readonly Agent[]) {
  const counts = new Map<AgentId, number>(agents.map(({ id }) => [id, 0]));
  for (const hex of world.hexes) {
    if (hex.state === 'infected' && hex.controllerAgentId !== null)
      counts.set(
        hex.controllerAgentId,
        (counts.get(hex.controllerAgentId) ?? 0) + 1,
      );
  }
  return agents.map(({ id, name, color }) => ({
    agentId: id,
    name,
    color,
    controlledCellCount: counts.get(id) ?? 0,
  }));
}

export function createExperimentPreview(
  source: ExperimentSource,
  request: unknown,
  generatedAt: string,
): ExperimentExportPreview {
  const document = createExperimentExport(source, request, generatedAt);
  const serialized = serializeExperimentExport(document);
  const serializedUtf8Bytes = new TextEncoder().encode(serialized).byteLength;
  const ledgerKnownCost = (document.providerAttempts ?? []).reduce(
    (sum, attempt) => sum + Number(attempt.actualCostCredits ?? 0),
    0,
  );
  const ledgerUnknownCost = (document.providerAttempts ?? []).filter(
    ({ actualCostCredits }) => actualCostCredits === undefined,
  ).length;
  return experimentExportPreviewSchema.parse({
    experimentId: source.id,
    ...(document.selection.matchingTickCount === undefined
      ? {}
      : { matchingTickCount: document.selection.matchingTickCount }),
    ...(document.selection.matchingSwarmTickCount === undefined
      ? {}
      : { matchingSwarmTickCount: document.selection.matchingSwarmTickCount }),
    matchingControlChangeCount: document.selection.matchingControlChangeCount,
    matchingProviderAttemptCount:
      document.selection.matchingProviderAttemptCount ?? 0,
    selectedAgentCount: document.selection.selectedAgentIds.length,
    retention: document.retention,
    knownCostCredits:
      document.schemaVersion === 11
        ? ledgerKnownCost
        : (document.metrics?.aggregate.knownCostCredits ?? 0),
    attemptsWithUnknownCost:
      document.schemaVersion === 11
        ? ledgerUnknownCost
        : (document.metrics?.aggregate.attemptsWithUnknownCost ?? 0),
    serializedUtf8Bytes,
    approximateAiInputTokens: Math.ceil(serializedUtf8Bytes / 4),
    tokenEstimateMethod: 'ceil(UTF-8 bytes / 4)',
  });
}

function resolveAgentIds(
  source: ExperimentSource,
  request: ExperimentExportRequest,
): AgentId[] {
  const known = new Set([
    ...source.initialAgents.map(({ id }) => id),
    ...source.currentAgents.map(({ id }) => id),
  ]);
  const selected =
    request.agents.mode === 'all' ? [...known] : request.agents.agentIds;
  if (selected.some((id) => !known.has(id))) {
    throw new ExperimentExportValidationError(
      'unknown_agent',
      'One or more selected agents do not exist.',
    );
  }
  return [...selected];
}

function filterProviderAttempts(
  source: ExperimentSource,
  selected: Set<AgentId>,
  tickNumbers: Set<number> | 'all',
): ProviderAttemptRecord[] {
  let attempts = (source.providerAttempts ?? []).filter(({ agentId }) =>
    selected.has(agentId),
  );
  if (tickNumbers !== 'all')
    attempts = attempts.filter(
      ({ intendedTickNumber }) =>
        intendedTickNumber !== undefined && tickNumbers.has(intendedTickNumber),
    );
  return structuredClone(attempts).sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.id.localeCompare(right.id),
  );
}

function filterControlChanges(
  requestFiltered: readonly ResolvedWorldAction[],
  request: ExperimentExportRequest,
  selected: Set<AgentId>,
): ExportedControlChange[] {
  if (
    !request.outcomes.includes('accepted') ||
    !request.actions.includes('capture')
  )
    return [];
  return requestFiltered.flatMap(({ tickNumber, actionResult }) => {
    if (!actionResult.accepted || actionResult.event.type !== 'hex-captured')
      return [];
    const event = actionResult.event;
    if (
      !selected.has(event.controllerAgentId) &&
      (event.previousControllerAgentId === null ||
        !selected.has(event.previousControllerAgentId))
    )
      return [];
    return [{ ...structuredClone(event), originatingTurn: tickNumber }];
  });
}

function rangeExtendsBeyondRetention(
  request: ExperimentExportRequest,
  source: ExperimentSource,
  first?: number,
  last?: number,
): boolean {
  if (request.turns.mode === 'entire-retained')
    return source.totalCompletedTicks > (source.swarmTicks?.length ?? 0);
  if (request.turns.mode !== 'range') return false;
  if (!first || !last) return true;
  return request.turns.fromTurn < first || request.turns.toTurn > last;
}

function inclusionsFor(request: ExperimentExportRequest) {
  if (request.level === 'custom') {
    const custom = request.custom!;
    return {
      metrics: custom.computedMetrics,
      initialWorld: custom.initialWorldState,
      currentWorld: custom.currentWorldState,
      controlChanges: custom.controlChanges,
    };
  }
  return {
    metrics: true,
    initialWorld: request.level === 'full-safe',
    currentWorld: request.level === 'full-safe',
    controlChanges: true,
  };
}

function summarizeTicks(
  ticks: readonly SwarmTickRecord[],
  attempts: readonly ProviderAttemptRecord[],
): ExperimentTickSummary[] {
  return ticks.map((tick) => {
    const tickAttempts = attempts.filter(
      ({ intendedTickNumber }) => intendedTickNumber === tick.tickNumber,
    );
    const latencies = tickAttempts.flatMap(({ provider }) =>
      provider ? [provider.latencyMs] : [],
    );
    const knownCosts = tickAttempts.flatMap(({ actualCostCredits }) =>
      actualCostCredits === undefined ? [] : [Number(actualCostCredits)],
    );
    return {
      tickNumber: tick.tickNumber,
      virtualTime: tick.virtualTime,
      intervalMinutes: tick.tickIntervalMinutes,
      agentRecordCount: Math.max(
        1,
        tick.workers.length + (tick.zeroActionResult ? 1 : 0),
      ),
      lostTicks: 0,
      deadlineMisses: 0,
      providerCallCount: tickAttempts.length,
      aggregateDecisionLatencyMs: latencies.reduce(
        (total, latency) => total + latency,
        0,
      ),
      maximumDecisionLatencyMs: Math.max(0, ...latencies),
      knownCostCredits: knownCosts.reduce((total, cost) => total + cost, 0),
      attemptsWithUnknownCost: tickAttempts.length - knownCosts.length,
    };
  });
}

function attemptMetrics(attempts: readonly ProviderAttemptRecord[]) {
  const failedModelAttempts = attempts.filter(
    ({ outcome }) => outcome !== 'completed',
  ).length;
  const automaticRepairAttempts = attempts.filter(
    ({ kind }) => kind === 'automatic-repair',
  ).length;
  const automaticTransportRetries = attempts.filter(
    ({ kind }) => kind === 'automatic-transport-retry',
  ).length;
  const manualRetryAttempts = attempts.filter(
    ({ kind }) => kind === 'manual-retry',
  ).length;
  const unattendedRetryAttempts = attempts.filter(
    ({ kind }) => kind === 'unattended-retry',
  ).length;
  const groups = new Map<string, ProviderAttemptRecord[]>();
  for (const attempt of attempts) {
    const key = `${attempt.agentId}:${attempt.intendedTickNumber ?? attempt.intendedTurnNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  const retriedGroups = [...groups.values()].filter((group) =>
    group.some((attempt) => attempt.kind !== 'initial'),
  );
  const recovered = (predicate: (group: ProviderAttemptRecord[]) => boolean) =>
    retriedGroups.filter(
      (group) =>
        predicate(group) &&
        group.some((attempt) => attempt.outcome === 'completed'),
    ).length;
  const latencies = attempts.flatMap(({ provider }) =>
    provider ? [provider.latencyMs] : [],
  );
  const tokens: Record<string, number> = {};
  for (const field of metricTokenFields) {
    const known = attempts
      .map(({ provider }) => provider?.[field])
      .filter((value): value is number => value !== undefined);
    if (known.length > 0)
      tokens[field] = known.reduce((sum, value) => sum + value, 0);
  }
  const attemptsWithUnknownTokenUsage = attempts.filter(({ provider }) =>
    metricTokenFields.some((field) => provider?.[field] === undefined),
  ).length;
  const costs = attempts.flatMap(({ actualCostCredits }) =>
    actualCostCredits === undefined ? [] : [Number(actualCostCredits)],
  );
  return {
    modelCalls: attempts.length,
    failedModelAttempts,
    automaticRepairAttempts,
    automaticTransportRetries,
    manualRetryAttempts,
    unattendedRetryAttempts,
    retriedTurns: retriedGroups.length,
    recoveredByUnattendedRetry: recovered(
      (group) =>
        group.some((attempt) => attempt.kind === 'unattended-retry') &&
        !group.some((attempt) => attempt.kind === 'manual-retry'),
    ),
    recoveredManually: recovered((group) =>
      group.some((attempt) => attempt.kind === 'manual-retry'),
    ),
    recoveredAutomatically: recovered(
      (group) => !group.some((attempt) => attempt.kind === 'manual-retry'),
    ),
    recoveredByRetry: recovered(() => true),
    ...(latencies.length > 0
      ? {
          averageLatencyMs:
            latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
        }
      : {}),
    tokens,
    tokenUsageComplete: attemptsWithUnknownTokenUsage === 0,
    attemptsWithUnknownTokenUsage,
    knownCostCredits: costs.reduce((sum, value) => sum + value, 0),
    attemptsWithUnknownCost: attempts.filter(
      ({ actualCostCredits }) => actualCostCredits === undefined,
    ).length,
  };
}

function metricCountsFor(
  scopeActions: readonly ResolvedWorldAction[],
  scopeAttempts: readonly ProviderAttemptRecord[],
  controlChanges: readonly ExportedControlChange[],
  scopedAgentIds: readonly AgentId[],
  agentId?: AgentId,
) {
  const accepted = scopeActions.filter(
    ({ actionResult }) => actionResult.accepted,
  ).length;
  const rejected = scopeActions.length - accepted;
  const visited = new Set<string>();
  const firstMove = scopeActions.find(
    ({ actionResult }) =>
      actionResult.accepted && actionResult.event.type === 'agent-moved',
  );
  if (
    firstMove &&
    firstMove.actionResult.accepted &&
    firstMove.actionResult.event.type === 'agent-moved'
  )
    visited.add(firstMove.actionResult.event.fromCell);
  for (const { actionResult } of scopeActions)
    if (actionResult.accepted && actionResult.event.type === 'agent-moved')
      visited.add(actionResult.event.toCell);
  const successfullyInfectedCells = scopeActions.filter(
    ({ actionResult }) =>
      actionResult.accepted && actionResult.event.type === 'hex-infected',
  ).length;
  const territoryGainedThroughCapture = agentId
    ? controlChanges.filter(
        ({ controllerAgentId }) => controllerAgentId === agentId,
      ).length
    : controlChanges.filter(({ controllerAgentId }) =>
        scopedAgentIds.includes(controllerAgentId),
      ).length;
  const territoryLostThroughCapture = agentId
    ? controlChanges.filter(
        ({ previousControllerAgentId }) =>
          previousControllerAgentId === agentId,
      ).length
    : controlChanges.filter(
        ({ previousControllerAgentId }) =>
          previousControllerAgentId !== null &&
          scopedAgentIds.includes(previousControllerAgentId),
      ).length;
  return {
    totalTurns: scopeActions.length,
    accepted,
    rejected,
    providerErrors: 0,
    requestedMoves: scopeActions.filter(({ action }) => action.type === 'move')
      .length,
    requestedInfections: scopeActions.filter(
      ({ action }) => action.type === 'infect',
    ).length,
    requestedCaptures: scopeActions.filter(
      ({ action }) => action.type === 'capture',
    ).length,
    requestedWaits: scopeActions.filter(({ action }) => action.type === 'wait')
      .length,
    acceptedMovements: scopeActions.filter(
      ({ actionResult }) =>
        actionResult.accepted && actionResult.event.type === 'agent-moved',
    ).length,
    successfullyInfectedCells,
    successfulCaptures: scopeActions.filter(
      ({ actionResult }) =>
        actionResult.accepted && actionResult.event.type === 'hex-captured',
    ).length,
    acceptedWaits: scopeActions.filter(
      ({ actionResult }) =>
        actionResult.accepted && actionResult.event.type === 'agent-waited',
    ).length,
    rejectedWorldActions: rejected,
    territoryGainedThroughInfection: successfullyInfectedCells,
    territoryGainedThroughCapture,
    territoryLostThroughCapture,
    uniqueVisitedCells: visited.size,
    ...attemptMetrics(scopeAttempts),
  };
}

export function calculateExperimentMetrics(
  resolvedActions: readonly ResolvedWorldAction[],
  agentIds: readonly AgentId[],
  providerAttempts: readonly ProviderAttemptRecord[] = [],
  controlChanges: readonly ExportedControlChange[] = [],
): ExperimentMetrics {
  return experimentMetricsSchema.parse({
    aggregate: metricCountsFor(
      resolvedActions,
      providerAttempts,
      controlChanges,
      agentIds,
    ),
    byAgent: agentIds.map((agentId) => ({
      agentId,
      metrics: metricCountsFor(
        resolvedActions.filter((action) => action.agentId === agentId),
        providerAttempts.filter((attempt) => attempt.agentId === agentId),
        controlChanges,
        [agentId],
        agentId,
      ),
    })),
  });
}

export function serializeExperimentExport(
  document: ExperimentExportDocument,
): string {
  return document.filters.serialization === 'pretty'
    ? JSON.stringify(document, null, 2)
    : JSON.stringify(document);
}
