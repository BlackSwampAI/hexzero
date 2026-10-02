import { describe, expect, it, vi } from 'vitest';
import type {
  ReflexBatchAttemptFinalizer,
  ReflexBatchDecisionResult,
  ReflexAttemptStarter,
  ReflexProvider,
} from '@hexzero/agent-runtime';
import {
  reflexDecisionSchema,
  type ReflexObservation,
  type SwarmDirective,
} from '@hexzero/shared';
import { createDevelopmentWorld, toWorldState } from '@hexzero/world-engine';
import { AttemptAccounting } from './attempt-accounting';
import {
  chooseReflexWorldActions,
  compileReflexObservation,
  ReflexSelectionCancelledError,
  ReflexSelectionDeadlineError,
} from './reflex-execution';

function setup(workerCount = 3) {
  const state = toWorldState(createDevelopmentWorld());
  const agents = [...state.agents.values()].slice(0, workerCount);
  const inputs = agents.map((agent, index) => {
    const directive: SwarmDirective = {
      id: `batch-directive-${index}`,
      agentId: agent.id,
      mission: 'hold',
      targetCell: null,
      priority: 'normal',
      riskTolerance: 'medium',
      issuedAtTick: 0,
      expiresAtTick: 5,
    };
    return {
      compiled: compileReflexObservation(state, directive),
      intendedTickNumber: 1,
      intendedTurnNumber: index + 1,
      initialPermitReserved: true,
    };
  });
  return { state, inputs };
}

function decision(
  observation: ReflexObservation,
  choice = observation.candidates[0]!.id,
) {
  return reflexDecisionSchema.parse({
    chosenCandidateId: choice,
    confidence: 1,
    probabilities: Object.fromEntries(
      observation.candidates.map(({ id }) => [id, id === choice ? 1 : 0]),
    ),
    replanProbability: 0,
    model: 'jev-1.13.0',
    latencyMs: 2,
    inputTokens: 12,
    outputTokens: 2,
    directiveId: observation.directive.id,
    cognitionSource: 'jev-reflex',
  });
}

function provider(
  decideBatch: NonNullable<ReflexProvider['decideBatch']>,
): ReflexProvider {
  return {
    mode: 'typesafe-jev',
    model: 'jev-1.13.0',
    configured: true,
    async decide() {
      throw new Error('scalar path should not be called');
    },
    decideBatch,
  };
}

