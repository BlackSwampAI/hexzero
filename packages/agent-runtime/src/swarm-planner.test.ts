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

describe('swarm planners', () => {
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
});
