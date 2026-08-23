import {
  AGENT_DECISION_CONTRACT_VERSION,
  experimentExportDocumentSchema,
  experimentExportPreviewSchema,
  experimentExportRequestSchema,
  experimentMetricsSchema,
  PERSONALITY_PROFILES,
  NEUTRAL_AGENT_COLOR,
  STRATEGY_PROFILES,
  type Agent,
  type AgentId,
  type AgentObservation,
  type AgentTurnRecord,
  type EventId,
  type AllianceEvent,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentExportRequest,
  type ExperimentExportWorldState,
  type ExperimentId,
  type ExperimentMetrics,
  type ExperimentModelConfiguration,
  type ModelId,
  type ReasoningProfile,
  type DiplomacyRejectionReason,
  type DiplomacyResult,
  type ExportedCommunication,
  type ExportedControlChange,
  type ExperimentConfigurationEvent,
  type ProviderMetadata,
  type WorldSnapshot,
  type BehaviorConfiguration,
  type AppliedScenario,
  type ExperimentTickSummary,
  type AgentGoalState,
  type MemoryEntry,
} from '@hexzero/shared';

export interface ExperimentSource {
  schemaVersion: 9 | 10;
  id: ExperimentId;
  startedAt: string;
  providerMode: 'openrouter' | 'scripted-test';
  retentionLimit: number;
  totalCompletedTurns: number;
  turns: readonly AgentTurnRecord[];
  initialAgents: readonly Agent[];
  currentAgents: readonly Agent[];
  configurationEvents: readonly ExperimentConfigurationEvent[];
  initialWorld: WorldSnapshot;
  currentWorld: WorldSnapshot;
  modelConfiguration: ExperimentModelConfiguration;
  behaviorConfiguration: BehaviorConfiguration;
  scenario: AppliedScenario;
  agentGoals: readonly { agentId: AgentId; goal: AgentGoalState | null }[];
  agentMemories: readonly { agentId: AgentId; entries: MemoryEntry[] }[];
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

export class ExperimentMetricAccumulator {
  readonly #records = new Map<AgentId | 'aggregate', MutableMetrics>();

  constructor(agentIds: readonly AgentId[]) {
    this.#records.set('aggregate', mutableMetrics());
    for (const agentId of agentIds)
      this.#records.set(agentId, mutableMetrics());
  }

  add(turn: AgentTurnRecord): void {
    addToMutable(this.#records.get('aggregate')!, turn, true);
    const agent = this.#records.get(turn.agentId);
    if (agent) addToMutable(agent, turn);
    for (const event of turn.allianceEvents)
      for (const affectedId of allianceEventAgentIds(event)) {
        if (affectedId === turn.agentId) continue;
        const affected = this.#records.get(affectedId);
        if (affected) addAllianceEventMetric(affected, event, affectedId);
      }
    if (
      turn.outcome !== 'provider-error' &&
      turn.outcome !== 'lost-tick' &&
      turn.outcome !== 'operator-skipped' &&
      turn.communicationResult.requested &&
      turn.communicationResult.accepted &&
      turn.communicationResult.event.channel === 'direct'
    ) {
      const recipient = this.#records.get(
        turn.communicationResult.event.recipientId,
      );
      if (recipient) recipient.directMessagesReceived += 1;
    }
    if (
      turn.outcome !== 'provider-error' &&
      turn.outcome !== 'lost-tick' &&
      turn.outcome !== 'operator-skipped' &&
      turn.communicationResult.requested &&
      turn.communicationResult.accepted &&
      turn.communicationResult.event.channel === 'zero'
    ) {
      for (const recipientId of turn.communicationResult.event.recipientIds) {
        const recipient = this.#records.get(recipientId);
        if (recipient) {
          recipient.zeroRecipientDeliveries += 1;
          recipient.zeroDirectiveRecipients.add(recipientId);
        }
      }
    }
    if (
      turn.outcome === 'accepted' &&
      turn.worldActionResult.event.type === 'hex-captured'
    ) {
      const displaced = this.#records.get(
        turn.worldActionResult.event.previousControllerAgentId,
      );
      if (displaced) displaced.territoryLostThroughCapture += 1;
    }
  }

  snapshot(agentIds: readonly AgentId[]): ExperimentMetrics {
    return experimentMetricsSchema.parse({
      aggregate: finalizeMutable(this.#records.get('aggregate')!),
      byAgent: agentIds.map((agentId) => ({
        agentId,
        metrics: finalizeMutable(
          this.#records.get(agentId) ?? mutableMetrics(),
        ),
      })),
    });
  }
}

function addAllianceEventMetric(
  metrics: MutableMetrics,
  event: AllianceEvent,
  agentId?: AgentId,
): void {
  if (agentId && !allianceEventAgentIds(event).includes(agentId)) return;
  if (event.type === 'alliance-proposed') {
    if (!agentId || event.agentId === agentId) {
      metrics.proposalsCreated += 1;
      metrics.proposalsSent += 1;
    }
    if (!agentId || event.recipientAgentId === agentId)
      metrics.proposalsReceived += 1;
  } else if (event.type === 'alliance-proposal-closed') {
    if (event.reason === 'expired') metrics.proposalsExpired += 1;
    else metrics.proposalsInvalidated += 1;
  } else if (event.type === 'alliance-formed') {
    metrics.alliancesFormed += 1;
    metrics.alliancesJoined += agentId ? 1 : event.memberAgentIds.length;
  } else if (event.type === 'agent-joined-alliance') {
    if (!agentId || event.joinedAgentId === agentId)
      metrics.alliancesJoined += 1;
  } else if (event.type === 'agent-left-alliance') {
    if (!agentId || event.leftAgentId === agentId) metrics.alliancesLeft += 1;
  } else if (event.type === 'alliance-dissolved')
    metrics.alliancesDissolved += 1;
}

const metricTokenFields = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'reasoningTokens',
  'cachedReadTokens',
  'cacheWriteTokens',
] as const;

interface MutableMetrics {
  turns: number;
  accepted: number;
  rejected: number;
  providerErrors: number;
  lostTicks: number;
  operatorSkipped: number;
  modelCalls: number;
  failedModelAttempts: number;
  automaticRepairAttempts: number;
  automaticTransportRetries: number;
  manualRetryAttempts: number;
  unattendedRetryAttempts: number;
  manualSkips: number;
  unattendedSkips: number;
  recoveredByUnattendedRetry: number;
  skippedAfterUnattendedRecovery: number;
  retriedTurns: number;
  recoveredAutomatically: number;
  recoveredManually: number;
  recoveredByRetry: number;
  requestedMoves: number;
  requestedInfections: number;
  requestedCaptures: number;
  requestedWaits: number;
  acceptedMovements: number;
  infections: number;
  successfulCaptures: number;
  acceptedWaits: number;
  rejectedWorldActions: number;
  territoryGainedThroughInfection: number;
  territoryGainedThroughCapture: number;
  territoryLostThroughCapture: number;
  publicMessagesRequested: number;
  publicMessagesAccepted: number;
  publicMessagesRejected: number;
  directMessagesRequested: number;
  allianceMessagesRequested: number;
  allianceMessagesDelivered: number;
  allianceMessagesRejected: number;
  directMessagesDelivered: number;
  directMessagesRejected: number;
  publicMessagesSent: number;
  directMessagesSent: number;
  directMessagesReceived: number;
  zeroBroadcastsRequested: number;
  zeroBroadcastsDelivered: number;
  zeroBroadcastsRejected: number;
  zeroRecipientDeliveries: number;
  zeroDirectiveRecipients: Set<AgentId>;
  patientZeroRepliers: Set<AgentId>;
  directRepliesToPatientZero: number;
  firstZeroDirectiveTurn: number | null;
  mostRecentZeroDirective: {
    eventId: EventId;
    turnNumber: number;
    occurredAt: string;
    agentId: AgentId;
    recipientCount: number;
    modelId: ModelId;
    reasoningProfile: ReasoningProfile;
    personalityId: AgentObservation['behavior']['personalityId'];
    strategyId: AgentObservation['behavior']['strategyId'];
  } | null;
  diplomacyProposalsRequested: number;
  diplomacyAcceptancesRequested: number;
  diplomacyDeparturesRequested: number;
  diplomacyProposalsAccepted: number;
  diplomacyAcceptancesAccepted: number;
  diplomacyDeparturesAccepted: number;
  diplomacyRejected: number;
  diplomacyRejections: Map<
    string,
    {
      type:
        'propose-alliance' | 'accept-alliance' | 'leave-alliance' | 'invalid';
      reason: DiplomacyRejectionReason;
      count: number;
    }
  >;
  proposalsCreated: number;
  proposalsSent: number;
  proposalsReceived: number;
  proposalsExpired: number;
  proposalsInvalidated: number;
  alliancesFormed: number;
  alliancesJoined: number;
  alliancesLeft: number;
  alliancesDissolved: number;
  alliedCaptureAttempts: number;
  alliedCaptureRejections: number;
  latencyTotal: number;
  latencyCount: number;
  tokens: Record<(typeof metricTokenFields)[number], number>;
  tokenFieldsComplete: Record<(typeof metricTokenFields)[number], boolean>;
  tokenFieldsKnown: Record<(typeof metricTokenFields)[number], boolean>;
  knownCostCredits: string;
  attemptsWithUnknownTokenUsage: number;
  attemptsWithUnknownCost: number;
  turnsWithUnknownCost: Set<number>;
  visited: Set<string>;
}

