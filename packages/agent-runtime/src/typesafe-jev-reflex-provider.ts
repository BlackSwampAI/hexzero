import { z } from 'zod';
import {
  reflexDecisionSchema,
  reflexObservationSchema,
  type ProviderFailure,
  type ProviderMetadata,
  type ReflexDecision,
  type ReflexObservation,
} from '@hexzero/shared';
import {
  ReflexProviderError,
  type ReflexAttemptCompletion,
  type ReflexDecisionOptions,
  type ReflexProvider,
} from './reflex-provider';

export const TYPESAFE_SYSTEM_ONE_ENDPOINT =
  'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_JEV_MODEL = 'jev-1.13.0';

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 250;
const MAX_TIMEOUT_MS = 300_000;

const typesafeResponseSchema = z.object({
  model: z.literal(TYPESAFE_JEV_MODEL),
  answers: z.object({
    choose_action: z.object({
      type: z.literal('choice'),
      choice: z.string().trim().min(1).max(32),
      probabilities: z.record(
        z.string().min(1).max(32),
        z.number().finite().min(0).max(1),
      ),
      confidence: z.number().finite().min(0).max(1),
    }),
    request_replan: z.object({
      type: z.literal('noul'),
      noul: z.number().finite().min(0).max(1),
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export interface TypeSafeJevReflexProviderOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export class TypeSafeJevReflexProvider implements ReflexProvider {
  readonly mode = 'typesafe-jev' as const;
  readonly model = TYPESAFE_JEV_MODEL;
  readonly configured: boolean;
  readonly #apiKey?: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor({
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImplementation = fetch,
  }: TypeSafeJevReflexProviderOptions = {}) {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS
    )
      throw new RangeError(
        `TypeSafe Jev timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`,
      );
    this.#apiKey =
      (apiKey ?? process.env.TYPESAFE_API_KEY)?.trim() || undefined;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImplementation;
    this.configured = Boolean(this.#apiKey);
  }

  async decide(
    observationInput: ReflexObservation,
    options: ReflexDecisionOptions = {},
  ): Promise<ReflexDecision> {
    const startedAtMs = Date.now();
    if (options.signal?.aborted)
      throw this.#failure('cancelled', false, startedAtMs);
    if (!this.#apiKey)
      throw new ReflexProviderError({
        code: 'configuration',
        message:
          'TypeSafe Jev is unavailable. Set TYPESAFE_API_KEY on the Game API server.',
        retryable: false,
      });
    const observation = reflexObservationSchema.parse(observationInput);
    const candidateIds = new Set(observation.candidates.map(({ id }) => id));
    const request = buildTypeSafeJevRequest(observation);
    const requestBody = JSON.stringify(request);
    const deadlineAtMs = Math.min(
      options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      startedAtMs + this.#timeoutMs,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw this.#failure('timeout', true, startedAtMs);
      const finalize = options.beginAttempt?.(
        attempt === 0 ? 'initial' : 'automatic-transport-retry',
      );
      if (finalize === null)
        throw new ReflexProviderError({
          code: 'budget-exhausted',
          message: 'The reflex provider attempt budget is exhausted.',
          retryable: false,
        });
      let finalized = false;
      const complete = (completion: ReflexAttemptCompletion) => {
        if (finalized) return;
        finalized = true;
        finalize?.(completion);
      };
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remainingMs);
      const cancel = () => controller.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        let response: Response;
        try {
          response = await this.#fetch(TYPESAFE_SYSTEM_ONE_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json',
            },
            body: requestBody,
            signal: controller.signal,
          });
        } catch {
          if (timedOut || options.signal?.aborted)
            throw this.#failure(
              timedOut ? 'timeout' : 'cancelled',
              false,
              startedAtMs,
            );
          throw this.#failure('network', true, startedAtMs);
        }
        if (options.signal?.aborted)
          throw this.#failure('cancelled', false, startedAtMs);
        if (
          (response.status === 429 || response.status === 529) &&
          attempt === 0
        ) {
          const failure: ProviderFailure = {
            code: 'provider-http',
            message: `TypeSafe Jev returned HTTP ${response.status}.`,
            retryable: true,
            httpStatus: response.status,
            model: this.model,
            latencyMs: Date.now() - startedAtMs,
          };
          complete({
            outcome: 'provider-error',
            provider: this.#metadata(Date.now() - startedAtMs, response.status),
            failure,
          });
          const delayMs = Math.min(
            retryDelay(response.headers.get('retry-after')),
            Math.max(0, deadlineAtMs - Date.now()),
          );
          if (delayMs > 0) await abortableDelay(delayMs, options.signal);
          continue;
        }
        if (!response.ok)
          throw new ReflexProviderError(
            {
              code: 'provider-http',
              message: `TypeSafe Jev returned HTTP ${response.status}.`,
              retryable: response.status === 429 || response.status === 529,
              httpStatus: response.status,
              model: this.model,
              latencyMs: Date.now() - startedAtMs,
            },
            this.#metadata(Date.now() - startedAtMs, response.status),
          );
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          throw new ReflexProviderError(
            {
              code: 'malformed-response',
              message: 'TypeSafe Jev returned malformed JSON.',
              retryable: true,
              httpStatus: response.status,
              model: this.model,
              latencyMs: Date.now() - startedAtMs,
            },
            this.#metadata(Date.now() - startedAtMs, response.status),
          );
        }
        const parsed = typesafeResponseSchema.safeParse(raw);
        if (!parsed.success)
          throw new ReflexProviderError(
            {
              code: 'unsupported-response',
              message: 'TypeSafe Jev returned an unsupported response shape.',
              retryable: true,
              httpStatus: response.status,
              model: this.model,
              latencyMs: Date.now() - startedAtMs,
            },
            this.#metadata(Date.now() - startedAtMs, response.status),
          );
        const answer = parsed.data.answers.choose_action;
        const replanAnswer = parsed.data.answers.request_replan;
        const choiceValid = candidateIds.has(answer.choice);
        const probabilityIds = Object.keys(answer.probabilities);
        const probabilitiesValid =
          probabilityIds.length === candidateIds.size &&
          probabilityIds.every((id) => candidateIds.has(id)) &&
          approximatelyOne(Object.values(answer.probabilities));
        if (!choiceValid || !probabilitiesValid)
          throw new ReflexProviderError(
            {
              code: 'invalid-decision',
              message: !choiceValid
                ? 'TypeSafe Jev selected a candidate outside the supplied choices.'
                : 'TypeSafe Jev returned an incomplete or inconsistent probability distribution.',
              retryable: false,
              httpStatus: response.status,
              model: this.model,
              latencyMs: Date.now() - startedAtMs,
            },
            this.#metadata(
              Date.now() - startedAtMs,
              response.status,
              parsed.data.usage.input_tokens,
              parsed.data.usage.output_tokens,
            ),
          );
        const decision = reflexDecisionSchema.parse({
          chosenCandidateId: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          replanProbability: replanAnswer.noul,
          model: parsed.data.model,
          latencyMs: Date.now() - startedAtMs,
          inputTokens: parsed.data.usage.input_tokens,
          outputTokens: parsed.data.usage.output_tokens,
          directiveId: observation.directive.id,
          cognitionSource: 'jev-reflex',
        });
        complete({
          outcome: 'completed',
          provider: this.#metadata(
            Date.now() - startedAtMs,
            response.status,
            parsed.data.usage.input_tokens,
            parsed.data.usage.output_tokens,
          ),
          reflexDecision: decision,
        });
        return decision;
      } catch (error) {
        const providerError =
          error instanceof ReflexProviderError
            ? error
            : new ReflexProviderError(
                {
                  code: 'unsupported-response',
                  message: 'TypeSafe Jev returned invalid decision telemetry.',
                  retryable: true,
                  model: this.model,
                  latencyMs: Date.now() - startedAtMs,
                },
                this.#metadata(Date.now() - startedAtMs),
              );
        const outcome =
          providerError.failure.code === 'cancelled'
            ? 'cancelled'
            : providerError.failure.code === 'timeout'
              ? 'timeout'
              : 'provider-error';
        complete({
          outcome,
          provider: providerError.metadata,
          failure: providerError.failure,
        });
        throw providerError;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
      }
    }
    throw this.#failure('provider-http', true, startedAtMs);
  }

  #metadata(
    latencyMs: number,
    httpStatus?: number,
    promptTokens?: number,
    completionTokens?: number,
  ): ProviderMetadata {
    return {
      provider: 'typesafe',
      model: this.model,
      selectedModel: this.model,
      resolvedModel: this.model,
      latencyMs,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(promptTokens === undefined || completionTokens === undefined
        ? {}
        : { totalTokens: promptTokens + completionTokens }),
    };
  }

  #failure(
    code: ProviderFailure['code'],
    retryable: boolean,
    startedAtMs: number,
  ): ReflexProviderError {
    const message =
      code === 'cancelled'
        ? 'The TypeSafe Jev request was cancelled.'
        : code === 'timeout'
          ? 'The TypeSafe Jev request timed out.'
          : 'The TypeSafe Jev request could not be completed.';
    return new ReflexProviderError(
      {
        code,
        message,
        retryable,
        model: this.model,
        latencyMs: Date.now() - startedAtMs,
      },
      this.#metadata(Date.now() - startedAtMs),
    );
  }
}

