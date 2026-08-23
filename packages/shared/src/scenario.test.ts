import { describe, expect, it } from 'vitest';
import {
  appliedScenarioSchema,
  archivedAppliedScenarioSchema,
  assignBehavior,
  behaviorConfigurationSchema,
  worldSetupPreviewResponseSchema,
  worldSetupRequestSchema,
  WORLD_SCENARIO_LIMITS,
  AGENT_DECISION_CONTRACT_VERSION,
  LEGACY_AGENT_DECISION_CONTRACT_VERSION,
} from './index';

const roster = [
  {
    id: '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
    name: 'Ember',
    color: '#ff6b57',
    personality: 'Adaptive.',
  },
] as const;
const request = {
  scenarioVersion: 'world-scenario-v1' as const,
  center: { latitude: 41.6528, longitude: -83.5379 },
  resolution: 9,
  radius: 3,
  worldSeed: 'world',
  rosterSeed: 'roster',
  spawnSeed: 'spawn',
  minimumSpawnSeparation: 1,
  communicationRangeKm: 12,
  patientZeroAgentId: roster[0].id,
  roster: [...roster],
  modelConfiguration: {
    globalModelId: null,
    globalReasoningProfile: 'provider-default' as const,
    overrides: [],
    locked: false,
  },
  behaviorConfiguration: {
    registryVersion: 1 as const,
    assignmentMode: 'balanced-random' as const,
    seed: 'behavior',
    assignments: assignBehavior(
      roster.map(({ id }) => id as never),
      'behavior',
      'balanced-random',
    ),
    locked: false,
  },
  objectiveVersion: 'durable-influence-v2' as const,
  capabilities: { communication: true, diplomacy: true },
};