function mutableMetrics(): MutableMetrics {
  return {
    turns: 0,
    accepted: 0,
    rejected: 0,
    providerErrors: 0,
    lostTicks: 0,
    operatorSkipped: 0,
    modelCalls: 0,
    failedModelAttempts: 0,
    automaticRepairAttempts: 0,
    automaticTransportRetries: 0,
    manualRetryAttempts: 0,
    unattendedRetryAttempts: 0,
    manualSkips: 0,
    unattendedSkips: 0,
    recoveredByUnattendedRetry: 0,
    skippedAfterUnattendedRecovery: 0,
    retriedTurns: 0,
    recoveredAutomatically: 0,
    recoveredManually: 0,
    recoveredByRetry: 0,
    requestedMoves: 0,
    requestedInfections: 0,
    requestedCaptures: 0,
    requestedWaits: 0,
    acceptedMovements: 0,
    infections: 0,
    successfulCaptures: 0,
    acceptedWaits: 0,
    rejectedWorldActions: 0,
    territoryGainedThroughInfection: 0,
    territoryGainedThroughCapture: 0,
    territoryLostThroughCapture: 0,
    publicMessagesRequested: 0,
    publicMessagesAccepted: 0,
    publicMessagesRejected: 0,
    directMessagesRequested: 0,
    allianceMessagesRequested: 0,
    allianceMessagesDelivered: 0,
    allianceMessagesRejected: 0,
    directMessagesDelivered: 0,
    directMessagesRejected: 0,
    publicMessagesSent: 0,
    directMessagesSent: 0,
    directMessagesReceived: 0,
    zeroBroadcastsRequested: 0,
    zeroBroadcastsDelivered: 0,
    zeroBroadcastsRejected: 0,
    zeroRecipientDeliveries: 0,
    zeroDirectiveRecipients: new Set(),
    patientZeroRepliers: new Set(),
    directRepliesToPatientZero: 0,
    firstZeroDirectiveTurn: null,
    mostRecentZeroDirective: null,
    diplomacyProposalsRequested: 0,
    diplomacyAcceptancesRequested: 0,
    diplomacyDeparturesRequested: 0,
    diplomacyProposalsAccepted: 0,
    diplomacyAcceptancesAccepted: 0,
    diplomacyDeparturesAccepted: 0,
    diplomacyRejected: 0,
    diplomacyRejections: new Map(),
    proposalsCreated: 0,
    proposalsSent: 0,
    proposalsReceived: 0,
    proposalsExpired: 0,
    proposalsInvalidated: 0,
    alliancesFormed: 0,
    alliancesJoined: 0,
    alliancesLeft: 0,
    alliancesDissolved: 0,
    alliedCaptureAttempts: 0,
    alliedCaptureRejections: 0,
    latencyTotal: 0,
    latencyCount: 0,
    tokens: Object.fromEntries(
      metricTokenFields.map((field) => [field, 0]),
    ) as MutableMetrics['tokens'],
    tokenFieldsComplete: Object.fromEntries(
      metricTokenFields.map((field) => [field, true]),
    ) as MutableMetrics['tokenFieldsComplete'],
    tokenFieldsKnown: Object.fromEntries(
      metricTokenFields.map((field) => [field, false]),
    ) as MutableMetrics['tokenFieldsKnown'],
    knownCostCredits: '0',
    attemptsWithUnknownTokenUsage: 0,
    attemptsWithUnknownCost: 0,
    turnsWithUnknownCost: new Set(),
    visited: new Set(),
  };
}

function addToMutable(
  metrics: MutableMetrics,
  turn: AgentTurnRecord,
  aggregate = false,
): void {
  metrics.turns += 1;
  if (turn.outcome === 'provider-error') metrics.providerErrors += 1;
  else if (turn.outcome === 'lost-tick') metrics.lostTicks += 1;
  else if (turn.outcome === 'operator-skipped') {
    metrics.operatorSkipped += 1;
    if (turn.skipKind === 'unattended') {
      metrics.unattendedSkips += 1;
      metrics.skippedAfterUnattendedRecovery += 1;
    } else metrics.manualSkips += 1;
  } else metrics[turn.outcome] += 1;
  metrics.visited.add(turn.observation.currentCell.cell);
  if (
    turn.outcome !== 'provider-error' &&
    turn.outcome !== 'lost-tick' &&
    turn.outcome !== 'operator-skipped'
  ) {
    if (turn.worldAction.type === 'move') metrics.requestedMoves += 1;
    if (turn.worldAction.type === 'infect') metrics.requestedInfections += 1;
    if (turn.worldAction.type === 'capture') metrics.requestedCaptures += 1;
    if (turn.worldAction.type === 'wait') metrics.requestedWaits += 1;
    if (turn.outcome === 'rejected') metrics.rejectedWorldActions += 1;
    if (turn.communicationResult.requested) {
      const channel = turn.communicationResult.accepted
        ? turn.communicationResult.event.channel
        : turn.communicationResult.attempt.channel;
      if (channel === 'public') metrics.publicMessagesRequested += 1;
      else if (channel === 'direct') metrics.directMessagesRequested += 1;
      else if (channel === 'alliance') metrics.allianceMessagesRequested += 1;
      else metrics.zeroBroadcastsRequested += 1;
      if (turn.communicationResult.accepted) {
        if (turn.communicationResult.event.channel === 'public') {
          metrics.publicMessagesAccepted += 1;
          metrics.publicMessagesSent += 1;
        } else if (turn.communicationResult.event.channel === 'direct') {
          metrics.directMessagesDelivered += 1;
          metrics.directMessagesSent += 1;
          if (aggregate) metrics.directMessagesReceived += 1;
        } else if (turn.communicationResult.event.channel === 'alliance')
          metrics.allianceMessagesDelivered += 1;
        else {
          metrics.zeroBroadcastsDelivered += 1;
          metrics.zeroRecipientDeliveries +=
            turn.communicationResult.event.recipientIds.length;
          for (const id of turn.communicationResult.event.recipientIds)
            metrics.zeroDirectiveRecipients.add(id);
          metrics.firstZeroDirectiveTurn ??= turn.turnNumber;
          metrics.mostRecentZeroDirective = {
            eventId: turn.communicationResult.event.id,
            turnNumber: turn.turnNumber,
            occurredAt: turn.communicationResult.event.occurredAt,
            agentId: turn.agentId,
            recipientCount: turn.communicationResult.event.recipientIds.length,
            modelId: turn.provider.model,
            reasoningProfile:
              turn.modelAttempts.at(-1)?.reasoningProfile ?? 'provider-default',
            personalityId: turn.observation.behavior.personalityId,
            strategyId: turn.observation.behavior.strategyId,
          };
        }
      } else if (turn.communicationResult.attempt.channel === 'public') {
        metrics.publicMessagesRejected += 1;
      } else if (turn.communicationResult.attempt.channel === 'direct')
        metrics.directMessagesRejected += 1;
      else if (turn.communicationResult.attempt.channel === 'alliance')
        metrics.allianceMessagesRejected += 1;
      else metrics.zeroBroadcastsRejected += 1;
    }
    if (
      turn.communicationResult.requested &&
      turn.communicationResult.accepted &&
      turn.communicationResult.event.channel === 'direct' &&
      turn.observation.patientZero.agentId !== null &&
      turn.agentId !== turn.observation.patientZero.agentId &&
      turn.communicationResult.event.recipientId ===
        turn.observation.patientZero.agentId
    ) {
      metrics.directRepliesToPatientZero += 1;
      metrics.patientZeroRepliers.add(turn.agentId);
    }
    if (turn.diplomacyResult.requested) {
      const type = turn.diplomacyResult.accepted
        ? turn.diplomacyResult.intent.type
        : turn.diplomacyResult.attempt.type;
      if (type === 'propose-alliance') metrics.diplomacyProposalsRequested += 1;
      if (type === 'accept-alliance')
        metrics.diplomacyAcceptancesRequested += 1;
      if (type === 'leave-alliance') metrics.diplomacyDeparturesRequested += 1;
      if (!turn.diplomacyResult.accepted) {
        metrics.diplomacyRejected += 1;
        const key = `${type}:${turn.diplomacyResult.reason}`;
        const existing = metrics.diplomacyRejections.get(key);
        metrics.diplomacyRejections.set(key, {
          type,
          reason: turn.diplomacyResult.reason,
          count: (existing?.count ?? 0) + 1,
        });
      } else if (type === 'propose-alliance')
        metrics.diplomacyProposalsAccepted += 1;
      else if (type === 'accept-alliance')
        metrics.diplomacyAcceptancesAccepted += 1;
      else metrics.diplomacyDeparturesAccepted += 1;
    }
    if (
      turn.worldAction.type === 'capture' &&
      !turn.worldActionResult.accepted &&
      turn.worldActionResult.reason === 'allied-controller'
    ) {
      metrics.alliedCaptureAttempts += 1;
      metrics.alliedCaptureRejections += 1;
    }
  }
  for (const event of turn.allianceEvents)
    addAllianceEventMetric(
      metrics,
      event,
      aggregate ? undefined : turn.agentId,
    );
  if (
    turn.outcome === 'accepted' &&
    turn.worldActionResult.event.type === 'agent-moved'
  ) {
    metrics.acceptedMovements += 1;
    metrics.visited.add(turn.worldActionResult.event.toCell);
  }
  if (
    turn.outcome === 'accepted' &&
    turn.worldActionResult.event.type === 'hex-infected'
  ) {
    metrics.infections += 1;
    metrics.territoryGainedThroughInfection += 1;
  }
  if (
    turn.outcome === 'accepted' &&
    turn.worldActionResult.event.type === 'hex-captured'
  ) {
    metrics.successfulCaptures += 1;
    metrics.territoryGainedThroughCapture += 1;
    if (aggregate) metrics.territoryLostThroughCapture += 1;
  }
  if (
    turn.outcome === 'accepted' &&
    turn.worldActionResult.event.type === 'agent-waited'
  )
    metrics.acceptedWaits += 1;
  const attempts = usageAttempts(turn);
  metrics.modelCalls += attempts.length;
  metrics.failedModelAttempts += attempts.filter(({ failed }) => failed).length;
  metrics.automaticRepairAttempts += attempts.filter(
    ({ kind }) => kind === 'automatic-repair',
  ).length;
  metrics.automaticTransportRetries += attempts.filter(
    ({ kind }) => kind === 'automatic-transport-retry',
  ).length;
  metrics.manualRetryAttempts += attempts.filter(
    ({ kind }) => kind === 'manual-retry',
  ).length;
  metrics.unattendedRetryAttempts += attempts.filter(
    ({ kind }) => kind === 'unattended-retry',
  ).length;
  const retried = attempts.some(({ kind }) => kind !== 'initial');
  const manuallyRetried = attempts.some(({ kind }) => kind === 'manual-retry');
  const unattendedRetried = attempts.some(
    ({ kind }) => kind === 'unattended-retry',
  );
  if (retried) metrics.retriedTurns += 1;
  if (
    retried &&
    turn.outcome !== 'provider-error' &&
    turn.outcome !== 'lost-tick' &&
    turn.outcome !== 'operator-skipped'
  )
    metrics.recoveredByRetry += 1;
  if (
    retried &&
    turn.outcome !== 'provider-error' &&
    turn.outcome !== 'lost-tick' &&
    turn.outcome !== 'operator-skipped'
  ) {
    if (manuallyRetried) metrics.recoveredManually += 1;
    else if (unattendedRetried) {
      metrics.recoveredAutomatically += 1;
      metrics.recoveredByUnattendedRetry += 1;
    } else metrics.recoveredAutomatically += 1;
  }
  for (const { provider } of attempts) {
    if (provider) {
      metrics.latencyTotal += provider.latencyMs;
      metrics.latencyCount += 1;
    }
    for (const field of metricTokenFields) {
      const value = provider?.[field];
      if (value === undefined) metrics.tokenFieldsComplete[field] = false;
      else {
        metrics.tokens[field] += value;
        metrics.tokenFieldsKnown[field] = true;
      }
    }
    if (metricTokenFields.some((field) => provider?.[field] === undefined))
      metrics.attemptsWithUnknownTokenUsage += 1;
    if (provider?.costCredits === undefined) {
      metrics.attemptsWithUnknownCost += 1;
      metrics.turnsWithUnknownCost.add(turn.turnNumber);
    } else
      metrics.knownCostCredits = addDecimalValue(
        metrics.knownCostCredits,
        provider.costCredits,
      );
  }
}

