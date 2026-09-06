import type {
  AgentId,
  AgentObservation,
  ModelAttempt,
  ModelId,
  ProviderFailure,
  ReasoningProfile,
} from '@hexzero/shared';
import { providerFailureSchema, providerMetadataSchema } from '@hexzero/shared';
import {
  AgentProviderError,
  type AgentProvider,
  type ProviderDecision,
} from './index';

export interface TickDecisionJob {
  agentId: AgentId;
  observation: AgentObservation;
  modelId: ModelId;
  reasoningProfile: ReasoningProfile;
}

export interface TickDecisionSuccess extends TickDecisionJob {
  outcome: 'completed';
  decision: ProviderDecision;
  attempts: ModelAttempt[];
}

export interface TickDecisionFailure extends TickDecisionJob {
  outcome: 'lost-tick';
  failure: ProviderFailure;
  attempts: ModelAttempt[];
}

export type TickDecisionResult = TickDecisionSuccess | TickDecisionFailure;

export interface TickDispatcherOptions {
  concurrency?: number;
  deadlineAtMs: number;
  signal?: AbortSignal;
  now?: () => string;
  nowMs?: () => number;
  waitForMs?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  beginAttempt?: (
    job: TickDecisionJob,
    kind: ModelAttempt['kind'],
  ) => ((metadata?: ProviderDecision['metadata']) => void) | null;
}

/**
 * Provider-neutral bounded dispatcher. Jobs retain their immutable observation
 * and share one absolute deadline; result order always matches input order.
 */
export async function dispatchTickDecisions(
  provider: AgentProvider,
  jobs: readonly TickDecisionJob[],
  options: TickDispatcherOptions,
): Promise<TickDecisionResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 8, jobs.length),
  );
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? Date.now;
  const waitForMs = options.waitForMs ?? cancellableWait;
  const results = new Array<TickDecisionResult>(jobs.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      if (options.signal?.aborted) throw cancelled();
      const index = cursor++;
      const job = jobs[index]!;
      const attempts: ModelAttempt[] = [];
      let kind: ModelAttempt['kind'] = 'initial';
      let feedback: ProviderFailure['validationCodes'];
      for (let call = 0; call < 2; call += 1) {
        if (options.signal?.aborted) throw cancelled();
        if (nowMs() >= options.deadlineAtMs) {
          results[index] = deadlineFailure(job, attempts);
          break;
        }
        const finalizeAccounting = options.beginAttempt?.(job, kind);
        if (options.beginAttempt && !finalizeAccounting) {
          const failure: ProviderFailure = {
            code: 'budget-exhausted',
            message:
              'The experiment does not have enough provider-attempt or credit-admission capacity.',
            retryable: false,
            model: job.modelId,
          };
          results[index] = { ...job, outcome: 'lost-tick', failure, attempts };
          break;
        }
        const startedAt = now();
        let accountingMetadata: ProviderDecision['metadata'] | undefined;
        try {
          const decision = await decideBeforeDeadline(provider, job, {
            reasoningProfile: job.reasoningProfile,
            validationFeedback: feedback,
            deadlineAtMs: options.deadlineAtMs,
            nowMs,
            signal: options.signal,
          });
          accountingMetadata = decision.metadata;
          if (nowMs() >= options.deadlineAtMs) {
            const completedAt = now();
            const failure = timeoutFailure(job);
            results[index] = deadlineFailure(job, [
              ...attempts,
              {
                attemptNumber: attempts.length + 1,
                kind,
                startedAt,
                completedAt,
                modelId: job.modelId,
                reasoningProfile: job.reasoningProfile,
                provider: decision.metadata,
                failure,
              },
            ]);
            break;
          }
          attempts.push({
            attemptNumber: attempts.length + 1,
            kind,
            startedAt,
            completedAt: now(),
            modelId: job.modelId,
            reasoningProfile: job.reasoningProfile,
            provider: decision.metadata,
          });
          results[index] = { ...job, outcome: 'completed', decision, attempts };
          break;
        } catch (error) {
          const providerError = sanitizedProviderError(error, job.modelId) ?? {
            failure: {
              code: 'network',
              message: 'The model provider failed unexpectedly.',
              retryable: false,
              model: job.modelId,
            } satisfies ProviderFailure,
            metadata: undefined,
          };
          accountingMetadata = providerError.metadata ?? accountingMetadata;
          if (
            providerError.failure.code === 'cancelled' ||
            options.signal?.aborted
          )
            throw cancelled();
          attempts.push({
            attemptNumber: attempts.length + 1,
            kind,
            startedAt,
            completedAt: now(),
            modelId: job.modelId,
            reasoningProfile: job.reasoningProfile,
            failure: providerError.failure,
            provider: providerError.metadata,
          });
          const repairable = Boolean(
            providerError.failure.validationCodes?.length,
          );
          const transient = isEstablishedTransient(providerError.failure);
          const delayMs = retryDelay(providerError.failure);
          if (
            call === 0 &&
            nowMs() + delayMs < options.deadlineAtMs &&
            (repairable || transient)
          ) {
            if (delayMs > 0) await waitForMs(delayMs, options.signal);
            feedback = providerError.failure.validationCodes;
            kind = repairable
              ? 'automatic-repair'
              : 'automatic-transport-retry';
            continue;
          }
          results[index] = {
            ...job,
            outcome: 'lost-tick',
            failure: providerError.failure,
            attempts,
          };
          break;
        } finally {
          finalizeAccounting?.(accountingMetadata);
        }
      }
    }
  };

  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, worker),
  );
  const cancellation = settled.find(
    (entry): entry is PromiseRejectedResult =>
      entry.status === 'rejected' && isCancelled(entry.reason),
  );
  if (cancellation) throw cancelled();
  const unexpected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
  );
  if (unexpected) throw unexpected.reason;
  return results;
}

