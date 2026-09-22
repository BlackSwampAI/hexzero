import { gridDistance } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  ReflexProviderError,
  ScriptedReflexProvider,
  type PlannerOptions,
  type ReflexProvider,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  h3CellSchema,
  type CompatibleModel,
  type SwarmPlan,
  type ZeroStrategicObservation,
  reflexDecisionSchema,
  swarmPlanSchema,
  singleTickResponseSchema,
} from '@hexzero/shared';
import { generateDeterministicRoster } from '@hexzero/world-engine';
import { createApp } from './app';
import {
  SimulationConflictError,
  SimulationService,
  SimulationTurnCancelledError,
  replanThresholdForPressure,
} from './simulation-service';
import { geographicDirectionBetweenCells } from './geographic-direction';

const model = {
  id: 'test/zero',
  name: 'Zero',
  author: 'test',
  contextLength: 4_096,
  inputPricePerToken: '0',
  outputPricePerToken: '0',
  supportedParameters: [],
  isFree: true,
  reasoning: { mandatory: false, supportedEfforts: ['low'] },
} as CompatibleModel;

class InspectingPlanner implements SwarmPlanner {
  readonly mode = 'scripted-swarm-test' as const;
  readonly configured = true;
  readonly observations: ZeroStrategicObservation[] = [];
  constructor(
    private readonly failure: boolean | number = false,
    private readonly directiveLifetime = 5,
    private readonly targetDistance = 0,
  ) {}
  async plan(
    observation: ZeroStrategicObservation,
    _model: string,
    options: PlannerOptions = {},
  ): Promise<{
    plan: SwarmPlan;
    metadata: { provider: 'scripted-test'; model: string; latencyMs: number };
  }> {
    this.observations.push(structuredClone(observation));
    const finalize = options.beginAttempt?.('initial');
    if (this.failure === true || this.failure === observation.tickNumber) {
      finalize?.({
        outcome: 'provider-error',
        failure: {
          code: 'provider-http',
          message: 'planner unavailable',
          retryable: true,
        },
      });
      throw new Error('planner unavailable');
    }
    const result = {
      plan: {
        strategySummary: 'Hold the local perimeter.',
        zeroActionCandidateId: observation.legalZeroActions.find(
          ({ action }) => action.type === 'wait',
        )!.id,
        directives: observation.agents
          .filter(({ agentId }) => agentId !== observation.zeroAgentId)
          .map((agent, index) => {
            const targetCell =
              this.targetDistance === 0
                ? agent.position
                : observation.strategicTargetCells.find(
                    (cell) =>
                      cell !== agent.position &&
                      gridDistance(cell, agent.position) ===
                        this.targetDistance,
                  );
            if (!targetCell)
              throw new Error(
                `No strategic target is ${this.targetDistance} cells from ${agent.agentId}.`,
              );
            return {
              id: `directive-${observation.tickNumber}-${index}`,
              agentId: agent.agentId,
              mission: 'hold',
              targetCell,
              priority: 'normal',
              riskTolerance: 'low',
              issuedAtTick: observation.tickNumber,
              expiresAtTick: observation.tickNumber + this.directiveLifetime,
            };
          }),
      },
      metadata: { provider: 'scripted-test', model: 'test/zero', latencyMs: 0 },
    } satisfies Awaited<ReturnType<SwarmPlanner['plan']>>;
    finalize?.({
      outcome: 'completed',
      provider: result.metadata,
      swarmPlan: result.plan,
    });
    return result;
  }
}