function usageAttempts(turn: AgentTurnRecord) {
  if (turn.modelAttempts.length > 0)
    return turn.modelAttempts.map((attempt) => ({
      provider: attempt.provider,
      failed: attempt.failure !== undefined,
      kind: attempt.kind,
    }));
  return turn.provider
    ? [
        {
          provider: turn.provider,
          failed:
            turn.outcome === 'provider-error' || turn.outcome === 'lost-tick',
          kind: 'initial' as const,
        },
      ]
    : [];
}

function finalizeMutable(metrics: MutableMetrics) {
  const tokens: Record<string, number> = {};
  if (metrics.turns > 0)
    for (const field of metricTokenFields)
      if (metrics.tokenFieldsKnown[field])
        tokens[field] = metrics.tokens[field];
  return {
    totalTurns: metrics.turns,
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    providerErrors: metrics.providerErrors,
    lostTicks: metrics.lostTicks,
    operatorSkipped: metrics.operatorSkipped,
    modelCalls: metrics.modelCalls,
    failedModelAttempts: metrics.failedModelAttempts,
    automaticRepairAttempts: metrics.automaticRepairAttempts,
    automaticTransportRetries: metrics.automaticTransportRetries,
    manualRetryAttempts: metrics.manualRetryAttempts,
    unattendedRetryAttempts: metrics.unattendedRetryAttempts,
    manualSkips: metrics.manualSkips,
    unattendedSkips: metrics.unattendedSkips,
    recoveredByUnattendedRetry: metrics.recoveredByUnattendedRetry,
    skippedAfterUnattendedRecovery: metrics.skippedAfterUnattendedRecovery,
    retriedTurns: metrics.retriedTurns,
    recoveredAutomatically: metrics.recoveredAutomatically,
    recoveredManually: metrics.recoveredManually,
    recoveredByRetry: metrics.recoveredByRetry,
    requestedMoves: metrics.requestedMoves,
    requestedInfections: metrics.requestedInfections,
    requestedCaptures: metrics.requestedCaptures,
    requestedWaits: metrics.requestedWaits,
    acceptedMovements: metrics.acceptedMovements,
    successfullyInfectedCells: metrics.infections,
    successfulCaptures: metrics.successfulCaptures,
    acceptedWaits: metrics.acceptedWaits,
    rejectedWorldActions: metrics.rejectedWorldActions,
    territoryGainedThroughInfection: metrics.territoryGainedThroughInfection,
    territoryGainedThroughCapture: metrics.territoryGainedThroughCapture,
    territoryLostThroughCapture: metrics.territoryLostThroughCapture,
    publicMessagesRequested: metrics.publicMessagesRequested,
    publicMessagesAccepted: metrics.publicMessagesAccepted,
    publicMessagesRejected: metrics.publicMessagesRejected,
    directMessagesRequested: metrics.directMessagesRequested,
    directMessagesDelivered: metrics.directMessagesDelivered,
    directMessagesRejected: metrics.directMessagesRejected,
    allianceMessagesRequested: metrics.allianceMessagesRequested,
    allianceMessagesDelivered: metrics.allianceMessagesDelivered,
    allianceMessagesRejected: metrics.allianceMessagesRejected,
    publicMessagesSent: metrics.publicMessagesSent,
    directMessagesSent: metrics.directMessagesSent,
    directMessagesReceived: metrics.directMessagesReceived,
    zeroBroadcastsRequested: metrics.zeroBroadcastsRequested,
    zeroBroadcastsDelivered: metrics.zeroBroadcastsDelivered,
    zeroBroadcastsRejected: metrics.zeroBroadcastsRejected,
    zeroRecipientDeliveries: metrics.zeroRecipientDeliveries,
    uniqueZeroDirectiveRecipients: metrics.zeroDirectiveRecipients.size,
    directRepliesToPatientZero: metrics.directRepliesToPatientZero,
    uniquePatientZeroRepliers: metrics.patientZeroRepliers.size,
    firstZeroDirectiveTurn: metrics.firstZeroDirectiveTurn,
    mostRecentZeroDirective: metrics.mostRecentZeroDirective,
    diplomacyProposalsRequested: metrics.diplomacyProposalsRequested,
    diplomacyAcceptancesRequested: metrics.diplomacyAcceptancesRequested,
    diplomacyDeparturesRequested: metrics.diplomacyDeparturesRequested,
    diplomacyProposalsAccepted: metrics.diplomacyProposalsAccepted,
    diplomacyAcceptancesAccepted: metrics.diplomacyAcceptancesAccepted,
    diplomacyDeparturesAccepted: metrics.diplomacyDeparturesAccepted,
    diplomacyRejected: metrics.diplomacyRejected,
    diplomacyRejections: [...metrics.diplomacyRejections.values()],
    proposalsCreated: metrics.proposalsCreated,
    proposalsSent: metrics.proposalsSent,
    proposalsReceived: metrics.proposalsReceived,
    proposalsExpired: metrics.proposalsExpired,
    proposalsInvalidated: metrics.proposalsInvalidated,
    alliancesFormed: metrics.alliancesFormed,
    alliancesJoined: metrics.alliancesJoined,
    alliancesLeft: metrics.alliancesLeft,
    alliancesDissolved: metrics.alliancesDissolved,
    alliedCaptureAttempts: metrics.alliedCaptureAttempts,
    alliedCaptureRejections: metrics.alliedCaptureRejections,
    uniqueVisitedCells: metrics.visited.size,
    ...(metrics.latencyCount > 0
      ? { averageLatencyMs: metrics.latencyTotal / metrics.latencyCount }
      : {}),
    tokens,
    tokenUsageComplete: metrics.attemptsWithUnknownTokenUsage === 0,
    attemptsWithUnknownTokenUsage: metrics.attemptsWithUnknownTokenUsage,
    knownCostCredits: Number(metrics.knownCostCredits),
    attemptsWithUnknownCost: metrics.attemptsWithUnknownCost,
    turnsWithUnknownCost: metrics.turnsWithUnknownCost.size,
  };
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
  const filtered = filterTurns(source, request, selectedSet);
  const communications = filterCommunications(source, request, selectedSet);
  const controlChanges = filterControlChanges(source, request, selectedSet);
  const allianceEvents = filterAllianceEvents(source, request, selectedSet);
  const firstRetainedTurn = source.turns[0]?.turnNumber;
  const lastRetainedTurn = source.turns.at(-1)?.turnNumber;
  const requestedRangeExtendsBeyondRetention = rangeExtendsBeyondRetention(
    request,
    source,
    firstRetainedTurn,
    lastRetainedTurn,
  );
  const droppedRecords = source.totalCompletedTurns - source.turns.length;
  const retention = {
    limit: source.retentionLimit,
    totalCompletedTurns: source.totalCompletedTurns,
    retainedTurns: source.turns.length,
    firstRetainedTurn,
    lastRetainedTurn,
    droppedRecords,
    complete: droppedRecords === 0,
    requestedRangeExtendsBeyondRetention,
  };
  const include = inclusionsFor(request);
  const selectedAgents = source.currentAgents
    .filter(({ id }) => selectedSet.has(id))
    .map((agent) =>
      include.personality
        ? structuredClone(agent)
        : {
            id: agent.id,
            name: agent.name,
            color: agent.color,
            currentCell: agent.currentCell,
          },
    );
  const document: ExperimentExportDocument = {
    schemaVersion: source.schemaVersion,
    generatedAt,
    experiment: {
      id: source.id,
      startedAt: source.startedAt,
      providerMode: source.providerMode,
      decisionContractVersion: AGENT_DECISION_CONTRACT_VERSION,
      modelConfiguration: structuredClone(source.modelConfiguration),
      behaviorConfiguration: structuredClone(source.behaviorConfiguration),
      scenario: structuredClone(source.scenario),
      ...(request.level === 'full-safe'
        ? { initialAgents: structuredClone([...source.initialAgents]) }
        : {}),
    },
    retention,
    filters: structuredClone(request),
    selection: {
      selectedAgentIds,
      matchingTurnCount: filtered.length,
      ...(source.schemaVersion === 10
        ? {
            matchingTickCount: new Set(
              filtered.map(({ tickNumber }) => tickNumber).filter(Boolean),
            ).size,
          }
        : {}),
      matchingCommunicationCount: communications.length,
      matchingControlChangeCount: controlChanges.length,
      matchingDiplomacyEventCount: allianceEvents.length,
      firstMatchingTurn: filtered[0]?.turnNumber,
      lastMatchingTurn: filtered.at(-1)?.turnNumber,
    },
    agents: selectedAgents,
    currentGoals: source.agentGoals
      .filter(({ agentId }) => selectedSet.has(agentId))
      .map((entry) => structuredClone(entry)),
    currentMemories: source.agentMemories
      .filter(({ agentId }) => selectedSet.has(agentId))
      .map((entry) => structuredClone(entry)),
    configurationEvents: source.configurationEvents
      .filter((event) =>
        'type' in event
          ? event.scope === 'global' ||
            (event.agentId !== undefined && selectedSet.has(event.agentId))
          : include.personalityHistory && selectedSet.has(event.agentId),
      )
      .map((event) => structuredClone(event)),
    ...(include.metrics
      ? {
          metrics: calculateExperimentMetrics(
            filtered,
            selectedAgentIds,
            communications,
            controlChanges,
            allianceEvents,
          ),
          currentTerritory: currentTerritory(
            source.currentWorld,
            source.currentAgents,
          ),
          currentAlliances: currentAlliances(
            source.currentWorld,
            source.currentAgents,
          ),
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
          worldEvents: filtered.flatMap((turn) => {
            if (
              turn.outcome !== 'accepted' ||
              turn.worldActionResult.event.type === 'hex-captured'
            )
              return [];
            return [structuredClone(turn.worldActionResult.event)];
          }),
        }
      : {}),
    ...(include.communications
      ? { communications: structuredClone(communications) }
      : {}),
    ...(include.controlChanges
      ? { controlChanges: structuredClone(controlChanges) }
      : {}),
    allianceEvents: structuredClone(allianceEvents),
    turns: filtered.map((turn) => exportTurn(turn, request)),
    ...(source.schemaVersion === 10
      ? { tickSummaries: summarizeTicks(filtered) }
      : {}),
  };
  return experimentExportDocumentSchema.parse(document);
}

