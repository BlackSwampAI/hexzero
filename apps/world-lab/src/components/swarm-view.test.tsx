import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SimulationSnapshot } from '@hexzero/shared';
import {
  SwarmActivityPanel,
  SwarmAgentInspector,
  SwarmRunPanel,
  SwarmStrategyPanel,
} from './swarm-view';

const zero = '00000000-0000-4000-8000-000000000001';
const worker = '00000000-0000-4000-8000-000000000002';
const cell = '8928308280fffff';

function snapshot(withTick = true): SimulationSnapshot {
  return {
    scenario: { patientZeroAgentId: zero },
    world: {
      agents: [
        { id: zero, name: 'Zero', currentCell: cell },
        { id: worker, name: 'Worker', currentCell: cell },
      ],
    },
    swarmTicks: withTick
      ? [
          {
            tickNumber: 3,
            planSource: 'deterministic-fallback',
            plannerFailure: { code: 'timeout', message: 'Planner timed out' },
            plan: {
              strategySummary: 'Secure the current infection.',
              directives: [
                {
                  id: 'directive-1',
                  agentId: worker,
                  mission: 'expand',
                  targetCell: cell,
                  priority: 'high',
                  riskTolerance: 'medium',
                  issuedAtTick: 3,
                  expiresAtTick: 5,
                },
              ],
              zeroActionCandidateId: 'zero_action_0',
            },
            zeroAction: { type: 'wait' },
            zeroActionResult: { accepted: true, event: { id: 'event-1' } },
            workers: [
              {
                agentId: worker,
                directive: {
                  id: 'directive-1',
                  agentId: worker,
                  mission: 'expand',
                  targetCell: cell,
                  priority: 'high',
                  riskTolerance: 'medium',
                  issuedAtTick: 3,
                  expiresAtTick: 5,
                },
                action: { type: 'infect' },
                actionResult: {
                  accepted: false,
                  reason: 'already-infected',
                  details: 'already infected',
                },
                source: 'jev-reflex',
                reflexDecision: {
                  chosenCandidateId: 'action_1',
                  confidence: 0.72,
                  probabilities: { action_0: 0.28, action_1: 0.72 },
                  model: 'jev',
                  latencyMs: 12,
                  inputTokens: 4,
                  outputTokens: 2,
                  directiveId: 'directive-1',
                  cognitionSource: 'jev-reflex',
                },
              },
            ],
          },
        ]
      : [],
    experiment: {
      attemptAccounting: {
        attemptsStarted: 2,
        attemptsFinalized: 2,
        attemptsWithUnknownCost: 1,
        knownFinalizedCostCredits: '0.02',
        committedCreditExposure: '0.03',
        reservationCreditsPerAttempt: '0.01',
      },
    },
    swarmProviderStatus: {
      plannerMode: 'openrouter-swarm',
      plannerConfigured: true,
      reflexMode: 'typesafe-jev',
      reflexConfigured: true,
      reflexModel: 'jev',
    },
  } as unknown as SimulationSnapshot;
}