class LifecyclePlanner implements SwarmPlanner {
  readonly mode = 'scripted-swarm-test' as const;
  readonly configured = true;
  readonly observations: ZeroStrategicObservation[] = [];
  private relocatingAgentId: string | null = null;
  constructor(private readonly mission: 'expand' | 'hold' | 'relocate') {}
  async plan(
    observation: ZeroStrategicObservation,
    _model: string,
    options: PlannerOptions = {},
  ) {
    this.observations.push(structuredClone(observation));
    const workers = observation.agents.filter(
      ({ agentId }) => agentId !== observation.zeroAgentId,
    );
    if (this.mission === 'relocate' && observation.tickNumber === 1) {
      this.relocatingAgentId =
        workers.find((agent) =>
          observation.strategicTargetCells.some(
            (cell) =>
              gridDistance(agent.position, cell) === 1 &&
              !observation.agents.some(({ position }) => position === cell),
          ),
        )?.agentId ?? null;
      if (!this.relocatingAgentId)
        throw new Error('No worker has an adjacent relocate target.');
    }
    const zeroActionCandidateId = observation.legalZeroActions.find(
      ({ action }) => action.type === 'wait',
    )!.id;
    const plan: SwarmPlan = {
      strategySummary: 'Lifecycle fixture.',
      zeroActionCandidateId,
      directives: workers.map((agent, index) => {
        const mission =
          this.mission === 'relocate'
            ? agent.agentId === this.relocatingAgentId &&
              observation.tickNumber === 1
              ? 'relocate'
              : 'hold'
            : this.mission;
        const targetCell =
          mission === 'relocate'
            ? observation.strategicTargetCells.find(
                (cell) =>
                  gridDistance(agent.position, cell) === 1 &&
                  !observation.agents.some(({ position }) => position === cell),
              )
            : agent.position;
        if (!targetCell) throw new Error('No adjacent relocate target.');
        return {
          id: `lifecycle-${observation.tickNumber}-${index}`,
          agentId: agent.agentId,
          mission,
          targetCell,
          priority: 'normal',
          riskTolerance: 'low',
          issuedAtTick: observation.tickNumber,
          expiresAtTick: observation.tickNumber + 4,
        };
      }),
    };
    const metadata = {
      provider: 'scripted-test' as const,
      model: 'test/zero',
      latencyMs: 0,
    };
    options.beginAttempt?.('initial')?.({
      outcome: 'completed',
      provider: metadata,
      swarmPlan: plan,
    });
    return { plan, metadata };
  }
}

function lifecycleReflex(): ReflexProvider {
  return {
    mode: 'scripted-reflex-test',
    model: 'test-reflex',
    configured: true,
    async decide(observation, options) {
      const choice = observation.candidates.find(({ description }) =>
        observation.directive.mission === 'relocate'
          ? description.includes('This advances toward the assigned target.')
          : description.startsWith('Remain on the current cell'),
      )!;
      const decision = reflexDecisionSchema.parse({
        chosenCandidateId: choice.id,
        confidence: 1,
        probabilities: Object.fromEntries(
          observation.candidates.map(({ id }) => [
            id,
            id === choice.id ? 1 : 0,
          ]),
        ),
        model: 'test-reflex',
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        directiveId: observation.directive.id,
        cognitionSource: 'jev-reflex',
      });
      options?.beginAttempt?.('initial')?.({
        outcome: 'completed',
        reflexDecision: decision,
      });
      return decision;
    },
  };
}

function setup(
  planner: SwarmPlanner,
  reflex: ReflexProvider,
  pressure = false,
) {
  const simulation = new SimulationService({
    swarmPlanner: planner,
    reflexProvider: reflex,
    now: () => '2026-08-13T12:00:00.000Z',
  });
  simulation.setCompatibleModels([model]);
  const request = simulation.getDefaultWorldSetup();
  simulation.applyWorldSetup({
    ...request,
    ...(pressure
      ? {
          objectiveVersion: 'durable-influence-v3' as const,
          capabilities: {
            ...request.capabilities,
            simulatedPlayerPressure: true,
          },
          simulatedPlayer: {
            enabled: true,
            profile: 'casual-cleaner' as const,
            seed: 'swarm-export-pressure',
          },
        }
      : {}),
    modelConfiguration: {
      globalModelId: model.id,
      globalReasoningProfile: 'low',
      overrides: [],
      locked: false,
    },
  });
  return simulation;
}

