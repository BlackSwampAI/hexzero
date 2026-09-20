import { describe, expect, it } from 'vitest';
import { runOfflineComparison } from './swarm-comparison';

describe('runOfflineComparison', () => {
  it('is byte-for-byte reproducible for the same deterministic inputs', async () => {
    const options = { seeds: ['worker-capture-spawn'], tickCap: 3 };
    await expect(runOfflineComparison(options)).resolves.toEqual(
      await runOfflineComparison(options),
    );
  });

  it('covers every comparison mode and retains engine capture telemetry', async () => {
    const report = await runOfflineComparison({
      seeds: ['worker-capture-spawn'],
      tickCap: 3,
    });
    expect(report.variants.map(({ variant }) => variant)).toEqual([
      'legacy-multi-agent',
      'zero-swarm-v1',
      'deterministic-worker-baseline',
    ]);
    for (const variant of report.variants) {
      const run = variant.runs[0]!;
      expect(run.providerAttempts.started).toBeGreaterThanOrEqual(0);
      expect(run.providerAttempts.finalized).toBe(run.providerAttempts.started);
      expect(run.final.captures).toBeGreaterThan(0);
    }
    const swarm = report.variants.find(
      ({ variant }) => variant === 'zero-swarm-v1',
    )!;
    expect(swarm.aggregate.totalGenerativeAttempts).toBeGreaterThan(0);
    expect(swarm.aggregate.totalReflexAttempts).toBeGreaterThan(0);
    const baseline = report.variants.find(
      ({ variant }) => variant === 'deterministic-worker-baseline',
    )!;
    expect(baseline.aggregate.totalReflexAttempts).toBe(0);
    expect(baseline.aggregate.totalProviderAttempts).toBe(
      baseline.aggregate.totalGenerativeAttempts,
    );
    expect(
      baseline.runs.flatMap(({ samples }) =>
        samples.flatMap(({ reflexConfidence }) => reflexConfidence),
      ),
    ).toEqual([]);
    expect(
      swarm.runs[0]!.samples.flatMap(
        ({ reflexProbabilityDistributions }) => reflexProbabilityDistributions,
      ),
    ).toEqual(expect.arrayContaining([expect.any(Object)]));
    expect(report.costDisclaimer).toContain('no authoritative billed');
  });

  it('continues legacy observations after captured message participants leave the roster', async () => {
    const report = await runOfflineComparison({
      seeds: ['worker-capture-spawn'],
      tickCap: 12,
    });
    const legacy = report.variants.find(
      ({ variant }) => variant === 'legacy-multi-agent',
    )!.runs[0]!;
    expect(legacy.samples).toHaveLength(12);
    expect(legacy.final.captures).toBeGreaterThan(0);
  });
});