function exportWorldState(world: WorldSnapshot): ExperimentExportWorldState {
  return {
    generatedAt: world.generatedAt,
    hexes: structuredClone(world.hexes),
    agents: structuredClone(world.agents),
    alliances: structuredClone(world.alliances),
    pendingAllianceProposals: structuredClone(world.pendingAllianceProposals),
  };
}

function currentTerritory(world: WorldSnapshot, agents: readonly Agent[]) {
  const counts = new Map<AgentId, number>(agents.map(({ id }) => [id, 0]));
  for (const hex of world.hexes) {
    if (hex.state === 'infected')
      counts.set(
        hex.controllerAgentId,
        (counts.get(hex.controllerAgentId) ?? 0) + 1,
      );
  }
  return agents.map(({ id, name, color }) => {
    const alliance = world.alliances.find(({ memberAgentIds }) =>
      memberAgentIds.includes(id),
    );
    return {
      agentId: id,
      name,
      color,
      allianceId: alliance?.id ?? null,
      effectiveColor: alliance?.color ?? NEUTRAL_AGENT_COLOR,
      controlledCellCount: counts.get(id) ?? 0,
    };
  });
}

function currentAlliances(world: WorldSnapshot, agents: readonly Agent[]) {
  const territory = currentTerritory(world, agents);
  return world.alliances.map((alliance) => {
    const members = alliance.memberAgentIds.map((agentId) => {
      const entry = territory.find(
        (candidate) => candidate.agentId === agentId,
      )!;
      return {
        agentId,
        name: entry.name,
        controlledCellCount: entry.controlledCellCount,
      };
    });
    return {
      allianceId: alliance.id,
      color: alliance.color,
      totalControlledCellCount: members.reduce(
        (sum, member) => sum + member.controlledCellCount,
        0,
      ),
      members,
    };
  });
}

export function createExperimentPreview(
  source: ExperimentSource,
  request: unknown,
  generatedAt: string,
): ExperimentExportPreview {
  const document = createExperimentExport(source, request, generatedAt);
  const serialized = serializeExperimentExport(document);
  const serializedUtf8Bytes = new TextEncoder().encode(serialized).byteLength;
  const metrics = calculateExperimentMetrics(
    filterTurns(
      source,
      document.filters,
      new Set(document.selection.selectedAgentIds),
    ),
    document.selection.selectedAgentIds,
    filterCommunications(
      source,
      document.filters,
      new Set(document.selection.selectedAgentIds),
    ),
    filterControlChanges(
      source,
      document.filters,
      new Set(document.selection.selectedAgentIds),
    ),
    filterAllianceEvents(
      source,
      document.filters,
      new Set(document.selection.selectedAgentIds),
    ),
  );
  return experimentExportPreviewSchema.parse({
    experimentId: source.id,
    matchingTurnCount: document.selection.matchingTurnCount,
    ...(document.selection.matchingTickCount === undefined
      ? {}
      : { matchingTickCount: document.selection.matchingTickCount }),
    matchingCommunicationCount: document.selection.matchingCommunicationCount,
    matchingControlChangeCount: document.selection.matchingControlChangeCount,
    matchingDiplomacyEventCount: document.selection.matchingDiplomacyEventCount,
    selectedAgentCount: document.selection.selectedAgentIds.length,
    firstMatchingTurn: document.selection.firstMatchingTurn,
    lastMatchingTurn: document.selection.lastMatchingTurn,
    retention: document.retention,
    knownCostCredits: metrics.aggregate.knownCostCredits,
    attemptsWithUnknownCost: metrics.aggregate.attemptsWithUnknownCost,
    turnsWithUnknownCost: metrics.aggregate.turnsWithUnknownCost,
    serializedUtf8Bytes,
    approximateAiInputTokens: Math.ceil(serializedUtf8Bytes / 4),
    tokenEstimateMethod: 'ceil(UTF-8 bytes / 4)',
  });
}

function resolveAgentIds(
  source: ExperimentSource,
  request: ExperimentExportRequest,
): AgentId[] {
  const known = new Set(source.currentAgents.map(({ id }) => id));
  const selected =
    request.agents.mode === 'all'
      ? source.currentAgents.map(({ id }) => id)
      : request.agents.agentIds;
  if (selected.some((id) => !known.has(id))) {
    throw new ExperimentExportValidationError(
      'unknown_agent',
      'One or more selected agents do not exist.',
    );
  }
  return [...selected];
}

function filterTurns(
  source: ExperimentSource,
  request: ExperimentExportRequest,
  selected: Set<AgentId>,
): AgentTurnRecord[] {
  let turns = source.turns.filter(
    (turn) =>
      selected.has(turn.agentId) &&
      request.outcomes.includes(turn.outcome) &&
      (turn.outcome === 'provider-error' ||
        turn.outcome === 'lost-tick' ||
        turn.outcome === 'operator-skipped' ||
        request.actions.includes(turn.worldAction.type)),
  );
  if (request.turns.mode === 'range') {
    const range = request.turns;
    turns = turns.filter(
      ({ turnNumber }) =>
        turnNumber >= range.fromTurn && turnNumber <= range.toTurn,
    );
  } else if (request.turns.mode === 'latest') {
    turns = turns.slice(-request.turns.count);
  }
  return turns.map((turn) => structuredClone(turn));
}

