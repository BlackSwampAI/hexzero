import { describe, expect, it, vi } from 'vitest';
import { gridDistance } from 'h3-js';
import {
  AgentProviderError,
  ScriptedAgentProvider,
  type AgentProvider,
  type ProviderDecision,
} from '@hexzero/agent-runtime';
import {
  AGENT_DECISION_CONTRACT_VERSION,
  ALLIANCE_COLOR_PALETTE,
  PERSONALITY_MAX_LENGTH,
  PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS,
  assignBehavior,
  agentIdSchema,
  allianceIdSchema,
  agentTurnRecordSchema,
  experimentExportDocumentSchema,
  h3CellSchema,
  memoryIdSchema,
  type Alliance,
  type AgentId,
  type AgentObservation,
  type AgentTurnRecord,
  type CompatibleModel,
  type WorldEvent,
} from '@hexzero/shared';
import {
  DEVELOPMENT_AGENT_BLUEPRINTS,
  createDevelopmentWorld,
  defaultWorldSetupRequest,
  generateDeterministicRoster,
  physicalDistanceKm,
  toWorldState,
  type WorldState,
} from '@hexzero/world-engine';
import {
  SimulationConflictError,
  SimulationService,
  SimulationTurnCancelledError,
  SimulationValidationError,
  selectDiplomacyBlockerExamples,
  applyGoalRevision,
  applyMemoryOperation,
} from './simulation-service';
import {
  calculateExperimentMetrics,
  serializeExperimentExport,
} from './experiment-export';

const now = () => '2026-08-13T12:00:01.000Z';
const createEventId = () => '67aa21b9-fc78-4b04-9f92-9862bf346f96';
const compatibleModels: CompatibleModel[] = [
  {
    id: 'author/global-model',
    name: 'Global Model',
    author: 'author',
    contextLength: 16_384,
    inputPricePerToken: '0.000001',
    outputPricePerToken: '0.000002',
    supportedParameters: ['max_tokens'],
    isFree: false,
    reasoning: {
      mandatory: false,
      supportedEfforts: ['xhigh', 'low', 'medium'],
    },
  },
  {
    id: 'author/override-model',
    name: 'Override Model',
    author: 'author',
    contextLength: 32_768,
    inputPricePerToken: '0',
    outputPricePerToken: '0',
    supportedParameters: ['max_tokens'],
    isFree: true,
    reasoning: {
      mandatory: true,
      supportedEfforts: ['high', 'low'],
    },
  },
];

function service(provider: AgentProvider) {
  return new SimulationService({ provider, now, createEventId });
}

function exportRequest(level: 'minimal' | 'standard' | 'full-safe' | 'custom') {
  return {
    agents: { mode: 'all' as const },
    turns: { mode: 'entire-retained' as const },
    outcomes: ['accepted', 'rejected', 'provider-error'] as const,
    actions: ['move', 'infect', 'capture', 'wait'] as const,
    communications: { channel: 'all' as const, status: 'all' as const },
    level,
  };
}