describe('batched reflex execution seam', () => {
  it('closes a settled worker attempt gate while another worker remains pending', async () => {
    const { inputs } = setup(2);
    const accounting = new AttemptAccounting(3);
    expect(accounting.reserve(2)).toBe(true);
    let lateBegin: ReflexAttemptStarter | undefined;
    let release!: () => void;
    const scalar: ReflexProvider = {
      mode: 'scripted-reflex-test',
      configured: true,
      async decide(observation, options) {
        const finalize = options?.beginAttempt?.('initial');
        if (observation.directive.id === 'batch-directive-0') {
          lateBegin = options?.beginAttempt;
        } else {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        finalize?.({
          outcome: 'completed',
          reflexDecision: decision(observation),
        });
        return decision(observation);
      },
    };
    const selecting = chooseReflexWorldActions(inputs, scalar, {
      accounting,
      concurrencyLimit: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(accounting.snapshot()).toMatchObject({
      attemptsStarted: 2,
      attemptsFinalized: 1,
      attemptsInFlight: 1,
    });
    expect(lateBegin?.('automatic-transport-retry')).toBeNull();
    expect(accounting.ledger()).toHaveLength(2);
    release();
    await selecting;
    expect(accounting.snapshot()).toMatchObject({
      attemptsStarted: 2,
      attemptsFinalized: 2,
      attemptsInFlight: 0,
    });
    accounting.releaseReservations();
  });
  it('finalizes failed scalar dispatches without retaining an invalid success completion field', async () => {
    const { inputs } = setup(1);
    const accounting = new AttemptAccounting(1);
    expect(accounting.reserve(1)).toBe(true);
    const scalar: ReflexProvider = {
      mode: 'scripted-reflex-test',
      configured: true,
      async decide(observation, options) {
        options?.beginAttempt?.('initial')?.({
          outcome: 'provider-error',
          failure: {
            code: 'provider-http',
            message: 'Unavailable.',
            retryable: false,
          },
          reflexDecision: decision(observation),
        });
        throw new Error('Unavailable');
      },
    };
    const [selection] = await chooseReflexWorldActions(inputs, scalar, {
      accounting,
    });
    expect(selection?.cognitionSource).toBe('deterministic-fallback');
    expect(accounting.snapshot()).toMatchObject({
      attemptsStarted: 1,
      attemptsFinalized: 1,
      attemptsInFlight: 0,
    });
    expect(accounting.ledger()[0]).toMatchObject({ outcome: 'provider-error' });
    expect(accounting.ledger()[0]?.reflexDecision).toBeUndefined();
  });
  it('maps reordered native results by worker and records one shared batch attempt', async () => {
    const { inputs } = setup();
    const accounting = new AttemptAccounting(1);
    expect(accounting.reserve(1)).toBe(true);
    const batched = provider(async (observations, options) => {
      expect(observations).toHaveLength(inputs.length);
      expect(Object.isFrozen(observations[0])).toBe(true);
      expect(Object.isFrozen(observations[0]?.candidates)).toBe(true);
      const finalize = options?.beginAttempt?.('initial');
      expect(finalize).not.toBeNull();
      finalize?.({
        outcome: 'completed',
        provider: {
          provider: 'typesafe',
          model: 'jev-1.13.0',
          latencyMs: 9,
          promptTokens: 90,
          completionTokens: 12,
          totalTokens: 102,
        },
      });
      return [...observations].reverse().map((observation) => ({
        agentId: observation.agentId,
        status: 'completed' as const,
        decision: decision(observation),
      }));
    });

    const selected = await chooseReflexWorldActions(inputs, batched, {
      accounting,
    });

    expect(
      selected.map(
        ({ decision: selectedDecision }) => selectedDecision?.directiveId,
      ),
    ).toEqual(inputs.map(({ compiled }) => compiled.observation.directive.id));
    const [attempt] = accounting.ledger();
    expect(accounting.ledger()).toHaveLength(1);
    expect(attempt).toMatchObject({
      agentId: inputs[0]?.compiled.observation.agentId,
      batch: {
        members: inputs.map(({ compiled }, index) => ({
          agentId: compiled.observation.agentId,
          intendedTurnNumber: index + 1,
        })),
      },
      provider: { promptTokens: 90, completionTokens: 12, totalTokens: 102 },
    });
    expect(attempt).not.toHaveProperty('reflexDecision');
  });

  it('isolates failed, malformed, missing, duplicate, and extra keyed results', async () => {
    const { inputs } = setup(4);
    const [first, second, third, fourth] = inputs;
    const results: unknown[] = [
      {
        agentId: first!.compiled.observation.agentId,
        status: 'completed',
        decision: decision(first!.compiled.observation),
      },
      {
        agentId: second!.compiled.observation.agentId,
        status: 'failed',
        failure: { code: 'invalid-decision', message: 'bad', retryable: false },
      },
      {
        agentId: third!.compiled.observation.agentId,
        status: 'completed',
        decision: { bogus: true },
      },
      {
        agentId: first!.compiled.observation.agentId,
        status: 'completed',
        decision: decision(first!.compiled.observation),
      },
      { agentId: '00000000-0000-4000-8000-000000000099', status: 'ignored' },
    ];
    const selected = await chooseReflexWorldActions(
      inputs,
      provider(async () => results as ReflexBatchDecisionResult[]),
    );

    expect(selected[0]?.cognitionSource).toBe('deterministic-fallback');
    expect(selected[0]?.failure?.code).toBe('unsupported-response');
    expect(selected[1]?.cognitionSource).toBe('deterministic-fallback');
    expect(selected[1]?.failure?.code).toBe('invalid-decision');
    expect(selected[2]?.cognitionSource).toBe('deterministic-fallback');
    expect(selected[2]?.failure?.code).toBe('malformed-response');
    expect(selected[3]?.cognitionSource).toBe('deterministic-fallback');
    expect(selected[3]?.failure?.code).toBe('unsupported-response');
    expect(fourth).toBeDefined();
  });

  it('uses a bounded scalar adapter and preserves input result order', async () => {
    const { inputs } = setup(4);
    let active = 0;
    let maximumActive = 0;
    const pending: Array<() => void> = [];
    const scalar: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'jev-1.13.0',
      configured: true,
      async decide(observation) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;
        return decision(observation);
      },
    };

    const selecting = chooseReflexWorldActions(inputs, scalar, {
      concurrencyLimit: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(2);
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(2);
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.splice(0).forEach((resolve) => resolve());

    const selected = await selecting;
    expect(maximumActive).toBe(2);
    expect(selected.map(({ decision: item }) => item?.directiveId)).toEqual(
      inputs.map(({ compiled }) => compiled.observation.directive.id),
    );
  });

  it.each([true, false])(
    'keeps scarce retry permits assigned to the input prefix (reverse completion: %s)',
    async (reverseCompletion) => {
      const { inputs } = setup(3);
      const accounting = new AttemptAccounting(4);
      expect(accounting.reserve(3)).toBe(true);
      const gates: Array<() => void> = [];
      const scalar: ReflexProvider = {
        mode: 'scripted-reflex-test',
        model: 'jev-1.13.0',
        configured: true,
        async decide(observation, options) {
          const initial = options?.beginAttempt?.('initial');
          if (!initial) throw new Error('initial permit unavailable');
          initial({ outcome: 'provider-error' });
          expect(options?.beginAttempt?.('initial')).toBeNull();
          if (observation.directive.id !== 'batch-directive-2')
            await new Promise<void>((resolve) => gates.push(resolve));
          const retry = options?.beginAttempt?.('automatic-transport-retry');
          if (!retry) throw new Error('retry permit unavailable');
          retry({
            outcome: 'completed',
            provider: {
              provider: 'typesafe',
              model: 'jev-1.13.0',
              latencyMs: 1,
            },
          });
          expect(
            options?.beginAttempt?.('automatic-transport-retry'),
          ).toBeNull();
          return decision(observation);
        },
      };

      const selecting = chooseReflexWorldActions(inputs, scalar, {
        accounting,
        concurrencyLimit: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gates).toHaveLength(2);
      if (reverseCompletion) {
        gates[1]!();
        await new Promise((resolve) => setTimeout(resolve, 0));
        gates[0]!();
      } else {
        gates[0]!();
        await new Promise((resolve) => setTimeout(resolve, 0));
        gates[1]!();
      }
      const selected = await selecting;

      expect(selected[0]?.cognitionSource).toBe('jev-reflex');
      expect(selected[1]?.cognitionSource).toBe('deterministic-fallback');
      expect(selected[2]?.cognitionSource).toBe('deterministic-fallback');
      expect(accounting.ledger()).toHaveLength(4);
      expect(
        accounting
          .ledger()
          .filter(({ kind }) => kind === 'automatic-transport-retry')
          .map(({ agentId }) => agentId),
      ).toEqual([inputs[0]?.compiled.observation.agentId]);
      accounting.releaseReservations();
    },
  );

  it('cancels promptly and finalizes an open batch attempt once', async () => {
    const { inputs } = setup(2);
    const accounting = new AttemptAccounting(1);
    expect(accounting.reserve(1)).toBe(true);
    const controller = new AbortController();
    let release!: (results: readonly ReflexBatchDecisionResult[]) => void;
    let lateFinalize: ReflexBatchAttemptFinalizer | null | undefined;
    const selecting = chooseReflexWorldActions(
      inputs,
      provider(async (_observations, options) => {
        const finalize = options?.beginAttempt?.('initial');
        lateFinalize = finalize;
        return await new Promise((resolve) => {
          release = resolve;
        });
      }),
      { accounting, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(selecting).rejects.toBeInstanceOf(
      ReflexSelectionCancelledError,
    );
    expect(accounting.ledger()).toHaveLength(1);
    expect(accounting.ledger()[0]?.outcome).toBe('cancelled');
    lateFinalize?.({ outcome: 'completed' });
    expect(accounting.ledger()[0]?.outcome).toBe('cancelled');
    release([]);
  });

  it('times out the whole batch when the provider ignores abort', async () => {
    const { inputs } = setup(2);
    vi.useFakeTimers();
    const selecting = chooseReflexWorldActions(
      inputs,
      provider(async () => await new Promise(() => undefined)),
      { deadlineAtMs: Date.now() + 20 },
    );
    const rejected = expect(selecting).rejects.toBeInstanceOf(
      ReflexSelectionDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    vi.useRealTimers();
  });

  it('does not dispatch a native batch after its deadline has expired', async () => {
    const { inputs } = setup(2);
    const decideBatch = vi.fn(async () => []);
    await expect(
      chooseReflexWorldActions(inputs, provider(decideBatch), {
        deadlineAtMs: Date.now() - 1,
      }),
    ).rejects.toBeInstanceOf(ReflexSelectionDeadlineError);
    expect(decideBatch).not.toHaveBeenCalled();
  });
});
