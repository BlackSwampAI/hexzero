import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  modelIdSchema,
  type AgentObservation,
} from '@hexzero/shared';
import {
  AgentProviderError,
  dispatchTickDecisions,
  type AgentProvider,
} from '.';

const observation = {} as AgentObservation;
const modelId = modelIdSchema.parse('test/model');
const jobs = Array.from({ length: 4 }, (_, index) => ({
  agentId: agentIdSchema.parse(
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ),
  observation,
  modelId,
  reasoningProfile: 'provider-default' as const,
}));
const decision = (model = modelId) => ({
  decision: { worldAction: { type: 'wait' as const }, summary: 'Wait.' },
  metadata: {
    provider: 'scripted-test' as const,
    model,
    latencyMs: 0,
    costCredits: 0,
  },
});

describe('dispatchTickDecisions', () => {
  it('bounds concurrency, shares the deadline, and preserves job identity order', async () => {
    let active = 0;
    let maximum = 0;
    const deadlines = new Set<number>();
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide(_observation, model, options) {
        active += 1;
        maximum = Math.max(maximum, active);
        deadlines.add(options!.deadlineAtMs!);
        await Promise.resolve();
        active -= 1;
        return decision(model as typeof modelId);
      },
    };
    const results = await dispatchTickDecisions(provider, jobs, {
      concurrency: 2,
      deadlineAtMs: 100,
      nowMs: () => 0,
    });
    expect(maximum).toBe(2);
    expect(deadlines).toEqual(new Set([100]));
    expect(results.map(({ agentId }) => agentId)).toEqual(
      jobs.map(({ agentId }) => agentId),
    );
  });

  it('returns input-ordered results when providers resolve in reverse order', async () => {
    const releases: Array<() => void> = [];
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide(_observation, model) {
        await new Promise<void>((resolve) => releases.push(resolve));
        return decision(model as typeof modelId);
      },
    };
    const pending = dispatchTickDecisions(provider, jobs, {
      concurrency: 4,
      deadlineAtMs: 1_000,
      nowMs: () => 0,
    });
    await Promise.resolve();
    for (const release of [...releases].reverse()) release();
    const results = await pending;
    expect(results.map(({ agentId }) => agentId)).toEqual(
      jobs.map(({ agentId }) => agentId),
    );
  });

  it('retries only established transient failures and honors bounded backoff', async () => {
    let calls = 0;
    const waits: number[] = [];
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide() {
        calls += 1;
        if (calls === 1)
          throw new AgentProviderError({
            code: 'provider-http',
            httpStatus: 429,
            message: 'limited',
            retryable: true,
            retryAfterMs: 20,
          });
        return decision();
      },
    };
    const [result] = await dispatchTickDecisions(provider, jobs.slice(0, 1), {
      deadlineAtMs: 100,
      nowMs: () => 0,
      waitForMs: async (delay) => {
        waits.push(delay);
      },
    });
    expect(calls).toBe(2);
    expect(waits).toEqual([20]);
    expect(result?.attempts).toHaveLength(2);
  });

  it('does not start an exhausted queued job and sanitizes unexpected errors', async () => {
    let nowMs = 0;
    let calls = 0;
    let starts = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide() {
        calls += 1;
        nowMs = 101;
        throw new Error('secret diagnostic');
      },
    };
    const results = await dispatchTickDecisions(provider, jobs.slice(0, 2), {
      concurrency: 1,
      deadlineAtMs: 100,
      nowMs: () => nowMs,
      beginAttempt: () => {
        starts += 1;
        return () => {};
      },
    });
    expect(calls).toBe(1);
    expect(starts).toBe(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      outcome: 'lost-tick',
      failure: { message: 'The model provider failed unexpectedly.' },
    });
    expect(results[1]).toMatchObject({
      outcome: 'lost-tick',
      failure: { code: 'timeout' },
    });
    expect(results[1]?.attempts).toHaveLength(0);
  });

  it('sanitizes malformed provider-shaped exceptions without affecting siblings', async () => {
    let calls = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide() {
        calls += 1;
        if (calls === 1)
          throw { failure: { message: 'secret provider diagnostic' } };
        return decision();
      },
    };
    const results = await dispatchTickDecisions(provider, jobs.slice(0, 2), {
      concurrency: 1,
      deadlineAtMs: 100,
      nowMs: () => 0,
    });
    expect(results[0]).toMatchObject({
      outcome: 'lost-tick',
      failure: { message: 'The model provider failed unexpectedly.' },
    });
    expect(JSON.stringify(results)).not.toContain('secret provider diagnostic');
    expect(results[1]).toMatchObject({ outcome: 'completed' });
  });

  it('enforces the absolute deadline when a provider ignores abort', async () => {
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      decide: async () => new Promise<never>(() => {}),
    };
    const [result] = await dispatchTickDecisions(provider, jobs.slice(0, 1), {
      deadlineAtMs: Date.now() + 5,
    });
    expect(result).toMatchObject({
      outcome: 'lost-tick',
      failure: { code: 'timeout' },
    });
    expect(result?.attempts).toHaveLength(1);
    expect(result?.attempts[0]?.failure).toMatchObject({
      code: 'timeout',
      latencyMs: expect.any(Number),
    });
    expect(result?.attempts[0]?.failure?.latencyMs).toBeLessThanOrEqual(5);
    if (!result || result.outcome !== 'lost-tick')
      throw new Error('Expected the hard deadline to produce a lost tick.');
    expect(result.failure.latencyMs).toBe(
      result.attempts[0]?.failure?.latencyMs,
    );
  });

  it('marks an exact-deadline completion and its usage-bearing attempt as timed out', async () => {
    let reads = 0;
    const [result] = await dispatchTickDecisions(
      {
        mode: 'scripted-test',
        configured: true,
        async decide() {
          return decision();
        },
      },
      jobs.slice(0, 1),
      {
        deadlineAtMs: 100,
        nowMs: () => (reads++ === 0 ? 0 : 100),
      },
    );
    expect(result).toMatchObject({
      outcome: 'lost-tick',
      attempts: [
        { failure: { code: 'timeout' }, provider: { costCredits: 0 } },
      ],
    });
  });

  it('atomically reports operator cancellation when a provider ignores abort', async () => {
    const controller = new AbortController();
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      decide: async () => new Promise<never>(() => {}),
    };
    const pending = dispatchTickDecisions(provider, jobs.slice(0, 1), {
      deadlineAtMs: Date.now() + 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      failure: { code: 'cancelled' },
    });
  });

  it('awaits all workers before rejecting cancellation', async () => {
    const controller = new AbortController();
    let settled = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      configured: true,
      async decide(_observation, _model, options) {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        settled += 1;
        throw new AgentProviderError({
          code: 'cancelled',
          message: 'cancelled',
          retryable: false,
        });
      },
    };
    const pending = dispatchTickDecisions(provider, jobs, {
      concurrency: 4,
      deadlineAtMs: 100,
      nowMs: () => 0,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      failure: { code: 'cancelled' },
    });
    expect(settled).toBe(4);
  });

  it('accounts only started calls and refuses a retry without a permit', async () => {
    let calls = 0;
    let permits = 1;
    const finalized: Array<number | undefined> = [];
    const [result] = await dispatchTickDecisions(
      {
        mode: 'scripted-test',
        configured: true,
        async decide() {
          calls += 1;
          throw new AgentProviderError({
            code: 'network',
            message: 'retryable',
            retryable: true,
          });
        },
      },
      jobs.slice(0, 1),
      {
        deadlineAtMs: 100,
        nowMs: () => 0,
        beginAttempt: () => {
          if (permits-- < 1) return null;
          return (metadata) => finalized.push(metadata?.costCredits);
        },
      },
    );
    expect(calls).toBe(1);
    expect(finalized).toEqual([undefined]);
    expect(result).toMatchObject({
      outcome: 'lost-tick',
      failure: { code: 'budget-exhausted' },
      attempts: [{ failure: { code: 'network' } }],
    });
  });

  it('finalizes a started cancelled attempt with unknown metadata', async () => {
    const controller = new AbortController();
    const finalized: unknown[] = [];
    const pending = dispatchTickDecisions(
      {
        mode: 'scripted-test',
        configured: true,
        decide: async () => new Promise<never>(() => {}),
      },
      jobs.slice(0, 1),
      {
        deadlineAtMs: Date.now() + 1_000,
        signal: controller.signal,
        beginAttempt: () => (metadata) => finalized.push(metadata),
      },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      failure: { code: 'cancelled' },
    });
    expect(finalized).toEqual([undefined]);
  });
});