describe('zero-swarm SimulationService tick', () => {
  it('uses conservative and elevated-pressure worker replan thresholds', () => {
    expect(0.6 >= replanThresholdForPressure('high')).toBe(true);
    expect(0.6 >= replanThresholdForPressure('rising')).toBe(true);
    expect(0.6 >= replanThresholdForPressure('low')).toBe(false);
    expect(0.79 >= replanThresholdForPressure('low')).toBe(false);
    expect(0.8 >= replanThresholdForPressure('low')).toBe(true);
  });

  it('escalates a real current-tick trail-hunter disinfection into the next Zero replan', async () => {
    const workerCell = h3CellSchema.parse('892a94d2e73ffff');
    const safeMoveCell = h3CellSchema.parse('892a94d2e47ffff');
    const safeMoveDirection = geographicDirectionBetweenCells(
      workerCell,
      safeMoveCell,
    );
    const moveToHunterDirection = geographicDirectionBetweenCells(
      safeMoveCell,
      workerCell,
    );
    const observations: ZeroStrategicObservation[] = [];
    const planner: SwarmPlanner = {
      mode: 'scripted-swarm-test',
      configured: true,
      async plan(observation, _model, options = {}) {
        observations.push(structuredClone(observation));
        const plan = {
          strategySummary: 'Follow assigned positions.',
          zeroActionCandidateId: observation.legalZeroActions.find(
            ({ action }) => action.type === 'wait',
          )!.id,
          directives: observation.agents
            .filter(({ agentId }) => agentId !== observation.zeroAgentId)
            .map((agent) => ({
              id: `pressure-${observation.tickNumber}-${agent.agentId}`,
              agentId: agent.agentId,
              mission: 'hold' as const,
              targetCell: agent.position,
              priority: 'normal' as const,
              riskTolerance: 'medium' as const,
              issuedAtTick: observation.tickNumber,
              expiresAtTick: observation.tickNumber + 5,
            })),
        };
        swarmPlanSchema.parse(plan);
        options.beginAttempt?.('initial')?.({
          outcome: 'completed',
          provider: {
            provider: 'scripted-test',
            model: 'test/zero',
            latencyMs: 0,
          },
          swarmPlan: plan,
        });
        return {
          plan,
          metadata: {
            provider: 'scripted-test',
            model: 'test/zero',
            latencyMs: 0,
          },
        };
      },
    };
    let reflexCalls = 0;
    const reflex: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        const choice =
          reflexCalls === 0
            ? observation.candidates.find(({ description }) =>
                description.startsWith('Infect'),
              )!
            : reflexCalls === 1
              ? observation.candidates.find(({ description }) =>
                  description.startsWith(`Move ${safeMoveDirection} `),
                )!
              : reflexCalls === 3
                ? observation.candidates.find(({ description }) =>
                    description.startsWith(`Move ${moveToHunterDirection} `),
                  )!
                : observation.candidates.find(({ description }) =>
                    description.startsWith('Remain'),
                  )!;
        reflexCalls += 1;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          replanProbability: 0.6,
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          reflexDecision: decision,
        });
        return decision;
      },
    };
    const simulation = new SimulationService({
      swarmPlanner: planner,
      reflexProvider: reflex,
      now: () => '2026-08-13T12:00:00.000Z',
    });
    simulation.setCompatibleModels([model]);
    const request = simulation.getDefaultWorldSetup();
    const roster = request.roster.slice(0, 2);
    simulation.applyWorldSetup({
      ...request,
      roster,
      patientZeroAgentId: roster[0]!.id,
      spawnSeed: 'pressure-spawn-0',
      objectiveVersion: 'durable-influence-v3',
      capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
      simulatedPlayer: {
        enabled: true,
        profile: 'trail-hunter-v1',
        seed: 'pressure-hunter-17',
      },
      modelConfiguration: {
        globalModelId: model.id,
        globalReasoningProfile: 'low',
        overrides: [],
        locked: false,
      },
    });

    await simulation.executeNextTick();
    await simulation.executeNextTick();
    await simulation.executeNextTick();
    const firstTwo = simulation.getSnapshot().swarmTicks?.slice(0, 2) ?? [];
    expect(firstTwo).toHaveLength(2);
    expect(
      firstTwo.every(
        (tick) =>
          tick.workers[0]?.situation?.nearbyPressure === 'low' &&
          tick.workers[0]?.reflexDecision?.replanProbability === 0.6 &&
          tick.signals === undefined,
      ),
    ).toBe(true);
    const third = simulation.getSnapshot().swarmTicks?.[2];
    expect(third).toBeDefined();
    expect(reflexCalls).toBe(3);
    expect(third?.workers[0]?.situation?.nearbyPressure).toBe('high');
    expect(third?.workers[0]?.reflexDecision?.replanProbability).toBe(0.6);
    expect(third?.signals).toEqual([
      expect.objectContaining({
        type: 'worker-replan-requested',
        probability: 0.6,
      }),
    ]);
    const zeroAtDisinfection = observations.find(
      ({ tickNumber }) => tickNumber === 3,
    );
    expect(
      zeroAtDisinfection?.agents.find(
        ({ agentId }) => agentId === roster[1]!.id,
      ),
    ).toMatchObject({
      localPressure: 'high',
      pressureDistance: 'adjacent',
      pressureDirection: geographicDirectionBetweenCells(
        safeMoveCell,
        workerCell,
      ),
    });
    await simulation.executeNextTick();
    expect(simulation.getSnapshot().swarmTicks?.[3]?.replanReasons).toContain(
      'worker-request',
    );
    expect(
      observations.find(({ tickNumber }) => tickNumber === 4)?.replanReasons,
    ).toContain('worker-request');
    await simulation.executeNextTick();
    const afterCapture = observations.find(
      ({ tickNumber }) => tickNumber === 5,
    )!;
    expect(afterCapture.agents.map(({ agentId }) => agentId)).toEqual([
      roster[0]!.id,
    ]);
    expect(afterCapture.replanReasons).toContain('roster-changed');
    expect(afterCapture.replanReasons).not.toContain('worker-request');
    expect(afterCapture.workerReplanRequests).toBeUndefined();
    expect(afterCapture.recentCaptures).toEqual([
      expect.objectContaining({ capturedAgentId: roster[1]!.id }),
    ]);
  });

  it('commits a player-only terminal tick when trail hunter captures Patient Zero', async () => {
    const planner = new InspectingPlanner();
    const simulation = setup(
      planner,
      new ScriptedReflexProvider([{ chosenCandidateId: 'action_0' }]),
    );
    const request = simulation.getDefaultWorldSetup();
    const roster = generateDeterministicRoster(1, 'terminal-roster');
    simulation.applyWorldSetup({
      ...request,
      roster,
      patientZeroAgentId: roster[0]!.id,
      spawnSeed: 'terminal-spawn',
      objectiveVersion: 'durable-influence-v3',
      capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
      simulatedPlayer: {
        enabled: true,
        profile: 'trail-hunter-v1',
        seed: 'terminal-spawn',
      },
      modelConfiguration: {
        globalModelId: model.id,
        globalReasoningProfile: 'low',
        overrides: [],
        locked: false,
      },
    });

    await expect(simulation.executeNextTick()).resolves.toBeNull();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.status).toBe('infection-eliminated');
    expect(snapshot.tickNumber).toBe(1);
    expect(snapshot.resolutionOrder).toEqual([]);
    expect(snapshot.world.agents).toEqual([]);
    expect(snapshot.world.events).toContainEqual(
      expect.objectContaining({ type: 'simulated-player-agent-captured' }),
    );
    expect(snapshot.experiment.attemptAccounting.attemptsStarted).toBe(0);
    expect(planner.observations).toEqual([]);
    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    expect(exported.selection.selectedAgentIds).toEqual([roster[0]!.id]);
    expect(exported.agents).toEqual([
      expect.objectContaining({ id: roster[0]!.id }),
    ]);
    expect(exported.worldEvents).toContainEqual(
      expect.objectContaining({
        type: 'simulated-player-agent-captured',
        capturedAgentId: roster[0]!.id,
      }),
    );
    await expect(simulation.executeNextTick()).rejects.toBeInstanceOf(
      SimulationConflictError,
    );
  });

  it('removes a captured worker before Zero plans or any worker reflex runs', async () => {
    const planner = new InspectingPlanner();
    const simulation = setup(
      planner,
      new ScriptedReflexProvider([{ chosenCandidateId: 'action_0' }]),
    );
    const request = simulation.getDefaultWorldSetup();
    const roster = generateDeterministicRoster(2, 'worker-capture-roster');
    simulation.applyWorldSetup({
      ...request,
      roster,
      patientZeroAgentId: roster[1]!.id,
      spawnSeed: 'worker-capture-spawn',
      objectiveVersion: 'durable-influence-v3',
      capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
      simulatedPlayer: {
        enabled: true,
        profile: 'trail-hunter-v1',
        seed: 'worker-capture-spawn',
      },
      modelConfiguration: {
        globalModelId: model.id,
        globalReasoningProfile: 'low',
        overrides: [],
        locked: false,
      },
    });

    await simulation.executeNextTick();
    const snapshot = simulation.getSnapshot();
    expect(snapshot.status).toBe('paused');
    expect(snapshot.world.agents.map(({ id }) => id)).toEqual([roster[1]!.id]);
    expect(snapshot.swarmTicks?.[0]?.workers).toEqual([]);
    expect(
      planner.observations[0]?.agents.map(({ agentId }) => agentId),
    ).toEqual([roster[1]!.id]);
    expect(planner.observations[0]?.recentPlayerPressure).toEqual(
      expect.arrayContaining([expect.stringContaining(roster[0]!.id)]),
    );
    expect(planner.observations[0]?.recentCaptures).toEqual([
      expect.objectContaining({ capturedAgentId: roster[0]!.id }),
    ]);
    expect(snapshot.experiment.attemptAccounting.attemptsStarted).toBe(1);
  });

  it('keeps provider attempt turn numbers unique after a worker capture', async () => {
    const simulation = setup(
      new InspectingPlanner(),
      new ScriptedReflexProvider(
        Array.from({ length: 2 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    const request = simulation.getDefaultWorldSetup();
    const roster = generateDeterministicRoster(3, 'attempt-capture-roster');
    simulation.applyWorldSetup({
      ...request,
      roster,
      patientZeroAgentId: roster[1]!.id,
      spawnSeed: 'attempt-capture-spawn',
      objectiveVersion: 'durable-influence-v3',
      capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
      simulatedPlayer: {
        enabled: true,
        profile: 'trail-hunter-v1',
        seed: 'attempt-capture-spawn',
      },
      modelConfiguration: {
        globalModelId: model.id,
        globalReasoningProfile: 'low',
        overrides: [],
        locked: false,
      },
    });

    await simulation.executeNextTick();
    await simulation.executeNextTick();
    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    const attempts = exported.providerAttempts ?? [];
    const intendedTurns = attempts.map(
      ({ intendedTurnNumber }) => intendedTurnNumber,
    );
    expect(new Set(intendedTurns).size).toBe(intendedTurns.length);
    expect(attempts.map(({ agentId }) => agentId)).not.toContain(roster[0]!.id);
  });

  it('returns a schema-valid swarm tick through the API without legacy turn records', async () => {
    const simulation = setup(
      new InspectingPlanner(),
      new ScriptedReflexProvider(
        Array.from({ length: 7 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    const response = await createApp({ service: simulation }).request(
      '/api/simulation/tick',
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const tick = singleTickResponseSchema.parse(await response.json());
    expect(tick.swarmTick?.tickNumber).toBe(1);
  });

  it('reports live experiment metrics equal to an all-agents entire-retained export', async () => {
    const simulation = setup(
      new InspectingPlanner(),
      new ScriptedReflexProvider(
        Array.from({ length: 21 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );

    await simulation.executeNextTick();
    await simulation.executeNextTick();
    await simulation.executeNextTick();

    const snapshot = simulation.getSnapshot();
    const resolvedActionCount = (snapshot.swarmTicks ?? []).reduce(
      (count, tick) =>
        count +
        (tick.zeroAction && tick.zeroActionResult ? 1 : 0) +
        tick.workers.filter(
          ({ action, actionResult }) => action && actionResult,
        ).length,
      0,
    );
    expect(resolvedActionCount).toBeGreaterThan(0);
    expect(snapshot.experiment.metrics.aggregate.totalTurns).toBe(
      resolvedActionCount,
    );

    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: [
        'accepted',
        'rejected',
        'lost-tick',
        'provider-error',
        'operator-skipped',
      ],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    expect(snapshot.experiment.metrics).toEqual(exported.metrics);
  });

  it('freezes player-advanced facts for Zero, uses only reflex choices, and resolves physical actions in engine order', async () => {
    const planner = new InspectingPlanner();
    const simulation = setup(
      planner,
      new ScriptedReflexProvider(
        Array.from({ length: 7 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    const startingCells = new Map(
      simulation
        .getSnapshot()
        .world.agents.map(({ id, currentCell }) => [id, currentCell]),
    );
    await expect(simulation.executeNextTick()).resolves.toMatchObject({
      tickNumber: 1,
    });
    const snapshot = simulation.getSnapshot();
    expect(snapshot.tickNumber).toBe(1);
    expect(snapshot.swarmTicks).toHaveLength(1);
    expect(snapshot.swarmProviderStatus).toMatchObject({
      plannerMode: 'scripted-swarm-test',
      plannerConfigured: true,
      reflexMode: 'scripted-reflex-test',
      reflexConfigured: true,
    });
    expect(snapshot.swarmTicks?.[0]?.workers).toHaveLength(7);
    expect(snapshot.swarmTicks?.[0]?.workers[0]?.situation).toMatchObject({
      directiveProgress: expect.any(String),
      nearbyPressure: expect.any(String),
    });
    expect(
      snapshot.swarmTicks?.[0]?.workers.every(
        ({ source }) => source === 'jev-reflex',
      ),
    ).toBe(true);
    expect(
      snapshot.swarmTicks?.[0]?.workers.some(
        ({ agentId, action, actionResult }) =>
          action?.type === 'move' &&
          actionResult?.accepted === true &&
          snapshot.world.agents.find(({ id }) => id === agentId)
            ?.currentCell !== startingCells.get(agentId),
      ),
    ).toBe(true);
    expect(planner.observations[0]?.tickNumber).toBe(1);
    expect(planner.observations[0]?.cells).toEqual(expect.any(Array));
    expect(snapshot.resolutionOrder).toHaveLength(8);
    expect(snapshot.experiment.attemptAccounting.attemptsStarted).toBe(8);
  });

  it('uses one billed Zero attempt and deterministic legal expansion when the first plan fails', async () => {
    const simulation = setup(
      new InspectingPlanner(true),
      new ScriptedReflexProvider(
        Array.from({ length: 7 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    await simulation.executeNextTick();
    const tick = simulation.getSnapshot().swarmTicks?.[0];
    expect(tick?.planSource).toBe('deterministic-fallback');
    expect(tick?.zeroAction).toEqual({ type: 'wait' });
    expect(
      tick?.workers.every(
        ({ directive, source }) =>
          directive.mission === 'expand' && source === 'deterministic-fallback',
      ),
    ).toBe(true);
    expect(
      tick?.workers.some(
        ({ action, actionResult }) =>
          action?.type === 'infect' && actionResult?.accepted === true,
      ),
    ).toBe(true);
    expect(tick?.signals).toBeUndefined();
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(1);
  });

  it('reuses unexpired directives for four ticks, then replans on the fifth tick', async () => {
    const simulation = setup(
      new InspectingPlanner(6),
      new ScriptedReflexProvider(
        Array.from({ length: 42 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    await simulation.executeNextTick();
    const first = simulation.getSnapshot().swarmTicks?.[0];
    for (let tick = 0; tick < 4; tick += 1) await simulation.executeNextTick();
    const reused = simulation.getSnapshot().swarmTicks?.slice(1);
    expect(
      reused?.every(({ planSource }) => planSource === 'directive-reuse'),
    ).toBe(true);
    expect(reused?.map(({ plan }) => plan.directives)).toEqual(
      Array.from({ length: 4 }, () => first?.plan.directives),
    );
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(36);
    await simulation.executeNextTick();
    const sixth = simulation.getSnapshot().swarmTicks?.[5];
    expect(sixth?.planSource).toBe('deterministic-fallback');
    expect(sixth?.replanReasons).toContain('periodic-review');
    expect(sixth?.zeroAction).toEqual({ type: 'wait' });
  });

  it('wakes Zero for a worker replan request and only admits worker attempts on reuse', async () => {
    const planner = new InspectingPlanner();
    const simulation = setup(
      planner,
      new ScriptedReflexProvider(
        Array.from({ length: 21 }, () => ({
          chosenCandidateId: 'action_0',
          replanProbability: 0.8,
        })),
      ),
    );
    await simulation.executeNextTick();
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(8);
    await simulation.executeNextTick();
    const second = simulation.getSnapshot().swarmTicks?.[1];
    expect(second?.replanReasons).toContain('worker-request');
    expect(second?.planSource).toBe('zero-llm');
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(16);
    expect(planner.observations).toHaveLength(2);

    const reuseSimulation = setup(
      new InspectingPlanner(),
      new ScriptedReflexProvider(
        Array.from({ length: 14 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    await reuseSimulation.executeNextTick();
    await reuseSimulation.executeNextTick();
    expect(reuseSimulation.getSnapshot().swarmTicks?.[1]?.planSource).toBe(
      'directive-reuse',
    );
    expect(
      reuseSimulation.getSnapshot().experiment.attemptAccounting
        .attemptsStarted,
    ).toBe(15);
  });

  it('wakes Zero when retained directives expire', async () => {
    const planner = new InspectingPlanner(false, 1);
    const simulation = setup(
      planner,
      new ScriptedReflexProvider(
        Array.from({ length: 21 }, () => ({ chosenCandidateId: 'action_0' })),
      ),
    );
    await simulation.executeNextTick();
    await simulation.executeNextTick();
    await simulation.executeNextTick();
    const third = simulation.getSnapshot().swarmTicks?.[2];
    expect(third?.replanReasons).toContain('directive-expired');
    expect(third?.planSource).toBe('zero-llm');
    expect(planner.observations).toHaveLength(2);
  });

  it('reports workers who wait on their targets as at-target to Zero', async () => {
    const planner = new InspectingPlanner(false, 1);
    const waitingReflex: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        const choice = observation.candidates.find(({ description }) =>
          description.startsWith('Remain on the current cell'),
        )!;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          reflexDecision: decision,
        });
        return decision;
      },
    };
    const simulation = setup(planner, waitingReflex);

    await simulation.executeNextTick();
    await simulation.executeNextTick();
    await simulation.executeNextTick();

    expect(
      simulation
        .getSnapshot()
        .swarmTicks?.[1]?.workers.every(
          ({ action, actionResult }) =>
            action?.type === 'wait' && actionResult?.accepted === true,
        ),
    ).toBe(true);
    const workerObservations = planner.observations[1]?.agents.filter(
      ({ agentId }) => agentId !== planner.observations[1]?.zeroAgentId,
    );
    expect(workerObservations).toHaveLength(7);
    expect(workerObservations?.map(({ workerStatus }) => workerStatus)).toEqual(
      Array.from({ length: 7 }, () => 'at-target'),
    );
  });

  it('reports accepted moves toward a target as advancing to Zero', async () => {
    const planner = new InspectingPlanner(false, 5, 2);
    const advancingReflex: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        const choice = observation.candidates.find(({ description }) =>
          description.includes('This advances toward the assigned target.'),
        )!;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          replanProbability: 0.8,
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          reflexDecision: decision,
        });
        return decision;
      },
    };
    const simulation = setup(planner, advancingReflex);

    await simulation.executeNextTick();
    await simulation.executeNextTick();

    expect(
      simulation
        .getSnapshot()
        .swarmTicks?.[0]?.workers.every(
          ({ action, actionResult }) =>
            action?.type === 'move' && actionResult?.accepted === true,
        ),
    ).toBe(true);
    const workerObservations = planner.observations[1]?.agents.filter(
      ({ agentId }) => agentId !== planner.observations[1]?.zeroAgentId,
    );
    expect(workerObservations?.map(({ workerStatus }) => workerStatus)).toEqual(
      Array.from({ length: 7 }, () => 'advancing'),
    );
  });

  it('releases reuse-tick reservations when a worker request is cancelled', async () => {
    let calls = 0;
    const reflex: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        calls += 1;
        const finalize = options?.beginAttempt?.('initial');
        if (calls > 7)
          return await new Promise<never>((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => {
                finalize?.({
                  outcome: 'cancelled',
                  failure: {
                    code: 'cancelled',
                    message: 'cancelled',
                    retryable: false,
                  },
                });
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          });
        const choice = observation.candidates[0]!;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        finalize?.({ outcome: 'completed', reflexDecision: decision });
        return decision;
      },
    };
    const simulation = setup(new InspectingPlanner(), reflex);
    await simulation.executeNextTick();
    const execution = simulation.executeNextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    simulation.cancelCurrentRequest();
    await expect(execution).rejects.toBeInstanceOf(
      SimulationTurnCancelledError,
    );
    expect(simulation.getSnapshot().tickNumber).toBe(1);
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(9);
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsInFlight,
    ).toBe(0);
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.reservedPermits,
    ).toBe(0);
  });

  it('exports simulated-player events under swarm tick selection', async () => {
    const reflex: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        const choice =
          observation.candidates.find(({ description }) =>
            description.startsWith('Infect the current open cell'),
          ) ??
          observation.candidates.find(({ description }) =>
            description.startsWith('Remain on the current cell'),
          )!;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          provider: {
            provider: 'scripted-test',
            model: 'test-reflex',
            latencyMs: 0,
            costCredits: 0,
          },
          reflexDecision: decision,
        });
        return decision;
      },
    };
    const simulation = setup(new InspectingPlanner(), reflex, true);
    for (let tick = 0; tick < 12; tick += 1) await simulation.executeNextTick();
    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    expect(exported.swarmTicks).toHaveLength(12);
    expect(exported.selection.matchingTickCount).toBe(12);
    expect(
      exported.selection.matchingSimulatedPlayerEventCount,
    ).toBeGreaterThan(0);
    expect(
      exported.worldEvents?.filter(
        (event) =>
          event.type === 'simulated-player-moved' ||
          event.type === 'hex-disinfected' ||
          event.type === 'simulated-player-clean-blocked',
      ),
    ).toHaveLength(exported.selection.matchingSimulatedPlayerEventCount);
  });

  it('falls back to wait for one failed Jev request without losing the tick', async () => {
    const failing: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(_observation, options) {
        const failure = {
          code: 'provider-http' as const,
          message: 'down',
          retryable: true,
        };
        options?.beginAttempt?.('initial')?.({
          outcome: 'provider-error',
          failure,
        });
        throw new ReflexProviderError(failure);
      },
    };
    const simulation = setup(new InspectingPlanner(), failing);
    await simulation.executeNextTick();
    const workers = simulation.getSnapshot().swarmTicks?.[0]?.workers ?? [];
    expect(
      workers.every(
        ({ source, action }) =>
          source === 'deterministic-fallback' && action?.type === 'wait',
      ),
    ).toBe(true);
    expect(simulation.getSnapshot().swarmTicks?.[0]?.signals).toBeUndefined();
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(8);
  });

  it('cancels without committing the candidate world while retaining the started planner attempt', async () => {
    let abort: (() => void) | undefined;
    const planner: SwarmPlanner = {
      mode: 'scripted-swarm-test',
      configured: true,
      async plan(_observation, _model, options) {
        const finalize = options?.beginAttempt?.('initial');
        return await new Promise((_, reject) => {
          abort = () => {
            finalize?.({
              outcome: 'cancelled',
              failure: {
                code: 'cancelled',
                message: 'cancelled',
                retryable: false,
              },
            });
            reject(new Error('aborted'));
          };
          options?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    };
    const simulation = setup(
      planner,
      new ScriptedReflexProvider([{ chosenCandidateId: 'action_0' }]),
    );
    const execution = simulation.executeNextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    simulation.cancelCurrentRequest();
    abort?.();
    await expect(execution).rejects.toBeInstanceOf(
      SimulationTurnCancelledError,
    );
    expect(simulation.getSnapshot().tickNumber).toBe(0);
    expect(simulation.getSnapshot().swarmTicks).toEqual([]);
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(1);
  });

  it('replans after relocate completion and identifies completed directives to Zero', async () => {
    const planner = new LifecyclePlanner('relocate');
    const simulation = setup(planner, lifecycleReflex());
    await simulation.executeNextTick();
    const first = simulation.getSnapshot().swarmTicks?.[0];
    const relocating = first?.workers.find(
      ({ directive }) => directive.mission === 'relocate',
    );
    expect(relocating?.action?.type).toBe('move');
    await simulation.executeNextTick();
    const second = simulation.getSnapshot().swarmTicks?.[1];
    expect(second?.replanReasons).toContain('directive-complete');
    expect(second?.planSource).toBe('zero-llm');
    expect(planner.observations).toHaveLength(2);
    expect(planner.observations[1]?.completedDirectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: relocating?.agentId,
          directiveId: relocating?.directive.id,
        }),
      ]),
    );
  });

  it('completes expand only after its target becomes worker-controlled', async () => {
    const planner = new LifecyclePlanner('expand');
    const infecting: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test-reflex',
      configured: true,
      async decide(observation, options) {
        const choice = observation.candidates.find(({ description }) =>
          description.startsWith('Infect the current open cell'),
        )!;
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: choice.id,
          confidence: 1,
          probabilities: Object.fromEntries(
            observation.candidates.map(({ id }) => [
              id,
              id === choice.id ? 1 : 0,
            ]),
          ),
          model: 'test-reflex',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          reflexDecision: decision,
        });
        return decision;
      },
    };
    const simulation = setup(planner, infecting);
    await simulation.executeNextTick();
    expect(planner.observations).toHaveLength(1);
    expect(
      simulation
        .getSnapshot()
        .swarmTicks?.[0]?.workers.every(
          ({ actionResult }) => actionResult?.accepted,
        ),
    ).toBe(true);
    await simulation.executeNextTick();
    const second = simulation.getSnapshot().swarmTicks?.[1];
    expect(second?.replanReasons).toContain('directive-complete');
    expect(second?.planSource).toBe('deterministic-fallback');
    expect(second?.plannerFailure?.code).toBe('invalid-decision');
    expect(
      simulation.getSnapshot().experiment.attemptAccounting.attemptsStarted,
    ).toBe(9);
  });

  it('does not complete a hold directive merely because its worker waits at target', async () => {
    const planner = new LifecyclePlanner('hold');
    const simulation = setup(planner, lifecycleReflex());
    await simulation.executeNextTick();
    await simulation.executeNextTick();
    expect(simulation.getSnapshot().swarmTicks?.[1]?.planSource).toBe(
      'directive-reuse',
    );
    expect(planner.observations).toHaveLength(1);
  });
});
