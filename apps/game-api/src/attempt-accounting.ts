import type { ProviderMetadata } from '@hexzero/shared';
import { addDecimalValue } from './experiment-export';

export interface AttemptAccountingSnapshot {
  providerAttemptLimit: number | null;
  reservedPermits: number;
  attemptsStarted: number;
  attemptsFinalized: number;
  attemptsInFlight: number;
  remainingAttempts: number | null;
  knownCostCredits: number;
  attemptsWithUnknownCost: number;
  exhausted: boolean;
  exhaustionReason: 'provider-attempt-limit' | null;
}

/** Billing accounting is independent of transactional world/tick state. */
export class AttemptAccounting {
  #reserved = 0;
  #started = 0;
  #finalized = 0;
  #knownCost = '0';
  #unknownCost = 0;
  #nextPermitId = 1;
  readonly #inFlight = new Set<number>();
  #exhausted = false;

  constructor(readonly limit: number | null) {}

  reserve(count: number): boolean {
    if (!Number.isInteger(count) || count < 1)
      throw new Error('Attempt reservation count must be a positive integer.');
    if (
      this.limit !== null &&
      this.#started + this.#reserved + count > this.limit
    ) {
      this.#exhausted = true;
      return false;
    }
    this.#reserved += count;
    return true;
  }

  startReserved(): number | null {
    if (this.#reserved < 1) return null;
    this.#reserved -= 1;
    this.#started += 1;
    const permitId = this.#nextPermitId++;
    this.#inFlight.add(permitId);
    return permitId;
  }

  startAdditional(): number | null {
    if (!this.reserve(1)) return null;
    return this.startReserved();
  }

  releaseReservations(): void {
    this.#reserved = 0;
  }

  finalize(permitId: number, metadata?: ProviderMetadata): void {
    if (!this.#inFlight.delete(permitId)) return;
    this.#finalized += 1;
    if (metadata?.costCredits === undefined) this.#unknownCost += 1;
    else
      this.#knownCost = addDecimalValue(this.#knownCost, metadata.costCredits);
  }

  snapshot(): AttemptAccountingSnapshot {
    const remaining =
      this.limit === null
        ? null
        : Math.max(0, this.limit - this.#started - this.#reserved);
    const exhausted =
      this.limit !== null &&
      (this.#exhausted || (remaining === 0 && this.#reserved === 0));
    return {
      providerAttemptLimit: this.limit,
      reservedPermits: this.#reserved,
      attemptsStarted: this.#started,
      attemptsFinalized: this.#finalized,
      attemptsInFlight: this.#inFlight.size,
      remainingAttempts: remaining,
      knownCostCredits: Number(this.#knownCost),
      attemptsWithUnknownCost: this.#unknownCost,
      exhausted,
      exhaustionReason: exhausted ? 'provider-attempt-limit' : null,
    };
  }
}
