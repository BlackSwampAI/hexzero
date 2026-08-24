import { describe, expect, it } from 'vitest';
import {
  MODEL_SUMMARY_MAX_LENGTH,
  AGENT_DECISION_CONTRACT_VERSION,
  PREVIOUS_AGENT_DECISION_CONTRACT_VERSION,
  FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION,
  PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS,
  WORLD_SCENARIO_LIMITS,
  OBJECTIVE_PROMPT_VERSION,
  MESSAGE_MAX_LENGTH,
  PERSONALITY_MAX_LENGTH,
  apiErrorSchema,
  agentIdSchema,
  agentDecisionSchema,
  agentObservationSchema,
  agentTurnRecordSchema,
  communicationResultSchema,
  directMessageEventSchema,
  captureEligibilitySchema,
  exportedCommunicationSchema,
  experimentExportWorldStateSchema,
  experimentExportTurnSchema,
  hexCapturedWorldEventSchema,
  hexSchema,
  invalidActionReasonSchema,
  experimentExportRequestSchema,
  experimentIdSchema,
  personalityConfigurationEventSchema,
  providerMetadataSchema,
  restoreDefaultPersonalitiesResponseSchema,
  simulationSnapshotSchema,
  worldSnapshotSchema,
  singleTickResponseSchema,
  updateAgentPersonalityRequestSchema,
  updateAgentPersonalityResponseSchema,
  allianceSchema,
  allianceProposalSchema,
  patientZeroDiplomacySummarySchema,
  patientZeroPlayerThreatFeedSchema,
  PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT,
  diplomacyIntentSchema,
  diplomacyResultSchema,
  DEVELOPMENT_WORLD_CONFIG,
  experimentModelConfigurationSchema,
  modelVerificationSchema,
  reasoningProfilesForModel,
  type CompatibleModel,
  assignBehavior,
  NEUTRAL_AGENT_COLOR,
  GOAL_TEXT_MAX_LENGTH,
  agentGoalStateSchema,
  requestedGoalRevisionSchema,
  agentDecisionContractVersionSchema,
  MEMORY_ENTRY_LIMIT,
  MEMORY_TEXT_MAX_LENGTH,
  memoryLedgerSchema,
  requestedMemoryOperationSchema,
  memoryOperationResultSchema,
  createMemoryId,
  archiveExperimentExportResponseSchema,
} from '.';

const agentId = '128f3f38-6b7d-4db7-9e95-751b4ce2681e';
const cell = '892a1072893ffff';
const adjacent = '892a1072883ffff';
const scoreboard = [
  '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
  '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
  '3ba3ef0b-2142-44cc-b175-f6e5d6e98df5',
  '442a1667-39c8-48e9-8c89-23803f9e2101',
  '5f812a08-05f2-4950-bf2d-4df59d05e9c2',
  '67a43b5c-ced8-45bd-970f-a89ac57853fc',
  '78b6d86c-39b4-47d8-9d7a-0b92686ada71',
  '89ce9ddb-611f-4a46-8f7b-36e656494aa2',
].map((id, index) => ({
  agentId: id,
  name: `Agent ${index + 1}`,
  color: '#ff6b57',
  allianceId: null,
  effectiveColor: NEUTRAL_AGENT_COLOR,
  controlledCellCount: 0,
}));
const observation = {
  agentId,
  agentName: 'Ember',
  personality: 'Prefer infection.',
  currentCell: {
    cell,
    state: 'open',
    controllerAgentId: null,
    controllerAllianceId: null,
    effectiveColor: null,
  },
  captureEligibility: {
    eligible: false,
    blockedReason: 'capture-open-cell',
  },
  actionAvailability: {
    moveTargetCellIds: [adjacent],
    infect: { available: true },
    capture: { available: false, reason: 'capture-open-cell' },
    wait: { available: true },
  },
  adjacentCells: [
    {
      cell: adjacent,
      state: 'open',
      controllerAgentId: null,
      controllerAllianceId: null,
      effectiveColor: null,
    },
  ],
  nearbyAgents: [],
  recentEvents: [],
  recentPublicMessages: [],
  recentDirectMessages: [],
  territoryScoreboard: scoreboard,
  actingAllianceId: null,
  actingAlliance: null,
  activeAlliances: [],
  inboundAllianceProposals: [],
  outboundAllianceProposals: [],
  recentAllianceEvents: [],
  recentControlChanges: [],
};
const baseTurn = {
  turnNumber: 1,
  agentId,
  startedAt: '2026-08-13T12:00:00.000Z',
  completedAt: '2026-08-13T12:00:01.000Z',
  observation,
};
const provider = {
  provider: 'openrouter',
  model: 'example/compatible-model',
  latencyMs: 100,
};
const event = {
  id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
  agentId,
  occurredAt: '2026-08-13T12:00:01.000Z',
  type: 'hex-infected',
  cell,
  controllerAgentId: agentId,
};
const worldAgent = {
  id: agentId,
  name: 'Ember',
  color: '#ff6b57',
  personality: 'Prefer infection.',
  currentCell: cell,
};
const worldAgents = scoreboard.map((entry) => ({
  id: entry.agentId,
  name: entry.name,
  color: entry.color,
  personality: 'Prefer infection.',
  currentCell: cell,
}));
const snapshot = {
  world: {
    generatedAt: '2026-08-13T12:00:00.000Z',
    hexes: [{ cell, state: 'open', controllerAgentId: null }],
    agents: worldAgents,
    events: [],
  },
  scenario: {
    scenarioVersion: 'world-scenario-v1',
    center: { latitude: 41.6528, longitude: -83.5379 },
    resolution: 9,
    radius: 6,
    worldSeed: 'world',
    rosterSeed: 'roster',
    spawnSeed: 'spawn',
    minimumSpawnSeparation: 0,
    communicationRangeKm: 12,
    patientZeroAgentId: worldAgents[0]!.id,
    roster: worldAgents.map(({ currentCell: _currentCell, ...agent }) => agent),
    modelConfiguration: {
      globalModelId: 'author/compatible-model',
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    },
    behaviorConfiguration: {
      registryVersion: 1,
      assignmentMode: 'balanced-random',
      seed: 'behavior',
      assignments: assignBehavior(
        worldAgents.map(({ id }) => id as never),
        'behavior',
        'balanced-random',
      ),
      locked: false,
    },
    objectiveVersion: 'durable-influence-v2',
    capabilities: { communication: true, diplomacy: true },
    decisionContractVersion: AGENT_DECISION_CONTRACT_VERSION,
    exactCellCount: 1,
    areaSquareKilometers: 0.1,
    startingCells: worldAgents.map(() => cell),
    setupWarnings: [],
  },
  turnNumber: 0,
  nextAgentId: agentId,
  activeAgentId: null,
  status: 'paused',
  providerMode: 'openrouter',
  providerConfigured: true,
  modelConfiguration: {
    globalModelId: 'author/compatible-model',
    overrides: [],
    locked: false,
  },
  resolvedModels: worldAgents.map(({ id }) => ({
    agentId: id,
    modelId: 'author/compatible-model',
    source: 'global',
    available: true,
  })),
  turns: [],
  experiment: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: '2026-08-13T12:00:00.000Z',
    totalCompletedTurns: 0,
    retainedTurns: 0,
    droppedRecords: 0,
    complete: true,
    metrics: {
      aggregate: {
        totalTurns: 0,
        accepted: 0,
        rejected: 0,
        providerErrors: 0,
        requestedMoves: 0,
        requestedInfections: 0,
        requestedCaptures: 0,
        requestedWaits: 0,
        acceptedMovements: 0,
        successfullyInfectedCells: 0,
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
        directMessagesDelivered: 0,
        directMessagesRejected: 0,
        publicMessagesSent: 0,
        directMessagesSent: 0,
        directMessagesReceived: 0,
        uniqueVisitedCells: 0,
        tokens: {},
        tokenUsageComplete: true,
        attemptsWithUnknownTokenUsage: 0,
        knownCostCredits: 0,
        attemptsWithUnknownCost: 0,
        turnsWithUnknownCost: 0,
      },
      byAgent: [],
    },
    currentTerritory: scoreboard,
    currentAlliances: [],
  },
};

