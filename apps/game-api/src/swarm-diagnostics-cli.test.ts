import { describe, expect, it } from 'vitest';
import type { SimulationSnapshot } from '@hexzero/shared';
import { summarizeSwarmSnapshot } from './swarm-diagnostics-cli';

describe('swarm diagnostic projection', () => {
  it('shows why a stationary swarm has no player pressure and fallback actions', () => {
    const snapshot = {
      tickNumber: 1,
      scenario: {
        cognitionMode: 'zero-swarm-v1',
        patientZeroAgentId: 'zero',
        simulatedPlayer: { enabled: false, profile: 'casual-cleaner' },
      },
      world: { simulatedPlayer: null, hexes: [] },
      resolvedModels: [{ agentId: 'zero', modelId: 'google/gemini-test' }],
      swarmProviderStatus: {
        plannerMode: 'openrouter-swarm',
        plannerConfigured: true,
        reflexMode: 'typesafe-jev',
        reflexConfigured: true,
      },
      experiment: {
        attemptAccounting: {
          attemptsStarted: 8,
          attemptsFinalized: 8,
          attemptsWithUnknownCost: 7,
          knownFinalizedCostCredits: '0.02',
          committedCreditExposure: '0.09',
          reservationCreditsPerAttempt: '0.01',
        },
      },
      swarmTicks: [
        {
          tickNumber: 1,
          planSource: 'deterministic-fallback',
          plannerFailure: { code: 'malformed-response' },
          zeroAction: { type: 'wait' },
          zeroActionResult: { accepted: true },
          workers: [
            {
              agentId: 'worker',
              action: { type: 'wait' },
              source: 'deterministic-fallback',
              failure: { code: 'timeout', message: 'Jev timed out.' },
            },
          ],
        },
      ],
    } as unknown as SimulationSnapshot;
    expect(summarizeSwarmSnapshot(snapshot)).toMatchObject({
      tick: 1,
      infectedCells: 0,
      player: { enabled: false, active: false, movements: 0 },
      attempts: {
        started: 8,
        finalized: 8,
        unknownCost: 7,
        providerReportedCostCredits: '0.02',
        admissionExposureCredits: '0.09',
        reservePerAttemptCredits: '0.01',
      },
      recentTicks: [
        {
          planSource: 'deterministic-fallback',
          plannerFailureCode: 'malformed-response',
          zeroAction: 'wait',
          workerActions: { wait: 1 },
          workerFallbacks: 1,
          workerFailureCodes: ['timeout'],
          workerFailures: [
            { agentId: 'worker', code: 'timeout', message: 'Jev timed out.' },
          ],
        },
      ],
    });
    expect(JSON.stringify(summarizeSwarmSnapshot(snapshot))).not.toContain(
      'apiKey',
    );
  });
});
