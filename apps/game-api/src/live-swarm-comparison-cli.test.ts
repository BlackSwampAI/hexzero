import { describe, expect, it, vi } from 'vitest';
import {
  markdownSummary,
  parseLiveComparisonArguments,
  runLiveComparisonCli,
} from './live-swarm-comparison-cli';

describe('live swarm comparison CLI', () => {
  it('refuses before constructing providers or calling the runner without cost acknowledgement', async () => {
    const runComparison = vi.fn();
    const providers = vi.fn();
    await expect(
      runLiveComparisonCli(['--model', 'openrouter/test'], {
        runComparison,
        providers,
        readFile: vi.fn(),
        env: { OPENROUTER_API_KEY: 'openrouter', TYPESAFE_API_KEY: 'typesafe' },
      } as never),
    ).rejects.toThrow('--confirm-provider-costs');
    expect(runComparison).not.toHaveBeenCalled();
    expect(providers).not.toHaveBeenCalled();
  });

  it('requires an explicit model after acknowledgement without invoking providers', async () => {
    const runComparison = vi.fn();
    const providers = vi.fn();
    await expect(
      runLiveComparisonCli(['--confirm-provider-costs'], {
        runComparison,
        providers,
        readFile: vi.fn(),
        env: { OPENROUTER_API_KEY: 'openrouter', TYPESAFE_API_KEY: 'typesafe' },
      } as never),
    ).rejects.toThrow('--model is required');
    expect(runComparison).not.toHaveBeenCalled();
    expect(providers).not.toHaveBeenCalled();
  });

  it('reads a saved report for a summary without acknowledgement, credentials, or providers', async () => {
    const runComparison = vi.fn();
    const providers = vi.fn();
    const report = {
      configuration: { modelId: 'openrouter/test', seeds: ['a'], tickCap: 20 },
      variants: [
        {
          variant: 'live-zero-jev',
          aggregate: {
            totalCaptures: 1,
            totalWorkerStalls: 2,
            openRouterTokens: { prompt: 10, completion: 4, total: 14 },
          },
        },
      ],
    };
    await expect(
      runLiveComparisonCli(['--summary-from', '/tmp/report.json'], {
        runComparison,
        providers,
        readFile: vi.fn().mockResolvedValue(JSON.stringify(report)),
        env: {},
      } as never),
    ).resolves.toContain('live-zero-jev');
    expect(runComparison).not.toHaveBeenCalled();
    expect(providers).not.toHaveBeenCalled();
  });

  it('rejects unsafe aggregate text in a hand-edited saved report', async () => {
    await expect(
      runLiveComparisonCli(['--summary-from', '/tmp/report.json'], {
        runComparison: vi.fn(),
        providers: vi.fn(),
        readFile: vi.fn().mockResolvedValue(
          JSON.stringify({
            configuration: {
              modelId: 'openrouter/test',
              seeds: ['a'],
              tickCap: 20,
            },
            variants: [
              {
                variant: 'live-zero-jev',
                aggregate: { captures: '| injected Markdown |' },
              },
            ],
          }),
        ),
        env: {},
      } as never),
    ).rejects.toThrow('invalid shape');
  });

  it('uses the bounded defaults and rejects oversized live inputs', () => {
    expect(
      parseLiveComparisonArguments([
        '--confirm-provider-costs',
        '--model',
        'openrouter/test',
      ]),
    ).toMatchObject({
      seeds: ['worker-capture-spawn', 'comparison-seed-b', 'comparison-seed-c'],
      ticks: 20,
      agents: 8,
      attempts: 200,
      creditLimit: '3',
      reservation: '0.02',
    });
    expect(() =>
      parseLiveComparisonArguments([
        '--model',
        'openrouter/test',
        '--ticks',
        '31',
      ]),
    ).toThrow('between 1 and 30');
    expect(() =>
      parseLiveComparisonArguments([
        '--model',
        'openrouter/test',
        '--agents',
        '1',
      ]),
    ).toThrow('between 2 and 8');
  });

  it('keeps survival, territory, stalls, replans, and cost separate in summaries', () => {
    expect(
      markdownSummary({
        configuration: {
          modelId: 'openrouter/test',
          seeds: ['a'],
          tickCap: 20,
        },
        variants: [
          { variant: 'live-zero-jev', aggregate: { totalCaptures: 1 } },
        ],
      } as never),
    ).toContain('This summary does not select a winner.');
  });
});
