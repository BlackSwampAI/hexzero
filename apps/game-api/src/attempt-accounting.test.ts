import { describe, expect, it } from 'vitest';
import { AttemptAccounting } from './attempt-accounting';

describe('AttemptAccounting', () => {
  it('reserves atomically and finalizes known and unknown cost exactly once', () => {
    const accounting = new AttemptAccounting(3);
    expect(accounting.reserve(3)).toBe(true);
    expect(accounting.reserve(1)).toBe(false);
    const first = accounting.startReserved()!;
    const second = accounting.startReserved()!;
    const third = accounting.startReserved()!;
    accounting.finalize(first, {
      provider: 'scripted-test',
      model: 'deterministic-script' as never,
      latencyMs: 0,
      costCredits: 0.1,
    });
    accounting.finalize(first);
    accounting.finalize(second, {
      provider: 'scripted-test',
      model: 'deterministic-script' as never,
      latencyMs: 0,
      costCredits: 0.2,
    });
    accounting.finalize(third);
    expect(accounting.snapshot()).toEqual({
      providerAttemptLimit: 3,
      reservedPermits: 0,
      attemptsStarted: 3,
      attemptsFinalized: 3,
      attemptsInFlight: 0,
      remainingAttempts: 0,
      knownCostCredits: 0.3,
      attemptsWithUnknownCost: 1,
      exhausted: true,
      exhaustionReason: 'provider-attempt-limit',
    });
  });

  it('releases unused reservations without charging them', () => {
    const accounting = new AttemptAccounting(3);
    expect(accounting.reserve(3)).toBe(true);
    const permit = accounting.startReserved()!;
    accounting.finalize(permit);
    accounting.releaseReservations();
    expect(accounting.snapshot()).toMatchObject({
      attemptsStarted: 1,
      attemptsFinalized: 1,
      remainingAttempts: 2,
      attemptsWithUnknownCost: 1,
      exhausted: false,
    });
  });

  it('reports explicit unlimited capacity', () => {
    const accounting = new AttemptAccounting(null);
    expect(accounting.startAdditional()).not.toBeNull();
    expect(accounting.snapshot()).toMatchObject({
      providerAttemptLimit: null,
      remainingAttempts: null,
      exhausted: false,
      exhaustionReason: null,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid internal reservation count %s',
    (count) => {
      const accounting = new AttemptAccounting(10);
      expect(() => accounting.reserve(count)).toThrow(
        'Attempt reservation count must be a positive integer.',
      );
      expect(accounting.snapshot().attemptsStarted).toBe(0);
    },
  );
});
