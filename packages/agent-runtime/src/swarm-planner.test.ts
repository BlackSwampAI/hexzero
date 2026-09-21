import { describe, expect, it, vi } from 'vitest';
import {
  swarmPlanSchema,
  zeroStrategicObservationSchema,
} from '@hexzero/shared';
import {
  OpenRouterSwarmPlanner,
  ScriptedSwarmPlanner,
  SwarmPlannerError,
} from './swarm-planner';

const zero = '00000000-0000-4000-8000-000000000001';
const worker = '00000000-0000-4000-8000-000000000002';
const cell = '8928308280fffff';
const observation = zeroStrategicObservationSchema.parse({
  zeroAgentId: zero,
  tickNumber: 1,
  virtualTime: '2026-08-13T12:00:00.000Z',
  cells: [{ cell, state: 'infected' as const, controllerAgentId: zero }],
  agents: [
    {
      agentId: zero,
      position: cell,
      controlledCellCount: 1,
      territoryDelta: 0,
    },
    {
      agentId: worker,
      position: cell,
      controlledCellCount: 0,
      territoryDelta: 0,
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
});
const plan = swarmPlanSchema.parse({
  strategySummary: 'Expand carefully.',
  zeroActionCandidateId: 'zero_action_0',
  directives: [
    {
      id: 'directive-1',
      agentId: worker,
      mission: 'expand' as const,
      targetCell: cell,
      priority: 'normal' as const,
      riskTolerance: 'medium' as const,
      issuedAtTick: 1,
      expiresAtTick: 2,
    },
  ],
});
const compactPlan = {
  strategySummary: 'Expand carefully.',
  zeroActionCandidateId: 'zero_action_0',
  directives: [
    {
      workerId: 'worker_0',
      mission: 'expand',
      targetId: 'target_0',
      priority: 'normal',
      riskTolerance: 'medium',
    },
  ],
};

describe('swarm planners', () => {
  it('turns bounded worker and target choices into authoritative directives', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(plannerResponse(compactPlan));
    const result = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation,
    }).plan(observation, 'test-model', { reasoningProfile: 'low' });
    expect(result.plan).toEqual({
      strategySummary: 'Expand carefully.',
      zeroActionCandidateId: 'zero_action_0',
      directives: [
        {
          id: 'directive-1-worker_0',
          agentId: worker,
          mission: 'expand',
          targetCell: cell,
          priority: 'normal',
          riskTolerance: 'medium',
          issuedAtTick: 1,
          expiresAtTick: 5,
        },
      ],
    });
    const body = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    ) as {
      messages: Array<{ content: string }>;
      reasoning: { enabled: boolean; effort: string; exclude: boolean };
      max_tokens: number;
    };
    expect(body.reasoning).toEqual({
      enabled: true,
      effort: 'low',
      exclude: true,
    });
    expect(body.max_tokens).toBe(4_096);
    expect(body.messages[0]?.content).toContain('Code supplies directive IDs');
    expect(body.messages[0]?.content).toContain(
      'Expand targets must be open cells.',
    );
    expect(JSON.parse(body.messages[1]!.content)).toMatchObject({
      workers: [{ workerId: 'worker_0', position: cell }],
      targetChoices: [{ targetId: 'target_0', cell }],
    });
  });

  it('marks completed worker directives in the compact Zero request', async () => {
    const completedObservation = zeroStrategicObservationSchema.parse({
      ...observation,
      agents: observation.agents.map((agent) =>
        agent.agentId === worker
          ? { ...agent, directive: plan.directives[0] }
          : agent,
      ),
      replanReasons: ['directive-complete'],
      completedDirectives: [{ agentId: worker, directiveId: 'directive-1' }],
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(plannerResponse(compactPlan));
    await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation,
    }).plan(completedObservation, 'test-model');
    const body = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<{ content: string }> };
    expect(JSON.parse(body.messages[1]!.content)).toMatchObject({
      replanReasons: ['directive-complete'],
      workers: [{ workerId: 'worker_0', directiveComplete: true }],
    });
  });

  it('rejects unknown compact choices with a safe specific reason', async () => {
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse({
            ...compactPlan,
            directives: [
              { ...compactPlan.directives[0], targetId: 'target_99' },
            ],
          }),
        ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message: 'Agent Zero plan rejected: unknown target choice.',
      },
    });
  });

  it('reports missing compact worker directives without exposing raw output', async () => {
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            plannerResponse({ ...compactPlan, directives: [] }),
          ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message:
          'Agent Zero plan rejected: missing or extra worker directives.',
      },
    });
  });

  it('uses a deterministic plan only when it stays within authoritative options', async () => {
    const result = await new ScriptedSwarmPlanner([plan]).plan(
      observation,
      'test-model',
    );
    expect(result.plan).toEqual(plan);
    expect(result.metadata.provider).toBe('openrouter');
  });

  it('rejects directives extending beyond the ten-tick lifetime', async () => {
    const tooLong = swarmPlanSchema.parse({
      ...plan,
      directives: [{ ...plan.directives[0]!, expiresAtTick: 11 }],
    });
    await expect(
      new ScriptedSwarmPlanner([tooLong]).plan(observation, 'test-model'),
    ).rejects.toBeInstanceOf(SwarmPlannerError);
  });

  it('rejects an OpenRouter plan with an invented zero candidate', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...plan,
                  zeroActionCandidateId: 'zero_action_9',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation,
    });
    await expect(
      provider.plan(observation, 'test-model'),
    ).rejects.toBeInstanceOf(SwarmPlannerError);
  });

  it('rejects a plan that omits a worker directive before it is committed', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ ...plan, directives: [] }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const finalized: unknown[] = [];
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation,
      }).plan(observation, 'test-model', {
        beginAttempt: () => (completion) => finalized.push(completion),
      }),
    ).rejects.toBeInstanceOf(SwarmPlannerError);
    expect(finalized).toMatchObject([{ outcome: 'provider-error' }]);
  });

  it('makes one bounded retry for an overloaded planner response', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 529 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'safe-request-id',
            model: 'test-model',
            choices: [{ message: { content: JSON.stringify(plan) } }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
          { status: 200 },
        ),
      );
    const attempts: string[] = [];
    const result = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation,
    }).plan(observation, 'test-model', {
      beginAttempt: (kind) => {
        attempts.push(kind);
        return () => undefined;
      },
    });
    expect(result.metadata.totalTokens).toBe(7);
    expect(attempts).toEqual(['initial', 'automatic-transport-retry']);
  });

  it('preserves complete provider-reported OpenRouter accounting', async () => {
    const result = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        plannerResponse(plan, {
          prompt_tokens: 101,
          completion_tokens: 23,
          total_tokens: 124,
          cost: 0.00000017,
          completion_tokens_details: { reasoning_tokens: 7 },
          prompt_tokens_details: {
            cached_tokens: 80,
            cache_write_tokens: 4,
          },
        }),
      ),
    }).plan(observation, 'test-model');
    expect(result.metadata).toMatchObject({
      promptTokens: 101,
      completionTokens: 23,
      totalTokens: 124,
      reasoningTokens: 7,
      cachedReadTokens: 80,
      cacheWriteTokens: 4,
      costCredits: 0.00000017,
    });
  });

  it('retains billable usage when the returned plan is invalid', async () => {
    const finalized: unknown[] = [];
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse(
            { ...plan, zeroActionCandidateId: 'invented' },
            {
              prompt_tokens: 11,
              completion_tokens: 5,
              total_tokens: 16,
              cost: 0.001,
            },
          ),
        ),
      }).plan(observation, 'test-model', {
        beginAttempt: () => (completion) => finalized.push(completion),
      }),
    ).rejects.toMatchObject({ metadata: { costCredits: 0.001 } });
    expect(finalized).toMatchObject([
      {
        outcome: 'provider-error',
        provider: { promptTokens: 11, totalTokens: 16, costCredits: 0.001 },
      },
    ]);
  });

  it('retains billable usage when a response cannot be parsed as a plan', async () => {
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{not-json' } }],
              usage: { prompt_tokens: 12, cost: 0.002 },
            }),
            { status: 200 },
          ),
        ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      failure: { code: 'malformed-response' },
      metadata: { promptTokens: 12, costCredits: 0.002 },
    });
  });

  it('omits absent or malformed optional provider cost while retaining valid usage', async () => {
    const withoutUsage = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(plannerResponse(plan)),
    }).plan(observation, 'test-model');
    expect(withoutUsage.metadata).not.toHaveProperty('costCredits');
    const malformedCost = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          plannerResponse(plan, { prompt_tokens: 9, cost: 'untrusted' }),
        ),
    }).plan(observation, 'test-model');
    expect(malformedCost.metadata).toMatchObject({ promptTokens: 9 });
    expect(malformedCost.metadata).not.toHaveProperty('costCredits');
  });

  it('attributes usage from a retryable non-OK attempt before retrying', async () => {
    const finalized: unknown[] = [];
    const result = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ usage: { prompt_tokens: 4, cost: 0.003 } }),
            { status: 529 },
          ),
        )
        .mockResolvedValueOnce(plannerResponse(plan)),
    }).plan(observation, 'test-model', {
      beginAttempt: () => (completion) => finalized.push(completion),
    });
    expect(result.metadata).not.toHaveProperty('costCredits');
    expect(finalized).toMatchObject([
      {
        outcome: 'provider-error',
        provider: { promptTokens: 4, costCredits: 0.003, httpStatus: 529 },
      },
      { outcome: 'completed' },
    ]);
  });

  it('attributes usage from a non-retryable non-OK response', async () => {
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ usage: { completion_tokens: 8, cost: 0.004 } }),
              { status: 400 },
            ),
          ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      metadata: { completionTokens: 8, costCredits: 0.004, httpStatus: 400 },
    });
  });

  it('preserves cancellation while reading a non-OK response body', async () => {
    const cancellation = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        cancellation.abort();
        controller.error(new Error('cancelled body'));
      },
    });
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body, { status: 400 })),
      }).plan(observation, 'test-model', { signal: cancellation.signal }),
    ).rejects.toMatchObject({ failure: { code: 'cancelled' } });
  });

  it('excludes echoed secrets and worker observation data from response metadata', async () => {
    const echoed = `Bearer test-key ${cell}`;
    const success = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: echoed,
            model: echoed,
            choices: [{ message: { content: JSON.stringify(plan) } }],
          }),
          { status: 200 },
        ),
      ),
    }).plan(observation, 'test-model');
    expect(success.metadata).not.toHaveProperty('requestId');
    expect(success.metadata).not.toHaveProperty('resolvedModel');
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              id: echoed,
              model: echoed,
              usage: { cost: 0.005 },
            }),
            { status: 400 },
          ),
        ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      metadata: { costCredits: 0.005 },
    });
  });
});

function plannerResponse(planValue: unknown, usage?: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'safe-request-id',
      model: 'test-model',
      choices: [{ message: { content: JSON.stringify(planValue) } }],
      ...(usage === undefined ? {} : { usage }),
    }),
    { status: 200 },
  );
}
