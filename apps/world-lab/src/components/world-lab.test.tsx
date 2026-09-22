import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulationSnapshotSchema } from '@hexzero/shared';
import {
  createDefaultAppliedScenario,
  createDevelopmentWorld,
} from '@hexzero/world-engine';
import { WorldLab } from './world-lab';

vi.mock('./world-map', () => ({
  WorldMap: () => <div aria-label="World map" />,
}));

const world = createDevelopmentWorld({
  generatedAt: '2026-08-13T12:00:00.000Z',
});
const metrics = {
  totalTurns: 0,
  accepted: 0,
  rejected: 0,
  providerErrors: 0,
  requestedMoves: 0,
  requestedInfections: 0,
  requestedCaptures: 0,
  requestedWaits: 0,
  acceptedMovements: 0,
  successfullyInfectedCells: 0,
  successfulCaptures: 0,
  acceptedWaits: 0,
  rejectedWorldActions: 0,
  territoryGainedThroughInfection: 0,
  territoryGainedThroughCapture: 0,
  territoryLostThroughCapture: 0,
  publicMessagesRequested: 0,
  publicMessagesAccepted: 0,
  publicMessagesRejected: 0,
  directMessagesRequested: 0,
  directMessagesDelivered: 0,
  directMessagesRejected: 0,
  publicMessagesSent: 0,
  directMessagesSent: 0,
  directMessagesReceived: 0,
  uniqueVisitedCells: 0,
  tokens: {},
  knownCostCredits: 0,
};
const snapshot = simulationSnapshotSchema.parse({
  world,
  scenario: createDefaultAppliedScenario('2026-08-13T12:00:00.000Z'),
  tickNumber: 0,
  virtualTime: '2026-08-13T12:00:00.000Z',
  lastTickIntervalMinutes: null,
  resolutionOrder: [],
  activeAgentId: null,
  status: 'paused',
  providerMode: 'scripted-test',
  providerConfigured: true,
  swarmProviderStatus: {
    plannerMode: 'scripted-swarm-test',
    plannerConfigured: true,
    reflexMode: 'scripted-reflex-test',
    reflexConfigured: true,
  },
  modelConfiguration: {
    globalModelId: 'deterministic-script',
    globalReasoningProfile: 'provider-default',
    overrides: [],
    locked: false,
  },
  resolvedModels: world.agents.map(({ id }) => ({
    agentId: id,
    modelId: 'deterministic-script',
    source: 'global',
    available: true,
  })),
  swarmTicks: [],
  experiment: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: '2026-08-13T12:00:00.000Z',
    metrics: {
      aggregate: metrics,
      byAgent: world.agents.map(({ id }) => ({ agentId: id, metrics })),
    },
    currentTerritory: world.agents.map(({ id, name, color }) => ({
      agentId: id,
      name,
      color,
      controlledCellCount: 0,
    })),
    simulatedPlayerMetrics: {
      movements: 0,
      cellsDisinfected: 0,
      blockedDisinfections: 0,
    },
  },
});

function response(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
}

function committedTick(tickNumber: number) {
  const virtualTime = `2026-08-13T12:${String(tickNumber).padStart(2, '0')}:00.000Z`;
  const next = simulationSnapshotSchema.parse({
    ...snapshot,
    tickNumber,
    virtualTime,
    lastTickIntervalMinutes: 1,
    resolutionOrder: world.agents.map(({ id }) => id),
    swarmTicks: [
      {
        tickNumber,
        virtualTime,
        tickIntervalMinutes: 1,
        plan: {
          strategySummary: 'Hold the frontier.',
          directives: [],
          zeroActionCandidateId: 'zero_action_0',
        },
        planSource: 'deterministic-fallback',
        workers: [],
      },
    ],
  });
  return { snapshot: next, tickNumber, swarmTick: next.swarmTicks![0] };
}

afterEach(() => vi.unstubAllGlobals());

