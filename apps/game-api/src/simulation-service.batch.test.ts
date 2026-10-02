import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeterministicSwarmPlanner,
  DeterministicReflexProvider,
  type ReflexProvider,
  type ReflexDecisionOptions,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import { type ReflexDecision, type ReflexObservation } from '@hexzero/shared';
import { generateDeterministicRoster } from '@hexzero/world-engine';
import {
  SimulationService,
  SimulationTurnCancelledError,
} from './simulation-service';

function decisionFor(observation: ReflexObservation): ReflexDecision {
  const chosen =
    observation.candidates.find(({ description }) =>
      description.startsWith('Infect'),
    ) ?? observation.candidates[0]!;
  return {
    chosenCandidateId: chosen.id,
    confidence: 1,
    probabilities: Object.fromEntries(
      observation.candidates.map(({ id }) => [id, Number(id === chosen.id)]),
    ),
    model: 'controlled-reflex',
    latencyMs: 0,
    directiveId: observation.directive.id,
    cognitionSource: 'jev-reflex',
  };
}

class ControlledReflex implements ReflexProvider {
  readonly mode = 'scripted-reflex-test' as const;
  readonly model = 'controlled-reflex';
  readonly configured = true;
  readonly calls: { observation: ReflexObservation; finish: () => void }[] = [];
  async decide(
    observation: ReflexObservation,
    options: ReflexDecisionOptions = {},
  ) {
    const finalize = options.beginAttempt?.('initial');
    if (finalize === null) throw new Error('Attempt denied');
    return await new Promise<ReflexDecision>((resolve) => {
      this.calls.push({
        observation,
        finish: () => {
          const decision = decisionFor(observation);
          finalize?.({ outcome: 'completed', reflexDecision: decision });
          resolve(decision);
        },
      });
    });
  }
}

