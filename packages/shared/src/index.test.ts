import { describe, expect, it } from 'vitest';
import {
  SWARM_PLANNER_CONTRACT_VERSION,
  OBJECTIVE_PROMPT_VERSION,
  apiErrorSchema,
  agentObservationSchema,
  captureEligibilitySchema,
  experimentExportWorldStateSchema,
  hexCapturedWorldEventSchema,
  simulatedPlayerAgentCapturedEventSchema,
  hexSchema,
  invalidActionReasonSchema,
  experimentExportRequestSchema,
  experimentIdSchema,
  providerMetadataSchema,
  simulationSnapshotSchema,
  worldSnapshotSchema,
  singleTickResponseSchema,
  patientZeroPlayerThreatFeedSchema,
  PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT,
  DEVELOPMENT_WORLD_CONFIG,
  experimentModelConfigurationSchema,
  modelVerificationSchema,
  reasoningProfilesForModel,
  type CompatibleModel,
  swarmPlannerContractVersionSchema,
  archiveExperimentExportResponseSchema,
  providerAttemptRecordSchema,
  zeroStrategicObservationSchema,
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
  controlledCellCount: 0,
}));
const observation = {
  agentId,
  agentName: 'Ember',
  currentCell: {
    cell,
    state: 'open',
    controllerAgentId: null,
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
    },
  ],
  nearbyAgents: [],
  recentEvents: [],
  territoryScoreboard: scoreboard,
  recentControlChanges: [],
};
const provider = {
  provider: 'openrouter',
  model: 'example/compatible-model',
  latencyMs: 100,
};
const worldAgents = scoreboard.map((entry) => ({
  id: entry.agentId,
  name: entry.name,
  color: entry.color,
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
    patientZeroAgentId: worldAgents[0]!.id,
    roster: worldAgents.map(({ id, name, color }) => ({ id, name, color })),
    modelConfiguration: {
      globalModelId: 'author/compatible-model',
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    },
    objectiveVersion: 'durable-influence-v2',
    capabilities: {},
    swarmPlannerContractVersion: SWARM_PLANNER_CONTRACT_VERSION,
    exactCellCount: 1,
    areaSquareKilometers: 0.1,
    startingCells: worldAgents.map(() => cell),
    setupWarnings: [],
  },
  turnNumber: 0,
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
  experiment: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: '2026-08-13T12:00:00.000Z',
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
        uniqueVisitedCells: 0,
        tokens: {},
        tokenUsageComplete: true,
        attemptsWithUnknownTokenUsage: 0,
        knownCostCredits: 0,
        attemptsWithUnknownCost: 0,
      },
      byAgent: [],
    },
    currentTerritory: scoreboard,
  },
};