async function decideBeforeDeadline(
  provider: AgentProvider,
  job: TickDecisionJob,
  options: {
    reasoningProfile: ReasoningProfile;
    validationFeedback?: ProviderFailure['validationCodes'];
    deadlineAtMs: number;
    nowMs: () => number;
    signal?: AbortSignal;
  },
): Promise<ProviderDecision> {
  const controller = new AbortController();
  const remaining = Math.max(0, options.deadlineAtMs - options.nowMs());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeOperatorListener = () => {};
  const providerPromise = provider.decide(
    structuredClone(job.observation),
    job.modelId,
    {
      reasoningProfile: options.reasoningProfile,
      signal: controller.signal,
      deadlineAtMs: options.deadlineAtMs,
      validationFeedback: options.validationFeedback,
    },
  );
  // Attach handlers through the race so a provider that settles after timeout
  // cannot create an unhandled rejection.
  const boundary = new Promise<never>((_resolve, reject) => {
    const cancel = () => {
      controller.abort();
      reject(cancelled());
    };
    if (options.signal?.aborted) return cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    removeOperatorListener = () =>
      options.signal?.removeEventListener('abort', cancel);
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('tick deadline'), { tickDeadline: true }));
    }, remaining);
  });
  try {
    return await Promise.race([providerPromise, boundary]);
  } catch (error) {
    if (error && typeof error === 'object' && 'tickDeadline' in error)
      throw new AgentProviderError(timeoutFailure(job, remaining));
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeOperatorListener();
  }
}

function isEstablishedTransient(failure: ProviderFailure): boolean {
  return (
    failure.retryable &&
    (failure.code === 'network' ||
      failure.code === 'timeout' ||
      failure.code === 'malformed-response' ||
      failure.code === 'unsupported-response' ||
      (failure.code === 'provider-http' &&
        [408, 429, 500, 502, 503, 504].includes(failure.httpStatus ?? 0)))
  );
}

function retryDelay(failure: ProviderFailure): number {
  if (failure.code !== 'provider-http' || failure.httpStatus !== 429) return 0;
  return failure.retryAfterMs ?? 1_500;
}

function deadlineFailure(
  job: TickDecisionJob,
  attempts: ModelAttempt[],
): TickDecisionFailure {
  const failure = timeoutFailure(job);
  return {
    ...job,
    outcome: 'lost-tick',
    failure,
    attempts,
  };
}

function timeoutFailure(
  job: TickDecisionJob,
  latencyMs?: number,
): ProviderFailure {
  return {
    code: 'timeout',
    message: 'The shared tick deadline elapsed before the decision completed.',
    retryable: false,
    model: job.modelId,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

function cancellableWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(cancelled());
      },
      { once: true },
    );
  });
}

function isCancelled(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'failure' in value &&
    (value as { failure?: ProviderFailure }).failure?.code === 'cancelled',
  );
}

function cancelled(): Error & { failure: ProviderFailure } {
  return Object.assign(new Error('The tick was cancelled by the operator.'), {
    failure: {
      code: 'cancelled' as const,
      message: 'The tick was cancelled by the operator.',
      retryable: false,
    },
  });
}

function sanitizedProviderError(
  value: unknown,
  modelId: ModelId,
): {
  failure: ProviderFailure;
  metadata?: TickDecisionSuccess['decision']['metadata'];
} | null {
  if (!(value instanceof AgentProviderError)) return null;
  const failure = providerFailureSchema.safeParse(
    (value as { failure?: unknown }).failure,
  );
  const metadata = providerMetadataSchema.safeParse(
    (value as { metadata?: unknown }).metadata,
  );
  if (!failure.success) return null;
  return {
    failure: { ...failure.data, model: failure.data.model ?? modelId },
    ...(metadata.success ? { metadata: metadata.data } : {}),
  };
}