function filterCommunications(
  source: ExperimentSource,
  request: ExperimentExportRequest,
  selected: Set<AgentId>,
): ExportedCommunication[] {
  let communications = source.turns.flatMap((turn) => {
    if (
      turn.outcome === 'provider-error' ||
      turn.outcome === 'lost-tick' ||
      turn.outcome === 'operator-skipped' ||
      !turn.communicationResult.requested
    )
      return [];
    const result = turn.communicationResult;
    const communication = result.accepted ? result.event : result.attempt;
    const selectedByParticipant =
      communication.channel !== 'direct'
        ? selected.has(communication.agentId)
        : selected.has(communication.agentId) ||
          (communication.recipientId !== null &&
            selected.has(communication.recipientId));
    const selectedByChannel =
      request.communications.channel === 'all' ||
      request.communications.channel === communication.channel;
    const status = result.accepted
      ? ('accepted' as const)
      : ('rejected' as const);
    const selectedByStatus =
      request.communications.status === 'all' ||
      request.communications.status === status;
    if (!selectedByParticipant || !selectedByChannel || !selectedByStatus)
      return [];
    return [
      {
        ...structuredClone(communication),
        originatingTurn: turn.turnNumber,
        status,
        ...(!result.accepted
          ? {
              rejectionReason: result.reason,
              rejectionDetails: result.details,
            }
          : {}),
      },
    ];
  });
  if (request.turns.mode === 'range') {
    const range = request.turns;
    communications = communications.filter(
      ({ originatingTurn }) =>
        originatingTurn >= range.fromTurn && originatingTurn <= range.toTurn,
    );
  } else if (request.turns.mode === 'latest') {
    const firstIncludedTurn = source.turns.at(-request.turns.count)?.turnNumber;
    communications = firstIncludedTurn
      ? communications.filter(
          ({ originatingTurn }) => originatingTurn >= firstIncludedTurn,
        )
      : communications;
  }
  return communications;
}

function filterControlChanges(
  source: ExperimentSource,
  request: ExperimentExportRequest,
  selected: Set<AgentId>,
): ExportedControlChange[] {
  if (
    !request.outcomes.includes('accepted') ||
    !request.actions.includes('capture')
  )
    return [];
  let controlChanges = source.turns.flatMap((turn) => {
    if (
      turn.outcome !== 'accepted' ||
      turn.worldActionResult.event.type !== 'hex-captured' ||
      (!selected.has(turn.worldActionResult.event.controllerAgentId) &&
        !selected.has(turn.worldActionResult.event.previousControllerAgentId))
    )
      return [];
    return [
      {
        ...structuredClone(turn.worldActionResult.event),
        originatingTurn: turn.turnNumber,
      },
    ];
  });
  if (request.turns.mode === 'range') {
    const range = request.turns;
    controlChanges = controlChanges.filter(
      ({ originatingTurn }) =>
        originatingTurn >= range.fromTurn && originatingTurn <= range.toTurn,
    );
  } else if (request.turns.mode === 'latest') {
    controlChanges = controlChanges.slice(-request.turns.count);
  }
  return controlChanges;
}

function filterAllianceEvents(
  source: ExperimentSource,
  request: ExperimentExportRequest,
  selected: Set<AgentId>,
): AllianceEvent[] {
  let events = source.turns.flatMap(({ allianceEvents }) =>
    allianceEvents.filter((event) =>
      allianceEventAgentIds(event).some((id) => selected.has(id)),
    ),
  );
  if (request.turns.mode === 'range') {
    const range = request.turns;
    events = events.filter(
      ({ turnNumber }) =>
        turnNumber >= range.fromTurn && turnNumber <= range.toTurn,
    );
  } else if (request.turns.mode === 'latest') {
    const first = source.turns.at(-request.turns.count)?.turnNumber;
    if (first) events = events.filter(({ turnNumber }) => turnNumber >= first);
  }
  return events.map((event) => structuredClone(event));
}

function allianceEventAgentIds(event: AllianceEvent): AgentId[] {
  if (event.type === 'alliance-proposed')
    return [event.agentId, event.recipientAgentId];
  if (event.type === 'alliance-proposal-closed')
    return [event.proposerAgentId, event.recipientAgentId];
  if (event.type === 'alliance-formed') return event.memberAgentIds;
  if (event.type === 'agent-joined-alliance') return event.memberAgentIds;
  if (event.type === 'agent-left-alliance')
    return [event.leftAgentId, ...event.remainingMemberAgentIds];
  return event.formerMemberAgentIds;
}

function rangeExtendsBeyondRetention(
  request: ExperimentExportRequest,
  source: ExperimentSource,
  first?: number,
  last?: number,
): boolean {
  if (request.turns.mode === 'entire-retained')
    return source.totalCompletedTurns > source.turns.length;
  if (request.turns.mode !== 'range') return false;
  if (!first || !last) return true;
  return request.turns.fromTurn < first || request.turns.toTurn > last;
}

function inclusionsFor(request: ExperimentExportRequest) {
  if (request.level === 'full-safe')
    return {
      personality: true,
      personalityHistory: true,
      metrics: true,
      initialWorld: true,
      currentWorld: true,
      communications: true,
      controlChanges: true,
    };
  if (request.level === 'custom') {
    const custom = request.custom!;
    return {
      personality: custom.personalityTextHistory,
      personalityHistory: custom.personalityTextHistory,
      metrics: custom.computedMetrics,
      initialWorld: custom.initialWorldState,
      currentWorld: custom.currentWorldState,
      communications: custom.communications,
      controlChanges: custom.controlChanges,
    };
  }
  return {
    personality: true,
    personalityHistory: false,
    metrics: true,
    initialWorld: false,
    currentWorld: false,
    communications: true,
    controlChanges: true,
  };
}

function compactProvider(provider: ProviderMetadata): ProviderMetadata {
  return {
    provider: provider.provider,
    model: provider.model,
    ...(provider.selectedModel === undefined
      ? {}
      : { selectedModel: provider.selectedModel }),
    ...(provider.resolvedModel === undefined
      ? {}
      : { resolvedModel: provider.resolvedModel }),
    ...(provider.requestId === undefined
      ? {}
      : { requestId: provider.requestId }),
    ...(provider.httpStatus === undefined
      ? {}
      : { httpStatus: provider.httpStatus }),
    ...(provider.finishReason === undefined
      ? {}
      : { finishReason: provider.finishReason }),
    ...(provider.nativeFinishReason === undefined
      ? {}
      : { nativeFinishReason: provider.nativeFinishReason }),
    latencyMs: provider.latencyMs,
    ...(provider.promptTokens === undefined
      ? {}
      : { promptTokens: provider.promptTokens }),
    ...(provider.completionTokens === undefined
      ? {}
      : { completionTokens: provider.completionTokens }),
    ...(provider.totalTokens === undefined
      ? {}
      : { totalTokens: provider.totalTokens }),
    ...(provider.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: provider.reasoningTokens }),
    ...(provider.cachedReadTokens === undefined
      ? {}
      : { cachedReadTokens: provider.cachedReadTokens }),
    ...(provider.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: provider.cacheWriteTokens }),
    ...(provider.costCredits === undefined
      ? {}
      : { costCredits: provider.costCredits }),
  };
}

function exportTurn(
  turn: AgentTurnRecord,
  request: ExperimentExportRequest,
): ExperimentExportDocument['turns'][number] {
  const standard = request.level === 'standard';
  const full = request.level === 'full-safe';
  const custom = request.level === 'custom' ? request.custom! : undefined;
  const includeObservation = full || standard || custom?.turnObservations;
  const includePersonality = full || standard || custom?.personalityTextHistory;
  const includeValidation = full || standard || custom?.validationDetails;
  const includeEvent = full || standard || custom?.resultingEvents;
  const includeProvider =
    request.level !== 'custom' || Boolean(custom?.providerUsageMetadata);
  const base: ExperimentExportDocument['turns'][number] = {
    turnNumber: turn.turnNumber,
    ...(turn.tickNumber === undefined ? {} : { tickNumber: turn.tickNumber }),
    ...(turn.tickPosition === undefined
      ? {}
      : { tickPosition: turn.tickPosition }),
    ...(turn.virtualTime === undefined
      ? {}
      : { virtualTime: turn.virtualTime }),
    ...(turn.tickIntervalMinutes === undefined
      ? {}
      : { tickIntervalMinutes: turn.tickIntervalMinutes }),
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    agentId: turn.agentId,
    behavior: structuredClone(turn.behavior ?? turn.observation.behavior),
    outcome: turn.outcome,
    modelAttempts: turn.modelAttempts.map((attempt) => ({
      ...structuredClone(attempt),
      ...(includeProvider ? {} : { provider: undefined }),
    })),
    ...(turn.outcome === 'provider-error' ||
    turn.outcome === 'lost-tick' ||
    turn.outcome === 'operator-skipped'
      ? { failure: structuredClone(turn.failure) }
      : {
          worldAction: structuredClone(turn.worldAction),
          ...(turn.communication
            ? { communication: structuredClone(turn.communication) }
            : {}),
          ...(turn.diplomacy
            ? { diplomacy: structuredClone(turn.diplomacy) }
            : {}),
          ...(turn.goalRevision
            ? { goalRevision: structuredClone(turn.goalRevision) }
            : {}),
          goalRevisionResult: structuredClone(turn.goalRevisionResult),
          ...(turn.memoryOperation
            ? { memoryOperation: structuredClone(turn.memoryOperation) }
            : {}),
          memoryOperationResult: structuredClone(turn.memoryOperationResult),
          summary: turn.summary,
          worldActionSummary: turn.worldActionResult.accepted
            ? summarizeEvent(turn.worldActionResult.event)
            : `Rejected: ${turn.worldActionResult.reason}.`,
          ...(turn.communicationResult.requested
            ? {
                communicationSummary: turn.communicationResult.accepted
                  ? summarizeCommunication(
                      turn.communicationResult.event.channel,
                      turn.communicationResult.event.channel === 'direct'
                        ? turn.communicationResult.event.recipientId
                        : undefined,
                      turn.communicationResult.event.channel === 'direct'
                        ? turn.communicationResult.event.distance
                        : undefined,
                    )
                  : `Rejected: ${turn.communicationResult.reason}.`,
              }
            : {}),
          ...(turn.diplomacyResult.requested
            ? {
                diplomacySummary: turn.diplomacyResult.accepted
                  ? `Accepted: ${turn.diplomacyResult.intent.type}.`
                  : `Rejected: ${turn.diplomacyResult.reason}.`,
              }
            : {}),
        }),
  };
  if (includePersonality) base.personality = turn.observation.personality;
  if (includeObservation) {
    const observation: Partial<AgentObservation> = structuredClone(
      turn.observation,
    );
    if (!includePersonality) delete observation.personality;
    if (custom && !custom.nearbyAgents) delete observation.nearbyAgents;
    if (custom && !custom.recentEvents) delete observation.recentEvents;
    if (custom && !custom.recentPublicMessages)
      delete observation.recentPublicMessages;
    if (custom && !custom.recentDirectMessages)
      delete observation.recentDirectMessages;
    if (custom && !custom.recentControlChanges)
      delete observation.recentControlChanges;
    base.observation = observation;
  }
  if (
    turn.outcome !== 'provider-error' &&
    turn.outcome !== 'lost-tick' &&
    turn.outcome !== 'operator-skipped' &&
    (includeValidation || includeEvent)
  ) {
    base.worldActionResult = structuredClone(turn.worldActionResult);
    base.communicationResult = structuredClone(turn.communicationResult);
    base.diplomacyResult = structuredClone(turn.diplomacyResult);
  }
  if (includeProvider && turn.provider)
    base.provider = full
      ? structuredClone(turn.provider)
      : compactProvider(turn.provider);
  return base;
}

