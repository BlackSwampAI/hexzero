import {
  providerAttemptRecordSchema,
  type AgentId,
  type ModelAttempt,
  type ModelId,
  type ProviderAttemptRecord,
  type ProviderFailure,
  type ProviderMetadata,
  type ReasoningProfile,
} from '@hexzero/shared';

export type AttemptExhaustionReason =
  | 'provider-attempt-limit'
  | 'credit-admission-limit'
  | 'credit-reservation-overrun';

export interface AttemptAccountingSnapshot {
  providerAttemptLimit: number | null;
  reservedPermits: number;
  attemptsStarted: number;
  attemptsFinalized: number;
  attemptsInFlight: number;
  remainingAttempts: number | null;
  creditLimit: string | null;
  reservationCreditsPerAttempt: string;
  unstartedReservedCredits: string;
  committedCreditExposure: string;
  remainingAdmissionCredits: string | null;
  knownFinalizedCostCredits: string;
  reservationOverageCredits: string;
  attemptsWithUnknownCost: number;
  exhausted: boolean;
  exhaustionReason: AttemptExhaustionReason | null;
}

export interface AttemptStart {
  agentId: AgentId;
  intendedTurnNumber: number;
  intendedTickNumber?: number;
  kind: ModelAttempt['kind'];
  startedAt: string;
  modelId: ModelId;
  reasoningProfile: ReasoningProfile;
}

export interface AttemptCompletion {
  outcome: 'completed' | 'provider-error' | 'cancelled' | 'timeout';
  completedAt: string;
  provider?: ProviderMetadata;
  failure?: ProviderFailure;
}

interface Decimal {
  integer: bigint;
  scale: number;
}

