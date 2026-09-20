import { describe, expect, it } from 'vitest';
import {
  BrowserTestAgentProvider,
  ReflexProviderError,
  ScriptedReflexProvider,
  type AgentProvider,
  type PlannerOptions,
  type ReflexProvider,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  assignBehavior,
  type CompatibleModel,
  type SwarmPlan,
  type ZeroStrategicObservation,
  reflexDecisionSchema,
  singleTickResponseSchema,
} from '@hexzero/shared';
import { generateDeterministicRoster } from '@hexzero/world-engine';
import { createApp } from './app';
import {
  SimulationConflictError,
  SimulationService,
  SimulationTurnCancelledError,
} from './simulation-service';

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
          .map((agent, index) => ({
            id: `directive-${observation.tickNumber}-${index}`,
            agentId: agent.agentId,
            mission: 'hold',
            targetCell: agent.position,
            priority: 'normal',
            riskTolerance: 'low',
            issuedAtTick: observation.tickNumber,
            expiresAtTick: observation.tickNumber + this.directiveLifetime,
          })),
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

function setup(
  planner: SwarmPlanner,
  reflex: ReflexProvider,
  pressure = false,
  provider: AgentProvider = new BrowserTestAgentProvider(),
) {
  const simulation = new SimulationService({
    provider,
    swarmPlanner: planner,
    reflexProvider: reflex,
    now: () => '2026-08-13T12:00:00.000Z',
  });
  simulation.setCompatibleModels([model]);
  const request = simulation.getDefaultWorldSetup();
  simulation.applyWorldSetup({
    ...request,
    cognitionMode: 'zero-swarm-v1',
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
      cognitionMode: 'zero-swarm-v1',
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
      behaviorConfiguration: {
        ...request.behaviorConfiguration,
        assignments: assignBehavior(
          roster.map(({ id }) => id),
          request.behaviorConfiguration.seed,
          'balanced-random',
        ),
      },
    });

    await expect(simulation.executeNextTick()).resolves.toEqual([]);
    const snapshot = simulation.getSnapshot();
    expect(snapshot.status).toBe('infection-eliminated');
    expect(snapshot.tickNumber).toBe(1);
    expect(snapshot.resolutionOrder).toEqual([]);
    expect(snapshot.nextAgentId).toBeNull();
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
      communications: { channel: 'all', status: 'all' },
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
      cognitionMode: 'zero-swarm-v1',
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
      behaviorConfiguration: {
        ...request.behaviorConfiguration,
        assignments: assignBehavior(
          roster.map(({ id }) => id),
          request.behaviorConfiguration.seed,
          'balanced-random',
        ),
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
      cognitionMode: 'zero-swarm-v1',
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
      behaviorConfiguration: {
        ...request.behaviorConfiguration,
        assignments: assignBehavior(
          roster.map(({ id }) => id),
          request.behaviorConfiguration.seed,
          'balanced-random',
        ),
      },
    });

    await simulation.executeNextTick();
    await simulation.executeNextTick();
    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      communications: { channel: 'all', status: 'all' },
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

  it('reports swarm providers without requiring the unused legacy provider', () => {
    const legacy: AgentProvider = {
      mode: 'openrouter',
      configured: false,
      async decide() {
        throw new Error('Legacy provider must not run in zero-swarm mode.');
      },
    };
    const simulation = setup(
      new InspectingPlanner(),
      new ScriptedReflexProvider([{ chosenCandidateId: 'action_0' }]),
      false,
      legacy,
    );
    const snapshot = simulation.getSnapshot();
    expect(snapshot.providerConfigured).toBe(false);
    expect(snapshot.status).toBe('paused');
    expect(snapshot.swarmProviderStatus).toMatchObject({
      plannerConfigured: true,
      reflexConfigured: true,
    });
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
    expect(tick.records).toEqual([]);
    expect(tick.swarmTick?.tickNumber).toBe(1);
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
    await expect(simulation.executeNextTick()).resolves.toEqual([]);
    const snapshot = simulation.getSnapshot();
    expect(snapshot.tickNumber).toBe(1);
    expect(snapshot.turnNumber).toBe(0);
    expect(snapshot.turns).toEqual([]);
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
      communications: { channel: 'all', status: 'all' },
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
});