export function buildTypeSafeJevRequest(observationInput: ReflexObservation) {
  const observation = reflexObservationSchema.parse(observationInput);
  const recentCaptures = observation.captureAlerts?.map(
    ({ abandonedCellCount }) => ({ abandonedCellCount }),
  );
  return {
    state: {
      agentId: observation.agentId,
      directive: {
        mission: observation.directive.mission,
        priority: observation.directive.priority,
        riskTolerance: observation.directive.riskTolerance,
      },
      currentSituation: observation.currentSituation,
      ...(recentCaptures?.length
        ? {
            capturePressure: {
              recentCaptures,
              recentCaptureCount: recentCaptures.length,
            },
          }
        : {}),
      candidateIds: observation.candidates.map(({ id }) => id),
    },
    model: TYPESAFE_JEV_MODEL,
    questions: {
      choose_action: {
        type: 'choice' as const,
        instructions:
          "Which currently legal action best advances this worker's assigned directive given its local observed conditions?",
        criteria: Object.fromEntries(
          observation.candidates.map(({ id, description }) => [
            id,
            description,
          ]),
        ),
      },
      request_replan: {
        type: 'noul' as const,
        instructions:
          'Do currently observed local conditions materially undermine or prevent successful execution of the assigned directive?',
        criteria: {
          false:
            'Observed local conditions leave the assigned directive materially achievable with one of the currently legal actions.',
          true: 'Observed local conditions materially undermine or prevent the assigned directive, such as when its target, route, required local state, or expected progress is unavailable or contradicted.',
        },
      },
    },
  };
}

function approximatelyOne(probabilities: number[]): boolean {
  return (
    Math.abs(probabilities.reduce((total, value) => total + value, 0) - 1) <
    0.001
  );
}

function retryDelay(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1_000, 5_000)
    : RETRY_DELAY_MS;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new ReflexProviderError({
          code: 'cancelled',
          message: 'The TypeSafe Jev request was cancelled.',
          retryable: false,
        }),
      );
      return;
    }
    const timeout = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(
        new ReflexProviderError({
          code: 'cancelled',
          message: 'The TypeSafe Jev request was cancelled.',
          retryable: false,
        }),
      );
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