function parts(value: string | number): Decimal {
  const [mantissa, exponentText = '0'] = value
    .toString()
    .toLowerCase()
    .split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  let integer = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - Number(exponentText);
  if (scale < 0) {
    integer *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { integer, scale };
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.integer * 10n ** BigInt(scale - left.scale),
    right.integer * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function text(integer: bigint, scale: number): string {
  if (integer === 0n) return '0';
  if (scale === 0) return integer.toString();
  const padded = integer.toString().padStart(scale + 1, '0');
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
    .replace(/0+$/u, '')
    .replace(/\.$/u, '');
}

function add(left: string, right: string | number): string {
  const [a, b, scale] = align(parts(left), parts(right));
  return text(a + b, scale);
}

function subtractFloor(left: string, right: string): string {
  const [a, b, scale] = align(parts(left), parts(right));
  return text(a > b ? a - b : 0n, scale);
}

function compare(left: string, right: string): number {
  const [a, b] = align(parts(left), parts(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function multiply(value: string, count: number): string {
  const parsed = parts(value);
  return text(parsed.integer * BigInt(count), parsed.scale);
}

function canonical(value: string): string {
  const parsed = parts(value);
  return text(parsed.integer, parsed.scale);
}

/** Provider billing exposure is independent of transactional world/tick state. */
export class AttemptAccounting {
  #reserved = 0;
  #started = 0;
  #finalized = 0;
  #knownCost = '0';
  #committedExposure = '0';
  #reservationOverage = '0';
  #unknownCost = 0;
  #nextPermitId = 1;
  readonly #inFlight = new Set<number>();
  readonly #records = new Map<number, ProviderAttemptRecord>();
  #retainedRecords: ProviderAttemptRecord[] = [];
  #droppedRecords = 0;
  #exhaustionReason: AttemptExhaustionReason | null = null;
  readonly limit: number | null;
  readonly creditLimit: string | null;
  readonly reservationCreditsPerAttempt: string;

  constructor(
    limit: number | null,
    creditLimit: string | null = null,
    reservationCreditsPerAttempt = '0.01',
    readonly ledgerLimit = 10_000,
  ) {
    this.limit = limit;
    this.creditLimit = creditLimit === null ? null : canonical(creditLimit);
    this.reservationCreditsPerAttempt = canonical(reservationCreditsPerAttempt);
  }

  reserve(count: number): boolean {
    if (!Number.isInteger(count) || count < 1)
      throw new Error('Attempt reservation count must be a positive integer.');
    if (this.#exhaustionReason !== null) return false;
    if (
      this.limit !== null &&
      this.#started + this.#reserved + count > this.limit
    ) {
      this.#exhaustionReason = 'provider-attempt-limit';
      return false;
    }
    const requestedCredits = multiply(this.reservationCreditsPerAttempt, count);
    if (
      this.creditLimit !== null &&
      compare(
        add(
          add(this.#committedExposure, this.#reservedCredits()),
          requestedCredits,
        ),
        this.creditLimit,
      ) > 0
    ) {
      this.#exhaustionReason = 'credit-admission-limit';
      return false;
    }
    this.#reserved += count;
    return true;
  }

  startReserved(details?: AttemptStart): number | null {
    if (this.#reserved < 1) return null;
    const permitId = this.#nextPermitId;
    const record = details
      ? providerAttemptRecordSchema.parse({
          id: crypto.randomUUID(),
          ...details,
          outcome: 'in-flight',
          reservedCredits: this.reservationCreditsPerAttempt,
        })
      : undefined;
    this.#reserved -= 1;
    this.#started += 1;
    this.#committedExposure = add(
      this.#committedExposure,
      this.reservationCreditsPerAttempt,
    );
    this.#nextPermitId += 1;
    this.#inFlight.add(permitId);
    if (record) {
      this.#records.set(permitId, record);
      this.#retain(record);
    }
    return permitId;
  }

  startAdditional(details?: AttemptStart): number | null {
    if (!this.reserve(1)) return null;
    return this.startReserved(details);
  }

  releaseReservations(): void {
    this.#reserved = 0;
  }

  finalize(
    permitId: number,
    completion?: ProviderMetadata | AttemptCompletion,
  ): void {
    if (!this.#inFlight.has(permitId)) return;
    const detailed = completion && 'outcome' in completion ? completion : null;
    const metadata =
      detailed?.provider ??
      (completion && !('outcome' in completion) ? completion : undefined);
    const started = this.#records.get(permitId);
    let finalizedRecord: ProviderAttemptRecord | undefined;
    if (started && detailed) {
      finalizedRecord = providerAttemptRecordSchema.parse({
        ...started,
        ...detailed,
        actualCostCredits:
          metadata?.costCredits === undefined
            ? undefined
            : canonical(String(metadata.costCredits)),
      });
    }
    this.#inFlight.delete(permitId);
    this.#finalized += 1;
    if (started && finalizedRecord) {
      this.#records.delete(permitId);
      const index = this.#retainedRecords.findIndex(
        ({ id }) => id === started.id,
      );
      if (index >= 0) this.#retainedRecords[index] = finalizedRecord;
    }
    if (metadata?.costCredits === undefined) {
      this.#unknownCost += 1;
      return;
    }
    const actualParts = parts(metadata.costCredits);
    const actual = text(actualParts.integer, actualParts.scale);
    this.#knownCost = add(this.#knownCost, actual);
    const reservation = this.reservationCreditsPerAttempt;
    if (compare(actual, reservation) > 0) {
      const overage = subtractFloor(actual, reservation);
      this.#reservationOverage = add(this.#reservationOverage, overage);
      this.#committedExposure = add(this.#committedExposure, overage);
      if (this.creditLimit !== null)
        this.#exhaustionReason = 'credit-reservation-overrun';
    } else {
      this.#committedExposure = subtractFloor(
        this.#committedExposure,
        subtractFloor(reservation, actual),
      );
    }
  }

  #retain(record: ProviderAttemptRecord): void {
    this.#retainedRecords.push(record);
    while (this.#retainedRecords.length > this.ledgerLimit) {
      const removed = this.#retainedRecords.shift()!;
      for (const [permit, candidate] of this.#records)
        if (candidate.id === removed.id) this.#records.delete(permit);
      this.#droppedRecords += 1;
    }
  }

  ledger(): readonly ProviderAttemptRecord[] {
    return structuredClone(this.#retainedRecords);
  }

  retention() {
    return {
      limit: this.ledgerLimit,
      totalStartedAttempts: this.#started,
      retainedAttempts: this.#retainedRecords.length,
      droppedRecords: this.#droppedRecords,
      complete: this.#droppedRecords === 0,
      requestedRangeExtendsBeyondRetention: false,
    };
  }

  #reservedCredits(): string {
    return multiply(this.reservationCreditsPerAttempt, this.#reserved);
  }

  snapshot(): AttemptAccountingSnapshot {
    const remainingAttempts =
      this.limit === null
        ? null
        : Math.max(0, this.limit - this.#started - this.#reserved);
    const unstartedReservedCredits = this.#reservedCredits();
    const remainingAdmissionCredits =
      this.creditLimit === null
        ? null
        : subtractFloor(
            this.creditLimit,
            add(this.#committedExposure, unstartedReservedCredits),
          );
    let reason = this.#exhaustionReason;
    if (
      !reason &&
      this.limit !== null &&
      remainingAttempts === 0 &&
      this.#reserved === 0
    )
      reason = 'provider-attempt-limit';
    if (
      !reason &&
      this.creditLimit !== null &&
      compare(remainingAdmissionCredits!, this.reservationCreditsPerAttempt) <
        0 &&
      this.#reserved === 0
    )
      reason = 'credit-admission-limit';
    return {
      providerAttemptLimit: this.limit,
      reservedPermits: this.#reserved,
      attemptsStarted: this.#started,
      attemptsFinalized: this.#finalized,
      attemptsInFlight: this.#inFlight.size,
      remainingAttempts,
      creditLimit: this.creditLimit,
      reservationCreditsPerAttempt: this.reservationCreditsPerAttempt,
      unstartedReservedCredits,
      committedCreditExposure: this.#committedExposure,
      remainingAdmissionCredits,
      knownFinalizedCostCredits: this.#knownCost,
      reservationOverageCredits: this.#reservationOverage,
      attemptsWithUnknownCost: this.#unknownCost,
      exhausted: reason !== null,
      exhaustionReason: reason,
    };
  }
}