function summarizeTicks(
  records: readonly AgentTurnRecord[],
): ExperimentTickSummary[] {
  const groups = new Map<number, AgentTurnRecord[]>();
  for (const record of records) {
    if (record.tickNumber === undefined) continue;
    groups.set(record.tickNumber, [
      ...(groups.get(record.tickNumber) ?? []),
      record,
    ]);
  }
  return [...groups.entries()].map(([tickNumber, tickRecords]) => {
    const attempts = tickRecords.flatMap(({ modelAttempts }) => modelAttempts);
    const latencies = attempts.map(
      ({ provider, failure }) => provider?.latencyMs ?? failure?.latencyMs ?? 0,
    );
    const knownCosts = attempts.flatMap(({ provider }) =>
      provider?.costCredits === undefined ? [] : [provider.costCredits],
    );
    return {
      tickNumber,
      virtualTime: tickRecords[0]!.virtualTime!,
      intervalMinutes: tickRecords[0]!.tickIntervalMinutes!,
      agentRecordCount: tickRecords.length,
      lostTicks: tickRecords.filter(({ outcome }) => outcome === 'lost-tick')
        .length,
      deadlineMisses: tickRecords.filter(
        (record) =>
          record.outcome === 'lost-tick' && record.failure.code === 'timeout',
      ).length,
      providerCallCount: attempts.length,
      aggregateDecisionLatencyMs: latencies.reduce(
        (total, latency) => total + latency,
        0,
      ),
      maximumDecisionLatencyMs: Math.max(0, ...latencies),
      knownCostCredits: knownCosts.reduce((total, cost) => total + cost, 0),
      attemptsWithUnknownCost: attempts.length - knownCosts.length,
    };
  });
}

function summarizeEvent(
  event: Extract<
    AgentTurnRecord,
    { outcome: 'accepted' }
  >['worldActionResult']['event'],
): string {
  if (event.type === 'agent-moved')
    return `Moved from ${event.fromCell} to ${event.toCell}.`;
  if (event.type === 'hex-infected') return `Infected ${event.cell}.`;
  if (event.type === 'hex-captured')
    return `Captured ${event.cell} from ${event.previousControllerAgentId}.`;
  return 'Waited.';
}

function summarizeCommunication(
  channel: 'public' | 'direct' | 'alliance' | 'zero',
  recipientId?: AgentId,
  distance?: number,
): string {
  return channel === 'public'
    ? 'Published to world chat.'
    : channel === 'alliance'
      ? 'Delivered to current alliance members.'
      : channel === 'zero'
        ? 'Delivered privately to all other active agents.'
        : `Delivered directly to ${recipientId} from distance ${distance}.`;
}