describe('agent observation schema', () => {
  it('accepts a bounded state-bearing observation', () => {
    const parsed = agentObservationSchema.parse(observation);
    expect(parsed.currentCell.state).toBe('open');
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
      }),
    },
  ])('rejects invalid or oversized observations', (value) => {
    expect(agentObservationSchema.safeParse(value).success).toBe(false);
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

describe('Patient Zero player-threat feed', () => {
  it('caps Patient Zero cleaner evidence with truthful overflow metadata', () => {
    const pressureContext = {
      window: { tickCount: 6, startTick: 3, endTick: 8 },
      subject: {
        totalEvents: 3,
        disinfections: 2,
        blockedCleans: 1,
        consecutiveAffectedTicks: 2,
      },
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
            ...blockedBase,
            kind: 'occupied-clean-blocked',
            blockingAgentId: agentId,
            blockingAgentName: 'Ember',
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
});

describe('engine contract identifiers', () => {
  it('preserves established engine contract identifiers through branding changes', () => {
    expect(SWARM_PLANNER_CONTRACT_VERSION).toBe('swarm-planner-v1');
    expect(OBJECTIVE_PROMPT_VERSION).toBe('durable-influence-v3');
    expect(
      modelVerificationSchema.parse({
        modelId: 'author/model',
        contractVersion: SWARM_PLANNER_CONTRACT_VERSION,
        status: 'untested',
      }).contractVersion,
    ).toBe(SWARM_PLANNER_CONTRACT_VERSION);
    expect(
      modelVerificationSchema.safeParse({
        modelId: 'author/model',
        contractVersion: 'text-flat-json-v3',
        status: 'untested',
      }).success,
    ).toBe(false);
    expect(
      swarmPlannerContractVersionSchema.parse(SWARM_PLANNER_CONTRACT_VERSION),
    ).toBe(SWARM_PLANNER_CONTRACT_VERSION);
  });

  it('centralizes eight-agent, 127-cell world defaults', () => {
    expect(DEVELOPMENT_WORLD_CONFIG).toMatchObject({
      radius: 6,
      cellCount: 127,
      agentCount: 8,
      resolution: 9,
    });
  });
});

describe('world snapshot validation', () => {
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
    ).toBe(true);
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
    expect(
      hexCapturedWorldEventSchema.safeParse({
        id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
        type: 'hex-captured',
        agentId,
        controllerAgentId: agentId,
        previousControllerAgentId: null,
        cell,
        occurredAt: '2026-08-13T12:00:01.000Z',
      }).success,
    ).toBe(true);
    expect(
      simulatedPlayerAgentCapturedEventSchema.safeParse({
        id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
        type: 'simulated-player-agent-captured',
        profile: 'trail-hunter-v1',
        originatingTick: 2,
        occurredAt: '2026-08-13T12:00:01.000Z',
        cell,
        capturedAgentId: agentId,
        abandonedCellCount: 3,
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

  it('rejects a simulated player positioned outside the world', () => {
    expect(
      worldSnapshotSchema.safeParse({
        generatedAt: '2026-08-13T12:00:00.000Z',
        hexes: [{ cell, state: 'open', controllerAgentId: null }],
        agents: [],
        events: [],
        simulatedPlayer: {
          profile: 'casual-cleaner',
          currentCell: adjacent,
          metrics: {
            movements: 0,
            cellsDisinfected: 0,
            blockedDisinfections: 0,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('Zero strategic observation schema', () => {
  const strategicObservation = {
    zeroAgentId: agentId,
    tickNumber: 2,
    virtualTime: '2026-08-13T12:00:00.000Z',
    cells: [{ cell, state: 'infected' as const, controllerAgentId: agentId }],
    agents: [
      {
        agentId,
        position: cell,
        controlledCellCount: 1,
        territoryDelta: 0,
        localPressure: 'low' as const,
        pressureDirection: null,
        pressureDistance: null,
      },
      {
        agentId: scoreboard[1]!.agentId,
        position: cell,
        controlledCellCount: 0,
        territoryDelta: 0,
        localPressure: 'rising' as const,
        pressureDirection: 'NE' as const,
        pressureDistance: 'adjacent' as const,
      },
    ],
    recentPlayerPressure: [],
    legalZeroActions: [
      {
        id: 'zero_action_0',
        action: { type: 'wait' as const },
        description: 'Wait on the current cell.',
      },
    ],
    strategicTargetCells: [cell],
  };

  it('requires bounded semantic worker threat fields and caps recent captures', () => {
    expect(
      zeroStrategicObservationSchema.safeParse(strategicObservation).success,
    ).toBe(true);
    expect(
      zeroStrategicObservationSchema.safeParse({
        ...strategicObservation,
        agents: strategicObservation.agents.map((agent, index) =>
          index === 1 ? { ...agent, localPressure: undefined } : agent,
        ),
      }).success,
    ).toBe(false);
    expect(
      zeroStrategicObservationSchema.safeParse({
        ...strategicObservation,
        recentCaptures: Array.from({ length: 5 }, () => ({
          capturedAgentId: scoreboard[1]!.agentId,
          cell,
          originatingTick: 2,
          abandonedCellCount: 1,
        })),
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

describe('snapshot and export contracts', () => {
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

  it('validates a complete API snapshot and rejects unbounded histories', () => {
    expect(simulationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      simulationSnapshotSchema.safeParse({
        ...snapshot,
        world: {
          ...snapshot.world,
          events: Array(121).fill({
            id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
            agentId,
            occurredAt: '2026-08-13T12:00:01.000Z',
            type: 'hex-infected',
            cell,
            controllerAgentId: agentId,
          }),
        },
      }).success,
    ).toBe(false);
  });

  it('accepts terminal player-only ticks after trail-hunter captures', () => {
    const terminalBase = {
      ...snapshot,
      tickNumber: 1,
      lastTickIntervalMinutes: 5,
      resolutionOrder: [],
      activeAgentId: null,
    };
    expect(
      simulationSnapshotSchema.safeParse({
        ...terminalBase,
        status: 'infection-eliminated',
        world: { ...snapshot.world, agents: [] },
        resolvedModels: [],
        experiment: { ...snapshot.experiment, currentTerritory: [] },
      }).success,
    ).toBe(true);

    const survivingAgents = snapshot.world.agents.slice(1);
    const survivingIds = new Set(survivingAgents.map(({ id }) => id));
    expect(
      simulationSnapshotSchema.safeParse({
        ...terminalBase,
        status: 'patient-zero-captured',
        world: { ...snapshot.world, agents: survivingAgents },
        resolvedModels: snapshot.resolvedModels.filter(({ agentId }) =>
          survivingIds.has(agentId),
        ),
        experiment: {
          ...snapshot.experiment,
          currentTerritory: snapshot.experiment.currentTerritory.filter(
            ({ agentId }) => survivingIds.has(agentId),
          ),
        },
      }).success,
    ).toBe(true);
  });

  it('requires swarm telemetry in tick responses', () => {
    expect(
      singleTickResponseSchema.safeParse({ snapshot, tickNumber: 1 }).success,
    ).toBe(false);
  });

  it('validates all levels and rejects empty, malformed, duplicate and inverted selections', () => {
    const base = {
      agents: { mode: 'selected', agentIds: [agentId] },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted'],
      actions: ['capture', 'wait'],
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
          nearbyAgents: false,
          recentEvents: false,
          recentControlChanges: false,
          validationDetails: false,
          resultingEvents: false,
          providerUsageMetadata: false,
          initialWorldState: false,
          currentWorldState: false,
          computedMetrics: false,
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

describe('provider and archive contracts', () => {
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

  it('validates experiment identities', () => {
    expect(experimentIdSchema.safeParse('not-an-id').success).toBe(false);
  });

  it('validates typed safe API errors', () => {
    for (const code of ['tick_conflict', 'experiment_budget_exhausted'])
      expect(
        apiErrorSchema.safeParse({
          error: { code, message: 'The tick cannot start.' },
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

  it('validates safe provider-attempt lifecycle records and canonical costs', () => {
    const base = {
      id: '018f3f38-6b7d-7db7-8e95-751b4ce2681e',
      agentId,
      intendedTurnNumber: 1,
      intendedTickNumber: 1,
      kind: 'initial',
      startedAt: '2026-08-13T12:00:00.000Z',
      modelId: 'deterministic-script',
      reasoningProfile: 'provider-default',
      reservedCredits: '0.01',
    };
    expect(
      providerAttemptRecordSchema.safeParse({ ...base, outcome: 'in-flight' })
        .success,
    ).toBe(true);
    expect(
      providerAttemptRecordSchema.safeParse({
        ...base,
        outcome: 'completed',
        completedAt: '2026-08-13T12:00:01.000Z',
        actualCostCredits: '0.00000001',
        provider: {
          provider: 'scripted-test',
          model: 'deterministic-script',
          latencyMs: 1,
          costCredits: 1e-8,
        },
      }).success,
    ).toBe(true);
    const reflexDecision = {
      chosenCandidateId: 'action_0',
      confidence: 0.9,
      probabilities: { action_0: 0.9, action_1: 0.1 },
      model: 'jev-1.13.0',
      latencyMs: 12,
      inputTokens: 24,
      outputTokens: 1,
      directiveId: 'directive-1',
      cognitionSource: 'jev-reflex' as const,
    };
    expect(
      providerAttemptRecordSchema.safeParse({
        ...base,
        outcome: 'completed',
        completedAt: '2026-08-13T12:00:01.000Z',
        reflexDecision,
      }).success,
    ).toBe(true);
    expect(
      providerAttemptRecordSchema.safeParse({
        ...base,
        outcome: 'in-flight',
        reflexDecision,
      }).success,
    ).toBe(false);
    expect(
      providerAttemptRecordSchema.safeParse({
        ...base,
        outcome: 'cancelled',
        completedAt: '2026-08-13T12:00:01.000Z',
      }).success,
    ).toBe(false);
    expect(
      providerAttemptRecordSchema.safeParse({
        ...base,
        outcome: 'in-flight',
        rawResponse: 'unsafe',
      }).success,
    ).toBe(false);
  });
});