describe('agent observation and decision schemas', () => {
  it('bounds goal state and preserves v3-v8 decision attribution', () => {
    expect(
      agentGoalStateSchema.safeParse({
        longTermGoal: 'x'.repeat(GOAL_TEXT_MAX_LENGTH + 1),
        shortTermGoal: 'Secure the frontier.',
        planSummary: 'Expand deliberately.',
        establishedAtTick: 2,
        revisedAtTick: 1,
      }).success,
    ).toBe(false);
    expect(
      requestedGoalRevisionSchema.safeParse({
        operation: 'keep',
        reason: 'Contradictory extra field.',
      }).success,
    ).toBe(false);
    for (const version of [
      'text-flat-json-v3',
      'text-flat-json-v4',
      'text-flat-json-v5',
      'text-flat-json-v6',
      'text-flat-json-v7',
      'text-flat-json-v8',
    ])
      expect(agentDecisionContractVersionSchema.parse(version)).toBe(version);
  });

  it('requires exact canonical goal availability while defaulting legacy observations', () => {
    expect(agentObservationSchema.safeParse(observation).success).toBe(true);
    const goal = {
      longTermGoal: 'Hold a durable corridor.',
      shortTermGoal: 'Secure the frontier.',
      planSummary: 'Expand methodically.',
      establishedAtTick: 1,
      revisedAtTick: 1,
    };
    const active = {
      ...observation,
      currentGoal: goal,
      goalAvailability: {
        active: true,
        availableOperations: ['keep', 'revise', 'complete', 'abandon'],
      },
    };
    expect(agentObservationSchema.safeParse(active).success).toBe(true);
    for (const goalAvailability of [
      {
        active: false,
        availableOperations: ['keep', 'revise', 'complete', 'abandon'],
      },
      {
        active: true,
        availableOperations: ['keep', 'keep', 'complete', 'abandon'],
      },
      { active: true, availableOperations: ['keep', 'revise', 'complete'] },
    ])
      expect(
        agentObservationSchema.safeParse({
          ...active,
          goalAvailability,
        }).success,
      ).toBe(false);
  });

  it('bounds compact memory and requires exact canonical availability', () => {
    const entries = Array.from({ length: MEMORY_ENTRY_LIMIT }, (_, index) => ({
      id: `memory:${agentId}:${index + 1}`,
      text: `Memory ${index + 1}`,
      createdAtTick: index + 1,
      revisedAtTick: index + 1,
    }));
    expect(memoryLedgerSchema.safeParse(entries).success).toBe(true);
    expect(memoryLedgerSchema.safeParse([...entries, entries[0]]).success).toBe(
      false,
    );
    expect(
      requestedMemoryOperationSchema.safeParse({
        operation: 'remember',
        text: 'x'.repeat(MEMORY_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      memoryLedgerSchema.safeParse([
        {
          id: 'memory:00000000-0000-9000-8000-000000000000:1',
          text: 'Malformed owner identity.',
          createdAtTick: 1,
          revisedAtTick: 1,
        },
      ]).success,
    ).toBe(false);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        currentMemory: entries,
        memoryAvailability: {
          remember: false,
          revisableMemoryIds: entries.map(({ id }) => id),
          forgettableMemoryIds: entries.map(({ id }) => id),
        },
      }).success,
    ).toBe(true);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        currentMemory: entries,
        memoryAvailability: {
          remember: true,
          revisableMemoryIds: entries.map(({ id }) => id).reverse(),
          forgettableMemoryIds: entries.map(({ id }) => id),
        },
      }).success,
    ).toBe(false);
    const foreignId = createMemoryId(
      agentIdSchema.parse('2507bb46-7ae4-45ca-8dda-644c4f85ca14'),
      1,
    );
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        currentMemory: [{ ...entries[0]!, id: foreignId }],
        memoryAvailability: {
          remember: true,
          revisableMemoryIds: [foreignId],
          forgettableMemoryIds: [foreignId],
        },
      }).success,
    ).toBe(false);
    expect(
      memoryLedgerSchema.safeParse([
        {
          ...entries[0]!,
          id: createMemoryId(agentIdSchema.parse(agentId), 2),
        },
      ]).success,
    ).toBe(false);
    expect(memoryLedgerSchema.safeParse([entries[1], entries[0]]).success).toBe(
      false,
    );
    expect(
      memoryOperationResultSchema.safeParse({
        requested: true,
        accepted: false,
        operation: 'forget',
        reason: 'memory-full',
      }).success,
    ).toBe(false);
    expect(
      memoryOperationResultSchema.safeParse({
        requested: true,
        accepted: false,
        operation: 'remember',
        reason: 'memory-not-found',
      }).success,
    ).toBe(false);
  });

  it('keeps the maximum sparse Patient Zero diplomacy shape within budget', () => {
    const agentIds = Array.from({ length: 32 }, (_, index) =>
      agentIdSchema.parse(
        `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    );
    const proposalIds = Array.from(
      { length: PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.acceptableProposals },
      (_, index) =>
        `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const reasons = [
      'current-ally',
      'out-of-range',
      'outgoing-proposal-exists',
      'incoming-proposal-exists',
      'alliance-to-alliance-merge',
    ] as const;
    const summary = patientZeroDiplomacySummarySchema.parse({
      eligiblePairCount:
        WORLD_SCENARIO_LIMITS.maximumAgents *
        (WORLD_SCENARIO_LIMITS.maximumAgents - 1),
      displayedEligiblePairs: Array.from(
        {
          length: PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.displayedEligiblePairs,
        },
        (_, index) => ({
          proposerId: agentIds[index]!,
          recipientId: agentIds[(index + 1) % agentIds.length]!,
        }),
      ),
      eligiblePairsTruncated: true,
      acceptableProposals: proposalIds.map((proposalId, index) => ({
        agentId: agentIds[index]!,
        proposalId,
      })),
      acceptableProposalCount: WORLD_SCENARIO_LIMITS.maximumAgents,
      acceptableProposalsTruncated: true,
      leaveAvailableAgentIds: agentIds.slice(
        0,
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.leaveAvailableAgentIds,
      ),
      leaveAvailableCount: WORLD_SCENARIO_LIMITS.maximumAgents,
      leaveAvailableTruncated: true,
      blockedCounts: reasons.map((reason) => ({
        reason,
        count:
          WORLD_SCENARIO_LIMITS.maximumAgents *
          (WORLD_SCENARIO_LIMITS.maximumAgents - 1),
      })),
      blockerExamples: Array.from(
        { length: PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.blockerExamples },
        (_, index) => ({
          proposerId: agentIds[index + 12]!,
          recipientId: agentIds[index + 13]!,
          reason: reasons[index % reasons.length]!,
        }),
      ),
    });
    expect(
      new TextEncoder().encode(JSON.stringify(summary)).byteLength,
    ).toBeLessThanOrEqual(
      PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.serializedUtf8Bytes,
    );
  });

  it('caps Patient Zero cleaner evidence with truthful overflow metadata', () => {
    const pressureContext = {
      window: { tickCount: 6, startTick: 3, endTick: 8 },
      subject: {
        totalEvents: 3,
        disinfections: 2,
        blockedCleans: 1,
        consecutiveAffectedTicks: 2,
      },
      currentAlliance: null,
    };
    const events = Array.from(
      { length: PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT },
      (_, index) => ({
        eventId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        kind: 'territory-disinfected' as const,
        cell,
        occurredAt: '2026-08-13T12:00:01.000Z',
        affectedAgentId: agentId,
        affectedAgentName: 'Ember',
        affectedAllianceId: null,
        affectedAllianceColor: null,
        pressureContext,
      }),
    );
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events,
        totalEventCount: events.length + 1,
        truncated: true,
      }).success,
    ).toBe(true);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          ...events,
          {
            ...events[0]!,
            eventId: '30000000-0000-4000-8000-999999999999',
          },
        ],
        totalEventCount: events.length + 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...events[0]!,
            pressureContext: {
              ...pressureContext,
              window: { tickCount: 2, startTick: 7, endTick: 8 },
              subject: {
                ...pressureContext.subject,
                consecutiveAffectedTicks: 3,
              },
            },
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    const blockedBase = {
      eventId: events[0]!.eventId,
      cell: events[0]!.cell,
      occurredAt: events[0]!.occurredAt,
    };
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...blockedBase,
            kind: 'territory-disinfected',
            affectedAgentId: agentId,
            affectedAgentName: 'Ember',
            affectedAllianceId: null,
            affectedAllianceColor: null,
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...events[0]!,
            pressureContext: {
              ...pressureContext,
              subject: {
                ...pressureContext.subject,
                totalEvents: 4,
              },
            },
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...events[0]!,
            pressureContext: {
              ...pressureContext,
              window: { tickCount: 5, startTick: 3, endTick: 8 },
            },
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...events[0]!,
            pressureContext: {
              ...pressureContext,
              currentAlliance: {
                totalEvents: 3,
                disinfections: 2,
                blockedCleans: 1,
              },
            },
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events: [
          {
            ...blockedBase,
            kind: 'occupied-clean-blocked',
            blockingAgentId: agentId,
            blockingAgentName: 'Ember',
            blockingAllianceId: null,
            blockingAllianceColor: null,
            pressureContext: {
              ...pressureContext,
              subject: {
                totalEvents: 1,
                disinfections: 1,
                blockedCleans: 0,
                consecutiveAffectedTicks: 1,
              },
            },
          },
        ],
        totalEventCount: 1,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      patientZeroPlayerThreatFeedSchema.safeParse({
        events,
        totalEventCount: events.length,
        truncated: true,
      }).success,
    ).toBe(false);
    const globalView = {
      agents: [],
      individualTerritory: scoreboard,
      allianceTerritory: [],
      alliances: [],
      activeAllianceProposals: [],
      recentStrategicEvents: [],
      recentTerritoryChanges: [],
      playerThreatFeed: {
        events: events.slice(0, 1),
        totalEventCount: 1,
        truncated: false,
      },
    };
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        patientZeroGlobalView: globalView,
      }).success,
    ).toBe(false);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        patientZero: {
          agentId,
          agentName: 'Ember',
          isPatientZero: true,
          directRangeBypass: true,
        },
        patientZeroGlobalView: globalView,
      }).success,
    ).toBe(false);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        patientZero: {
          agentId,
          agentName: 'Ember',
          isPatientZero: true,
          directRangeBypass: true,
        },
        patientZeroGlobalView: globalView,
        playerPressure: { enabled: true, recentThreats: [] },
      }).success,
    ).toBe(true);
  });

  it('preserves established engine contract identifiers through branding changes', () => {
    expect(AGENT_DECISION_CONTRACT_VERSION).toBe('text-flat-json-v8');
    expect(PREVIOUS_AGENT_DECISION_CONTRACT_VERSION).toBe('text-flat-json-v4');
    expect(FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION).toBe(
      'text-flat-json-v5',
    );
    expect(OBJECTIVE_PROMPT_VERSION).toBe('durable-influence-v3');
    expect(
      modelVerificationSchema.parse({
        modelId: 'author/model',
        contractVersion: AGENT_DECISION_CONTRACT_VERSION,
        status: 'untested',
      }).contractVersion,
    ).toBe(AGENT_DECISION_CONTRACT_VERSION);
    expect(
      modelVerificationSchema.safeParse({
        modelId: 'author/model',
        contractVersion: 'text-flat-json-v3',
        status: 'untested',
      }).success,
    ).toBe(false);
  });

  it('centralizes eight-agent, 127-cell alliance and diplomacy limits', () => {
    expect(DEVELOPMENT_WORLD_CONFIG).toMatchObject({
      radius: 6,
      cellCount: 127,
      agentCount: 8,
      resolution: 9,
    });
    const allianceId = 'a1111111-1111-4111-8111-111111111111';
    const proposalId = 'b2222222-2222-4222-8222-222222222222';
    expect(
      allianceSchema.safeParse({
        id: allianceId,
        color: '#0072B2',
        memberAgentIds: scoreboard.slice(0, 2).map(({ agentId }) => agentId),
      }).success,
    ).toBe(true);
    expect(
      allianceProposalSchema.parse({
        id: proposalId,
        proposerAgentId: scoreboard[0]!.agentId,
        recipientAgentId: scoreboard[1]!.agentId,
        proposerAllianceId: null,
        originatingTurn: 1,
        expirationTurn: 17,
      }).recipientAllianceId,
    ).toBeNull();
    expect(
      diplomacyIntentSchema.safeParse({ type: 'accept-alliance', proposalId })
        .success,
    ).toBe(true);
    expect(diplomacyResultSchema.safeParse({ requested: false }).success).toBe(
      true,
    );
  });

  it('accepts a full-roster alliance and a maximum-count ten-agent partition with reused colors', () => {
    const ids = Array.from({ length: 32 }, (_, index) =>
      agentIdSchema.parse(
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    );
    expect(
      allianceSchema.safeParse({
        id: 'a1111111-1111-4111-8111-111111111111',
        color: '#0072B2',
        memberAgentIds: ids,
      }).success,
    ).toBe(true);
    const tenAgents = ids.slice(0, 10).map((id, index) => ({
      id,
      name: `Agent ${index}`,
      color: '#ff6b57',
      personality: 'Coordinates deliberately.',
      currentCell: cell,
    }));
    expect(
      worldSnapshotSchema.safeParse({
        generatedAt: '2026-08-13T12:00:00.000Z',
        hexes: [{ cell, state: 'open', controllerAgentId: null }],
        agents: tenAgents,
        events: [],
        alliances: Array.from({ length: 5 }, (_, index) => ({
          id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          color: '#0072B2',
          memberAgentIds: [ids[index * 2]!, ids[index * 2 + 1]!],
        })),
        pendingAllianceProposals: [],
      }).success,
    ).toBe(true);
    const participantState = {
      generatedAt: '2026-08-13T12:00:00.000Z',
      hexes: [{ cell, state: 'open', controllerAgentId: null }],
      agents: tenAgents,
      events: [],
      alliances: [
        {
          id: '10000000-0000-4000-8000-000000000000',
          color: '#0072B2',
          memberAgentIds: [ids[0]!, ids[1]!],
        },
      ],
    };
    const proposalBase = {
      id: '20000000-0000-4000-8000-000000000000',
      originatingTurn: 1,
      expirationTurn: 21,
      proposerAllianceId: null,
      recipientAllianceId: null,
    };
    const legacyProposalBase: Partial<typeof proposalBase> = {
      ...proposalBase,
    };
    delete legacyProposalBase.recipientAllianceId;
    expect(
      worldSnapshotSchema.safeParse({
        ...participantState,
        alliances: [],
        pendingAllianceProposals: [
          {
            ...legacyProposalBase,
            proposerAgentId: ids[2],
            recipientAgentId: ids[3],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      worldSnapshotSchema.safeParse({
        ...participantState,
        pendingAllianceProposals: [
          {
            ...proposalBase,
            proposerAgentId: ids[0],
            recipientAgentId: ids[2],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      worldSnapshotSchema.safeParse({
        ...participantState,
        pendingAllianceProposals: [
          {
            ...proposalBase,
            proposerAgentId: ids[2],
            recipientAgentId: ids[0],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a bounded state-bearing observation', () => {
    const parsed = agentObservationSchema.parse(observation);
    expect(parsed.currentCell.state).toBe('open');
    expect(parsed.diplomacyAvailability.propose).toMatchObject({
      available: false,
      blockedRecipients: [],
    });
    expect(parsed.patientZeroGlobalView).toBeNull();
    expect(parsed.playerPressure).toEqual({
      enabled: false,
      recentThreats: [],
    });
  });

  it.each([
    { ...observation, adjacentCells: [] },
    { ...observation, currentCell: { cell, state: 'unknown' } },
    {
      ...observation,
      nearbyAgents: Array(9).fill({
        id: agentId,
        name: 'x',
        currentCell: cell,
        distance: 1,
        allianceId: null,
      }),
    },
  ])('rejects invalid or oversized observations', (value) => {
    expect(agentObservationSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    {
      worldAction: { type: 'move', targetCell: adjacent },
      summary: 'Move.',
    },
    { worldAction: { type: 'infect' }, summary: 'Infect.' },
    { worldAction: { type: 'capture' }, summary: 'Capture.' },
    {
      worldAction: { type: 'wait' },
      communication: {
        channel: 'direct',
        recipientId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
        message: 'Coordinate here.',
      },
      summary: 'Message.',
    },
    { worldAction: { type: 'wait' }, summary: 'Wait.' },
  ])(
    'accepts every supported world action and optional communication',
    (decision) => {
      expect(agentDecisionSchema.safeParse(decision).success).toBe(true);
    },
  );

  it('validates explicit hex control invariants and capture events', () => {
    expect(
      hexSchema.safeParse({ cell, state: 'open', controllerAgentId: null })
        .success,
    ).toBe(true);
    expect(
      hexSchema.safeParse({
        cell,
        state: 'infected',
        controllerAgentId: agentId,
      }).success,
    ).toBe(true);
    expect(
      hexSchema.safeParse({ cell, state: 'open', controllerAgentId: agentId })
        .success,
    ).toBe(false);
    expect(
      hexSchema.safeParse({ cell, state: 'infected', controllerAgentId: null })
        .success,
    ).toBe(false);
    expect(
      hexCapturedWorldEventSchema.safeParse({
        id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
        type: 'hex-captured',
        agentId,
        controllerAgentId: agentId,
        previousControllerAgentId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
        cell,
        occurredAt: '2026-08-13T12:00:01.000Z',
      }).success,
    ).toBe(true);
    expect(invalidActionReasonSchema.parse('capture-open-cell')).toBe(
      'capture-open-cell',
    );
    expect(invalidActionReasonSchema.parse('already-controller')).toBe(
      'already-controller',
    );
    expect(invalidActionReasonSchema.parse('controller-present')).toBe(
      'controller-present',
    );
    expect(captureEligibilitySchema.parse({ eligible: true })).toEqual({
      eligible: true,
    });
    for (const blockedReason of [
      'capture-open-cell',
      'already-controller',
      'controller-present',
    ] as const) {
      expect(
        captureEligibilitySchema.parse({ eligible: false, blockedReason }),
      ).toEqual({ eligible: false, blockedReason });
    }

    expect(
      captureEligibilitySchema.safeParse({
        eligible: false,
        blockedReason: 'some-other-reason',
      }).success,
    ).toBe(false);
    expect(
      simulationSnapshotSchema.safeParse({
        ...snapshot,
        world: {
          ...snapshot.world,
          hexes: [
            {
              cell,
              state: 'infected',
              controllerAgentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      worldAction: { type: 'teleport', targetCell: adjacent },
      summary: 'No.',
    },
    {
      worldAction: { type: 'wait' },
      summary: 'x'.repeat(MODEL_SUMMARY_MAX_LENGTH + 1),
    },
  ])('rejects forbidden actions and oversized model text', (decision) => {
    expect(agentDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it('trims message content and enforces recipient and 280-character boundaries', () => {
    const recipientId = '2507bb46-7ae4-45ca-8dda-644c4f85ca14';
    const parsed = agentDecisionSchema.parse({
      worldAction: { type: 'wait' },
      communication: {
        channel: 'direct',
        recipientId,
        message: `  ${'x'.repeat(MESSAGE_MAX_LENGTH)}  `,
      },
      summary: 'Send.',
    });
    expect(parsed.communication).toMatchObject({
      channel: 'direct',
      message: 'x'.repeat(MESSAGE_MAX_LENGTH),
    });
    for (const communication of [
      { channel: 'direct', recipientId, message: '   ' },
      {
        channel: 'direct',
        recipientId,
        message: 'x'.repeat(MESSAGE_MAX_LENGTH + 1),
      },
      { channel: 'direct', recipientId: 'not-an-agent', message: 'Hello.' },
    ])
      expect(
        agentDecisionSchema.safeParse({
          worldAction: { type: 'wait' },
          communication,
          summary: 'Send.',
        }).success,
      ).toBe(false);
  });

  it('preserves rejected direct attempts with a safely nullable recipient', () => {
    const attempt = {
      id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
      agentId,
      occurredAt: '2026-08-13T12:00:01.000Z',
      channel: 'direct' as const,
      recipientId: null,
      message: 'Hello.',
      distance: null,
    };
    expect(
      communicationResultSchema.parse({
        requested: true,
        accepted: false,
        attempt,
        reason: 'invalid-communication',
        details: 'The communication failed schema validation.',
      }),
    ).toMatchObject({ attempt: { channel: 'direct', recipientId: null } });
    expect(
      exportedCommunicationSchema.safeParse({
        ...attempt,
        originatingTurn: 1,
        status: 'rejected',
        rejectionReason: 'invalid-communication',
        rejectionDetails: 'The communication failed schema validation.',
      }).success,
    ).toBe(true);
    expect(
      exportedCommunicationSchema.safeParse({
        ...attempt,
        originatingTurn: 1,
        status: 'accepted',
      }).success,
    ).toBe(false);
  });

  it('validates typed messages and caps directional conversation context at six', () => {
    const recipientId = '2507bb46-7ae4-45ca-8dda-644c4f85ca14';
    const messageEvent = directMessageEventSchema.parse({
      id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
      type: 'direct-message-sent',
      channel: 'direct',
      agentId,
      recipientId,
      occurredAt: '2026-08-13T12:00:01.000Z',
      message: 'Hello.',
      distance: 3,
    });
    const communication = {
      eventId: messageEvent.id,
      senderId: agentId,
      senderName: 'Ember',
      recipientId,
      recipientName: 'Rook',
      direction: 'outbound',
      message: messageEvent.message,
      occurredAt: messageEvent.occurredAt,
      distance: messageEvent.distance,
    };
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentPublicMessages: [],
        recentDirectMessages: Array(6).fill(communication),
      }).success,
    ).toBe(true);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentPublicMessages: [],
        recentDirectMessages: Array(7).fill(communication),
      }).success,
    ).toBe(false);
  });

  it('caps public context at twelve and accepts one-character public text', () => {
    const publicMessage = {
      eventId: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
      senderId: agentId,
      senderName: 'Ember',
      message: 'x',
      occurredAt: '2026-08-13T12:00:01.000Z',
    };
    expect(
      agentDecisionSchema.safeParse({
        worldAction: { type: 'wait' },
        communication: { channel: 'public', message: ' x ' },
        summary: 'Publish.',
      }).success,
    ).toBe(true);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentPublicMessages: Array(12).fill(publicMessage),
      }).success,
    ).toBe(true);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentPublicMessages: Array(13).fill(publicMessage),
      }).success,
    ).toBe(false);
  });

  it('caps chronological gained/lost control observations at six', () => {
    const change = {
      eventId: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
      direction: 'gained',
      otherAgentId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
      otherAgentName: 'Rook',
      cell,
      occurredAt: '2026-08-13T12:00:01.000Z',
    };
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentControlChanges: Array(6).fill(change),
      }).success,
    ).toBe(true);
    expect(
      agentObservationSchema.safeParse({
        ...observation,
        recentControlChanges: Array(7).fill(change),
      }).success,
    ).toBe(false);
  });
});

describe('reasoning profiles', () => {
  const model: CompatibleModel = {
    id: 'example/reasoning-model',
    name: 'Reasoning Model',
    author: 'example',
    contextLength: 16_384,
    inputPricePerToken: '0',
    outputPricePerToken: '0',
    supportedParameters: ['max_tokens'],
    isFree: true,
  };

  it('offers only metadata-advertised effort levels in stable order', () => {
    expect(
      reasoningProfilesForModel({
        ...model,
        reasoning: {
          mandatory: false,
          supportedEfforts: ['xhigh', 'low', 'medium'],
        },
      }),
    ).toEqual(['provider-default', 'off', 'low', 'medium', 'xhigh']);
    expect(reasoningProfilesForModel(model)).toEqual(['provider-default']);
  });

  it('omits Off for mandatory reasoning while retaining advertised efforts', () => {
    expect(
      reasoningProfilesForModel({
        ...model,
        reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] },
      }),
    ).toEqual(['provider-default', 'low', 'high']);
  });

  it('defaults older model assignments to Provider default', () => {
    expect(
      experimentModelConfigurationSchema.parse({
        globalModelId: model.id,
        overrides: [{ agentId, modelId: model.id }],
      }),
    ).toMatchObject({
      globalReasoningProfile: 'provider-default',
      overrides: [{ reasoningProfile: 'provider-default' }],
    });
  });
});

describe('turn and snapshot schemas', () => {
  it('validates state-only export snapshots without dropping controller invariants', () => {
    const worldState = {
      generatedAt: snapshot.world.generatedAt,
      hexes: snapshot.world.hexes,
      agents: snapshot.world.agents,
    };
    expect(experimentExportWorldStateSchema.safeParse(worldState).success).toBe(
      true,
    );
    expect(
      experimentExportWorldStateSchema.safeParse({
        ...worldState,
        hexes: [
          {
            cell,
            state: 'infected',
            controllerAgentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      ...baseTurn,
      outcome: 'accepted',
      worldAction: { type: 'infect' },
      summary: 'Infect.',
      worldActionResult: { accepted: true, event },
      communicationResult: { requested: false },
      diplomacyResult: { requested: false },
      provider,
    },
    {
      ...baseTurn,
      outcome: 'rejected',
      worldAction: { type: 'move', targetCell: adjacent },
      summary: 'Move.',
      worldActionResult: {
        accepted: false,
        reason: 'not-adjacent',
        details: 'No.',
      },
      communicationResult: { requested: false },
      diplomacyResult: { requested: false },
      provider,
    },
    {
      ...baseTurn,
      outcome: 'provider-error',
      failure: { code: 'timeout', message: 'Timed out.', retryable: true },
    },
    {
      ...baseTurn,
      outcome: 'lost-tick',
      tickNumber: 1,
      tickPosition: 1,
      virtualTime: '2026-08-13T12:05:00.000Z',
      tickIntervalMinutes: 5,
      failure: { code: 'timeout', message: 'Timed out.', retryable: false },
    },
  ])('validates $outcome turn records', (turn) => {
    expect(agentTurnRecordSchema.safeParse(turn).success).toBe(true);
  });

  it('validates a complete API snapshot and rejects unbounded histories', () => {
    const validTurn = {
      ...baseTurn,
      outcome: 'accepted',
      worldAction: { type: 'infect' },
      summary: 'Infect.',
      worldActionResult: { accepted: true, event },
      communicationResult: { requested: false },
      diplomacyResult: { requested: false },
      provider,
    };
    expect(simulationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      simulationSnapshotSchema.safeParse({
        ...snapshot,
        turns: Array(121).fill(validTurn),
      }).success,
    ).toBe(false);
    expect(
      simulationSnapshotSchema.safeParse({
        ...snapshot,
        world: {
          ...snapshot.world,
          events: Array(121).fill(event),
        },
      }).success,
    ).toBe(false);
  });

  it('requires tick attribution as one complete metadata group', () => {
    const lost = {
      ...baseTurn,
      outcome: 'lost-tick',
      failure: { code: 'timeout', message: 'Timed out.', retryable: false },
    };
    expect(
      agentTurnRecordSchema.safeParse({ ...lost, tickNumber: 1 }).success,
    ).toBe(false);
    expect(
      agentTurnRecordSchema.safeParse({
        ...lost,
        tickNumber: 1,
        tickPosition: 1,
        virtualTime: '2026-08-13T12:05:00.000Z',
        tickIntervalMinutes: 5,
      }).success,
    ).toBe(true);
    expect(
      experimentExportTurnSchema.safeParse({
        turnNumber: 1,
        tickNumber: 1,
        startedAt: baseTurn.startedAt,
        completedAt: baseTurn.completedAt,
        agentId,
        outcome: 'lost-tick',
        failure: { code: 'timeout', message: 'Timed out.', retryable: false },
      }).success,
    ).toBe(false);
  });

  it('requires one consistently attributed record per roster agent in tick responses', () => {
    const virtualTime = '2026-08-13T12:05:00.000Z';
    const records = worldAgents.map((agent, index) => ({
      ...baseTurn,
      turnNumber: index + 1,
      agentId: agent.id,
      observation: { ...observation, agentId: agent.id, agentName: agent.name },
      outcome: 'lost-tick',
      tickNumber: 1,
      tickPosition: index + 1,
      virtualTime,
      tickIntervalMinutes: 5,
      failure: { code: 'timeout', message: 'Timed out.', retryable: false },
    }));
    const tickSnapshot = {
      ...snapshot,
      turnNumber: records.length,
      tickNumber: 1,
      virtualTime,
      lastTickIntervalMinutes: 5,
      resolutionOrder: records.map(({ agentId: id }) => id),
      turns: records,
    };
    expect(
      singleTickResponseSchema.safeParse({
        snapshot: tickSnapshot,
        tickNumber: 1,
        records,
      }).success,
    ).toBe(true);
    expect(
      singleTickResponseSchema.safeParse({
        snapshot: tickSnapshot,
        tickNumber: 1,
        records: records.slice(1),
      }).success,
    ).toBe(false);
    expect(
      singleTickResponseSchema.safeParse({
        snapshot: tickSnapshot,
        tickNumber: 1,
        records: records.map((record) => ({ ...record, tickPosition: 1 })),
      }).success,
    ).toBe(false);
  });
});

describe('experiment telemetry and export contracts', () => {
  it('accepts complete, partial and tiny-cost provider usage without fabricating unknowns', () => {
    expect(
      providerMetadataSchema.parse({
        ...provider,
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
        reasoningTokens: 1,
        cachedReadTokens: 8,
        cacheWriteTokens: 2,
        costCredits: 0.00000001,
      }).costCredits,
    ).toBe(0.00000001);
    expect(providerMetadataSchema.parse(provider)).not.toHaveProperty(
      'costCredits',
    );
  });

  it('validates experiment identities and immutable configuration events', () => {
    expect(experimentIdSchema.safeParse('not-an-id').success).toBe(false);
    expect(
      personalityConfigurationEventSchema.safeParse({
        timestamp: '2026-08-13T12:00:00.000Z',
        agentId,
        previousPersonality: 'Before.',
        newPersonality: 'After.',
        operation: 'custom-edit',
      }).success,
    ).toBe(true);
  });

  it('validates all levels and rejects empty, malformed, duplicate and inverted selections', () => {
    const base = {
      agents: { mode: 'selected', agentIds: [agentId] },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted'],
      actions: ['capture', 'wait'],
      communications: { channel: 'all', status: 'all' },
    };
    for (const level of ['minimal', 'standard', 'full-safe'])
      expect(
        experimentExportRequestSchema.safeParse({ ...base, level }).success,
      ).toBe(true);
    expect(
      experimentExportRequestSchema.parse({ ...base, level: 'minimal' })
        .serialization,
    ).toBe('compact');
    expect(
      experimentExportRequestSchema.safeParse({
        ...base,
        level: 'minimal',
        serialization: 'pretty',
      }).success,
    ).toBe(true);
    expect(
      experimentExportRequestSchema.safeParse({
        ...base,
        level: 'custom',
        custom: {
          turnObservations: false,
          personalityTextHistory: false,
          nearbyAgents: false,
          recentEvents: false,
          recentPublicMessages: false,
          recentDirectMessages: false,
          recentControlChanges: false,
          validationDetails: false,
          resultingEvents: false,
          providerUsageMetadata: false,
          initialWorldState: false,
          currentWorldState: false,
          computedMetrics: false,
          communications: true,
          controlChanges: true,
        },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...base, agents: { mode: 'selected', agentIds: [] }, level: 'minimal' },
      { ...base, outcomes: [], level: 'minimal' },
      { ...base, actions: [], level: 'minimal' },
      {
        ...base,
        turns: { mode: 'range', fromTurn: 9, toTurn: 2 },
        level: 'minimal',
      },
      {
        ...base,
        agents: { mode: 'selected', agentIds: ['bad-id'] },
        level: 'minimal',
      },
    ])
      expect(experimentExportRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
});

describe('personality mutation contracts', () => {
  it('trims a valid update and validates its response', () => {
    const request = updateAgentPersonalityRequestSchema.parse({
      personality: '  Seek open adjacent cells.  ',
    });
    expect(request).toEqual({ personality: 'Seek open adjacent cells.' });
    expect(
      updateAgentPersonalityResponseSchema.safeParse({
        snapshot,
        agent: { ...worldAgent, personality: request.personality },
      }).success,
    ).toBe(true);
  });

  it.each([
    { personality: '' },
    { personality: '   ' },
    { personality: 'x'.repeat(PERSONALITY_MAX_LENGTH + 1) },
    { personality: 42 },
    { personality: 'Valid.', unexpected: true },
    null,
  ])('rejects empty, oversized, or malformed updates', (request) => {
    expect(updateAgentPersonalityRequestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it('validates restore-default responses and typed safe errors', () => {
    expect(
      restoreDefaultPersonalitiesResponseSchema.safeParse({ snapshot }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: 'personality_conflict',
          message: 'A turn is active.',
        },
      }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({
        error: {
          code: 'artifact_changed',
          message: 'Generate the export again before saving.',
        },
      }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'provider_secret', message: 'unsafe' },
      }).success,
    ).toBe(false);
  });

  it('bounds archive-write confirmations and rejects extra fields', () => {
    const confirmation = {
      experimentId: '018f3f38-6b7d-7db7-8e95-751b4ce2681e',
      inserted: 4,
      existing: 1,
      skipped: 0,
      rejected: 0,
      idempotent: false,
    };
    expect(
      archiveExperimentExportResponseSchema.safeParse(confirmation).success,
    ).toBe(true);
    expect(
      archiveExperimentExportResponseSchema.safeParse({
        ...confirmation,
        inserted: -1,
      }).success,
    ).toBe(false);
    expect(
      archiveExperimentExportResponseSchema.safeParse({
        ...confirmation,
        archivePath: '/private/archive.sqlite',
      }).success,
    ).toBe(false);
  });
});