function service(
  reflexProvider: ReflexProvider,
  concurrency = 3,
  planner: SwarmPlanner = new DeterministicSwarmPlanner(),
) {
  let event = 0;
  const simulation = new SimulationService({
    swarmPlanner: planner,
    reflexProvider,
    reflexConcurrencyLimit: concurrency,
    now: () => '2026-10-02T00:00:00.000Z',
    createEventId: () =>
      `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    createExperimentId: () => '00000000-0000-4000-8000-000000000001',
  });
  simulation.applyWorldSetup(simulation.getDefaultWorldSetup());
  return simulation;
}

// Flush bounded microtask scheduling, without speed or elapsed-time assertions.
async function dispatched(provider: ControlledReflex, count: number) {
  for (let pass = 0; pass < 100 && provider.calls.length < count; pass += 1)
    await Promise.resolve();
  expect(provider.calls).toHaveLength(count);
}

afterEach(() => vi.useRealTimers());

describe('batch-capable simultaneous worker tick', () => {
  it('reuses two eligible directives and makes 17 deterministic decisions after a failed 20-agent replan', async () => {
    const planner: SwarmPlanner = {
      mode: 'scripted-swarm-test',
      configured: true,
      async plan(observation, model, options = {}) {
        const finalize = options.beginAttempt?.('initial');
        if (observation.tickNumber > 1) {
          finalize?.({
            outcome: 'provider-error',
            failure: {
              code: 'invalid-decision',
              message: 'Invalid Zero plan.',
              retryable: false,
            },
          });
          throw new Error('Invalid Zero plan');
        }
        const plan = {
          strategySummary: 'Infect local cells; retain two holding directives.',
          zeroActionCandidateId: observation.legalZeroActions.find(
            ({ action }) => action.type === 'wait',
          )!.id,
          directives: observation.workerOptions.map((worker, index) => {
            const option = worker.options.find((candidate) =>
              index < 2
                ? candidate.mission === 'hold'
                : candidate.mission === 'expand',
            )!;
            return {
              id: `fallback-${index}`,
              agentId: worker.agentId,
              mission: option.mission,
              targetCell: option.targetCell,
              priority: 'normal' as const,
              riskTolerance: 'low' as const,
              issuedAtTick: 1,
              expiresAtTick: index < 2 ? 5 : 1,
            };
          }),
        };
        const metadata = {
          provider: 'scripted-test' as const,
          model,
          latencyMs: 0,
        };
        finalize?.({
          outcome: 'completed',
          provider: metadata,
          swarmPlan: plan,
        });
        return { plan, metadata };
      },
    };
    const deterministic = new DeterministicReflexProvider();
    const provider: ReflexProvider = {
      mode: deterministic.mode,
      model: deterministic.model,
      configured: true,
      decide: vi.fn((observation, options) =>
        deterministic.decide(observation, options),
      ),
    };
    const simulation = service(provider, 3, planner);
    const request = simulation.getDefaultWorldSetup();
    const roster = generateDeterministicRoster(20, 'fallback-roster');
    simulation.applyWorldSetup({
      ...request,
      radius: 12,
      roster,
      patientZeroAgentId: roster[0]!.id,
      spawnSeed: 'fallback-spawn',
    });
    const first = await simulation.executeNextTick();
    expect(first?.planSource).toBe('zero-llm');
    expect(provider.decide).toHaveBeenCalledTimes(19);
    const tick = await simulation.executeNextTick();
    expect(tick?.planSource).toBe('deterministic-fallback');
    expect(
      tick?.workers.filter(({ source }) => source === 'deterministic-fallback'),
    ).toHaveLength(17);
    expect(
      tick?.workers.filter(({ source }) => source === 'jev-reflex'),
    ).toHaveLength(2);
    expect(provider.decide).toHaveBeenCalledTimes(21);
    expect(simulation.getSnapshot().experiment.attemptAccounting).toMatchObject(
      { attemptsStarted: 23, attemptsFinalized: 23, reservedPermits: 0 },
    );
  });
  it('resolves identical frozen observations in seeded order despite reversed completion', async () => {
    const run = async (reverse: boolean) => {
      const provider = new ControlledReflex();
      const simulation = service(provider, 8);
      const before = simulation.getSnapshot();
      const execution = simulation.executeNextTick();
      await dispatched(provider, 7);
      expect(simulation.getSnapshot().world).toEqual(before.world);
      const calls = reverse ? [...provider.calls].reverse() : provider.calls;
      for (const call of calls) call.finish();
      const tick = await execution;
      return {
        world: simulation.getSnapshot().world,
        order: simulation.getSnapshot().resolutionOrder,
        tick,
        observations: provider.calls.map(({ observation }) => observation),
      };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('cancels an ignoring provider, releases queued reservations and rejects late accounting', async () => {
    const provider = new ControlledReflex();
    const simulation = service(provider, 2);
    const before = simulation.getSnapshot();
    const execution = simulation.executeNextTick();
    await dispatched(provider, 2);
    const rejection = expect(execution).rejects.toBeInstanceOf(
      SimulationTurnCancelledError,
    );
    simulation.cancelCurrentRequest();
    await rejection;
    const snapshot = simulation.getSnapshot();
    expect(snapshot.world).toEqual(before.world);
    expect(snapshot.tickNumber).toBe(0);
    expect(snapshot.swarmTicks).toEqual([]);
    expect(snapshot.experiment.attemptAccounting).toMatchObject({
      attemptsStarted: 3,
      attemptsFinalized: 3,
      attemptsInFlight: 0,
      reservedPermits: 0,
    });
    const accounting = snapshot.experiment.attemptAccounting;
    provider.calls.forEach(({ finish }) => finish());
    await Promise.resolve();
    expect(simulation.getSnapshot().experiment.attemptAccounting).toEqual(
      accounting,
    );
    expect(provider.calls).toHaveLength(2);
    expect(simulation.getSnapshot().world).toEqual(before.world);
  });

  it('rolls back an expired shared deadline, finalizes only dispatched work and ignores late results', async () => {
    vi.useFakeTimers();
    const provider = new ControlledReflex();
    const simulation = service(provider, 2);
    const before = simulation.getSnapshot();
    const execution = simulation.executeNextTick();
    await dispatched(provider, 2);
    const rejection = expect(execution).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(75_001);
    await rejection;
    expect(simulation.getSnapshot().world).toEqual(before.world);
    expect(simulation.getSnapshot().tickNumber).toBe(0);
    const accounting = simulation.getSnapshot().experiment.attemptAccounting;
    expect(accounting).toMatchObject({
      attemptsStarted: 3,
      attemptsFinalized: 3,
      attemptsInFlight: 0,
      reservedPermits: 0,
    });
    provider.calls.forEach(({ finish }) => finish());
    await Promise.resolve();
    expect(simulation.getSnapshot().experiment.attemptAccounting).toEqual(
      accounting,
    );
    expect(provider.calls).toHaveLength(2);
  });

  it('attributes a native shared dispatch once and retains unrelated valid worker results', async () => {
    const provider: ReflexProvider = {
      mode: 'scripted-reflex-test',
      configured: true,
      model: 'controlled-reflex',
      decide: vi.fn(async () => {
        throw new Error('Scalar path must not run');
      }),
      async decideBatch(observations, options) {
        options?.beginAttempt?.('initial')?.({
          outcome: 'completed',
          provider: {
            provider: 'scripted-test',
            model: 'controlled-reflex',
            latencyMs: 5,
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            costCredits: 0.02,
          },
        });
        return observations
          .map((observation, index) => ({
            status: 'completed' as const,
            agentId: observation.agentId,
            decision:
              index === 1 ? { invalid: true } : decisionFor(observation),
          }))
          .reverse();
      },
    };
    const simulation = service(provider);
    const tick = await simulation.executeNextTick();
    expect(provider.decide).not.toHaveBeenCalled();
    expect(
      tick?.workers.filter(({ source }) => source === 'jev-reflex'),
    ).toHaveLength(6);
    expect(
      tick?.workers.filter(({ source }) => source === 'deterministic-fallback'),
    ).toHaveLength(1);
    expect(simulation.getSnapshot().experiment.attemptAccounting).toMatchObject(
      {
        attemptsStarted: 2,
        attemptsFinalized: 2,
        reservedPermits: 0,
        knownFinalizedCostCredits: '0.02',
      },
    );
    const exported = simulation.generateExperimentExport({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    const batch = exported.providerAttempts?.find(({ batch }) => batch);
    expect(batch?.batch?.members.map(({ agentId }) => agentId)).toEqual(
      tick?.workers.map(({ agentId }) => agentId),
    );
    expect(batch?.actualCostCredits).toBe('0.02');
    expect(batch?.reflexDecision).toBeUndefined();
    expect(
      tick?.workers.every(
        ({ reflexDecision }) => reflexDecision?.inputTokens === undefined,
      ),
    ).toBe(true);
    const memberId = tick!.workers.at(-1)!.agentId;
    const filtered = simulation.generateExperimentExport({
      agents: { mode: 'selected', agentIds: [memberId] },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'full-safe',
      serialization: 'compact',
    });
    expect(filtered.selection.selectedAgentIds).toEqual([memberId]);
    expect(filtered.providerAttempts).toHaveLength(1);
    expect(filtered.providerAttempts?.[0]?.batch?.members).toEqual(
      batch?.batch?.members,
    );
    expect(filtered.agents.map(({ id }) => id)).toEqual(
      expect.arrayContaining(
        batch!.batch!.members.map(({ agentId }) => agentId),
      ),
    );
    expect(filtered.metrics?.aggregate.knownCostCredits).toBe(0.02);
    expect(filtered.metrics?.byAgent[0]?.metrics.knownCostCredits).toBe(0);
  });

  it('preserves deterministic expansion without any reflex dispatch after first planner failure', async () => {
    const planner: SwarmPlanner = {
      mode: 'scripted-swarm-test',
      configured: true,
      async plan(_observation, _model, options) {
        options?.beginAttempt?.('initial')?.({
          outcome: 'provider-error',
          failure: {
            code: 'provider-http',
            message: 'Planner unavailable.',
            retryable: false,
          },
        });
        throw new Error('Planner unavailable');
      },
    };
    const provider = new ControlledReflex();
    const simulation = service(provider, 3, planner);
    const tick = await simulation.executeNextTick();
    expect(provider.calls).toHaveLength(0);
    expect(tick?.planSource).toBe('deterministic-fallback');
    expect(
      tick?.workers.every(({ source }) => source === 'deterministic-fallback'),
    ).toBe(true);
    expect(tick?.workers.some(({ action }) => action?.type === 'infect')).toBe(
      true,
    );
    expect(simulation.getSnapshot().experiment.attemptAccounting).toMatchObject(
      { attemptsStarted: 1, attemptsFinalized: 1, reservedPermits: 0 },
    );
  });
});