describe('scenario contracts', () => {
  it('defaults safe virtual tick bounds and rejects inverted bounds', () => {
    const parsed = worldSetupRequestSchema.parse(request);
    expect(parsed.minimumTickIntervalMinutes).toBe(5);
    expect(parsed.maximumTickIntervalMinutes).toBe(10);
    expect(
      worldSetupRequestSchema.safeParse({
        ...parsed,
        minimumTickIntervalMinutes: 11,
        maximumTickIntervalMinutes: 10,
      }).success,
    ).toBe(false);
    expect(parsed.simulatedPlayer).toEqual({
      enabled: false,
      profile: 'casual-cleaner',
      seed: 'casual-cleaner-v1',
    });
    expect(parsed.capabilities.simulatedPlayerPressure).toBe(false);
    expect(parsed.objectiveVersion).toBe('durable-influence-v2');
    expect(
      worldSetupRequestSchema.safeParse({
        ...parsed,
        capabilities: {
          ...parsed.capabilities,
          simulatedPlayerPressure: true,
        },
      }).success,
    ).toBe(false);
    expect(
      worldSetupRequestSchema.safeParse({
        ...parsed,
        objectiveVersion: 'durable-influence-v3',
      }).success,
    ).toBe(false);
    expect(
      worldSetupRequestSchema.safeParse({
        ...parsed,
        objectiveVersion: 'durable-influence-v2',
        capabilities: {
          ...parsed.capabilities,
          simulatedPlayerPressure: true,
        },
        simulatedPlayer: {
          enabled: true,
          profile: 'casual-cleaner',
          seed: 'pressure',
        },
      }).success,
    ).toBe(false);
    expect(
      worldSetupRequestSchema.safeParse({
        ...parsed,
        objectiveVersion: 'durable-influence-v3',
        capabilities: {
          ...parsed.capabilities,
          simulatedPlayerPressure: true,
        },
        simulatedPlayer: {
          enabled: true,
          profile: 'casual-cleaner',
          seed: 'pressure',
        },
      }).success,
    ).toBe(true);
  });

  it('centralizes temporary limits', () => {
    expect(WORLD_SCENARIO_LIMITS).toMatchObject({
      minimumAgents: 1,
      maximumAgents: 32,
      minimumResolution: 8,
      maximumResolution: 11,
      maximumGeneratedCells: 5000,
      maximumRadius: 40,
    });
  });

  it('runtime-validates request, preview and applied contracts', () => {
    const parsed = worldSetupRequestSchema.parse(request);
    const scenario = {
      ...parsed,
      exactCellCount: 1,
      areaSquareKilometers: 0.1,
      startingCells: ['8928308280fffff'],
      setupWarnings: [],
    };
    const preview = worldSetupPreviewResponseSchema.parse({
      feasible: true,
      scenario,
      world: {
        generatedAt: '2026-08-15T00:00:00.000Z',
        hexes: [
          { cell: '8928308280fffff', state: 'open', controllerAgentId: null },
        ],
        agents: [{ ...parsed.roster[0], currentCell: '8928308280fffff' }],
        events: [],
        alliances: [],
        pendingAllianceProposals: [],
      },
    });
    expect(preview.feasible).toBe(true);
    if (preview.feasible)
      expect(
        appliedScenarioSchema.parse(preview.scenario).objectiveVersion,
      ).toBe('durable-influence-v2');
  });

  it('rejects dynamic roster overflow and behavior under-coverage', () => {
    expect(
      worldSetupRequestSchema.safeParse({
        ...request,
        roster: Array.from({ length: 33 }, (_, index) => ({
          ...roster[0],
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          name: `Agent ${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      behaviorConfigurationSchema.safeParse({
        ...request.behaviorConfiguration,
        assignments: [],
      }).success,
    ).toBe(false);
  });

  it('requires a known Patient Zero for current setup requests', () => {
    expect(
      worldSetupRequestSchema.safeParse({
        ...request,
        patientZeroAgentId: undefined,
      }).success,
    ).toBe(false);
    expect(
      worldSetupRequestSchema.safeParse({
        ...request,
        patientZeroAgentId: null,
      }).success,
    ).toBe(false);
    expect(
      worldSetupRequestSchema.parse({
        ...request,
        patientZeroAgentId: roster[0].id,
      }).patientZeroAgentId,
    ).toBe(roster[0].id);
    expect(
      worldSetupRequestSchema.safeParse({
        ...request,
        patientZeroAgentId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
      }).success,
    ).toBe(false);
  });

  it('keeps prompt attribution out of setup input and attributes applied scenarios to the current contract', () => {
    expect(
      worldSetupRequestSchema.safeParse({
        ...request,
        decisionContractVersion: LEGACY_AGENT_DECISION_CONTRACT_VERSION,
      }).success,
    ).toBe(false);
    expect(
      appliedScenarioSchema.parse({
        ...worldSetupRequestSchema.parse(request),
        exactCellCount: 1,
        areaSquareKilometers: 0.1,
        startingCells: ['8928308280fffff'],
        setupWarnings: [],
      }).decisionContractVersion,
    ).toBe(AGENT_DECISION_CONTRACT_VERSION);
  });

  it('preserves null only for strict archived applied scenarios with common refinements', () => {
    const archivedRoster = [
      ...request.roster,
      {
        ...request.roster[0],
        id: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
        name: 'Rook',
      },
    ];
    const archived = {
      ...worldSetupRequestSchema.parse(request),
      patientZeroAgentId: null,
      roster: archivedRoster,
      behaviorConfiguration: {
        ...request.behaviorConfiguration,
        assignments: assignBehavior(
          archivedRoster.map(({ id }) => id as never),
          request.behaviorConfiguration.seed,
          'balanced-random',
        ),
      },
      exactCellCount: 2,
      areaSquareKilometers: 0.1,
      startingCells: ['8928308280fffff', '892a1072893ffff'],
      setupWarnings: [],
    };
    expect(
      archivedAppliedScenarioSchema.parse(archived).patientZeroAgentId,
    ).toBeNull();
    expect(
      archivedAppliedScenarioSchema.parse({
        ...archived,
        objectiveVersion: 'durable-influence-v1',
      }).objectiveVersion,
    ).toBe('durable-influence-v1');
    const missingObjective = { ...archived } as Record<string, unknown>;
    delete missingObjective.objectiveVersion;
    expect(
      archivedAppliedScenarioSchema.parse(missingObjective).objectiveVersion,
    ).toBe('durable-influence-v2');
    expect(
      archivedAppliedScenarioSchema.safeParse({
        ...archived,
        objectiveVersion: 'durable-influence-v1',
        capabilities: {
          ...archived.capabilities,
          simulatedPlayerPressure: true,
        },
        simulatedPlayer: {
          enabled: true,
          profile: 'casual-cleaner',
          seed: 'legacy-pressure',
        },
      }).success,
    ).toBe(false);
    expect(
      archivedAppliedScenarioSchema.safeParse({
        ...archived,
        maximumTickIntervalMinutes: 1,
        minimumTickIntervalMinutes: 2,
      }).success,
    ).toBe(false);
    expect(
      archivedAppliedScenarioSchema.safeParse({
        ...archived,
        startingCells: archived.startingCells.slice(0, -1),
      }).success,
    ).toBe(false);
    expect(
      archivedAppliedScenarioSchema.safeParse({
        ...archived,
        unknownHistoricalField: true,
      }).success,
    ).toBe(false);
  });
});
