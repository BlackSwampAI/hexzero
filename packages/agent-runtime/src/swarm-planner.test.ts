import { describe, expect, it, vi } from 'vitest';
import {
  swarmPlanSchema,
  zeroStrategicObservationSchema,
} from '@hexzero/shared';
import {
  OpenRouterSwarmPlanner,
  DeterministicSwarmPlanner,
  ScriptedSwarmPlanner,
  SwarmPlannerError,
} from './swarm-planner';

const zero = '00000000-0000-4000-8000-000000000001';
const worker = '00000000-0000-4000-8000-000000000002';
const cell = '8928308280fffff';
const openCell = '892a1072883ffff';
const observation = zeroStrategicObservationSchema.parse({
  zeroAgentId: zero,
  tickNumber: 1,
  virtualTime: '2026-08-13T12:00:00.000Z',
  cells: [
    { cell, state: 'infected' as const, controllerAgentId: zero },
    { cell: openCell, state: 'open' as const, controllerAgentId: null },
  ],
  agents: [
    {
      agentId: zero,
      position: cell,
      controlledCellCount: 1,
      territoryDelta: 0,
      localPressure: 'low',
      pressureDirection: null,
      pressureDistance: null,
    },
    {
      agentId: worker,
      position: cell,
      controlledCellCount: 0,
      territoryDelta: 0,
      localPressure: 'low',
      pressureDirection: null,
      pressureDistance: null,
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
  worldSummary: {
    totalCells: 2,
    openCells: 1,
    swarmInfectedCells: 1,
    abandonedInfectedCells: 0,
    openFrontierCells: 1,
  },
  workerOptions: [
    {
      agentId: worker,
      options: [
        {
          optionId: 'w0_o0',
          mission: 'hold' as const,
          targetCell: null,
          direction: null,
          distance: 0,
          targetState: null,
          territoryRelation: null,
          pressureAtTarget: 'low' as const,
          pressureEffect: 'none' as const,
          crowding: 0,
          continuesActiveDirective: false,
          description: 'Hold current position.',
        },
        {
          optionId: 'w0_o1',
          mission: 'expand' as const,
          targetCell: openCell,
          direction: 'N' as const,
          distance: 1,
          targetState: 'open' as const,
          territoryRelation: 'open-frontier' as const,
          pressureAtTarget: 'low' as const,
          pressureEffect: 'none' as const,
          crowding: 0,
          continuesActiveDirective: false,
          description: 'Expand to open frontier cell.',
        },
      ],
    },
  ],
});
const plan = swarmPlanSchema.parse({
  strategySummary: 'Expand carefully.',
  zeroActionCandidateId: 'zero_action_0',
  directives: [
    {
      id: 'directive-1',
      agentId: worker,
      mission: 'expand' as const,
      targetCell: openCell,
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
      optionId: 'w0_o1',
      priority: 'normal',
      riskTolerance: 'medium',
    },
  ],
};

describe('swarm planners', () => {
  it('supplies repeatable observation-derived plans for browser swarm runs', async () => {
    const planner = new DeterministicSwarmPlanner();
    const first = await planner.plan(observation, 'deterministic-browser');
    const second = await planner.plan(observation, 'deterministic-browser');

    expect(first).toEqual(second);
    expect(first.plan.zeroActionCandidateId).toBe('zero_action_0');
    expect(first.plan.directives).toHaveLength(1);
    expect(first.plan.directives[0]).toMatchObject({
      agentId: worker,
      mission: 'expand',
      targetCell: openCell,
      issuedAtTick: 1,
    });
  });

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
          targetCell: openCell,
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
    expect(body.messages[0]?.content).toContain(
      'Do not output mission or targetCell fields',
    );
    expect(body.messages[0]?.content).toContain(
      'pre-validated mission options',
    );
    const requestContent = JSON.parse(body.messages[1]!.content) as Record<
      string,
      unknown
    >;
    expect(requestContent).toMatchObject({
      worldSummary: {
        totalCells: 2,
        openCells: 1,
        swarmInfectedCells: 1,
      },
      workers: [
        expect.objectContaining({
          workerId: 'worker_0',
          options: expect.arrayContaining([
            expect.objectContaining({ optionId: 'w0_o1', mission: 'expand' }),
          ]),
        }),
      ],
    });
    // targetCell must not appear in the request body (server-only field).
    expect(body.messages[1]!.content).not.toContain(openCell);
    // No raw H3 cell IDs or agent IDs in the user message.
    expect(body.messages[1]!.content).not.toContain(cell);
    expect(body.messages[1]!.content).not.toContain(worker);
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

  it('gives Zero bounded, event-derived worker threat and capture context', async () => {
    const threatenedObservation = zeroStrategicObservationSchema.parse({
      ...observation,
      agents: observation.agents.map((agent) =>
        agent.agentId === worker
          ? {
              ...agent,
              localPressure: 'high',
              pressureDirection: 'NE',
              pressureDistance: 'adjacent',
            }
          : agent,
      ),
      recentCaptures: [
        {
          capturedAgentId: worker,
          cell,
          originatingTick: 1,
          abandonedCellCount: 3,
        },
      ],
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(plannerResponse(compactPlan));
    await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation,
    }).plan(threatenedObservation, 'test-model');
    const body = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toContain(
      'permanently captured and removed',
    );
    expect(body.messages[0]?.content).toContain(
      'Hold under high pressure only as an intentional defensive or sacrifice choice',
    );
    const requestContent = JSON.parse(body.messages[1]!.content) as Record<
      string,
      unknown
    >;
    expect(requestContent).toMatchObject({
      workers: [
        {
          workerId: 'worker_0',
          localPressure: 'high',
          pressureDirection: 'NE',
          pressureDistance: 'adjacent',
        },
      ],
      recentCaptures: [
        {
          originatingTick: 1,
          abandonedCellCount: 3,
        },
      ],
    });
    // Cell IDs and agent IDs must not appear in the recentCaptures payload.
    const capturesJson = JSON.stringify(
      requestContent['recentCaptures'] as unknown[],
    );
    expect(capturesJson).not.toContain(cell);
    expect(capturesJson).not.toContain(worker);
    expect(body.messages[1]?.content).not.toContain('targetingState');
    expect(body.messages[1]?.content).not.toContain('simulatedPlayerPosition');
  });

  it('rejects unknown compact choices with a safe specific reason', async () => {
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse({
            ...compactPlan,
            directives: [{ ...compactPlan.directives[0], optionId: 'w0_o99' }],
          }),
        ),
      }).plan(observation, 'test-model'),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message: 'Agent Zero plan rejected: unknown option choice.',
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
                  ...compactPlan,
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
                content: JSON.stringify({ ...compactPlan, directives: [] }),
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
            choices: [{ message: { content: JSON.stringify(compactPlan) } }],
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
        plannerResponse(compactPlan, {
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
            { ...compactPlan, zeroActionCandidateId: 'invented' },
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
        .mockResolvedValue(plannerResponse(compactPlan)),
    }).plan(observation, 'test-model');
    expect(withoutUsage.metadata).not.toHaveProperty('costCredits');
    const malformedCost = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          plannerResponse(compactPlan, { prompt_tokens: 9, cost: 'untrusted' }),
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
        .mockResolvedValueOnce(plannerResponse(compactPlan)),
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
    const echoed = `Bearer test-key`;
    const success = await new OpenRouterSwarmPlanner({
      apiKey: 'test-key',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: echoed,
            model: echoed,
            choices: [{ message: { content: JSON.stringify(compactPlan) } }],
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
  // ── multi-worker rejection tests ──────────────────────────────────────────

  const worker2 = '00000000-0000-4000-8000-000000000003';
  const openCell2 = '892a1072887ffff';
  const twoWorkerObservation = zeroStrategicObservationSchema.parse({
    zeroAgentId: zero,
    tickNumber: 1,
    virtualTime: '2026-09-22T12:00:00.000Z',
    cells: [
      { cell, state: 'infected' as const, controllerAgentId: zero },
      { cell: openCell, state: 'open' as const, controllerAgentId: null },
      { cell: openCell2, state: 'open' as const, controllerAgentId: null },
    ],
    agents: [
      {
        agentId: zero,
        position: cell,
        controlledCellCount: 1,
        territoryDelta: 0,
        localPressure: 'low',
        pressureDirection: null,
        pressureDistance: null,
      },
      {
        agentId: worker,
        position: cell,
        controlledCellCount: 0,
        territoryDelta: 0,
        localPressure: 'low',
        pressureDirection: null,
        pressureDistance: null,
      },
      {
        agentId: worker2,
        position: cell,
        controlledCellCount: 0,
        territoryDelta: 0,
        localPressure: 'low',
        pressureDirection: null,
        pressureDistance: null,
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
    worldSummary: {
      totalCells: 3,
      openCells: 2,
      swarmInfectedCells: 1,
      abandonedInfectedCells: 0,
      openFrontierCells: 2,
    },
    workerOptions: [
      {
        agentId: worker,
        options: [
          {
            optionId: 'w0_o0',
            mission: 'hold' as const,
            targetCell: null,
            direction: null,
            distance: 0,
            targetState: null,
            territoryRelation: null,
            pressureAtTarget: 'low' as const,
            pressureEffect: 'none' as const,
            crowding: 0,
            continuesActiveDirective: false,
            description: 'Hold current position.',
          },
          {
            optionId: 'w0_o1',
            mission: 'expand' as const,
            targetCell: openCell,
            direction: 'N' as const,
            distance: 1,
            targetState: 'open' as const,
            territoryRelation: 'open-frontier' as const,
            pressureAtTarget: 'low' as const,
            pressureEffect: 'none' as const,
            crowding: 0,
            continuesActiveDirective: false,
            description: 'Expand to open frontier cell.',
          },
        ],
      },
      {
        agentId: worker2,
        options: [
          {
            optionId: 'w1_o0',
            mission: 'hold' as const,
            targetCell: null,
            direction: null,
            distance: 0,
            targetState: null,
            territoryRelation: null,
            pressureAtTarget: 'low' as const,
            pressureEffect: 'none' as const,
            crowding: 0,
            continuesActiveDirective: false,
            description: 'Hold current position.',
          },
          {
            optionId: 'w1_o1',
            mission: 'expand' as const,
            targetCell: openCell2,
            direction: 'S' as const,
            distance: 1,
            targetState: 'open' as const,
            territoryRelation: 'open-frontier' as const,
            pressureAtTarget: 'low' as const,
            pressureEffect: 'none' as const,
            crowding: 0,
            continuesActiveDirective: false,
            description: 'Expand to open frontier cell.',
          },
        ],
      },
    ],
  });

  it('rejects a directive whose optionId belongs to a different worker', async () => {
    // worker_0 submits w1_o1 — an option that belongs to worker_1
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse({
            strategySummary: 'Cross-worker option attempt.',
            zeroActionCandidateId: 'zero_action_0',
            directives: [
              {
                workerId: 'worker_0',
                optionId: 'w1_o1', // belongs to worker_1, not worker_0
                priority: 'normal',
                riskTolerance: 'medium',
              },
              {
                workerId: 'worker_1',
                optionId: 'w1_o0',
                priority: 'normal',
                riskTolerance: 'medium',
              },
            ],
          }),
        ),
      }).plan(twoWorkerObservation, 'test-model'),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message:
          'Agent Zero plan rejected: optionId belongs to different worker.',
      },
    });
  });

  it('rejects a model response shaped like a v1 plan (agentId, mission, targetCell, no optionId)', async () => {
    // v1-shaped plan: directives carry agentId, mission, targetCell, id, ticks — no optionId.
    // The model must never return raw H3 cell IDs; compactPlanSchema must reject this shape.
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse({
            strategySummary: 'Legacy v1 plan shape.',
            zeroActionCandidateId: 'zero_action_0',
            directives: [
              {
                id: 'directive-1',
                agentId: worker,
                mission: 'expand',
                targetCell: openCell,
                priority: 'normal',
                riskTolerance: 'medium',
                issuedAtTick: 1,
                expiresAtTick: 5,
              },
              {
                id: 'directive-2',
                agentId: worker2,
                mission: 'hold',
                targetCell: null,
                priority: 'normal',
                riskTolerance: 'medium',
                issuedAtTick: 1,
                expiresAtTick: 5,
              },
            ],
          }),
        ),
      }).plan(twoWorkerObservation, 'test-model'),
    ).rejects.toMatchObject({
      failure: { code: 'invalid-decision' },
    });
  });

  it('rejects a plan with a repeated workerId', async () => {
    // Two directives both name worker_0; worker_1 is missing.
    await expect(
      new OpenRouterSwarmPlanner({
        apiKey: 'test-key',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          plannerResponse({
            strategySummary: 'Repeated worker attempt.',
            zeroActionCandidateId: 'zero_action_0',
            directives: [
              {
                workerId: 'worker_0',
                optionId: 'w0_o0',
                priority: 'normal',
                riskTolerance: 'medium',
              },
              {
                workerId: 'worker_0', // repeated — worker_1 missing
                optionId: 'w0_o1',
                priority: 'normal',
                riskTolerance: 'medium',
              },
            ],
          }),
        ),
      }).plan(twoWorkerObservation, 'test-model'),
    ).rejects.toMatchObject({
      failure: { code: 'invalid-decision' },
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