export function calculateExperimentMetrics(
  turns: readonly AgentTurnRecord[],
  agentIds: readonly AgentId[],
  communications: readonly ExportedCommunication[] = [],
  controlChanges: readonly ExportedControlChange[] = [],
  allianceEvents: readonly AllianceEvent[] = [],
): ExperimentMetrics {
  const metricFor = (
    records: readonly AgentTurnRecord[],
    relevantCommunications: readonly ExportedCommunication[],
    relevantControlChanges: readonly ExportedControlChange[],
    agentId?: AgentId,
    scopedAgentIds: readonly AgentId[] = agentIds,
  ) => {
    const attempts = records.flatMap(usageAttempts);
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
    const visited = new Set<string>();
    for (const turn of records) {
      visited.add(turn.observation.currentCell.cell);
      if (
        turn.outcome === 'accepted' &&
        turn.worldActionResult.event.type === 'agent-moved'
      )
        visited.add(turn.worldActionResult.event.toCell);
    }
    const costs = attempts.flatMap(({ provider }) =>
      provider?.costCredits === undefined ? [] : [provider.costCredits],
    );
    const manualRetryAttempts = attempts.filter(
      ({ kind }) => kind === 'manual-retry',
    ).length;
    const automaticRepairAttempts = attempts.filter(
      ({ kind }) => kind === 'automatic-repair',
    ).length;
    const automaticTransportRetries = attempts.filter(
      ({ kind }) => kind === 'automatic-transport-retry',
    ).length;
    const retriedTurns = records.filter((turn) =>
      usageAttempts(turn).some(({ kind }) => kind !== 'initial'),
    );
    const movement = movementMetrics(records);
    const mostRecentZeroTurn = records.findLast(
      (turn) =>
        turn.outcome !== 'provider-error' &&
        turn.outcome !== 'lost-tick' &&
        turn.outcome !== 'operator-skipped' &&
        turn.communicationResult.requested &&
        turn.communicationResult.accepted &&
        turn.communicationResult.event.channel === 'zero',
    );
    const mostRecentZeroDirective =
      mostRecentZeroTurn &&
      mostRecentZeroTurn.outcome !== 'provider-error' &&
      mostRecentZeroTurn.outcome !== 'lost-tick' &&
      mostRecentZeroTurn.outcome !== 'operator-skipped' &&
      mostRecentZeroTurn.communicationResult.requested &&
      mostRecentZeroTurn.communicationResult.accepted &&
      mostRecentZeroTurn.communicationResult.event.channel === 'zero'
        ? {
            eventId: mostRecentZeroTurn.communicationResult.event.id,
            turnNumber: mostRecentZeroTurn.turnNumber,
            occurredAt: mostRecentZeroTurn.communicationResult.event.occurredAt,
            agentId: mostRecentZeroTurn.agentId,
            recipientCount:
              mostRecentZeroTurn.communicationResult.event.recipientIds.length,
            modelId: mostRecentZeroTurn.provider.model,
            reasoningProfile:
              mostRecentZeroTurn.modelAttempts.at(-1)?.reasoningProfile ??
              'provider-default',
            personalityId:
              mostRecentZeroTurn.observation.behavior.personalityId,
            strategyId: mostRecentZeroTurn.observation.behavior.strategyId,
          }
        : null;
    return {
      totalTurns: records.length,
      accepted: records.filter(({ outcome }) => outcome === 'accepted').length,
      rejected: records.filter(({ outcome }) => outcome === 'rejected').length,
      providerErrors: records.filter(
        ({ outcome }) => outcome === 'provider-error',
      ).length,
      lostTicks: records.filter(({ outcome }) => outcome === 'lost-tick')
        .length,
      operatorSkipped: records.filter(
        ({ outcome }) => outcome === 'operator-skipped',
      ).length,
      modelCalls: attempts.length,
      failedModelAttempts: attempts.filter(({ failed }) => failed).length,
      automaticRepairAttempts,
      automaticTransportRetries,
      manualRetryAttempts,
      retriedTurns: retriedTurns.length,
      recoveredAutomatically: retriedTurns.filter(
        (turn) =>
          !usageAttempts(turn).some(({ kind }) => kind === 'manual-retry') &&
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped',
      ).length,
      recoveredManually: retriedTurns.filter(
        (turn) =>
          usageAttempts(turn).some(({ kind }) => kind === 'manual-retry') &&
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped',
      ).length,
      recoveredByRetry: retriedTurns.filter(
        ({ outcome }) =>
          outcome !== 'provider-error' &&
          outcome !== 'lost-tick' &&
          outcome !== 'operator-skipped',
      ).length,
      requestedMoves: records.filter(
        (turn) =>
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped' &&
          turn.worldAction.type === 'move',
      ).length,
      requestedInfections: records.filter(
        (turn) =>
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped' &&
          turn.worldAction.type === 'infect',
      ).length,
      requestedCaptures: records.filter(
        (turn) =>
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped' &&
          turn.worldAction.type === 'capture',
      ).length,
      requestedWaits: records.filter(
        (turn) =>
          turn.outcome !== 'provider-error' &&
          turn.outcome !== 'lost-tick' &&
          turn.outcome !== 'operator-skipped' &&
          turn.worldAction.type === 'wait',
      ).length,
      acceptedMovements: records.filter(
        (turn) =>
          turn.outcome === 'accepted' &&
          turn.worldActionResult.event.type === 'agent-moved',
      ).length,
      successfullyInfectedCells: records.filter(
        (turn) =>
          turn.outcome === 'accepted' &&
          turn.worldActionResult.event.type === 'hex-infected',
      ).length,
      successfulCaptures: records.filter(
        (turn) =>
          turn.outcome === 'accepted' &&
          turn.worldActionResult.event.type === 'hex-captured',
      ).length,
      acceptedWaits: records.filter(
        (turn) =>
          turn.outcome === 'accepted' &&
          turn.worldActionResult.event.type === 'agent-waited',
      ).length,
      rejectedWorldActions: records.filter(
        ({ outcome }) => outcome === 'rejected',
      ).length,
      territoryGainedThroughInfection: records.filter(
        (turn) =>
          turn.outcome === 'accepted' &&
          turn.worldActionResult.event.type === 'hex-infected',
      ).length,
      territoryGainedThroughCapture: agentId
        ? relevantControlChanges.filter(
            ({ controllerAgentId }) => controllerAgentId === agentId,
          ).length
        : relevantControlChanges.filter(({ controllerAgentId }) =>
            scopedAgentIds.includes(controllerAgentId),
          ).length,
      territoryLostThroughCapture: agentId
        ? relevantControlChanges.filter(
            ({ previousControllerAgentId }) =>
              previousControllerAgentId === agentId,
          ).length
        : relevantControlChanges.filter(({ previousControllerAgentId }) =>
            scopedAgentIds.includes(previousControllerAgentId),
          ).length,
      ...communicationMetrics(relevantCommunications, scopedAgentIds, agentId),
      mostRecentZeroDirective,
      ...diplomacyMetrics(
        records,
        agentId
          ? allianceEvents
          : allianceEvents.filter((event) =>
              scopedAgentIds.includes(event.agentId),
            ),
        agentId,
      ),
      uniqueVisitedCells: visited.size,
      eligibleNearbyAgentObservations: records.reduce(
        (sum, turn) =>
          sum +
          turn.observation.nearbyAgents.filter(
            ({ directMessageLegal }) => directMessageLegal,
          ).length,
        0,
      ),
      ...movement,
      ...(latencies.length > 0
        ? {
            averageLatencyMs:
              latencies.reduce((sum, value) => sum + value, 0) /
              latencies.length,
          }
        : {}),
      tokens,
      tokenUsageComplete: attemptsWithUnknownTokenUsage === 0,
      attemptsWithUnknownTokenUsage,
      knownCostCredits: sumDecimalNumbers(costs),
      attemptsWithUnknownCost: attempts.filter(
        ({ provider }) => provider?.costCredits === undefined,
      ).length,
      turnsWithUnknownCost: records.filter((turn) =>
        usageAttempts(turn).some(
          ({ provider }) => provider?.costCredits === undefined,
        ),
      ).length,
    };
  };
  const assignmentFor = (turn: AgentTurnRecord) =>
    turn.behavior ?? turn.observation.behavior;
  const metricsForBehavior = (matches: (turn: AgentTurnRecord) => boolean) => {
    const records = turns.filter(matches);
    const scopedAgentIds = [...new Set(records.map(({ agentId }) => agentId))];
    return metricFor(
      records,
      communications,
      controlChanges,
      undefined,
      scopedAgentIds,
    );
  };
  const combinations = [
    ...new Map(
      turns.map((turn) => {
        const assignment = assignmentFor(turn);
        return [
          `${assignment.personalityId}:${assignment.strategyId}`,
          assignment,
        ];
      }),
    ).values(),
  ];
  return experimentMetricsSchema.parse({
    aggregate: metricFor(turns, communications, controlChanges),
    byAgent: agentIds.map((agentId) => ({
      agentId,
      metrics: metricFor(
        turns.filter((turn) => turn.agentId === agentId),
        communications,
        controlChanges,
        agentId,
      ),
    })),
    byPersonality: PERSONALITY_PROFILES.map(({ id: personalityId }) => ({
      personalityId,
      metrics: metricsForBehavior(
        (turn) => assignmentFor(turn).personalityId === personalityId,
      ),
    })),
    byStrategy: STRATEGY_PROFILES.map(({ id: strategyId }) => ({
      strategyId,
      metrics: metricsForBehavior(
        (turn) => assignmentFor(turn).strategyId === strategyId,
      ),
    })),
    byBehaviorCombination: combinations.map(
      ({ personalityId, strategyId }) => ({
        personalityId,
        strategyId,
        metrics: metricsForBehavior((turn) => {
          const assignment = assignmentFor(turn);
          return (
            assignment.personalityId === personalityId &&
            assignment.strategyId === strategyId
          );
        }),
      }),
    ),
  });
}

function diplomacyMetrics(
  records: readonly AgentTurnRecord[],
  events: readonly AllianceEvent[],
  agentId?: AgentId,
) {
  const relevantEvents = agentId
    ? events.filter((event) => allianceEventAgentIds(event).includes(agentId))
    : events;
  const completed = records.filter(
    (
      turn,
    ): turn is Exclude<
      AgentTurnRecord,
      { outcome: 'provider-error' | 'lost-tick' | 'operator-skipped' }
    > & {
      diplomacyResult: Exclude<DiplomacyResult, { requested: false }>;
    } =>
      turn.outcome !== 'provider-error' &&
      turn.outcome !== 'lost-tick' &&
      turn.outcome !== 'operator-skipped' &&
      turn.diplomacyResult.requested,
  );
  const requested = (type: string) =>
    completed.filter((turn) => {
      const result = turn.diplomacyResult;
      return (
        result.requested &&
        (result.accepted ? result.intent.type : result.attempt.type) === type
      );
    });
  const accepted = (type: string) =>
    requested(type).filter(
      (turn) => turn.diplomacyResult.requested && turn.diplomacyResult.accepted,
    ).length;
  const formed = relevantEvents.filter(
    (event): event is Extract<AllianceEvent, { type: 'alliance-formed' }> =>
      event.type === 'alliance-formed',
  );
  const completedDurations = formed.flatMap((created) => {
    const dissolved = relevantEvents.find(
      (event) =>
        event.type === 'alliance-dissolved' &&
        event.allianceId === created.allianceId &&
        event.turnNumber >= created.turnNumber,
    );
    return dissolved ? [dissolved.turnNumber - created.turnNumber] : [];
  });
  const allianceSizes = relevantEvents.flatMap((event) =>
    event.type === 'alliance-formed'
      ? [event.memberAgentIds.length]
      : event.type === 'agent-joined-alliance'
        ? [event.memberAgentIds.length]
        : [],
  );
  return {
    diplomacyProposalsRequested: requested('propose-alliance').length,
    diplomacyAcceptancesRequested: requested('accept-alliance').length,
    diplomacyDeparturesRequested: requested('leave-alliance').length,
    diplomacyProposalsAccepted: accepted('propose-alliance'),
    diplomacyAcceptancesAccepted: accepted('accept-alliance'),
    diplomacyDeparturesAccepted: accepted('leave-alliance'),
    diplomacyRejected: completed.filter(
      (turn) => !turn.diplomacyResult.accepted,
    ).length,
    diplomacyRejections: groupedDiplomacyRejections(completed),
    proposalsCreated: relevantEvents.filter(
      (event) =>
        event.type === 'alliance-proposed' &&
        (!agentId || event.agentId === agentId),
    ).length,
    proposalsSent: relevantEvents.filter(
      (event) =>
        event.type === 'alliance-proposed' &&
        (!agentId || event.agentId === agentId),
    ).length,
    proposalsReceived: relevantEvents.filter(
      (event) =>
        event.type === 'alliance-proposed' &&
        (!agentId || event.recipientAgentId === agentId),
    ).length,
    proposalsExpired: relevantEvents.filter(
      (event) =>
        event.type === 'alliance-proposal-closed' && event.reason === 'expired',
    ).length,
    proposalsInvalidated: relevantEvents.filter(
      (event) =>
        event.type === 'alliance-proposal-closed' &&
        event.reason === 'invalidated',
    ).length,
    alliancesFormed: relevantEvents.filter(
      (event) => event.type === 'alliance-formed',
    ).length,
    alliancesJoined: relevantEvents.reduce(
      (count, event) =>
        count +
        (event.type === 'alliance-formed'
          ? agentId
            ? 1
            : event.memberAgentIds.length
          : event.type === 'agent-joined-alliance' &&
              (!agentId || event.joinedAgentId === agentId)
            ? 1
            : 0),
      0,
    ),
    alliancesLeft: relevantEvents.filter(
      (event) =>
        event.type === 'agent-left-alliance' &&
        (!agentId || event.leftAgentId === agentId),
    ).length,
    alliancesDissolved: relevantEvents.filter(
      (event) => event.type === 'alliance-dissolved',
    ).length,
    firstAllianceTurn: formed.length
      ? Math.min(...formed.map(({ turnNumber }) => turnNumber))
      : null,
    maximumAllianceSize: Math.max(0, ...allianceSizes),
    completedAllianceDurationTurnsTotal: completedDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    ),
    completedAllianceDurationTurnsAverage: completedDurations.length
      ? completedDurations.reduce((sum, duration) => sum + duration, 0) /
        completedDurations.length
      : 0,
    alliedCaptureAttempts: records.filter(
      (turn) =>
        turn.outcome !== 'provider-error' &&
        turn.outcome !== 'lost-tick' &&
        turn.outcome !== 'operator-skipped' &&
        turn.worldAction.type === 'capture' &&
        !turn.worldActionResult.accepted &&
        turn.worldActionResult.reason === 'allied-controller',
    ).length,
    alliedCaptureRejections: records.filter(
      (turn) =>
        turn.outcome !== 'provider-error' &&
        turn.outcome !== 'lost-tick' &&
        turn.outcome !== 'operator-skipped' &&
        turn.worldAction.type === 'capture' &&
        !turn.worldActionResult.accepted &&
        turn.worldActionResult.reason === 'allied-controller',
    ).length,
  };
}