describe('swarm telemetry panels', () => {
  it('summarizes inactive player pressure, actions, and provider failures', () => {
    const value = snapshot();
    value.swarmTicks![0]!.workers[0]!.failure = {
      code: 'invalid-decision',
      message:
        'TypeSafe Jev returned an incomplete or inconsistent probability distribution.',
      retryable: false,
    };
    render(<SwarmActivityPanel snapshot={value} />);
    expect(
      screen.getByRole('tabpanel', { name: 'Swarm activity' }),
    ).toHaveAttribute('tabindex', '0');
    const diagnostic = screen.getByRole('status');
    expect(diagnostic).toHaveTextContent('0 moves');
    expect(diagnostic).toHaveTextContent('1 infections');
    expect(diagnostic).toHaveTextContent('1 Zero fallbacks');
    expect(diagnostic).toHaveTextContent('Simulated player pressure is off');
    expect(diagnostic).toHaveTextContent('Zero planner failure: timeout');
    expect(diagnostic).toHaveTextContent(
      'Worker: invalid-decision · TypeSafe Jev returned an incomplete or inconsistent probability distribution.',
    );
  });

  it('shows Zero fallback and worker reflex telemetry without social labels', () => {
    const value = snapshot();
    render(
      <>
        <SwarmStrategyPanel snapshot={value} />
        <SwarmAgentInspector
          snapshot={value}
          agent={value.world.agents[1]!}
          cellState="infected"
          controlledCellCount={1}
        />
        <SwarmRunPanel snapshot={value} status="paused" runTarget={10} />
      </>,
    );
    expect(screen.getByText('Deterministic fallback')).toBeInTheDocument();
    expect(screen.getByText(/Planner timed out/)).toBeInTheDocument();
    expect(screen.getAllByText('action_1')).toHaveLength(2);
    expect(screen.getAllByText('72%')).toHaveLength(2);
    expect(
      screen.getByText(/TypeSafe Jev reports tokens, no monetary cost/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/alliance|chat|personality|memory/i),
    ).not.toBeInTheDocument();
  });

  it('separates reported provider cost from admission exposure', () => {
    const value = snapshot();
    render(<SwarmRunPanel snapshot={value} status="paused" runTarget={10} />);
    expect(screen.getByText('Provider-reported cost')).toBeInTheDocument();
    expect(screen.getByText('0.02 credits')).toBeInTheDocument();
    expect(
      screen.getByText('Admission exposure (not spend)'),
    ).toBeInTheDocument();
    expect(screen.getByText(/0.03 credits · includes/)).toBeInTheDocument();
  });

  it('shows the telemetry empty state before the first committed tick', () => {
    render(<SwarmStrategyPanel snapshot={snapshot(false)} />);
    expect(
      screen.getByText('No committed swarm tick telemetry yet.'),
    ).toBeInTheDocument();
  });

  it('keeps fallback worker actions and failures visible without Jev telemetry', () => {
    const value = snapshot();
    const fallback = value.swarmTicks![0]!.workers[0]!;
    fallback.source = 'deterministic-fallback';
    fallback.action = { type: 'wait' };
    fallback.reflexDecision = undefined;
    fallback.failure = {
      code: 'timeout',
      message: 'Reflex timed out',
      retryable: true,
    };
    render(
      <SwarmAgentInspector
        snapshot={value}
        agent={value.world.agents[1]!}
        cellState="infected"
        controlledCellCount={1}
      />,
    );
    expect(screen.getByText('Fallback action')).toBeInTheDocument();
    expect(
      screen.getByText(/Wait · Rejected · already-infected/),
    ).toBeInTheDocument();
    expect(screen.getByText('deterministic-fallback')).toBeInTheDocument();
    expect(screen.getByText(/Reflex timed out/)).toBeInTheDocument();
  });

  it('distinguishes reused directives and shows a structured worker replan request', () => {
    const value = snapshot();
    const tick = value.swarmTicks![0]!;
    tick.planSource = 'directive-reuse';
    tick.replanReasons = [];
    tick.workers[0]!.reflexDecision!.replanProbability = 0.91;
    tick.signals = [
      {
        type: 'worker-replan-requested',
        agentId: value.world.agents[1]!.id,
        directiveId: 'directive-1',
        probability: 0.91,
      },
    ];
    render(
      <>
        <SwarmStrategyPanel snapshot={value} />
        <SwarmAgentInspector
          snapshot={value}
          agent={value.world.agents[1]!}
          cellState="infected"
          controlledCellCount={1}
        />
        <SwarmRunPanel snapshot={value} status="paused" runTarget={10} />
      </>,
    );
    expect(screen.getByText('Active directives reused')).toBeInTheDocument();
    expect(screen.getByText(/91% · request sent to Zero/)).toBeInTheDocument();
    expect(
      screen.getByText('Retained Zero plans / reused ticks'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 / 1')).toBeInTheDocument();
    expect(
      screen.getByText('Retained worker replan requests'),
    ).toBeInTheDocument();
  });
});