describe('SimulationService', () => {
  it('keeps compact memory canonical and rejects full or missing operations independently', () => {
    const agent = agentIdSchema.parse('128f3f38-6b7d-4db7-9e95-751b4ce2681e');
    const remembered = applyMemoryOperation(
      [],
      { operation: 'remember', text: 'The northern route was blocked.' },
      agent,
      1,
    );
    expect(remembered).toMatchObject({
      entries: [
        {
          text: 'The northern route was blocked.',
          createdAtTick: 1,
          revisedAtTick: 1,
        },
      ],
      result: { accepted: true, operation: 'remember' },
    });
    const id = remembered.entries[0]!.id;
    const revised = applyMemoryOperation(
      remembered.entries,
      { operation: 'revise', memoryId: id, text: 'The route reopened.' },
      agent,
      2,
    );
    expect(revised.entries[0]).toMatchObject({
      id,
      text: 'The route reopened.',
      createdAtTick: 1,
      revisedAtTick: 2,
    });
    expect(remembered.entries[0]!.text).toBe(
      'The northern route was blocked.',
    );
    expect(
      applyMemoryOperation(
        revised.entries,
        {
          operation: 'forget',
          memoryId: memoryIdSchema.parse(
            'memory:00000000-0000-4000-8000-000000000999:1',
          ),
        },
        agent,
        3,
      ).result,
    ).toMatchObject({ accepted: false, reason: 'memory-not-found' });
    const full = Array.from({ length: 8 }, (_, index) => ({
      id: memoryIdSchema.parse(`memory:${agent}:${index + 1}`),
      text: `Memory ${index + 1}`,
      createdAtTick: index + 1,
      revisedAtTick: index + 1,
    }));
    expect(
      applyMemoryOperation(
        full,
        { operation: 'remember', text: 'Overflow.' },
        agent,
        9,
      ).result,
    ).toMatchObject({ accepted: false, reason: 'memory-full' });
    expect(
      applyMemoryOperation(
        revised.entries,
        { operation: 'forget', memoryId: id },
        agent,
        3,
      ).entries,
    ).toEqual([]);
  });

  it('keeps, revises, completes, and abandons active goal state deterministically', () => {
    const initial = applyGoalRevision(
      undefined,
      {
        operation: 'establish',
        longTermGoal: 'Hold a corridor.',
        shortTermGoal: 'Infect the frontier.',
        planSummary: 'Expand north.',
        reason: 'Begin a plan.',
      },
      1,
    ).goal!;
    expect(applyGoalRevision(initial, { operation: 'keep' }, 2)).toEqual({
      goal: initial,
      result: { requested: true, accepted: true, operation: 'keep' },
    });
    const revised = applyGoalRevision(
      initial,
      {
        operation: 'revise',
        longTermGoal: 'Hold a corridor.',
        shortTermGoal: 'Turn east.',
        planSummary: 'Avoid the occupied route.',
        reason: 'The frontier changed.',
      },
      3,
    );
    expect(revised.goal).toMatchObject({
      establishedAtTick: 1,
      revisedAtTick: 3,
      shortTermGoal: 'Turn east.',
    });
    expect(
      applyGoalRevision(
        revised.goal,
        { operation: 'complete', reason: 'Done.' },
        4,
      ),
    ).toMatchObject({
      goal: undefined,
      result: { accepted: true, operation: 'complete' },
    });
    expect(
      applyGoalRevision(
        revised.goal,
        { operation: 'abandon', reason: 'Blocked.' },
        4,
      ),
    ).toMatchObject({
      goal: undefined,
      result: { accepted: true, operation: 'abandon' },
    });
  });

  it('applies bounded goal revisions independently from world actions and clears them on reset', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        {
          worldAction: { type: 'wait' },
          goalRevision: {
            operation: 'establish',
            longTermGoal: 'Control a durable corridor.',
            shortTermGoal: 'Secure the current frontier.',
            planSummary: 'Infect locally before moving outward.',
            reason: 'Create strategic continuity.',
          },
          memoryOperation: {
            operation: 'remember',
            text: 'The corridor plan began here.',
          },
          summary: 'Establish a corridor goal.',
        },
        {
          worldAction: { type: 'wait' },
          goalRevision: { operation: 'complete', reason: 'No goal exists.' },
          memoryOperation: {
            operation: 'revise',
            memoryId: memoryIdSchema.parse(
              'memory:00000000-0000-4000-8000-000000000999:1',
            ),
            text: 'This memory is unavailable.',
          },
          summary: 'Wait while requesting an unavailable completion.',
        },
      ]),
    );

    const established = await simulation.executeNextTurn();
    expect(established).toMatchObject({
      outcome: 'accepted',
      goalRevisionResult: {
        requested: true,
        accepted: true,
        operation: 'establish',
      },
    });
    expect(
      simulation
        .getSnapshot()
        .agentGoals.find(({ agentId }) => agentId === established.agentId)
        ?.goal,
    ).toMatchObject({ establishedAtTick: 1, revisedAtTick: 1 });
    expect(
      simulation
        .getSnapshot()
        .agentMemories.find(({ agentId }) => agentId === established.agentId)
        ?.entries,
    ).toEqual([
      expect.objectContaining({ text: 'The corridor plan began here.' }),
    ]);
    simulation.updateAgentPersonality(
      established.agentId,
      'A deliberate memory-preservation test personality.',
    );
    expect(
      simulation
        .getSnapshot()
        .agentMemories.find(({ agentId }) => agentId === established.agentId)
        ?.entries,
    ).toEqual([
      expect.objectContaining({ text: 'The corridor plan began here.' }),
    ]);
    simulation.restoreDefaultPersonalities();
    expect(
      simulation
        .getSnapshot()
        .agentGoals.find(({ agentId }) => agentId === established.agentId)
        ?.goal,
    ).toMatchObject({ longTermGoal: 'Control a durable corridor.' });
    const modelConfiguration = simulation.getSnapshot().modelConfiguration;
    simulation.updateModelConfiguration({
      globalModelId: modelConfiguration.globalModelId,
      globalReasoningProfile: modelConfiguration.globalReasoningProfile,
      overrides: modelConfiguration.overrides,
    });
    expect(
      simulation
        .getSnapshot()
        .agentGoals.find(({ agentId }) => agentId === established.agentId)
        ?.goal,
    ).toMatchObject({ longTermGoal: 'Control a durable corridor.' });
    const exported = simulation.generateExperimentExport(
      exportRequest('full-safe'),
    );
    expect(exported.currentGoals).toContainEqual({
      agentId: established.agentId,
      goal: expect.objectContaining({
        longTermGoal: 'Control a durable corridor.',
      }),
    });
    expect(exported.turns[0]).toMatchObject({
      goalRevision: { operation: 'establish' },
      goalRevisionResult: { accepted: true, operation: 'establish' },
      memoryOperation: { operation: 'remember' },
      memoryOperationResult: { accepted: true, operation: 'remember' },
    });
    expect(exported.currentMemories).toContainEqual({
      agentId: established.agentId,
      entries: [
        expect.objectContaining({ text: 'The corridor plan began here.' }),
      ],
    });
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentMemories: [
          exported.currentMemories![0],
          exported.currentMemories![0],
        ],
      }).success,
    ).toBe(false);
    const memorySelectionMismatch = structuredClone(exported);
    delete memorySelectionMismatch.currentGoals;
    memorySelectionMismatch.selection.selectedAgentIds =
      memorySelectionMismatch.selection.selectedAgentIds.slice(1);
    expect(
      experimentExportDocumentSchema.safeParse(memorySelectionMismatch).success,
    ).toBe(false);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentMemories: exported.currentMemories!.slice(1),
      }).success,
    ).toBe(false);
    simulation.importModelConfiguration(exported);
    expect(
      simulation
        .getSnapshot()
        .agentGoals.find(({ agentId }) => agentId === established.agentId)
        ?.goal,
    ).toMatchObject({ longTermGoal: 'Control a durable corridor.' });
    expect(
      simulation
        .getSnapshot()
        .agentMemories.find(({ agentId }) => agentId === established.agentId)
        ?.entries,
    ).toEqual([
      expect.objectContaining({ text: 'The corridor plan began here.' }),
    ]);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentGoals: [exported.currentGoals![0], exported.currentGoals![0]],
      }).success,
    ).toBe(false);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentGoals: exported.currentGoals!.slice(1),
      }).success,
    ).toBe(false);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentGoals: Array.from(
          { length: 33 },
          () => exported.currentGoals![0],
        ),
      }).success,
    ).toBe(false);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...exported,
        currentGoals: [
          {
            agentId: '00000000-0000-4000-8000-000000000999',
            goal: null,
          },
        ],
      }).success,
    ).toBe(false);

    const independentlyRejected = await simulation.executeNextTurn();
    expect(independentlyRejected).toMatchObject({
      outcome: 'accepted',
      worldActionResult: { accepted: true },
      goalRevisionResult: {
        requested: true,
        accepted: false,
        operation: 'complete',
        reason: 'goal-not-active',
      },
      memoryOperationResult: {
        requested: true,
        accepted: false,
        operation: 'revise',
        reason: 'memory-not-found',
      },
    });
    simulation.reset();
    expect(simulation.getSnapshot().agentGoals.every(({ goal }) => !goal)).toBe(
      true,
    );
    expect(
      simulation
        .getSnapshot()
        .agentMemories.every(({ entries }) => entries.length === 0),
    ).toBe(true);
  });

  it('freezes simultaneous goal observations and commits every completed revision together', async () => {
    const seen: AgentObservation[] = [];
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation) {
        seen.push(structuredClone(observation));
        return {
          decision: {
            worldAction: { type: 'wait' },
            goalRevision: {
              operation: 'establish',
              longTermGoal: `Durable influence for ${observation.agentName}.`,
              shortTermGoal: 'Hold the local frontier.',
              planSummary: 'Wait for this deterministic test.',
              reason: 'Establish initial continuity.',
            },
            memoryOperation: {
              operation: 'remember',
              text: `Initial memory for ${observation.agentName}.`,
            },
            summary: 'Establish a strategic goal.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const records = await simulation.executeNextTick();
    expect(seen).toHaveLength(records.length);
    expect(seen.every(({ currentGoal }) => currentGoal === null)).toBe(true);
    expect(seen.every(({ currentMemory }) => currentMemory.length === 0)).toBe(
      true,
    );
    expect(
      simulation.getSnapshot().agentGoals.every(({ goal }) => goal !== null),
    ).toBe(true);
    expect(
      simulation
        .getSnapshot()
        .agentMemories.every(({ entries }) => entries.length === 1),
    ).toBe(true);
    expect(records.every((record) => record.outcome === 'accepted')).toBe(true);
  });

  it('requires a known Patient Zero at the live setup boundary', () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    const setup = defaultWorldSetupRequest();
    expect(setup.patientZeroAgentId).toBe(setup.roster[0]!.id);
    expect(() =>
      simulation.applyWorldSetup({ ...setup, patientZeroAgentId: null }),
    ).toThrow(SimulationValidationError);
    expect(() =>
      simulation.applyWorldSetup({
        ...setup,
        patientZeroAgentId: '00000000-0000-4000-8000-000000000999',
      }),
    ).toThrow(SimulationValidationError);
    expect(simulation.getSnapshot().scenario.patientZeroAgentId).toBe(
      setup.patientZeroAgentId,
    );
  });

  it('prioritizes free diplomacy blocker examples before allied relationships', () => {
    const base = toWorldState(createDevelopmentWorld({ generatedAt: now() }));
    const agents = [...base.agents.values()];
    const allianceEntries: Array<[Alliance['id'], Alliance]> = Array.from(
      { length: 3 },
      (_, index) => {
        const id = allianceIdSchema.parse(
          `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        );
        return [
          id,
          {
            id,
            color: ALLIANCE_COLOR_PALETTE[index]!,
            memberAgentIds: [agents[index * 2]!.id, agents[index * 2 + 1]!.id],
          },
        ];
      },
    );
    const state: WorldState = {
      ...base,
      alliances: new Map(allianceEntries),
    };
    const firstFreeId = agents[6]!.id;
    const distantFreeCounterpartId = agents[7]!.id;
    const blockersFor = (actingAgentId: AgentId) =>
      agents
        .filter(({ id }) => id !== actingAgentId)
        .map(({ id }) => ({ agentId: id, reason: 'out-of-range' as const }));
    expect(
      selectDiplomacyBlockerExamples(
        state,
        firstFreeId,
        blockersFor(firstFreeId),
        ['out-of-range'],
      )[0]?.agentId,
    ).toBe(distantFreeCounterpartId);
    expect(
      selectDiplomacyBlockerExamples(
        state,
        distantFreeCounterpartId,
        blockersFor(distantFreeCounterpartId),
        ['out-of-range'],
      )[0]?.agentId,
    ).toBe(firstFreeId);
    expect(
      selectDiplomacyBlockerExamples(
        state,
        agents[0]!.id,
        blockersFor(agents[0]!.id),
        ['out-of-range'],
      )
        .slice(0, 2)
        .map(({ agentId }) => agentId),
    ).toEqual([firstFreeId, distantFreeCounterpartId].toSorted());
  });

  it('authors exact range-blocked diplomacy affordances before inference', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    const setup = defaultWorldSetupRequest();
    simulation.applyWorldSetup({
      ...setup,
      communicationRangeKm: 0.1,
      modelConfiguration: {
        ...setup.modelConfiguration,
        globalModelId: 'deterministic-script',
      },
    });
    const record = await simulation.executeNextTurn();
    expect(
      record.observation.diplomacyAvailability.propose.blockedRecipients,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'out-of-range' }),
      ]),
    );
    expect(
      simulation.generateExperimentExport(exportRequest('full-safe')).turns[0]
        ?.observation?.diplomacyAvailability,
    ).toMatchObject({
      propose: {
        blockedRecipients: expect.arrayContaining([
          expect.objectContaining({ reason: 'out-of-range' }),
        ]),
      },
    });
  });

  it('freezes all observations, dispatches concurrently, and commits one complete tick', async () => {
    const observations: AgentObservation[] = [];
    const deadlines = new Set<number | undefined>();
    let active = 0;
    let maximumActive = 0;
    const simulation = service({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation, _model, options): Promise<ProviderDecision> {
        observations.push(structuredClone(observation));
        deadlines.add(options?.deadlineAtMs);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: {
              channel: 'public',
              message: `hello-${observation.agentName}`,
            },
            summary: 'Wait and report.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    });

    const records = await simulation.executeNextTick();
    expect(records).toHaveLength(8);
    expect(maximumActive).toBeGreaterThan(1);
    expect(deadlines.size).toBe(1);
    expect(new Set(records.map(({ tickNumber }) => tickNumber))).toEqual(
      new Set([1]),
    );
    expect(
      observations.every(
        ({ recentPublicMessages }) => recentPublicMessages.length === 0,
      ),
    ).toBe(true);
    expect(simulation.getSnapshot()).toMatchObject({
      tickNumber: 1,
      turnNumber: 8,
    });
  });

  it('keeps resolution records and world events independent of provider completion order', async () => {
    const makeProvider = (reverse: boolean): AgentProvider => ({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        const index = DEVELOPMENT_AGENT_BLUEPRINTS.findIndex(
          ({ id }) => id === observation.agentId,
        );
        for (let count = 0; count < (reverse ? 7 - index : index); count += 1)
          await Promise.resolve();
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: {
              channel: 'public',
              message: observation.agentName,
            },
            summary: 'Wait.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    });
    const forward = service(makeProvider(false));
    const reverse = service(makeProvider(true));
    const forwardRecords = await forward.executeNextTick();
    const reverseRecords = await reverse.executeNextTick();
    expect(
      reverseRecords.map(({ agentId, outcome }) => ({ agentId, outcome })),
    ).toEqual(
      forwardRecords.map(({ agentId, outcome }) => ({ agentId, outcome })),
    );
    expect(reverse.getSnapshot().world).toEqual(forward.getSnapshot().world);
  });

  it('resolves same-tick diplomacy contention in deterministic phase order', async () => {
    const recipientId = agentIdSchema.parse(
      DEVELOPMENT_AGENT_BLUEPRINTS[0]!.id,
    );
    const simulation = service({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: { type: 'wait' },
            ...(observation.agentId === recipientId
              ? {}
              : {
                  diplomacy: { type: 'propose-alliance' as const, recipientId },
                }),
            summary: 'Propose.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    });
    const records = await simulation.executeNextTick();
    type CompletedRecord = Exclude<
      AgentTurnRecord,
      { outcome: 'provider-error' | 'lost-tick' | 'operator-skipped' }
    >;
    const completed = records.filter(
      (record): record is CompletedRecord =>
        record.outcome !== 'lost-tick' &&
        record.outcome !== 'provider-error' &&
        record.outcome !== 'operator-skipped',
    );
    expect(
      completed
        .filter(({ agentId }) => agentId !== recipientId)
        .every(({ observation }) =>
          observation.diplomacyAvailability.propose.eligibleRecipientAgentIds.includes(
            recipientId,
          ),
        ),
    ).toBe(true);
    const requested = completed.filter(
      (record) => record.diplomacyResult.requested,
    );
    expect(
      requested.some(
        (record) =>
          record.diplomacyResult.requested && record.diplomacyResult.accepted,
      ),
    ).toBe(true);
    expect(
      requested.some(
        (record) =>
          record.diplomacyResult.requested && !record.diplomacyResult.accepted,
      ),
    ).toBe(true);
    expect(
      simulation.getSnapshot().world.pendingAllianceProposals,
    ).toHaveLength(1);
  });

  it('records one provider failure as a lost tick while committing sibling decisions', async () => {
    let failingAgent: string | undefined;
    const simulation = service({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        failingAgent ??= observation.agentId;
        if (observation.agentId === failingAgent)
          throw new AgentProviderError({
            code: 'timeout',
            message: 'deadline',
            retryable: false,
            latencyMs: 37,
          });
        return {
          decision: {
            worldAction: { type: 'wait' },
            goalRevision: {
              operation: 'establish',
              longTermGoal: 'Preserve durable influence.',
              shortTermGoal: 'Hold position.',
              planSummary: 'Wait safely.',
              reason: 'Start continuity.',
            },
            memoryOperation: {
              operation: 'remember',
              text: 'This sibling decision completed.',
            },
            summary: 'Wait.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    });
    const records = await simulation.executeNextTick();
    expect(
      records.filter(({ outcome }) => outcome === 'lost-tick'),
    ).toHaveLength(1);
    expect(
      records.filter(({ outcome }) => outcome === 'accepted'),
    ).toHaveLength(7);
    expect(simulation.getSnapshot().tickNumber).toBe(1);
    expect(
      simulation
        .getSnapshot()
        .agentGoals.find(({ agentId }) => agentId === failingAgent)?.goal,
    ).toBeNull();
    expect(
      simulation.getSnapshot().agentGoals.filter(({ goal }) => goal),
    ).toHaveLength(7);
    expect(
      simulation
        .getSnapshot()
        .agentMemories.find(({ agentId }) => agentId === failingAgent)?.entries,
    ).toEqual([]);
    expect(
      simulation
        .getSnapshot()
        .agentMemories.filter(({ entries }) => entries.length > 0),
    ).toHaveLength(7);
    const exported = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      outcomes: [
        'accepted',
        'rejected',
        'lost-tick',
        'provider-error',
        'operator-skipped',
      ],
    });
    expect(exported.tickSummaries).toEqual([
      expect.objectContaining({
        providerCallCount: 8,
        aggregateDecisionLatencyMs: 37,
        maximumDecisionLatencyMs: 37,
        lostTicks: 1,
      }),
    ]);
  });

  it('cancels a simultaneous tick atomically without advancing virtual time', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const simulation = service({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(_observation, _model, options): Promise<ProviderDecision> {
        started();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        throw new AgentProviderError({
          code: 'cancelled',
          message: 'cancelled',
          retryable: false,
        });
      },
    });
    const before = simulation.getSnapshot();
    const pending = simulation.executeNextTick();
    await requestStarted;
    simulation.cancelCurrentRequest();
    await expect(pending).rejects.toBeInstanceOf(SimulationTurnCancelledError);
    expect(simulation.getSnapshot()).toMatchObject({
      tickNumber: before.tickNumber,
      turnNumber: before.turnNumber,
      virtualTime: before.virtualTime,
      turns: before.turns,
      world: before.world,
      agentGoals: before.agentGoals,
      agentMemories: before.agentMemories,
    });
  });

  it('dispatches per-agent model and reasoning overrides for a tick', async () => {
    const dispatched: Array<{
      agentId: string;
      model: string;
      reasoning: string | undefined;
    }> = [];
    const simulation = service({
      mode: 'scripted-test',
      configured: true,
      async decide(observation, model, options): Promise<ProviderDecision> {
        dispatched.push({
          agentId: observation.agentId,
          model,
          reasoning: options?.reasoningProfile,
        });
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model,
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    });
    simulation.setCompatibleModels(compatibleModels);
    const overriddenAgent = simulation.getSnapshot().world.agents[0]!.id;
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[0]!.id,
      globalReasoningProfile: 'low',
      overrides: [
        {
          agentId: overriddenAgent,
          modelId: compatibleModels[1]!.id,
          reasoningProfile: 'high',
        },
      ],
    });
    await simulation.executeNextTick();
    expect(
      dispatched.find(({ agentId }) => agentId === overriddenAgent),
    ).toMatchObject({
      model: compatibleModels[1]!.id,
      reasoning: 'high',
    });
    expect(
      dispatched
        .filter(({ agentId }) => agentId !== overriddenAgent)
        .every(
          ({ model, reasoning }) =>
            model === compatibleModels[0]!.id && reasoning === 'low',
        ),
    ).toBe(true);
  });

  it('prevents mixing legacy sequential records and simultaneous ticks in either direction', async () => {
    const legacy = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Legacy wait.' },
      ]),
    );
    await legacy.executeNextTurn();
    await expect(legacy.executeNextTick()).rejects.toBeInstanceOf(
      SimulationConflictError,
    );
    expect(
      legacy.generateExperimentExport(exportRequest('minimal')).schemaVersion,
    ).toBe(9);

    const tick = service(
      new ScriptedAgentProvider(
        Array.from({ length: 8 }, () => ({
          worldAction: { type: 'wait' as const },
          summary: 'Tick wait.',
        })),
      ),
    );
    await tick.executeNextTick();
    await expect(tick.executeNextTurn()).rejects.toBeInstanceOf(
      SimulationConflictError,
    );
    await expect(tick.retryFailedTurn()).rejects.toBeInstanceOf(
      SimulationConflictError,
    );
    expect(() => tick.skipFailedTurn()).toThrow(SimulationConflictError);
    expect(
      tick.generateExperimentExport(exportRequest('minimal')).schemaVersion,
    ).toBe(10);
    expect(
      tick.generateExperimentExport(exportRequest('minimal')).experiment
        .decisionContractVersion,
    ).toBe(AGENT_DECISION_CONTRACT_VERSION);
  });

  it('reproduces tick order and interval after reset and retains only complete tick groups', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = new SimulationService({
      provider,
      now,
      createEventId,
      experimentRetentionLimit: 10,
    });
    await simulation.executeNextTick();
    const first = simulation.getSnapshot();
    await simulation.executeNextTick();
    const retained = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      outcomes: [
        'accepted',
        'rejected',
        'lost-tick',
        'provider-error',
        'operator-skipped',
      ],
    });
    expect(retained.turns).toHaveLength(8);
    expect(new Set(retained.turns.map(({ tickNumber }) => tickNumber))).toEqual(
      new Set([2]),
    );
    expect(experimentExportDocumentSchema.safeParse(retained).success).toBe(
      true,
    );
    expect(
      experimentExportDocumentSchema.safeParse({
        ...retained,
        tickSummaries: retained.tickSummaries?.map((summary) => ({
          ...summary,
          intervalMinutes: summary.intervalMinutes + 1,
        })),
      }).success,
    ).toBe(false);

    simulation.reset();
    await simulation.executeNextTick();
    expect(simulation.getSnapshot()).toMatchObject({
      resolutionOrder: first.resolutionOrder,
      lastTickIntervalMinutes: first.lastTickIntervalMinutes,
      virtualTime: first.virtualTime,
    });
  });

  it('preserves the default and custom physical communication range', () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    expect(simulation.getSnapshot().scenario.communicationRangeKm).toBe(12);
    const request = defaultWorldSetupRequest();
    const applied = simulation.applyWorldSetup({
      ...request,
      communicationRangeKm: 7.5,
    });
    expect(applied.scenario.communicationRangeKm).toBe(7.5);
  });

  it('gives only Patient Zero bounded global awareness and delivers a Zero directive plus global reply', async () => {
    const seen: AgentObservation[] = [];
    const simulation = service({
      mode: 'scripted-test',
      model: 'deterministic-script',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        seen.push(structuredClone(observation));
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: observation.patientZero.isPatientZero
              ? { channel: 'zero', message: 'Take separate infection fronts.' }
              : {
                  channel: 'direct',
                  recipientId: observation.patientZero.agentId!,
                  message: 'Taking the eastern front.',
                },
            summary: 'Coordinate while waiting.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'deterministic-script',
            latencyMs: 0,
          },
        };
      },
    });
    const setup = defaultWorldSetupRequest();
    const patientZeroId = setup.roster[0]!.id;
    simulation.applyWorldSetup({
      ...setup,
      patientZeroAgentId: patientZeroId,
      modelConfiguration: {
        ...setup.modelConfiguration,
        globalModelId: 'deterministic-script',
      },
    });
    const directive = await simulation.executeNextTurn();
    const reply = await simulation.executeNextTurn();
    expect(directive.observation.patientZeroGlobalView?.agents).toHaveLength(8);
    const diplomacySummary =
      directive.observation.patientZeroGlobalView?.diplomacySummary;
    expect(diplomacySummary).toMatchObject({
      eligiblePairCount: 56,
      eligiblePairsTruncated: true,
      acceptableProposals: [],
      acceptableProposalCount: 0,
      acceptableProposalsTruncated: false,
      leaveAvailableAgentIds: [],
      leaveAvailableCount: 0,
      leaveAvailableTruncated: false,
      blockedCounts: [],
      blockerExamples: [],
    });
    expect(diplomacySummary?.displayedEligiblePairs).toHaveLength(12);
    expect(
      new Set(
        diplomacySummary?.displayedEligiblePairs.map(
          ({ proposerId }) => proposerId,
        ),
      ).size,
    ).toBe(8);
    expect(reply.observation.patientZeroGlobalView).toBeNull();
    expect(
      JSON.stringify(directive.observation.patientZeroGlobalView),
    ).not.toMatch(/provider|credential|pendingDecision|gps|future/i);
    if (
      directive.outcome === 'provider-error' ||
      directive.outcome === 'lost-tick' ||
      directive.outcome === 'operator-skipped' ||
      reply.outcome === 'provider-error' ||
      reply.outcome === 'lost-tick' ||
      reply.outcome === 'operator-skipped'
    )
      throw new Error('Expected completed Patient Zero communication turns.');
    expect(directive.communicationResult).toMatchObject({
      accepted: true,
      event: { channel: 'zero', recipientIds: expect.any(Array) },
    });
    expect(reply.communicationResult).toMatchObject({
      accepted: true,
      event: { channel: 'direct', recipientId: patientZeroId },
    });
    expect(reply.observation.recentZeroMessages).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(simulation.getSnapshot().experiment.metrics.aggregate).toMatchObject(
      {
        zeroBroadcastsRequested: 1,
        zeroBroadcastsDelivered: 1,
        zeroRecipientDeliveries: 7,
        uniqueZeroDirectiveRecipients: 7,
        directRepliesToPatientZero: 1,
        uniquePatientZeroRepliers: 1,
        firstZeroDirectiveTurn: 1,
      },
    );
  });

  it('keeps 32-agent Patient Zero diplomacy guidance compact and surfaces a distant free-agent blocker', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    const setup = defaultWorldSetupRequest();
    const roster = generateDeterministicRoster(32, 'pz-diplomacy-bound');
    const patientZeroAgentId = roster[0]!.id;
    simulation.applyWorldSetup({
      ...setup,
      radius: 12,
      communicationRangeKm: 0.1,
      roster,
      patientZeroAgentId,
      modelConfiguration: {
        ...setup.modelConfiguration,
        globalModelId: 'deterministic-script',
      },
      behaviorConfiguration: {
        ...setup.behaviorConfiguration,
        assignments: assignBehavior(
          roster.map(({ id }) => id),
          setup.behaviorConfiguration.seed,
          'balanced-random',
        ),
      },
    });
    const record = await simulation.executeNextTurn();
    const summary = record.observation.patientZeroGlobalView?.diplomacySummary;
    expect(summary).toMatchObject({
      eligiblePairCount: 0,
      eligiblePairsTruncated: false,
      blockedCounts: expect.arrayContaining([
        expect.objectContaining({ reason: 'out-of-range' }),
      ]),
      blockerExamples: expect.arrayContaining([
        expect.objectContaining({ reason: 'out-of-range' }),
      ]),
    });
    expect(summary?.displayedEligiblePairs).toHaveLength(0);
    expect(summary?.blockerExamples.length).toBeLessThanOrEqual(8);
    expect(
      new TextEncoder().encode(JSON.stringify(summary)).byteLength,
    ).toBeLessThanOrEqual(
      PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.serializedUtf8Bytes,
    );
  });

  it('fairly and deterministically rotates sparse diplomacy pairs across ticks', async () => {
    const decisions = Array.from({ length: 64 }, () => ({
      worldAction: { type: 'wait' as const },
      summary: 'Wait.',
    }));
    const createSimulation = () => {
      const simulation = service(new ScriptedAgentProvider(decisions));
      const setup = defaultWorldSetupRequest();
      const roster = generateDeterministicRoster(32, 'pz-fair-pairs');
      simulation.applyWorldSetup({
        ...setup,
        radius: 12,
        communicationRangeKm: 100,
        roster,
        patientZeroAgentId: roster[0]!.id,
        modelConfiguration: {
          ...setup.modelConfiguration,
          globalModelId: 'deterministic-script',
        },
        behaviorConfiguration: {
          ...setup.behaviorConfiguration,
          assignments: assignBehavior(
            roster.map(({ id }) => id),
            setup.behaviorConfiguration.seed,
            'balanced-random',
          ),
        },
      });
      return simulation;
    };
    const first = createSimulation();
    const duplicate = createSimulation();
    const firstTick = (await first.executeNextTick()).find(
      ({ observation }) => observation.patientZero.isPatientZero,
    )?.observation.patientZeroGlobalView?.diplomacySummary;
    const duplicateTick = (await duplicate.executeNextTick()).find(
      ({ observation }) => observation.patientZero.isPatientZero,
    )?.observation.patientZeroGlobalView?.diplomacySummary;
    expect(firstTick?.displayedEligiblePairs).toEqual(
      duplicateTick?.displayedEligiblePairs,
    );
    expect(
      new Set(
        firstTick?.displayedEligiblePairs.map(({ proposerId }) => proposerId),
      ).size,
    ).toBe(12);
    const secondTick = (await first.executeNextTick()).find(
      ({ observation }) => observation.patientZero.isPatientZero,
    )?.observation.patientZeroGlobalView?.diplomacySummary;
    expect(secondTick?.displayedEligiblePairs).not.toEqual(
      firstTick?.displayedEligiblePairs,
    );
    expect(
      new Set(
        secondTick?.displayedEligiblePairs.map(({ proposerId }) => proposerId),
      ).size,
    ).toBe(12);
  });

  it('reproduces move ordering for identical inputs and varies it across agents', async () => {
    const provider = () =>
      new ScriptedAgentProvider(
        Array.from({ length: 8 }, () => ({
          worldAction: { type: 'wait' as const },
          summary: 'Wait.',
        })),
      );
    const first = service(provider());
    const second = service(provider());
    const firstOrders: string[] = [];
    const secondOrders: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      firstOrders.push(
        (
          await first.executeNextTurn()
        ).observation.actionAvailability.moveTargetCellIds.join(','),
      );
      secondOrders.push(
        (
          await second.executeNextTurn()
        ).observation.actionAvailability.moveTargetCellIds.join(','),
      );
    }
    expect(firstOrders).toEqual(secondOrders);
    expect(new Set(firstOrders).size).toBeGreaterThan(1);
  });

  it('derives compact action availability from the same authoritative world state', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    const turn = await simulation.executeNextTurn();
    expect(turn.observation.actionAvailability).toMatchObject({
      moveTargetCellIds: turn.observation.adjacentCells.map(({ cell }) => cell),
      infect: { available: true },
      capture: { available: false, reason: 'capture-open-cell' },
      wait: { available: true },
    });
    expect(turn.observation.actionAvailability.moveOptions).toHaveLength(
      turn.observation.adjacentCells.length,
    );
    expect(turn.outcome).toBe('accepted');
    if (
      turn.outcome === 'provider-error' ||
      turn.outcome === 'lost-tick' ||
      turn.outcome === 'operator-skipped'
    )
      throw new Error('Expected a completed engine decision.');
    expect(turn.worldActionResult.accepted).toBe(true);
  });

  it('uses one bounded automatic repair with the same observation and deadline', async () => {
    const calls: Array<{
      observation: AgentObservation;
      deadlineAtMs?: number;
      feedback?: readonly string[];
    }> = [];
    const simulation = service({
      mode: 'scripted-test',
      configured: true,
      async decide(observation, model, options) {
        calls.push({
          observation: structuredClone(observation),
          deadlineAtMs: options?.deadlineAtMs,
          feedback: options?.validationFeedback,
        });
        if (calls.length === 1)
          throw new AgentProviderError({
            code: 'invalid-json',
            message: 'Invalid decision JSON.',
            retryable: true,
            model,
            validationCodes: ['invalid-json'],
          });
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Repaired.' },
          metadata: {
            provider: 'scripted-test',
            model,
            latencyMs: 1,
            costCredits: 0,
          },
        };
      },
    });
    const turn = await simulation.executeNextTurn();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.observation).toEqual(calls[0]!.observation);
    expect(calls[1]!.deadlineAtMs).toBe(calls[0]!.deadlineAtMs);
    expect(calls[1]!.feedback).toEqual(['invalid-json']);
    expect(turn).toMatchObject({
      outcome: 'accepted',
      modelAttempts: [{ kind: 'initial' }, { kind: 'automatic-repair' }],
    });
  });

  it.each([
    ['valid Retry-After', 2_000, 2_000],
    ['missing Retry-After', undefined, 1_500],
  ])(
    'backs off for %s before the one automatic 429 retry',
    async (_label, retryAfterMs, expectedDelay) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
      try {
        let calls = 0;
        const simulation = service({
          mode: 'scripted-test',
          configured: true,
          async decide(_observation, model) {
            calls += 1;
            if (calls === 1)
              throw new AgentProviderError({
                code: 'provider-http',
                message: 'Rate limited.',
                retryable: true,
                model,
                httpStatus: 429,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              });
            return {
              decision: {
                worldAction: { type: 'wait' },
                summary: 'Recovered.',
              },
              metadata: { provider: 'scripted-test', model, latencyMs: 1 },
            };
          },
        });
        const turn = simulation.executeNextTurn();
        await vi.advanceTimersByTimeAsync(expectedDelay - 1);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(turn).resolves.toMatchObject({ outcome: 'accepted' });
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not retry a 429 when the fallback cannot fit the shared deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      let calls = 0;
      const simulation = service({
        mode: 'scripted-test',
        configured: true,
        async decide(_observation, model) {
          calls += 1;
          vi.setSystemTime(new Date('2026-08-15T12:01:14.000Z'));
          throw new AgentProviderError({
            code: 'provider-http',
            message: 'Rate limited.',
            retryable: true,
            model,
            httpStatus: 429,
          });
        },
      });
      await expect(simulation.executeNextTurn()).resolves.toMatchObject({
        outcome: 'provider-error',
        modelAttempts: [{ kind: 'initial' }],
      });
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancellation interrupts the 429 fallback without starting another call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      let calls = 0;
      const simulation = service({
        mode: 'scripted-test',
        configured: true,
        async decide(_observation, model) {
          calls += 1;
          throw new AgentProviderError({
            code: 'provider-http',
            message: 'Rate limited.',
            retryable: true,
            model,
            httpStatus: 429,
          });
        },
      });
      const turn = simulation.executeNextTurn();
      await Promise.resolve();
      simulation.cancelCurrentRequest();
      await expect(turn).rejects.toBeInstanceOf(SimulationTurnCancelledError);
      expect(calls).toBe(1);
      expect(simulation.getSnapshot()).toMatchObject({
        activeAgentId: null,
        pendingFailedTurn: null,
        turnNumber: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies formal diplomacy independently and exposes authoritative alliance observations', async () => {
    const [emberId, rookId] = DEVELOPMENT_AGENT_BLUEPRINTS.slice(0, 2).map(
      ({ id }) => agentIdSchema.parse(id),
    );
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'alliance-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: {
              type:
                observation.currentCell.state === 'open' ? 'infect' : 'wait',
            },
            communication: {
              channel: 'public',
              message: 'Formal diplomacy accompanies this action.',
            },
            diplomacy:
              observation.agentId === emberId
                ? { type: 'propose-alliance', recipientId: rookId! }
                : {
                    type: 'accept-alliance',
                    proposalId: observation.inboundAllianceProposals[0]!.id,
                  },
            summary: 'Exercise all independent components.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'alliance-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const proposed = await simulation.executeNextTurn();
    const formed = await simulation.executeNextTurn();
    expect(proposed).toMatchObject({
      diplomacyResult: {
        accepted: true,
        events: [{ type: 'alliance-proposed' }],
      },
    });
    expect(formed).toMatchObject({
      diplomacyResult: {
        accepted: true,
        events: [{ type: 'alliance-formed' }],
      },
    });
    const snapshot = simulation.getSnapshot();
    expect(snapshot.world.alliances).toHaveLength(1);
    expect(snapshot.experiment.currentAlliances[0]).toMatchObject({
      totalControlledCellCount: 2,
      members: [{ agentId: emberId }, { agentId: rookId }],
    });
    expect(
      snapshot.experiment.currentTerritory
        .slice(0, 2)
        .map(({ effectiveColor }) => effectiveColor),
    ).toEqual(['#0072B2', '#0072B2']);
    expect(formed.observation.inboundAllianceProposals).toHaveLength(1);
    expect(snapshot.experiment.metrics.aggregate).toMatchObject({
      proposalsCreated: 1,
      alliancesFormed: 1,
      alliancesJoined: 2,
    });
  });

  it('keeps an exact eight-agent round robin through 200 completed turns', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'two-hundred-turn-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model: 'two-hundred-turn-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    for (let turn = 0; turn < 200; turn += 1)
      await simulation.executeNextTurn();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.experiment.totalCompletedTurns).toBe(200);
    expect(
      snapshot.experiment.metrics.byAgent.map(
        ({ metrics }) => metrics.totalTurns,
      ),
    ).toEqual(Array(8).fill(25));
  });

  it('counts rejected diplomacy by sanitized type and reason without cancelling valid siblings', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'malformed-diplomacy-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: { type: 'infect' },
            communication: { channel: 'public', message: 'Valid sibling.' },
            diplomacy: { type: 'propose-alliance', recipientId: 'unsafe-id' },
            summary: 'Reject only diplomacy.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'malformed-diplomacy-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const turn = await simulation.executeNextTurn();
    expect(turn).toMatchObject({
      worldActionResult: { accepted: true },
      communicationResult: { accepted: true },
      diplomacyResult: {
        accepted: false,
        reason: 'invalid-diplomacy',
        attempt: { type: 'propose-alliance', recipientId: null },
      },
    });
    expect(
      simulation.getSnapshot().experiment.metrics.aggregate.diplomacyRejections,
    ).toEqual([
      { type: 'propose-alliance', reason: 'invalid-diplomacy', count: 1 },
    ]);
  });

  it('derives authoritative territory, bounded control history, capture metrics, and victim-aware exports', async () => {
    const emberId = agentIdSchema.parse(DEVELOPMENT_AGENT_BLUEPRINTS[0].id);
    const rookId = agentIdSchema.parse(DEVELOPMENT_AGENT_BLUEPRINTS[1].id);
    let targetCell: AgentObservation['currentCell']['cell'] | undefined;
    let emberDeparted = false;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'capture-scenario',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        let worldAction: ProviderDecision['decision']['worldAction'];
        if (observation.agentId === emberId && !targetCell) {
          targetCell = observation.currentCell.cell;
          worldAction = { type: 'infect' };
        } else if (observation.agentId === emberId && !emberDeparted) {
          emberDeparted = true;
          worldAction = {
            type: 'move',
            targetCell: observation.adjacentCells[0]!.cell,
          };
        } else if (observation.agentId === rookId) {
          if (
            observation.currentCell.cell === targetCell &&
            observation.captureEligibility.eligible
          ) {
            worldAction = { type: 'capture' };
          } else if (observation.currentCell.cell === targetCell) {
            worldAction = { type: 'wait' };
          } else {
            const target = targetCell!;
            const next = observation.adjacentCells.toSorted(
              (left, right) =>
                gridDistance(left.cell, target) -
                  gridDistance(right.cell, target) ||
                left.cell.localeCompare(right.cell),
            )[0]!;
            worldAction = { type: 'move', targetCell: next.cell };
          }
        } else {
          worldAction = { type: 'wait' };
        }
        return {
          decision: { worldAction, summary: 'Deterministic contest.' },
          metadata: {
            provider: 'scripted-test',
            model: 'capture-scenario',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    let capture: AgentTurnRecord | undefined;
    for (let index = 0; index < 31 && !capture; index += 1) {
      const turn = await simulation.executeNextTurn();
      if (
        turn.outcome === 'accepted' &&
        turn.worldActionResult.event.type === 'hex-captured'
      )
        capture = turn;
    }
    expect(capture).toMatchObject({
      agentId: rookId,
      worldAction: { type: 'capture' },
      worldActionResult: {
        event: {
          controllerAgentId: rookId,
          previousControllerAgentId: emberId,
          cell: targetCell,
        },
      },
    });
    if (!capture || capture.outcome !== 'accepted')
      throw new Error('Expected a successful capture fixture.');
    expect(capture.observation.currentCell).toMatchObject({
      state: 'infected',
      controllerAgentId: emberId,
    });
    expect(capture.observation.captureEligibility).toEqual({ eligible: true });
    expect(capture.observation.adjacentCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ controllerAgentId: null }),
      ]),
    );
    expect(capture.observation.territoryScoreboard).toHaveLength(8);
    expect(
      capture.observation.territoryScoreboard.reduce(
        (sum, { controlledCellCount }) => sum + controlledCellCount,
        0,
      ),
    ).toBe(1);
    const snapshot = simulation.getSnapshot();
    expect(
      snapshot.world.hexes.filter(({ state }) => state === 'infected'),
    ).toHaveLength(1);
    expect(
      snapshot.world.hexes.find(({ cell }) => cell === targetCell),
    ).toMatchObject({ state: 'infected', controllerAgentId: rookId });
    expect(
      snapshot.experiment.currentTerritory.reduce(
        (sum, { controlledCellCount }) => sum + controlledCellCount,
        0,
      ),
    ).toBe(1);
    expect(
      snapshot.experiment.currentTerritory.find(
        ({ agentId }) => agentId === rookId,
      )?.controlledCellCount,
    ).toBe(1);
    expect(
      snapshot.experiment.metrics.byAgent.find(
        ({ agentId }) => agentId === emberId,
      )?.metrics,
    ).toMatchObject({
      territoryGainedThroughInfection: 1,
      territoryLostThroughCapture: 1,
    });
    expect(
      snapshot.experiment.metrics.byAgent.find(
        ({ agentId }) => agentId === rookId,
      )?.metrics,
    ).toMatchObject({
      requestedCaptures: 1,
      successfulCaptures: 1,
      territoryGainedThroughCapture: 1,
    });

    const subsequent: AgentTurnRecord[] = [];
    for (let index = 0; index < 8; index += 1)
      subsequent.push(await simulation.executeNextTurn());
    const emberObservation = subsequent.find(
      ({ agentId }) => agentId === emberId,
    )?.observation;
    const rookObservation = subsequent.find(
      ({ agentId }) => agentId === rookId,
    )?.observation;
    expect(emberObservation?.recentControlChanges).toMatchObject([
      { direction: 'lost', otherAgentId: rookId, cell: targetCell },
    ]);
    expect(rookObservation?.recentControlChanges).toMatchObject([
      { direction: 'gained', otherAgentId: emberId, cell: targetCell },
    ]);
    expect(
      subsequent
        .filter(({ agentId }) => agentId !== emberId && agentId !== rookId)
        .every(
          ({ observation }) => observation.recentControlChanges.length === 0,
        ),
    ).toBe(true);

    const victimExport = simulation.generateExperimentExport({
      agents: { mode: 'selected', agentIds: [emberId] },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted'],
      actions: ['capture'],
      level: 'minimal',
    });
    expect(victimExport.schemaVersion).toBe(9);
    expect(victimExport.turns).toHaveLength(0);
    expect(victimExport.selection).toMatchObject({
      matchingTurnCount: 0,
      matchingControlChangeCount: 1,
    });
    expect(victimExport.controlChanges).toMatchObject([
      {
        controllerAgentId: rookId,
        previousControllerAgentId: emberId,
      },
    ]);
    expect(victimExport.metrics?.byAgent[0]?.metrics).toMatchObject({
      totalTurns: 0,
      territoryLostThroughCapture: 1,
    });
    expect(victimExport.currentTerritory).toHaveLength(8);
    const unrelatedAgentId = agentIdSchema.parse(
      DEVELOPMENT_AGENT_BLUEPRINTS[2].id,
    );
    expect(
      simulation.generateExperimentExport({
        ...exportRequest('minimal'),
        agents: { mode: 'selected', agentIds: [unrelatedAgentId] },
        outcomes: ['accepted'],
        actions: ['capture'],
      }).controlChanges,
    ).toEqual([]);
  });

  it('records controller-present rejection without control mutation or gain/loss metrics', async () => {
    const emberId = agentIdSchema.parse(DEVELOPMENT_AGENT_BLUEPRINTS[0].id);
    const rookId = agentIdSchema.parse(DEVELOPMENT_AGENT_BLUEPRINTS[1].id);
    let targetCell: AgentObservation['currentCell']['cell'] | undefined;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'defended-capture-scenario',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        let worldAction: ProviderDecision['decision']['worldAction'];
        if (observation.agentId === emberId && !targetCell) {
          targetCell = observation.currentCell.cell;
          worldAction = { type: 'infect' };
        } else if (observation.agentId === rookId) {
          if (observation.currentCell.cell === targetCell) {
            worldAction = { type: 'capture' };
          } else {
            const next = observation.adjacentCells.toSorted(
              (left, right) =>
                gridDistance(left.cell, targetCell!) -
                  gridDistance(right.cell, targetCell!) ||
                left.cell.localeCompare(right.cell),
            )[0]!;
            worldAction = { type: 'move', targetCell: next.cell };
          }
        } else {
          worldAction = { type: 'wait' };
        }
        return {
          decision: { worldAction, summary: 'Test defended capture.' },
          metadata: {
            provider: 'scripted-test',
            model: 'defended-capture-scenario',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    let rejected: AgentTurnRecord | undefined;
    for (let index = 0; index < 31 && !rejected; index += 1) {
      const turn = await simulation.executeNextTurn();
      if (
        turn.outcome === 'rejected' &&
        turn.worldActionResult.reason === 'controller-present'
      )
        rejected = turn;
    }
    expect(rejected).toMatchObject({
      agentId: rookId,
      worldAction: { type: 'capture' },
      observation: {
        captureEligibility: {
          eligible: false,
          blockedReason: 'controller-present',
        },
      },
    });
    const snapshot = simulation.getSnapshot();
    expect(
      snapshot.world.hexes.find(({ cell }) => cell === targetCell),
    ).toEqual(expect.objectContaining({ controllerAgentId: emberId }));
    expect(snapshot.world.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'hex-captured' }),
      ]),
    );
    expect(snapshot.experiment.metrics.aggregate).toMatchObject({
      requestedCaptures: 1,
      successfulCaptures: 0,
      territoryGainedThroughCapture: 0,
      territoryLostThroughCapture: 0,
    });
    const exported = simulation.generateExperimentExport({
      ...exportRequest('standard'),
      agents: { mode: 'selected', agentIds: [rookId] },
      outcomes: ['rejected'],
      actions: ['capture'],
    });
    expect(exported.schemaVersion).toBe(9);
    const behavior = exported.turns[0]!.behavior!;
    expect(
      exported.metrics!.byPersonality.find(
        ({ personalityId }) => personalityId === behavior.personalityId,
      )?.metrics.totalTurns,
    ).toBe(1);
    expect(
      exported.metrics!.byStrategy.find(
        ({ strategyId }) => strategyId === behavior.strategyId,
      )?.metrics.rejected,
    ).toBe(1);
    expect(
      exported.metrics!.byBehaviorCombination.find(
        (entry) =>
          entry.personalityId === behavior.personalityId &&
          entry.strategyId === behavior.strategyId,
      )?.metrics.modelCalls,
    ).toBe(exported.metrics!.aggregate.modelCalls);
    expect(
      exported.metrics!.byPersonality.reduce(
        (sum, entry) => sum + entry.metrics.totalTurns,
        0,
      ),
    ).toBe(exported.metrics!.aggregate.totalTurns);
    expect(exported.turns).toMatchObject([
      {
        outcome: 'rejected',
        worldActionResult: {
          accepted: false,
          reason: 'controller-present',
        },
        observation: {
          captureEligibility: {
            eligible: false,
            blockedReason: 'controller-present',
          },
        },
      },
    ]);
    expect(exported.controlChanges).toEqual([]);
  });

  it('resets to the exact deterministic eight-agent starting world', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    const initial = simulation.getSnapshot();
    await simulation.executeNextTurn();
    const reset = simulation.reset();
    expect(reset.world).toEqual(initial.world);
    expect(reset.experiment.id).not.toBe(initial.experiment.id);
    expect(reset.experiment.totalCompletedTurns).toBe(0);
    expect(initial.world.agents).toHaveLength(8);
    expect(initial.world.hexes).toHaveLength(127);
  });

  it('retains complete experiment records independently of the 120-turn browser snapshot', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'retention-test',
      configured: true,
      async decide() {
        return {
          decision: {
            worldAction: { type: 'wait' as const },
            summary: 'Wait.',
          },
          metadata: {
            provider: 'scripted-test' as const,
            model: 'retention-test',
            latencyMs: 1,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = new SimulationService({
      provider,
      now,
      createEventId,
      experimentRetentionLimit: 125,
    });
    for (let index = 0; index < 125; index += 1)
      await simulation.executeNextTurn();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.turns).toHaveLength(120);
    expect(snapshot.experiment).toMatchObject({
      totalCompletedTurns: 125,
      retainedTurns: 125,
      droppedRecords: 0,
      complete: true,
    });
    expect(
      simulation.generateExperimentExport(exportRequest('full-safe')).turns,
    ).toHaveLength(125);
  });

  it('reports configurable experiment truncation and absolute retained bounds', async () => {
    const simulation = new SimulationService({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: '1' },
        { worldAction: { type: 'wait' }, summary: '2' },
        { worldAction: { type: 'wait' }, summary: '3' },
      ]),
      now,
      createEventId,
      experimentRetentionLimit: 2,
    });
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    expect(simulation.getSnapshot().experiment).toMatchObject({
      retainedTurns: 2,
      firstRetainedTurn: 2,
      lastRetainedTurn: 3,
      droppedRecords: 1,
      complete: false,
    });
    const preview = simulation.previewExperimentExport({
      ...exportRequest('minimal'),
      turns: { mode: 'range', fromTurn: 1, toTurn: 3 },
    });
    expect(preview.retention.requestedRangeExtendsBeyondRetention).toBe(true);
  });

  it('estimates the selected Compact or Pretty serialization and defaults to Compact', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    await simulation.executeNextTurn();
    const compact = simulation.previewExperimentExport(
      exportRequest('minimal'),
    );
    const pretty = simulation.previewExperimentExport({
      ...exportRequest('minimal'),
      serialization: 'pretty',
    });
    expect(compact.serializedUtf8Bytes).toBeLessThan(
      pretty.serializedUtf8Bytes,
    );
    expect(compact.approximateAiInputTokens).toBeLessThan(
      pretty.approximateAiInputTokens,
    );
    expect(
      simulation.generateExperimentExport(exportRequest('minimal')).filters
        .serialization,
    ).toBe('compact');
  });

  it('aggregates charged cost as exact decimal input without JSON artifacts', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'decimal-cost-test',
      configured: true,
      async decide() {
        return {
          decision: {
            worldAction: { type: 'wait' as const },
            summary: 'Wait.',
          },
          metadata: {
            provider: 'scripted-test' as const,
            model: 'decimal-cost-test',
            latencyMs: 0,
            costCredits: 0.14064472125,
          },
        };
      },
    };
    const simulation = service(provider);
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    const document = simulation.generateExperimentExport(
      exportRequest('minimal'),
    );
    expect(document.metrics?.aggregate.knownCostCredits).toBe(0.42193416375);
    expect(serializeExperimentExport(document)).toContain(
      '"knownCostCredits":0.42193416375',
    );
    expect(serializeExperimentExport(document)).not.toContain(
      '0.4219341637499998',
    );
  });

  it('records immutable personality configuration history and clears it on reset', () => {
    let sequence = 0;
    const simulation = new SimulationService({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
      now,
      createEventId,
      createExperimentId: () =>
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, '0')}`,
    });
    const before = simulation.getSnapshot();
    const agent = before.world.agents[0]!;
    simulation.updateAgentPersonality(agent.id, 'Custom immutable edit.');
    simulation.restoreDefaultPersonalities();
    const full = simulation.generateExperimentExport(
      exportRequest('full-safe'),
    );
    expect(full.configurationEvents).toMatchObject([
      {
        operation: 'custom-edit',
        previousPersonality: agent.personality,
        newPersonality: 'Custom immutable edit.',
      },
      {
        operation: 'restore-default',
        previousPersonality: 'Custom immutable edit.',
        newPersonality: agent.personality,
      },
    ]);
    const captured = structuredClone(full.configurationEvents);
    simulation.updateAgentPersonality(agent.id, 'Another edit.');
    expect(full.configurationEvents).toEqual(captured);
    const reset = simulation.reset();
    expect(reset.experiment.id).not.toBe(before.experiment.id);
    expect(
      simulation.generateExperimentExport(exportRequest('full-safe'))
        .configurationEvents,
    ).toEqual([]);
  });

  it('filters agents, latest/ranges, outcomes and actions chronologically with subset metrics', async () => {
    let call = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'filter-test',
      configured: true,
      async decide(observation) {
        call += 1;
        const worldAction =
          call === 1
            ? { type: 'infect' as const }
            : call === 2
              ? {
                  type: 'move' as const,
                  targetCell: observation.adjacentCells[0]!.cell,
                }
              : { type: 'wait' as const };
        return {
          decision: { worldAction, summary: 'Safe summary.' },
          metadata: {
            provider: 'scripted-test',
            model: 'filter-test',
            latencyMs: call,
            promptTokens: call,
            completionTokens: call,
            totalTokens: call * 2,
            costCredits: call === 3 ? undefined : 0.00000001,
          },
        };
      },
    };
    const simulation = service(provider);
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    const agents = simulation.getSnapshot().world.agents;
    const selected = [agents[0]!.id, agents[1]!.id];
    const document = simulation.generateExperimentExport({
      ...exportRequest('standard'),
      agents: { mode: 'selected', agentIds: selected },
      turns: { mode: 'latest', count: 10 },
      outcomes: ['accepted'],
      actions: ['move', 'infect'],
    });
    expect(document.selection.selectedAgentIds).toEqual(selected);
    expect(document.turns.map(({ turnNumber }) => turnNumber)).toEqual([1, 2]);
    expect(document.metrics?.aggregate).toMatchObject({
      totalTurns: 2,
      requestedMoves: 1,
      requestedInfections: 1,
      acceptedMovements: 1,
      successfullyInfectedCells: 1,
      knownCostCredits: 0.00000002,
      attemptsWithUnknownCost: 0,
      turnsWithUnknownCost: 0,
    });
    expect(document.metrics?.aggregate.uniqueVisitedCells).toBeGreaterThan(1);
    const oneAgent = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      agents: { mode: 'selected', agentIds: [agents[2]!.id] },
      turns: { mode: 'range', fromTurn: 3, toTurn: 3 },
    });
    expect(oneAgent.selection).toMatchObject({
      selectedAgentIds: [agents[2]!.id],
      matchingTurnCount: 1,
      firstMatchingTurn: 3,
      lastMatchingTurn: 3,
    });
    expect(
      simulation.generateExperimentExport(exportRequest('minimal')).metrics
        ?.aggregate,
    ).toMatchObject({
      knownCostCredits: 0.00000002,
      attemptsWithUnknownCost: 1,
      turnsWithUnknownCost: 1,
    });
  });

  it('keeps Full safe world snapshots state-only and scopes canonical events to the export selection', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'full-safe-event-scope-test',
      configured: true,
      async decide() {
        return {
          decision: {
            worldAction: { type: 'wait' as const },
            summary: 'Wait.',
          },
          metadata: {
            provider: 'scripted-test' as const,
            model: 'full-safe-event-scope-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    for (let index = 0; index < 7; index += 1)
      await simulation.executeNextTurn();

    const agents = simulation.getSnapshot().world.agents;
    const selectedAgent = agents[0]!;
    const oneAgent = simulation.generateExperimentExport({
      ...exportRequest('full-safe'),
      agents: { mode: 'selected', agentIds: [selectedAgent.id] },
      turns: { mode: 'range', fromTurn: 1, toTurn: 6 },
      outcomes: ['accepted'],
      actions: ['wait'],
    });

    expect(oneAgent.initialWorld?.agents).toHaveLength(8);
    expect(oneAgent.initialWorld?.hexes).toHaveLength(127);
    expect(oneAgent.currentWorld?.agents).toHaveLength(8);
    expect(oneAgent.currentWorld?.hexes).toHaveLength(127);
    expect(oneAgent.initialWorld).not.toHaveProperty('events');
    expect(oneAgent.currentWorld).not.toHaveProperty('events');
    expect(oneAgent.worldEvents).toHaveLength(1);
    expect(
      oneAgent.worldEvents?.every(
        ({ agentId }) => agentId === selectedAgent.id,
      ),
    ).toBe(true);
    expect(oneAgent.turns.map(({ turnNumber }) => turnNumber)).toEqual([1]);

    const allAgents = simulation.generateExperimentExport(
      exportRequest('full-safe'),
    );
    expect(allAgents.selection.selectedAgentIds).toEqual(
      agents.map(({ id }) => id),
    );
    expect(allAgents.turns).toHaveLength(7);
    expect(allAgents.worldEvents).toHaveLength(7);
    expect(allAgents.initialWorld).not.toHaveProperty('events');
    expect(allAgents.currentWorld).not.toHaveProperty('events');
  });

  it('exports accepted communications for either participant without importing unrelated or rejected messages', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    ).getSnapshot();
    const [sender, recipient] = initial.world.agents;
    let call = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'message-export-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        call += 1;
        const communication =
          call === 1
            ? {
                channel: 'direct' as const,
                recipientId: recipient!.id,
                message: 'Inbound selection proof.',
              }
            : call === 2
              ? {
                  channel: 'public' as const,
                  message: 'Selected-author public message.',
                }
              : call === 3
                ? {
                    channel: 'direct' as const,
                    recipientId: observation.nearbyAgents.find(
                      ({ id, distance }) =>
                        distance <= 3 &&
                        id !== sender!.id &&
                        id !== recipient!.id,
                    )!.id,
                    message: 'Unrelated communication.',
                  }
                : call === 4
                  ? {
                      channel: 'direct' as const,
                      recipientId: observation.agentId,
                      message: 'Rejected self message.',
                    }
                  : call === 5
                    ? {
                        channel: 'public' as const,
                        message: 'Unselected-author public message.',
                      }
                    : undefined;
        return {
          decision: {
            worldAction: { type: 'wait' },
            ...(communication ? { communication } : {}),
            summary: 'Test export.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'message-export-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    for (let index = 0; index < 5; index += 1)
      await simulation.executeNextTurn();

    const inboundRequest = {
      ...exportRequest('minimal'),
      agents: { mode: 'selected', agentIds: [recipient!.id] },
      outcomes: ['accepted'],
      actions: ['wait'],
      communications: { channel: 'direct', status: 'accepted' },
    } as const;
    const inbound = simulation.generateExperimentExport(inboundRequest);
    expect(inbound.turns.map(({ turnNumber }) => turnNumber)).toEqual([2]);
    expect(inbound.communications).toMatchObject([
      {
        originatingTurn: 1,
        agentId: sender!.id,
        recipientId: recipient!.id,
        message: 'Inbound selection proof.',
      },
    ]);
    expect(inbound.metrics?.aggregate).toMatchObject({
      directMessagesRequested: 0,
      directMessagesDelivered: 0,
      directMessagesSent: 0,
      directMessagesReceived: 1,
    });
    const inboundPreview = simulation.previewExperimentExport(inboundRequest);
    const inboundBytes = new TextEncoder().encode(
      serializeExperimentExport(inbound),
    ).byteLength;
    expect(inboundPreview).toMatchObject({
      matchingTurnCount: 1,
      matchingCommunicationCount: 1,
      serializedUtf8Bytes: inboundBytes,
      approximateAiInputTokens: Math.ceil(inboundBytes / 4),
    });
    const multiAgent = simulation.generateExperimentExport({
      ...inboundRequest,
      agents: {
        mode: 'selected',
        agentIds: [sender!.id, recipient!.id],
      },
      communications: { channel: 'all', status: 'all' },
    });
    expect(multiAgent.communications).toMatchObject([
      { channel: 'direct', message: 'Inbound selection proof.' },
      { channel: 'public', message: 'Selected-author public message.' },
    ]);
    const allAgent = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      communications: { channel: 'all', status: 'all' },
    });
    expect(allAgent.communications).toHaveLength(5);
    expect(
      simulation.generateExperimentExport({
        ...inboundRequest,
        communications: { channel: 'public', status: 'all' },
      }).communications,
    ).toMatchObject([
      {
        originatingTurn: 2,
        agentId: recipient!.id,
        channel: 'public',
        message: 'Selected-author public message.',
      },
    ]);
    for (const filteredRequest of [
      {
        ...inboundRequest,
        communications: { channel: 'all', status: 'rejected' },
      },
      {
        ...inboundRequest,
        turns: { mode: 'range', fromTurn: 2, toTurn: 4 },
      },
    ])
      expect(
        simulation.generateExperimentExport(filteredRequest).communications,
      ).toEqual([]);
    const senderFull = simulation.generateExperimentExport({
      ...inboundRequest,
      level: 'full-safe',
      agents: { mode: 'selected', agentIds: [sender!.id] },
      actions: ['wait'],
    });
    expect(senderFull.turns).toHaveLength(1);
    expect(senderFull.turns[0]?.communicationResult).toMatchObject({
      accepted: true,
      event: { type: 'direct-message-sent' },
    });
    expect(senderFull.communications).toHaveLength(1);
    expect(senderFull.worldEvents).toMatchObject([{ type: 'agent-waited' }]);
    expect(senderFull.initialWorld).not.toHaveProperty('events');
    expect(senderFull.currentWorld).not.toHaveProperty('events');

    const rejectedSender = initial.world.agents[3]!;
    const rejected = simulation.generateExperimentExport({
      ...exportRequest('full-safe'),
      agents: { mode: 'selected', agentIds: [rejectedSender.id] },
      outcomes: ['accepted'],
      actions: ['wait'],
      communications: { channel: 'direct', status: 'rejected' },
    });
    expect(rejected.turns).toHaveLength(1);
    expect(rejected.turns[0]).toMatchObject({
      outcome: 'accepted',
      communicationResult: { accepted: false, reason: 'self-message' },
    });
    expect(rejected.communications).toMatchObject([
      { status: 'rejected', rejectionReason: 'self-message' },
    ]);
    expect(rejected.worldEvents).toMatchObject([{ type: 'agent-waited' }]);
    expect(rejected.metrics?.aggregate).toMatchObject({
      directMessagesRequested: 1,
      directMessagesDelivered: 0,
      directMessagesRejected: 1,
    });
  });

  it('produces predictable Minimal, Standard, Full safe and Custom omissions without mutation', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    await simulation.executeNextTurn();
    const before = simulation.getSnapshot();
    expect(() =>
      simulation.generateExperimentExport({
        ...exportRequest('minimal'),
        outcomes: [],
      }),
    ).toThrow(/invalid/i);
    expect(simulation.getSnapshot()).toEqual(before);
    const minimal = simulation.generateExperimentExport(
      exportRequest('minimal'),
    );
    const standard = simulation.generateExperimentExport(
      exportRequest('standard'),
    );
    const full = simulation.generateExperimentExport(
      exportRequest('full-safe'),
    );
    const custom = simulation.generateExperimentExport({
      ...exportRequest('custom'),
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
        communications: false,
        controlChanges: false,
      },
    });
    expect(minimal.schemaVersion).toBe(9);
    expect(
      experimentExportDocumentSchema.safeParse({
        ...minimal,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(minimal.turns[0]).not.toHaveProperty('observation');
    expect(standard.turns[0]).toHaveProperty('observation');
    expect(full).toHaveProperty('initialWorld');
    expect(full).toHaveProperty('configurationEvents');
    expect(full.initialWorld).not.toHaveProperty('events');
    expect(full.currentWorld).not.toHaveProperty('events');
    expect(full.worldEvents).toEqual([
      expect.objectContaining({ agentId: before.world.agents[0]!.id }),
    ]);
    expect(minimal.communications).toEqual([]);
    expect(standard.communications).toEqual([]);
    expect(full.communications).toEqual([]);
    expect(custom).not.toHaveProperty('communications');
    expect(custom).not.toHaveProperty('controlChanges');
    expect(custom).not.toHaveProperty('metrics');
    expect(custom.turns[0]).not.toHaveProperty('provider');
    minimal.turns[0]!.outcome = 'rejected';
    expect(
      simulation.generateExperimentExport(exportRequest('minimal')).turns[0]
        ?.outcome,
    ).toBe('accepted');
    expect(simulation.getSnapshot()).toEqual(before);
  });

  it('calls the provider exactly once per turn in round-robin order', async () => {
    const seen: AgentObservation[] = [];
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'recording-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        seen.push(observation);
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model: 'recording-test',
            latencyMs: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const order = simulation.getSnapshot().world.agents.map(({ id }) => id);
    for (let index = 0; index < 9; index += 1)
      await simulation.executeNextTurn();
    expect(seen).toHaveLength(9);
    expect(seen.map(({ agentId }) => agentId)).toEqual([...order, order[0]]);
  });

  it('keeps total turn numbering and round robin independent of retained history', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'long-running-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model: 'long-running-test',
            latencyMs: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const agentOrder = simulation
      .getSnapshot()
      .world.agents.map(({ id }) => id);

    for (let index = 0; index < 125; index += 1) {
      await simulation.executeNextTurn();
    }

    const snapshot = simulation.getSnapshot();
    const retainedNumbers = snapshot.turns.map(({ turnNumber }) => turnNumber);
    expect(snapshot.turnNumber).toBe(125);
    expect(snapshot.turns).toHaveLength(120);
    expect(retainedNumbers).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 6),
    );
    expect(new Set(retainedNumbers).size).toBe(120);
    expect(snapshot.turns.map(({ agentId }) => agentId)).toEqual(
      snapshot.turns.map(
        ({ turnNumber }) => agentOrder[(turnNumber - 1) % agentOrder.length],
      ),
    );
    expect(snapshot.nextAgentId).toBe(agentOrder[125 % agentOrder.length]);
  });

  it('builds each observation from the latest authoritative world state', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
        { worldAction: { type: 'wait' }, summary: 'Observe.' },
      ]),
    );
    await simulation.executeNextTurn();
    const second = await simulation.executeNextTurn();
    expect(second.observation.recentEvents).toHaveLength(1);
    expect(second.observation.recentEvents[0]?.type).toBe('hex-infected');
  });

  it('applies an infection and public message from the same provider decision', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        {
          worldAction: { type: 'infect' },
          communication: {
            channel: 'public',
            message: '  The center is claimed.  ',
          },
          summary: 'Claim and announce.',
        },
        { worldAction: { type: 'wait' }, summary: 'Observe.' },
      ]),
    );
    const first = await simulation.executeNextTurn();
    expect(first).toMatchObject({
      outcome: 'accepted',
      worldActionResult: { event: { type: 'hex-infected' } },
      communicationResult: {
        accepted: true,
        event: {
          type: 'public-message-sent',
          message: 'The center is claimed.',
        },
      },
    });
    expect(
      simulation.getSnapshot().world.events.map(({ type }) => type),
    ).toEqual(['hex-infected', 'public-message-sent']);
    const second = await simulation.executeNextTurn();
    expect(second.observation.recentPublicMessages).toMatchObject([
      { senderId: first.agentId, message: 'The center is claimed.' },
    ]);
  });

  it('preserves accepted communication when the world action is rejected', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    ).getSnapshot();
    const [sender, recipient] = initial.world.agents;
    for (const communication of [
      { channel: 'public' as const, message: 'Still speaking.' },
      {
        channel: 'direct' as const,
        recipientId: recipient!.id,
        message: 'Nearby despite the bad move.',
      },
    ]) {
      const simulation = service(
        new ScriptedAgentProvider([
          {
            worldAction: {
              type: 'move',
              targetCell: h3CellSchema.parse('8928308280fffff'),
            },
            communication,
            summary: 'Try both.',
          },
        ]),
      );
      const turn = await simulation.executeNextTurn();
      expect(turn).toMatchObject({
        agentId: sender!.id,
        outcome: 'rejected',
        worldActionResult: { accepted: false },
        communicationResult: { accepted: true },
      });
      expect(simulation.getSnapshot().world.events).toHaveLength(1);
    }
  });

  it('rejects an oversized communication without cancelling a valid world action', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'invalid-communication-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: { type: 'infect' },
            communication: {
              channel: 'public',
              message: 'x'.repeat(281),
            },
            summary: 'Apply the valid component.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'invalid-communication-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const turn = await simulation.executeNextTurn();
    expect(turn).toMatchObject({
      outcome: 'accepted',
      worldActionResult: { event: { type: 'hex-infected' } },
      communicationResult: {
        accepted: false,
        reason: 'invalid-communication',
        attempt: { channel: 'public' },
      },
    });
    if (
      turn.outcome === 'provider-error' ||
      turn.outcome === 'lost-tick' ||
      turn.outcome === 'operator-skipped' ||
      !turn.communicationResult.requested ||
      turn.communicationResult.accepted
    )
      throw new Error('Expected rejected communication fixture.');
    expect(turn.communicationResult.attempt.message).toHaveLength(280);
    expect(simulation.getSnapshot().experiment.metrics.aggregate).toMatchObject(
      {
        publicMessagesRequested: 1,
        publicMessagesRejected: 1,
        successfullyInfectedCells: 1,
      },
    );
  });

  it('counts and exports malformed direct recipients as rejected direct attempts', async () => {
    const invalidDirectCommunications = [
      { channel: 'direct', recipientId: 'Verge', message: 'Malformed ID.' },
      { channel: 'direct', message: 'Missing ID.' },
    ];
    let call = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'invalid-direct-recipient-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: invalidDirectCommunications[call++],
            summary: 'Keep the malformed attempt safe.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'invalid-direct-recipient-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const turns = [
      await simulation.executeNextTurn(),
      await simulation.executeNextTurn(),
    ];
    expect(
      turns.map((turn) =>
        turn.outcome === 'provider-error' ||
        turn.outcome === 'lost-tick' ||
        turn.outcome === 'operator-skipped'
          ? undefined
          : turn.communicationResult,
      ),
    ).toMatchObject([
      {
        accepted: false,
        reason: 'invalid-communication',
        attempt: { channel: 'direct', recipientId: null, distance: null },
      },
      {
        accepted: false,
        reason: 'invalid-communication',
        attempt: { channel: 'direct', recipientId: null, distance: null },
      },
    ]);
    expect(simulation.getSnapshot().experiment.metrics.aggregate).toMatchObject(
      {
        publicMessagesRequested: 0,
        publicMessagesRejected: 0,
        directMessagesRequested: 2,
        directMessagesRejected: 2,
      },
    );

    const exported = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      communications: { channel: 'direct', status: 'rejected' },
    });
    expect(exported.communications).toMatchObject([
      {
        originatingTurn: 1,
        channel: 'direct',
        recipientId: null,
        message: 'Malformed ID.',
        status: 'rejected',
        rejectionReason: 'invalid-communication',
      },
      {
        originatingTurn: 2,
        channel: 'direct',
        recipientId: null,
        message: 'Missing ID.',
        status: 'rejected',
        rejectionReason: 'invalid-communication',
      },
    ]);
    expect(exported.metrics?.aggregate).toMatchObject({
      publicMessagesRequested: 0,
      publicMessagesRejected: 0,
      directMessagesRequested: 2,
      directMessagesRejected: 2,
    });
    expect(
      simulation.generateExperimentExport({
        ...exportRequest('minimal'),
        communications: { channel: 'public', status: 'rejected' },
      }).communications,
    ).toEqual([]);
  });

  it('uses pre-action positions for direct-message range', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    ).getSnapshot();
    const sender = initial.world.agents[0]!;
    const recipient = initial.world.agents.find(
      (candidate) =>
        candidate.id !== sender.id &&
        gridDistance(sender.currentCell, candidate.currentCell) > 3,
    )!;
    const initialDistance = gridDistance(
      sender.currentCell,
      recipient.currentCell,
    );
    const targetCell = initial.world.hexes.find(
      ({ cell }) =>
        gridDistance(sender.currentCell, cell) === 1 &&
        gridDistance(cell, recipient.currentCell) === initialDistance - 1,
    )!.cell;
    const simulation = service(
      new ScriptedAgentProvider([
        {
          worldAction: { type: 'move', targetCell },
          communication: {
            channel: 'direct',
            recipientId: recipient.id,
            message: 'This must use the old distance.',
          },
          summary: 'Move closer and try to message.',
        },
      ]),
    );
    const initialPhysicalDistance = physicalDistanceKm(
      sender.currentCell,
      recipient.currentCell,
    )!;
    const turn = await simulation.executeNextTurn();
    expect(turn).toMatchObject({
      outcome: 'accepted',
      communicationResult: {
        accepted: true,
        event: { distance: initialPhysicalDistance },
      },
    });
    expect(simulation.getSnapshot().world.agents[0]?.currentCell).toBe(
      targetCell,
    );
  });

  it('delivers direct messages alongside world actions and exposes inbound and outbound context', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    ).getSnapshot();
    const sender = initial.world.agents[0]!;
    const recipient = initial.world.agents[1]!;
    const simulation = service(
      new ScriptedAgentProvider([
        {
          worldAction: { type: 'wait' },
          communication: {
            channel: 'direct',
            recipientId: recipient.id,
            message: '  Hold near the center.  ',
          },
          summary: 'Coordinate.',
        },
        { worldAction: { type: 'wait' }, summary: 'Observe.' },
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
        { worldAction: { type: 'wait' }, summary: 'Observe sender.' },
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
        { worldAction: { type: 'wait' }, summary: 'Observe sender again.' },
      ]),
    );
    const before = simulation.getSnapshot().world;
    const sent = await simulation.executeNextTurn();
    expect(sent).toMatchObject({
      agentId: sender.id,
      outcome: 'accepted',
      communicationResult: {
        event: {
          type: 'direct-message-sent',
          recipientId: recipient.id,
          message: 'Hold near the center.',
        },
      },
    });
    expect(simulation.getSnapshot().world.agents).toEqual(before.agents);
    expect(simulation.getSnapshot().world.hexes).toEqual(before.hexes);

    const recipientTurn = await simulation.executeNextTurn();
    expect(recipientTurn.observation.recentDirectMessages).toMatchObject([
      {
        senderId: sender.id,
        recipientId: recipient.id,
        direction: 'inbound',
        message: 'Hold near the center.',
      },
    ]);
    const unrelatedTurn = await simulation.executeNextTurn();
    expect(unrelatedTurn.observation.recentDirectMessages).toEqual([]);
    for (let index = 0; index < 6; index += 1)
      await simulation.executeNextTurn();
    const senderTurn = simulation.getSnapshot().turns.at(-1)!;
    expect(senderTurn.agentId).toBe(sender.id);
    expect(senderTurn.observation.recentDirectMessages[0]).toMatchObject({
      direction: 'outbound',
      recipientId: recipient.id,
    });
  });

  it('rejects self and unknown recipients without a delivered event', async () => {
    const ids = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    )
      .getSnapshot()
      .world.agents.map(({ id }) => id);
    for (const [recipientId, reason] of [
      [ids[0]!, 'self-message'],
      [
        agentIdSchema.parse('6b58a30d-5d47-4ea3-8c1c-43edcc919553'),
        'unknown-recipient',
      ],
    ] as const) {
      const simulation = service(
        new ScriptedAgentProvider([
          {
            worldAction: { type: 'wait' },
            communication: {
              channel: 'direct',
              recipientId,
              message: 'Hello.',
            },
            summary: 'Try message.',
          },
        ]),
      );
      expect(await simulation.executeNextTurn()).toMatchObject({
        outcome: 'accepted',
        communicationResult: { accepted: false, reason },
      });
      expect(simulation.getSnapshot().world.events).toHaveLength(1);
    }
  });

  it('keeps recent communication context chronological and capped at six', async () => {
    const seen: AgentObservation[] = [];
    let clock = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'communication-history-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        seen.push(observation);
        const target = observation.nearbyAgents.find(
          ({ distance }) => distance <= 3,
        );
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: target
              ? {
                  channel: 'direct',
                  recipientId: target.id,
                  message: `Turn ${seen.length}`,
                }
              : undefined,
            summary: 'Message.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'communication-history-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = new SimulationService({
      provider,
      now: () =>
        new Date(
          Date.parse('2026-08-13T12:00:00.000Z') + clock++,
        ).toISOString(),
      createEventId,
    });
    for (let index = 0; index < 48; index += 1)
      await simulation.executeNextTurn();
    const bounded = seen.findLast(
      ({ recentDirectMessages }) => recentDirectMessages.length === 6,
    );
    expect(bounded?.recentDirectMessages).toHaveLength(6);
    expect(
      bounded?.recentDirectMessages.map(({ occurredAt }) => occurredAt),
    ).toEqual(
      bounded?.recentDirectMessages
        .map(({ occurredAt }) => occurredAt)
        .toSorted(),
    );
  });

  it('keeps public world chat chronological, globally visible, and capped at twelve', async () => {
    const seen: AgentObservation[] = [];
    let clock = 0;
    let eventSequence = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'public-history-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        seen.push(observation);
        return {
          decision: {
            worldAction: { type: 'wait' },
            communication: {
              channel: 'public',
              message: `Public ${seen.length}`,
            },
            summary: 'Publish.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'public-history-test',
            latencyMs: 0,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = new SimulationService({
      provider,
      now: () =>
        new Date(
          Date.parse('2026-08-13T12:00:00.000Z') + clock++,
        ).toISOString(),
      createEventId: () =>
        `67aa21b9-fc78-4b04-9f92-${String(++eventSequence).padStart(12, '0')}`,
    });
    for (let index = 0; index < 14; index += 1)
      await simulation.executeNextTurn();
    const bounded = seen.at(-1)!.recentPublicMessages;
    expect(bounded).toHaveLength(12);
    expect(bounded.map(({ message }) => message)).toEqual(
      Array.from({ length: 12 }, (_, index) => `Public ${index + 2}`),
    );
    expect(new Set(bounded.map(({ senderId }) => senderId))).not.toEqual(
      new Set([seen.at(-1)!.agentId]),
    );
  });

  it('reset clears accepted communication history and metrics', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    ).getSnapshot();
    const simulation = service(
      new ScriptedAgentProvider([
        {
          worldAction: { type: 'wait' },
          communication: {
            channel: 'public',
            message: 'Public before reset.',
          },
          summary: 'Publish.',
        },
        {
          worldAction: { type: 'wait' },
          communication: {
            channel: 'direct',
            recipientId: initial.world.agents[0]!.id,
            message: 'Direct before reset.',
          },
          summary: 'Send directly.',
        },
      ]),
    );
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    expect(simulation.getSnapshot().world.events).toHaveLength(4);
    expect(simulation.getSnapshot().experiment.metrics.aggregate).toMatchObject(
      {
        publicMessagesRequested: 1,
        publicMessagesAccepted: 1,
        directMessagesRequested: 1,
        directMessagesDelivered: 1,
      },
    );
    const reset = simulation.reset();
    expect(reset.world.events).toEqual([]);
    expect(reset.experiment.metrics.aggregate).toMatchObject({
      publicMessagesSent: 0,
      publicMessagesRequested: 0,
      publicMessagesAccepted: 0,
      directMessagesRequested: 0,
      directMessagesDelivered: 0,
      directMessagesSent: 0,
      directMessagesReceived: 0,
    });
  });

  it('updates an existing agent and uses the trimmed personality on its next turn', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Use the edit.' },
      ]),
    );
    const agent = simulation.getSnapshot().world.agents[0]!;
    const updated = simulation.updateAgentPersonality(
      agent.id,
      '  Prioritize adjacent open cells.  ',
    );
    expect(updated).toMatchObject({
      id: agent.id,
      personality: 'Prioritize adjacent open cells.',
    });
    expect((await simulation.executeNextTurn()).observation.personality).toBe(
      'Prioritize adjacent open cells.',
    );
  });

  it('rejects unknown agents and invalid personalities without mutation, then recovers', () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    );
    const before = simulation.getSnapshot();
    expect(() =>
      simulation.updateAgentPersonality(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Valid personality.',
      ),
    ).toThrow(SimulationValidationError);
    expect(() =>
      simulation.updateAgentPersonality(before.world.agents[0]!.id, '   '),
    ).toThrow(SimulationValidationError);
    expect(() =>
      simulation.updateAgentPersonality(
        before.world.agents[0]!.id,
        'x'.repeat(PERSONALITY_MAX_LENGTH + 1),
      ),
    ).toThrow(SimulationValidationError);
    expect(simulation.getSnapshot()).toEqual(before);

    simulation.updateAgentPersonality(
      before.world.agents[0]!.id,
      'Recovered personality.',
    );
    expect(simulation.getSnapshot().world.agents[0]!.personality).toBe(
      'Recovered personality.',
    );
  });

  it('edits personality without changing world progress or historical observations', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    await simulation.executeNextTurn();
    const before = simulation.getSnapshot();
    const agent = before.world.agents[0]!;
    simulation.updateAgentPersonality(agent.id, 'A new active personality.');
    const after = simulation.getSnapshot();

    expect(after.world.hexes).toEqual(before.world.hexes);
    expect(after.world.events).toEqual(before.world.events);
    expect(after.world.agents.map(({ currentCell }) => currentCell)).toEqual(
      before.world.agents.map(({ currentCell }) => currentCell),
    );
    expect(
      after.world.agents.map(({ id, name, color }) => ({ id, name, color })),
    ).toEqual(
      before.world.agents.map(({ id, name, color }) => ({ id, name, color })),
    );
    expect(after.turns).toEqual(before.turns);
    expect(after.turns[0]!.observation.personality).toBe(agent.personality);
    expect(after.turnNumber).toBe(before.turnNumber);
    expect(after.nextAgentId).toBe(before.nextAgentId);
  });

  it('reset preserves active personality edits while restoring deterministic progress', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    const initial = simulation.getSnapshot();
    for (const agent of initial.world.agents) {
      simulation.updateAgentPersonality(
        agent.id,
        `Preserve ${agent.name}'s edit.`,
      );
    }
    await simulation.executeNextTurn();
    const reset = simulation.reset();

    expect(reset).toMatchObject({ turnNumber: 0, turns: [] });
    expect(reset.world.events).toEqual([]);
    expect(reset.world.hexes).toEqual(initial.world.hexes);
    expect(reset.world.agents.map(({ currentCell }) => currentCell)).toEqual(
      initial.world.agents.map(({ currentCell }) => currentCell),
    );
    expect(reset.world.agents.map(({ personality }) => personality)).toEqual(
      initial.world.agents.map(({ name }) => `Preserve ${name}'s edit.`),
    );
  });

  it('restores all eight defaults without resetting current world progress', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    for (const agent of simulation.getSnapshot().world.agents) {
      simulation.updateAgentPersonality(agent.id, `Custom ${agent.name}.`);
    }
    await simulation.executeNextTurn();
    const before = simulation.getSnapshot();
    const restored = simulation.restoreDefaultPersonalities();

    expect(restored.world.agents.map(({ personality }) => personality)).toEqual(
      DEVELOPMENT_AGENT_BLUEPRINTS.map(({ personality }) => personality),
    );
    expect(
      restored.world.agents.find(({ name }) => name === 'Mingle')?.personality,
    ).toBe(
      'You are a social coalition-builder. Seek agents, initiate and continue conversations, propose alliances, answer offers, negotiate borders, and coordinate captures against dominant rivals. Prefer cooperation and public diplomacy over silent expansion, but protect your own territory and leave an alliance that repeatedly ignores or exploits you. Make concrete proposals rather than merely announcing actions.',
    );
    expect(restored.world.hexes).toEqual(before.world.hexes);
    expect(restored.world.events).toEqual(before.world.events);
    expect(restored.turns).toEqual(before.turns);
    expect(restored.turnNumber).toBe(before.turnNumber);
    expect(restored.nextAgentId).toBe(before.nextAgentId);
    expect(restored.world.agents.map(({ currentCell }) => currentCell)).toEqual(
      before.world.agents.map(({ currentCell }) => currentCell),
    );
  });

  it('records accepted and rejected actions without mutating on rejection', async () => {
    const initial = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    );
    expect((await initial.executeNextTurn()).outcome).toBe('accepted');

    const rejected = service(
      new ScriptedAgentProvider([
        {
          worldAction: {
            type: 'move',
            targetCell: h3CellSchema.parse('8928308280fffff'),
          },
          summary: 'Attempt a distant move.',
        },
        { worldAction: { type: 'wait' }, summary: 'Continue.' },
      ]),
    );
    const before = rejected.getSnapshot().world;
    expect(await rejected.executeNextTurn()).toMatchObject({
      turnNumber: 1,
      outcome: 'rejected',
    });
    expect(rejected.getSnapshot().world.hexes).toEqual(before.hexes);
    expect(rejected.getSnapshot().world.agents).toEqual(before.agents);
    expect(await rejected.executeNextTurn()).toMatchObject({
      turnNumber: 2,
      outcome: 'accepted',
    });
    expect(rejected.getSnapshot().turnNumber).toBe(2);
  });

  it('manually retries the same failed logical turn without mutating the world', async () => {
    let calls = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'failure-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        calls += 1;
        if (calls <= 2)
          throw new AgentProviderError(
            {
              code: 'timeout',
              message: 'The model request timed out.',
              retryable: true,
            },
            {
              provider: 'scripted-test',
              model: 'failure-test',
              latencyMs: 10,
              promptTokens: 10,
              completionTokens: 2,
              reasoningTokens: 1,
              cachedReadTokens: 3,
              cacheWriteTokens: 4,
              totalTokens: 12,
              costCredits: 0.1,
            },
          );
        return {
          decision: {
            worldAction: { type: 'wait' },
            summary: 'Recovered.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'failure-test',
            latencyMs: 20,
            promptTokens: 20,
            completionTokens: 5,
            reasoningTokens: 2,
            cachedReadTokens: 6,
            cacheWriteTokens: 8,
            totalTokens: 25,
            costCredits: 0.2,
          },
        };
      },
    };
    const simulation = service(provider);
    const before = simulation.getSnapshot().world;
    expect(await simulation.executeNextTurn()).toMatchObject({
      turnNumber: 1,
      outcome: 'provider-error',
    });
    expect(simulation.getSnapshot().world).toEqual(before);
    expect(simulation.getSnapshot().turnNumber).toBe(0);
    expect(simulation.getSnapshot().pendingFailedTurn).toMatchObject({
      turnNumber: 1,
      attempts: [{ kind: 'initial' }, { kind: 'automatic-transport-retry' }],
    });
    expect(await simulation.retryFailedTurn()).toMatchObject({
      turnNumber: 1,
      outcome: 'accepted',
      modelAttempts: [
        { kind: 'initial' },
        { kind: 'automatic-transport-retry' },
        { kind: 'manual-retry' },
      ],
    });
    expect(simulation.getSnapshot().turnNumber).toBe(1);
    expect(simulation.getSnapshot().experiment.metrics.aggregate).toMatchObject(
      {
        totalTurns: 1,
        accepted: 1,
        rejected: 0,
        providerErrors: 0,
        operatorSkipped: 0,
        modelCalls: 3,
        failedModelAttempts: 2,
        automaticTransportRetries: 1,
        manualRetryAttempts: 1,
        retriedTurns: 1,
        recoveredByRetry: 1,
        tokens: {
          promptTokens: 40,
          completionTokens: 9,
          reasoningTokens: 4,
          cachedReadTokens: 12,
          cacheWriteTokens: 16,
          totalTokens: 49,
        },
        knownCostCredits: 0.4,
      },
    );
  });

  it('preserves partial-known token and cost totals per attempt and per logical turn', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Known usage.' },
      ]),
    );
    const completed = await simulation.executeNextTurn();
    const failedAttempt = (attemptNumber: number) => ({
      attemptNumber,
      kind:
        attemptNumber === 1
          ? ('initial' as const)
          : ('automatic-transport-retry' as const),
      startedAt: completed.startedAt,
      completedAt: completed.completedAt,
      modelId: 'acceptance/model',
      reasoningProfile: 'provider-default' as const,
      failure: {
        code: 'provider-http' as const,
        message: 'The model provider rate limited the request.',
        retryable: true,
        httpStatus: 429,
      },
      provider: {
        provider: 'openrouter' as const,
        model: 'acceptance/model',
        httpStatus: 429,
        latencyMs: 10,
      },
    });
    const acceptanceTurn = agentTurnRecordSchema.parse({
      ...completed,
      provider: {
        provider: 'openrouter',
        model: 'acceptance/model',
        latencyMs: 20,
        promptTokens: 73_931,
        completionTokens: 5_079,
        totalTokens: 79_010,
        reasoningTokens: 2_642,
        cachedReadTokens: 432,
        cacheWriteTokens: 8_175,
        costCredits: 1.25,
      },
      modelAttempts: [
        failedAttempt(1),
        failedAttempt(2),
        {
          attemptNumber: 3,
          kind: 'manual-retry',
          startedAt: completed.startedAt,
          completedAt: completed.completedAt,
          modelId: 'acceptance/model',
          reasoningProfile: 'provider-default',
          provider: {
            provider: 'openrouter',
            model: 'acceptance/model',
            latencyMs: 20,
            promptTokens: 73_931,
            completionTokens: 5_079,
            totalTokens: 79_010,
            reasoningTokens: 2_642,
            cachedReadTokens: 432,
            cacheWriteTokens: 8_175,
            costCredits: 1.25,
          },
        },
      ],
    });
    const metrics = calculateExperimentMetrics(
      [acceptanceTurn],
      [acceptanceTurn.agentId],
    ).aggregate;
    expect(metrics).toMatchObject({
      tokens: {
        promptTokens: 73_931,
        completionTokens: 5_079,
        totalTokens: 79_010,
        reasoningTokens: 2_642,
        cachedReadTokens: 432,
        cacheWriteTokens: 8_175,
      },
      tokenUsageComplete: false,
      attemptsWithUnknownTokenUsage: 2,
      knownCostCredits: 1.25,
      attemptsWithUnknownCost: 2,
      turnsWithUnknownCost: 1,
      manualRetryAttempts: 1,
      recoveredManually: 1,
    });
  });

  it('sums each partially reported token field independently', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Partial usage.' },
      ]),
    );
    const completed = await simulation.executeNextTurn();
    const partial = agentTurnRecordSchema.parse({
      ...completed,
      modelAttempts: [
        {
          attemptNumber: 1,
          kind: 'initial',
          startedAt: completed.startedAt,
          completedAt: completed.completedAt,
          modelId: 'partial/model',
          reasoningProfile: 'provider-default',
          provider: {
            provider: 'openrouter',
            model: 'partial/model',
            latencyMs: 1,
            promptTokens: 5,
            costCredits: 0.1,
          },
        },
        {
          attemptNumber: 2,
          kind: 'automatic-repair',
          startedAt: completed.startedAt,
          completedAt: completed.completedAt,
          modelId: 'partial/model',
          reasoningProfile: 'provider-default',
          provider: {
            provider: 'openrouter',
            model: 'partial/model',
            latencyMs: 1,
            completionTokens: 3,
            costCredits: 0.2,
          },
        },
      ],
    });
    expect(
      calculateExperimentMetrics([partial], [partial.agentId]).aggregate,
    ).toMatchObject({
      tokens: { promptTokens: 5, completionTokens: 3 },
      tokenUsageComplete: false,
      attemptsWithUnknownTokenUsage: 2,
      knownCostCredits: 0.3,
      attemptsWithUnknownCost: 0,
      turnsWithUnknownCost: 0,
      automaticRepairAttempts: 1,
      recoveredAutomatically: 1,
    });
  });

  it('skips one failed logical turn without applying an action and exports its attempts', async () => {
    const simulation = service({
      mode: 'scripted-test',
      model: 'failure-test',
      configured: true,
      async decide(_observation, model) {
        throw new AgentProviderError(
          {
            code: 'timeout',
            message: 'Timed out.',
            retryable: true,
            model,
          },
          {
            provider: 'scripted-test',
            model,
            latencyMs: 5,
            promptTokens: 4,
            completionTokens: 1,
            totalTokens: 5,
            reasoningTokens: 0,
            cachedReadTokens: 0,
            cacheWriteTokens: 0,
            costCredits: 0.01,
          },
        );
      },
    });
    const before = simulation.getSnapshot().world;
    await simulation.executeNextTurn();
    await simulation.retryFailedTurn();
    await simulation.retryFailedTurn();
    const skipped = simulation.skipFailedTurn();
    expect(skipped).toMatchObject({
      turnNumber: 1,
      outcome: 'operator-skipped',
      failure: { code: 'timeout', model: 'failure-test' },
      provider: { model: 'failure-test' },
      modelAttempts: [
        { kind: 'initial' },
        { kind: 'automatic-transport-retry' },
        { kind: 'manual-retry' },
        { kind: 'manual-retry' },
      ],
    });
    expect(simulation.getSnapshot().world).toEqual(before);
    expect(simulation.getSnapshot()).toMatchObject({
      turnNumber: 1,
      status: 'paused',
      pendingFailedTurn: null,
    });
    const exported = simulation.generateExperimentExport({
      ...exportRequest('minimal'),
      outcomes: ['operator-skipped'],
    });
    expect(exported.turns[0]).toMatchObject({
      outcome: 'operator-skipped',
      modelAttempts: [
        { kind: 'initial' },
        { kind: 'automatic-transport-retry' },
        { kind: 'manual-retry' },
        { kind: 'manual-retry' },
      ],
    });
    expect(exported.metrics?.aggregate).toMatchObject({
      totalTurns: 1,
      accepted: 0,
      rejected: 0,
      providerErrors: 0,
      operatorSkipped: 1,
      modelCalls: 4,
      failedModelAttempts: 4,
      automaticTransportRetries: 1,
      manualRetryAttempts: 2,
      retriedTurns: 1,
      recoveredByRetry: 0,
      knownCostCredits: 0.04,
    });
  });

  it('uses the operator current model and reasoning profile for one manual retry', async () => {
    const calls: Array<{ model: string; reasoningProfile?: string }> = [];
    const simulation = service({
      mode: 'openrouter',
      configured: true,
      async decide(_observation, model, options) {
        calls.push({ model, reasoningProfile: options?.reasoningProfile });
        if (calls.length <= 2)
          throw new AgentProviderError({
            code: 'timeout',
            message: 'Timed out.',
            retryable: true,
            model,
          });
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Recovered.' },
          metadata: { provider: 'openrouter', model, latencyMs: 1 },
        };
      },
    });
    simulation.setCompatibleModels(compatibleModels);
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[0]!.id,
      globalReasoningProfile: 'low',
      overrides: [],
    });
    await simulation.executeNextTurn();
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[1]!.id,
      globalReasoningProfile: 'low',
      overrides: [],
    });
    await simulation.retryFailedTurn();
    expect(calls).toEqual([
      { model: compatibleModels[0]!.id, reasoningProfile: 'low' },
      { model: compatibleModels[0]!.id, reasoningProfile: 'low' },
      { model: compatibleModels[1]!.id, reasoningProfile: 'low' },
    ]);
  });

  it('counts legacy top-level provider metadata once when attempts are absent', async () => {
    const simulation = service(
      new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Legacy wait.' },
      ]),
    );
    const turn = await simulation.executeNextTurn();
    const legacy = agentTurnRecordSchema.parse({
      ...turn,
      modelAttempts: undefined,
    });
    const metrics = calculateExperimentMetrics([legacy], [legacy.agentId]);
    expect(metrics.aggregate).toMatchObject({
      totalTurns: 1,
      accepted: 1,
      providerErrors: 0,
      operatorSkipped: 0,
      modelCalls: 1,
      failedModelAttempts: 0,
      knownCostCredits: 0,
    });
  });

  it('does not commit or advance after post-provider validation fails', async () => {
    const seenAgentIds: AgentObservation['agentId'][] = [];
    let calls = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'invalid-metadata-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        calls += 1;
        seenAgentIds.push(observation.agentId);
        if (calls === 1) {
          return {
            decision: {
              worldAction: { type: 'wait' },
              summary: 'Invalid metadata follows.',
            },
            metadata: {
              provider: 'scripted-test',
              model: '',
              latencyMs: 0,
            },
          } as ProviderDecision;
        }
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Valid.' },
          metadata: {
            provider: 'scripted-test',
            model: 'invalid-metadata-test',
            latencyMs: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const before = simulation.getSnapshot();

    await expect(simulation.executeNextTurn()).resolves.toMatchObject({
      outcome: 'provider-error',
      failure: { code: 'simulation-validation' },
    });

    const afterFailure = simulation.getSnapshot();
    expect(afterFailure.world).toEqual(before.world);
    expect(afterFailure.turnNumber).toBe(0);
    expect(afterFailure.turns).toEqual([]);
    expect(afterFailure.nextAgentId).toBe(before.nextAgentId);
    expect(afterFailure).toMatchObject({
      activeAgentId: null,
      status: 'provider-error',
      pendingFailedTurn: { turnNumber: 1 },
    });

    const recovered = await simulation.retryFailedTurn();
    expect(recovered).toMatchObject({
      turnNumber: 1,
      agentId: before.nextAgentId,
      outcome: 'accepted',
    });
    expect(seenAgentIds).toEqual([before.nextAgentId, before.nextAgentId]);
  });

  it('retains only the newest world events without changing current state', async () => {
    let clock = 0;
    let eventSequence = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'moving-history-test',
      configured: true,
      async decide(observation): Promise<ProviderDecision> {
        return {
          decision: {
            worldAction: {
              type: 'move',
              targetCell: observation.adjacentCells[0]!.cell,
            },
            summary: 'Move.',
          },
          metadata: {
            provider: 'scripted-test',
            model: 'moving-history-test',
            latencyMs: 0,
          },
        };
      },
    };
    const simulation = new SimulationService({
      provider,
      now: () =>
        new Date(
          Date.parse('2026-08-13T12:00:00.000Z') + clock++,
        ).toISOString(),
      createEventId: () =>
        `67aa21b9-fc78-4b04-9f92-${String(++eventSequence).padStart(12, '0')}`,
    });
    const producedEvents: WorldEvent[] = [];
    let lastRecord: AgentTurnRecord | undefined;

    for (let index = 0; index < 125; index += 1) {
      lastRecord = await simulation.executeNextTurn();
      if (lastRecord.outcome !== 'accepted') {
        throw new Error(
          'The moving history fixture must produce accepted turns.',
        );
      }
      producedEvents.push(lastRecord.worldActionResult.event);
    }

    const snapshot = simulation.getSnapshot();
    expect(snapshot.world.events).toHaveLength(120);
    expect(snapshot.world.events).toEqual(producedEvents.slice(-120));
    expect(
      lastRecord?.observation.recentEvents.map(({ occurredAt }) => occurredAt),
    ).toEqual(producedEvents.slice(-9, -1).map(({ occurredAt }) => occurredAt));

    for (const agent of snapshot.world.agents) {
      const latestMove = producedEvents
        .filter(
          (event) => event.type === 'agent-moved' && event.agentId === agent.id,
        )
        .at(-1);
      expect(latestMove?.type).toBe('agent-moved');
      if (latestMove?.type === 'agent-moved') {
        expect(agent.currentCell).toBe(latestMove.toCell);
      }
    }
  });

  it('prevents overlapping turns and reset during an in-flight request', async () => {
    let release!: (result: ProviderDecision) => void;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'deferred-test',
      configured: true,
      decide: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const simulation = service(provider);
    const pending = simulation.executeNextTurn();
    await expect(simulation.executeNextTurn()).rejects.toBeInstanceOf(
      SimulationConflictError,
    );
    expect(() => simulation.reset()).toThrow(SimulationConflictError);
    expect(() =>
      simulation.updateAgentPersonality(
        simulation.getSnapshot().world.agents[0]!.id,
        'Blocked edit.',
      ),
    ).toThrow(SimulationConflictError);
    expect(() => simulation.restoreDefaultPersonalities()).toThrow(
      SimulationConflictError,
    );
    expect(() =>
      simulation.previewExperimentExport(exportRequest('minimal')),
    ).toThrow(SimulationConflictError);
    expect(() =>
      simulation.generateExperimentExport(exportRequest('minimal')),
    ).toThrow(SimulationConflictError);
    release({
      decision: { worldAction: { type: 'wait' }, summary: 'Done.' },
      metadata: {
        provider: 'scripted-test',
        model: 'deferred-test',
        latencyMs: 0,
      },
    });
    await pending;
    expect(simulation.getSnapshot().turnNumber).toBe(1);
  });

  it('cancels an active provider request without mutating or consuming a turn', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'cancel-test',
      configured: true,
      async decide(_observation, _model, options) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve());
        });
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Too late.' },
          metadata: {
            provider: 'scripted-test',
            model: 'cancel-test',
            latencyMs: 1,
          },
        };
      },
    };
    const simulation = service(provider);
    const before = simulation.getSnapshot().world;
    const pending = simulation.executeNextTurn();
    expect(simulation.cancelCurrentRequest().cancellationRequested).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(SimulationTurnCancelledError);
    expect(simulation.getSnapshot()).toMatchObject({
      activeAgentId: null,
      cancellationRequested: false,
      status: 'paused',
      turnNumber: 0,
      turns: [],
      experiment: { totalCompletedTurns: 0 },
    });
    expect(simulation.getSnapshot().world).toEqual(before);
  });

  it('resolves models per turn and records between-turn model changes', async () => {
    const usedModels: string[] = [];
    const usedReasoningProfiles: string[] = [];
    const provider: AgentProvider = {
      mode: 'openrouter',
      configured: true,
      async decide(_observation, model, options) {
        usedModels.push(model);
        usedReasoningProfiles.push(
          options?.reasoningProfile ?? 'provider-default',
        );
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'openrouter',
            model,
            latencyMs: 1,
            costCredits: 0,
          },
        };
      },
    };
    const simulation = service(provider);
    const [first, second] = simulation.getSnapshot().world.agents;
    await expect(simulation.executeNextTurn()).rejects.toMatchObject({
      code: 'models_unavailable',
    });
    simulation.setCompatibleModels(compatibleModels);
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[0]!.id,
      globalReasoningProfile: 'xhigh',
      overrides: [
        {
          agentId: second!.id,
          modelId: compatibleModels[1]!.id,
          reasoningProfile: 'low',
        },
      ],
    });
    expect(simulation.getSnapshot().resolvedModels.slice(0, 2)).toMatchObject([
      {
        agentId: first!.id,
        modelId: compatibleModels[0]!.id,
        reasoningProfile: 'xhigh',
        source: 'global',
      },
      {
        agentId: second!.id,
        modelId: compatibleModels[1]!.id,
        reasoningProfile: 'low',
        source: 'override',
      },
    ]);
    await simulation.executeNextTurn();
    await simulation.executeNextTurn();
    expect(usedModels).toEqual([
      compatibleModels[0]!.id,
      compatibleModels[1]!.id,
    ]);
    expect(usedReasoningProfiles).toEqual(['xhigh', 'low']);
    expect(simulation.getSnapshot().modelConfiguration.locked).toBe(false);
    expect(() =>
      simulation.updateModelConfiguration({
        globalModelId: compatibleModels[1]!.id,
        globalReasoningProfile: 'high',
        overrides: [],
      }),
    ).not.toThrow();
    await simulation.executeNextTurn();
    expect(usedModels.at(-1)).toBe(compatibleModels[1]!.id);
    const fourth = simulation.getSnapshot().world.agents[3]!;
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[1]!.id,
      globalReasoningProfile: 'high',
      overrides: [
        {
          agentId: fourth.id,
          modelId: compatibleModels[0]!.id,
          reasoningProfile: 'medium',
        },
      ],
    });
    await simulation.executeNextTurn();
    expect(usedModels.at(-1)).toBe(compatibleModels[0]!.id);
    const exported = simulation.generateExperimentExport(
      exportRequest('full-safe'),
    );
    expect(exported.configurationEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model-assignment-changed',
          scope: 'global',
          effectiveTurn: 3,
        }),
        expect.objectContaining({
          type: 'model-assignment-changed',
          scope: 'agent',
          agentId: fourth.id,
          previousModelId: compatibleModels[1]!.id,
          newModelId: compatibleModels[0]!.id,
          previousReasoningProfile: 'high',
          newReasoningProfile: 'medium',
          effectiveTurn: 4,
        }),
      ]),
    );
  });

  it('removes overrides, preserves unavailable imports, and migrates legacy exports safely', () => {
    const simulation = service({
      mode: 'openrouter',
      configured: true,
      async decide(_observation, model) {
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: { provider: 'openrouter', model, latencyMs: 1 },
        };
      },
    });
    simulation.setCompatibleModels(compatibleModels);
    const agent = simulation.getSnapshot().world.agents[0]!;
    expect(() =>
      simulation.updateModelConfiguration({
        globalModelId: compatibleModels[1]!.id,
        globalReasoningProfile: 'off',
        overrides: [],
      }),
    ).toThrow(SimulationValidationError);
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[0]!.id,
      overrides: [{ agentId: agent.id, modelId: compatibleModels[1]!.id }],
    });
    simulation.updateModelConfiguration({
      globalModelId: compatibleModels[0]!.id,
      overrides: [],
    });
    expect(simulation.getSnapshot().resolvedModels[0]).toMatchObject({
      modelId: compatibleModels[0]!.id,
      source: 'global',
    });

    const exported = simulation.generateExperimentExport(
      exportRequest('minimal'),
    );
    expect(exported.experiment.modelConfiguration).toEqual(
      simulation.getSnapshot().modelConfiguration,
    );
    const olderVersionSix = structuredClone(exported) as unknown as {
      schemaVersion: number;
      experiment: {
        modelConfiguration: {
          globalReasoningProfile?: string;
          overrides: Array<{ reasoningProfile?: string }>;
        };
      };
    };
    olderVersionSix.schemaVersion = 6;
    delete olderVersionSix.experiment.modelConfiguration.globalReasoningProfile;
    for (const override of olderVersionSix.experiment.modelConfiguration
      .overrides)
      delete override.reasoningProfile;
    const migrated = simulation.importModelConfiguration(olderVersionSix);
    expect(migrated.snapshot.modelConfiguration).toMatchObject({
      globalReasoningProfile: 'provider-default',
      overrides: [],
    });
    const unavailable = structuredClone(exported);
    unavailable.experiment.modelConfiguration!.globalModelId = 'retired/model';
    const imported = simulation.importModelConfiguration(unavailable);
    expect(imported.snapshot.resolvedModels[0]).toMatchObject({
      modelId: 'retired/model',
      available: false,
      issue: 'unavailable',
    });
    const legacy = simulation.importModelConfiguration({ schemaVersion: 5 });
    expect(legacy.legacy).toBe(true);
    expect(legacy.snapshot.modelConfiguration.globalModelId).toBeNull();
  });
});