describe('WorldLab swarm workspace', () => {
  it('shows the fixed swarm architecture and Agent Zero model readiness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response(snapshot)),
    );
    render(<WorldLab />);
    expect(await screen.findByText('Swarm experiment')).toBeVisible();
    expect(screen.getByText('Architecture: zero-swarm-v1')).toBeVisible();
    expect(screen.getByText(/Zero: deterministic-script/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('applies a fresh swarm setup without an architecture selector', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        if (String(input).endsWith('/setup/preview'))
          return response({
            feasible: true,
            scenario: snapshot.scenario,
            world: snapshot.world,
          });
        if (String(input).endsWith('/experiment/setup'))
          return response({ snapshot });
        return response(snapshot);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', { name: 'Current swarm architecture' }),
    );
    expect(screen.queryByLabelText('Cognition mode')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(
      screen.getByRole('button', { name: 'Apply / Create Experiment' }),
    );
    expect(calls.some((call) => call.endsWith('/experiment/setup'))).toBe(true);
  });

  it('commits a swarm tick through the tick endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/tick')
          ? response(committedTick(1))
          : response(snapshot),
      ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', { name: 'Single tick' }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Experiment details. Tick 1, paused',
      }),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resets from a committed swarm tick', async () => {
    let reset = false;
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/reset')) {
          reset = true;
          return response({ snapshot });
        }
        return response(reset ? snapshot : committedTick(1).snapshot);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', { name: 'Reset world' }),
    );
    expect(reset).toBe(true);
    expect(await screen.findByText('Tick 0')).toBeVisible();
  });

  it('runs to the exact tick cap without overlapping tick requests', async () => {
    let current = snapshot;
    let requests = 0;
    let active = 0;
    let maximumActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (!String(input).includes('/tick')) return response(current);
        requests += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        current = committedTick(requests).snapshot;
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            active -= 1;
            resolve(
              new Response(JSON.stringify(committedTick(requests)), {
                status: 200,
              }),
            );
          }, 1);
        });
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Run to tick 25' });
    await user.selectOptions(screen.getByLabelText('Tick target'), '5');
    await user.selectOptions(screen.getByLabelText('Playback speed'), '250');
    await user.click(screen.getByRole('button', { name: 'Run to tick 5' }));
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Experiment details. Tick 5, paused',
        }),
      ).toBeVisible(),
    );
    expect(requests).toBe(5);
    expect(maximumActive).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toBe(5);
  }, 10_000);

  it('reconciles the authoritative snapshot after cancelling an active tick', async () => {
    let resolveTick!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/tick/cancel')) return response({ snapshot });
        if (url.includes('/tick'))
          return new Promise<Response>((resolve) => {
            resolveTick = resolve;
          });
        return response(snapshot);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', { name: 'Single tick' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/tick/cancel'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    resolveTick(
      new Response(JSON.stringify({ cancelled: true, snapshot }), {
        status: 200,
      }),
    );
    expect(await screen.findByText('Tick 0')).toBeVisible();
  });

  it('requests a bounded full-safe swarm export preview before enabling export actions', async () => {
    const preview = {
      experimentId: snapshot.experiment.id,
      matchingTickCount: 0,
      matchingSwarmTickCount: 0,
      matchingControlChangeCount: 0,
      matchingProviderAttemptCount: 0,
      selectedAgentCount: world.agents.length,
      retention: {
        limit: 5000,
        totalCompletedTurns: 0,
        retainedTurns: 0,
        droppedRecords: 0,
        complete: true,
        requestedRangeExtendsBeyondRetention: false,
      },
      knownCostCredits: 0,
      attemptsWithUnknownCost: 0,
      serializedUtf8Bytes: 100,
      approximateAiInputTokens: 25,
      tokenEstimateMethod: 'ceil(UTF-8 bytes / 4)' as const,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith('/experiment/export/preview')
          ? response(preview)
          : response(snapshot),
      ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByLabelText('More World Lab actions'));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByLabelText('Export preview')).toBeVisible();
    const previewRequest = vi
      .mocked(fetch)
      .mock.calls.find(([url]) =>
        String(url).endsWith('/experiment/export/preview'),
      );
    expect(JSON.parse(String(previewRequest?.[1]?.body))).toMatchObject({
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      level: 'full-safe',
    });
    expect(
      screen.getByRole('button', { name: 'Download JSON' }),
    ).toBeDisabled();
  });

  it('model console shows exactly one Agent Zero planner row and no per-agent override controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response(snapshot)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByLabelText('More World Lab actions'));
    await user.click(screen.getByRole('button', { name: 'Agent setup' }));
    const trigger = await screen.findByRole('button', {
      name: /Agent Zero model/,
    });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', {
      name: 'Agent Zero model selection',
    });
    expect(dialog).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(within(dialog).getByText('Agent Zero')).toBeVisible();
    for (const { name } of world.agents) {
      expect(within(dialog).queryByText(name)).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('tab', { name: 'Models' }));
    expect(screen.queryByText('Agent overrides')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Apply global model to all agents'),
    ).not.toBeInTheDocument();
  });

  it('export dialog offers JSON serialization but no agent / turn / level / outcome / action filters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response(snapshot)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByLabelText('More World Lab actions'));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.queryByText('Export level')).not.toBeInTheDocument();
    expect(screen.queryByText('Turn range')).not.toBeInTheDocument();
    expect(screen.queryByText('Outcomes')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Generate export' }),
    ).toBeVisible();
    expect(screen.getByLabelText('JSON serialization')).toBeVisible();
  });
});