function movementMetrics(records: readonly AgentTurnRecord[]) {
  const moves = records.flatMap((turn) => {
    if (
      turn.outcome !== 'accepted' ||
      turn.worldActionResult.event.type !== 'agent-moved'
    )
      return [];
    const moved = turn.worldActionResult.event;
    const option = turn.observation.actionAvailability.moveOptions.find(
      ({ targetCell }) => targetCell === moved.toCell,
    );
    return option
      ? [{ turn, direction: option.direction, toCell: option.targetCell }]
      : [];
  });
  const counts = new Map<(typeof moves)[number]['direction'], number>();
  let longest = 0;
  let streak = 0;
  let previousDirection: (typeof moves)[number]['direction'] | undefined;
  let previousMoveAt: string | undefined;
  let directionChangesAfterCommunication = 0;
  const visited = new Set<string>(
    records[0] ? [records[0].observation.currentCell.cell] : [],
  );
  let recentCellRevisits = 0;
  for (const { turn, direction, toCell } of moves) {
    const priorMoveAt = previousMoveAt;
    counts.set(direction, (counts.get(direction) ?? 0) + 1);
    streak = direction === previousDirection ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    if (
      previousDirection &&
      priorMoveAt &&
      direction !== previousDirection &&
      (turn.observation.recentDirectMessages.some(
        ({ direction: messageDirection, occurredAt }) =>
          messageDirection === 'inbound' &&
          occurredAt > priorMoveAt &&
          occurredAt <= turn.completedAt,
      ) ||
        turn.observation.recentAllianceMessages.some(
          ({ senderId, occurredAt }) =>
            senderId !== turn.agentId &&
            occurredAt > priorMoveAt &&
            occurredAt <= turn.completedAt,
        ))
    )
      directionChangesAfterCommunication += 1;
    previousDirection = direction;
    previousMoveAt = turn.completedAt;
    if (visited.has(toCell)) recentCellRevisits += 1;
    visited.add(toCell);
  }
  return {
    movementDirectionDistribution: [...counts.entries()]
      .map(([direction, count]) => ({ direction, count }))
      .toSorted((a, b) => a.direction.localeCompare(b.direction)),
    longestRepeatedDirectionStreak: longest,
    recentCellRevisits,
    directionChangesAfterCommunication,
  };
}

function groupedDiplomacyRejections(records: readonly AgentTurnRecord[]) {
  const grouped = new Map<
    string,
    {
      type:
        'propose-alliance' | 'accept-alliance' | 'leave-alliance' | 'invalid';
      reason: DiplomacyRejectionReason;
      count: number;
    }
  >();
  for (const turn of records) {
    if (
      turn.outcome === 'provider-error' ||
      turn.outcome === 'lost-tick' ||
      turn.outcome === 'operator-skipped' ||
      !turn.diplomacyResult.requested ||
      turn.diplomacyResult.accepted
    )
      continue;
    const { type } = turn.diplomacyResult.attempt;
    const { reason } = turn.diplomacyResult;
    const key = `${type}:${reason}`;
    grouped.set(key, {
      type,
      reason,
      count: (grouped.get(key)?.count ?? 0) + 1,
    });
  }
  return [...grouped.values()];
}

function communicationMetrics(
  communications: readonly ExportedCommunication[],
  agentIds: readonly AgentId[],
  agentId?: AgentId,
) {
  const authoredBySelection = ({ agentId: senderId }: ExportedCommunication) =>
    agentId ? senderId === agentId : agentIds.includes(senderId);
  const receivedBySelection = (communication: ExportedCommunication) =>
    communication.channel === 'direct' &&
    (agentId
      ? communication.recipientId === agentId
      : communication.recipientId !== undefined &&
        communication.recipientId !== null &&
        agentIds.includes(communication.recipientId));
  const publicAuthored = communications.filter(
    (communication) =>
      communication.channel === 'public' && authoredBySelection(communication),
  );
  const directAuthored = communications.filter(
    (communication) =>
      communication.channel === 'direct' && authoredBySelection(communication),
  );
  const allianceAuthored = communications.filter(
    (communication) =>
      communication.channel === 'alliance' &&
      authoredBySelection(communication),
  );
  const zeroAuthored = communications.filter(
    (communication) =>
      communication.channel === 'zero' && authoredBySelection(communication),
  );
  const patientZeroId = communications.find(
    ({ channel, status }) => channel === 'zero' && status === 'accepted',
  )?.agentId;
  const repliesToPatientZero = patientZeroId
    ? directAuthored.filter(
        ({ status, recipientId, agentId: senderId }) =>
          status === 'accepted' &&
          recipientId === patientZeroId &&
          senderId !== patientZeroId,
      )
    : [];
  const deliveredDirect = directAuthored.filter(
    (communication) =>
      communication.status === 'accepted' &&
      communication.distance !== null &&
      communication.distance !== undefined,
  );
  const directDistanceTotal = deliveredDirect.reduce(
    (sum, communication) => sum + (communication.distance ?? 0),
    0,
  );
  return {
    publicMessagesRequested: publicAuthored.length,
    publicMessagesAccepted: publicAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    publicMessagesRejected: publicAuthored.filter(
      ({ status }) => status === 'rejected',
    ).length,
    directMessagesRequested: directAuthored.length,
    directMessagesDelivered: directAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    directMessagesRejected: directAuthored.filter(
      ({ status }) => status === 'rejected',
    ).length,
    allianceMessagesRequested: allianceAuthored.length,
    allianceMessagesDelivered: allianceAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    allianceMessagesRejected: allianceAuthored.filter(
      ({ status }) => status === 'rejected',
    ).length,
    zeroBroadcastsRequested: zeroAuthored.length,
    zeroBroadcastsDelivered: zeroAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    zeroBroadcastsRejected: zeroAuthored.filter(
      ({ status }) => status === 'rejected',
    ).length,
    zeroRecipientDeliveries: zeroAuthored.reduce(
      (sum, communication) =>
        sum +
        (communication.status === 'accepted'
          ? (communication.recipientIds?.length ?? 0)
          : 0),
      0,
    ),
    uniqueZeroDirectiveRecipients: new Set(
      zeroAuthored.flatMap(({ recipientIds }) => recipientIds ?? []),
    ).size,
    directRepliesToPatientZero: repliesToPatientZero.length,
    uniquePatientZeroRepliers: new Set(
      repliesToPatientZero.map(({ agentId: senderId }) => senderId),
    ).size,
    firstZeroDirectiveTurn:
      zeroAuthored.find(({ status }) => status === 'accepted')
        ?.originatingTurn ?? null,
    publicMessagesSent: publicAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    directMessagesSent: directAuthored.filter(
      ({ status }) => status === 'accepted',
    ).length,
    directMessagesReceived: communications.filter(
      (communication) =>
        communication.status === 'accepted' &&
        receivedBySelection(communication),
    ).length,
    uniqueDirectMessagePairs: new Set(
      directAuthored.flatMap((communication) =>
        communication.recipientId
          ? [`${communication.agentId}:${communication.recipientId}`]
          : [],
      ),
    ).size,
    directMessageDistanceTotalKm: directDistanceTotal,
    directMessageDistanceAverageKm: deliveredDirect.length
      ? directDistanceTotal / deliveredDirect.length
      : 0,
    directMessageDistanceMaximumKm: Math.max(
      0,
      ...deliveredDirect.map(({ distance }) => distance ?? 0),
    ),
  };
}

export function serializeExperimentExport(
  document: ExperimentExportDocument,
): string {
  return document.filters.serialization === 'pretty'
    ? JSON.stringify(document, null, 2)
    : JSON.stringify(document);
}

function addDecimalValue(left: string, right: number): string {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInteger =
    leftParts.integer * 10n ** BigInt(scale - leftParts.scale);
  const rightInteger =
    rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return decimalString(leftInteger + rightInteger, scale);
}

function sumDecimalNumbers(values: readonly number[]): number {
  return Number(values.reduce(addDecimalValue, '0'));
}

function decimalParts(value: number | string): {
  integer: bigint;
  scale: number;
} {
  const [mantissa, exponentText = '0'] = value
    .toString()
    .toLowerCase()
    .split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = mantissa!.split('.');
  let integer = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    integer *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { integer, scale };
}

function decimalString(integer: bigint, scale: number): string {
  if (scale === 0) return integer.toString();
  const digits = integer.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
