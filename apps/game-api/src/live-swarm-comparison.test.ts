import { describe, expect, it, vi } from 'vitest';
import {
  ScriptedReflexProvider,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  runLiveComparison,
  type LiveComparisonConfig,
  type LiveComparisonProviders,
} from './live-swarm-comparison';

const config = (): LiveComparisonConfig => ({
  confirmed: true,
  modelId: 'operator/model',
  seeds: ['worker-capture-spawn'],
  tickCap: 2,
  agentCount: 8,
  providerAttemptLimit: 12,
  creditLimit: '1',
  reservationCreditsPerAttempt: '0.01',
});

describe('runLiveComparison admission guard', () => {
  it('rejects missing explicit confirmation before constructing a provider', async () => {
    const createPlanner = vi.fn();
    const providers = {
      createPlanner,
      createReflex: vi.fn(),
      createLegacy: vi.fn(),
    } as unknown as LiveComparisonProviders;

    await expect(
      runLiveComparison({ ...config(), confirmed: false } as never, providers),
    ).rejects.toThrow('explicit provider-cost confirmation');
    expect(createPlanner).not.toHaveBeenCalled();
  });

  it('enforces the fixed live experiment caps before constructing a provider', async () => {
    const createPlanner = vi.fn();
    const providers = {
      createPlanner,
      createReflex: vi.fn(),
      createLegacy: vi.fn(),
    } as unknown as LiveComparisonProviders;

    await expect(
      runLiveComparison({ ...config(), tickCap: 31 }, providers),
    ).rejects.toThrow('tickCap must be an integer between 1 and 30');
    expect(createPlanner).not.toHaveBeenCalled();
  });

  it('runs matched seeded inputs while omitting Jev calls in the deterministic control', async () => {
    const observations: string[] = [];
    const decide = vi.fn();
    const providers: LiveComparisonProviders = {
      createPlanner: () =>
        ({
          mode: 'scripted-swarm-test',
          configured: true,
          async plan(observation, model, options) {
            observations.push(JSON.stringify(observation));
            const plan = {
              strategySummary: 'Hold the seeded perimeter.',
              zeroActionCandidateId: observation.legalZeroActions.find(
                ({ action }) => action.type === 'wait',
              )!.id,
              directives: observation.agents
                .filter(({ agentId }) => agentId !== observation.zeroAgentId)
                .map((agent, index) => ({
                  id: `hold-${observation.tickNumber}-${index}`,
                  agentId: agent.agentId,
                  mission: 'hold' as const,
                  targetCell: agent.position,
                  priority: 'normal' as const,
                  riskTolerance: 'low' as const,
                  issuedAtTick: observation.tickNumber,
                  expiresAtTick: observation.tickNumber + 4,
                })),
            };
            const metadata = {
              provider: 'openrouter' as const,
              model,
              latencyMs: 2,
              promptTokens: 10,
              completionTokens: 4,
              totalTokens: 14,
              costCredits: 0.001,
            };
            options?.beginAttempt?.('initial')?.({
              outcome: 'completed',
              provider: metadata,
              swarmPlan: plan,
            });
            return { plan, metadata };
          },
        }) satisfies SwarmPlanner,
      createReflex: () => {
        const scripted = new ScriptedReflexProvider(
          Array.from({ length: 8 }, () => ({ chosenCandidateId: 'action_0' })),
        );
        return {
          ...scripted,
          decide: decide.mockImplementation(scripted.decide.bind(scripted)),
        };
      },
    };
    const report = await runLiveComparison(
      { ...config(), tickCap: 1 },
      providers,
    );
    expect(report.variants.map(({ variant }) => variant)).toEqual([
      'live-zero-jev',
      'live-zero-deterministic-workers',
    ]);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toBe(observations[1]);
    expect(decide.mock.calls.length).toBeGreaterThan(0);
    expect(report.variants[0]!.aggregate.jevAttempts).toBe(
      decide.mock.calls.length,
    );
    expect(report.variants[1]!.aggregate.jevAttempts).toBe(0);
    expect(report.variants[0]!.aggregate.zeroPlanningAttempts).toBe(1);
    expect(report.variants[1]!.aggregate.zeroPlanningAttempts).toBe(1);
    expect(report.variants[0]!.aggregate.openRouterTokens).toEqual({
      prompt: 10,
      completion: 4,
      total: 14,
    });
    expect(report.variants[0]!.aggregate.providerLatencyMs).toBeGreaterThan(0);
    expect(report.variants[0]!.runs[0]!.ticks[0]!.openRouterTokens.total).toBe(
      14,
    );
    expect(
      report.variants[0]!.runs[0]!.ticks[0]!.actualOpenRouterCostCredits,
    ).toBe('0.001');
    expect(
      report.variants[0]!.runs[0]!.effort.actualOpenRouterCostCredits,
    ).toBe('0.001');
    expect(report.variants[1]!.runs[0]!.effort.typeSafeCostCredits).toBeNull();
  });
});
