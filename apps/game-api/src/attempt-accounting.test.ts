import { describe, expect, it } from 'vitest';
import { AttemptAccounting } from './attempt-accounting';

describe('AttemptAccounting', () => {
  it('reserves atomically and finalizes known and unknown cost exactly once', () => {
    const accounting = new AttemptAccounting(3, '0.03', '0.01');
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
      creditLimit: '0.03',
      reservationCreditsPerAttempt: '0.01',
      unstartedReservedCredits: '0',
      committedCreditExposure: '0.31',
      remainingAdmissionCredits: '0',
      knownFinalizedCostCredits: '0.3',
      reservationOverageCredits: '0.28',
      attemptsWithUnknownCost: 1,
      exhausted: true,
      exhaustionReason: 'credit-reservation-overrun',
    });
  });

  it('releases unused reservations without charging them', () => {
    const accounting = new AttemptAccounting(3, '0.03', '0.01');
    expect(accounting.reserve(3)).toBe(true);
    const permit = accounting.startReserved()!;
    accounting.finalize(permit);
    accounting.releaseReservations();
    expect(accounting.snapshot()).toMatchObject({
      attemptsStarted: 1,
      attemptsFinalized: 1,
      remainingAttempts: 2,
      attemptsWithUnknownCost: 1,
      committedCreditExposure: '0.01',
      unstartedReservedCredits: '0',
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

  it('reports configured decimal inputs canonically', () => {
    const accounting = new AttemptAccounting(2, '1.00', '0.0100');
    expect(accounting.snapshot()).toMatchObject({
      creditLimit: '1',
      reservationCreditsPerAttempt: '0.01',
      remainingAdmissionCredits: '1',
    });
  });

  it('uses exact decimal admission, refunds known cost, and retains unknown exposure', () => {
    const accounting = new AttemptAccounting(null, '0.00000003', '0.00000001');
    expect(accounting.reserve(3)).toBe(true);
    expect(accounting.reserve(1)).toBe(false);
    const known = accounting.startReserved()!;
    const unknown = accounting.startReserved()!;
    accounting.finalize(known, {
      provider: 'scripted-test',
      model: 'deterministic-script' as never,
      latencyMs: 0,
      costCredits: 0.000000004,
    });
    accounting.finalize(unknown);
    accounting.releaseReservations();
    expect(accounting.snapshot()).toMatchObject({
      committedCreditExposure: '0.000000014',
      knownFinalizedCostCredits: '0.000000004',
      attemptsWithUnknownCost: 1,
      remainingAdmissionCredits: '0.000000016',
    });
  });

  it('rejects a reservation atomically and retains in-flight coverage', () => {
    const rejected = new AttemptAccounting(10, '0.02', '0.01');
    expect(rejected.reserve(3)).toBe(false);
    expect(rejected.reserve(1)).toBe(false);
    expect(rejected.snapshot()).toMatchObject({
      reservedPermits: 0,
      unstartedReservedCredits: '0',
      exhaustionReason: 'credit-admission-limit',
    });
    const accounting = new AttemptAccounting(10, '0.02', '0.01');
    expect(accounting.reserve(2)).toBe(true);
    expect(accounting.startReserved()).not.toBeNull();
    expect(accounting.snapshot()).toMatchObject({
      committedCreditExposure: '0.01',
      unstartedReservedCredits: '0.01',
    });
  });

  it('stops future admission after reported cost exceeds its reservation', () => {
    const accounting = new AttemptAccounting(null, '1', '0.01');
    const permit = accounting.startAdditional()!;
    accounting.finalize(permit, {
      provider: 'scripted-test',
      model: 'deterministic-script' as never,
      latencyMs: 0,
      costCredits: 0.015,
    });
    accounting.finalize(permit);
    expect(accounting.startAdditional()).toBeNull();
    expect(accounting.snapshot()).toMatchObject({
      committedCreditExposure: '0.015',
      knownFinalizedCostCredits: '0.015',
      reservationOverageCredits: '0.005',
      exhaustionReason: 'credit-reservation-overrun',
      attemptsFinalized: 1,
    });
  });

  it('reports an overage without exhausting unlimited credit admission', () => {
    const accounting = new AttemptAccounting(null, null, '0.01');
    const permit = accounting.startAdditional()!;
    accounting.finalize(permit, {
      provider: 'scripted-test',
      model: 'deterministic-script' as never,
      latencyMs: 0,
      costCredits: 0.015,
    });
    expect(accounting.startAdditional()).not.toBeNull();
    expect(accounting.snapshot()).toMatchObject({
      creditLimit: null,
      committedCreditExposure: '0.025',
      knownFinalizedCostCredits: '0.015',
      reservationOverageCredits: '0.005',
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
