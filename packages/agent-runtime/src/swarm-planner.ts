import { z } from 'zod';
import {
  providerMetadataSchema,
  swarmPlanSchema,
  zeroStrategicObservationSchema,
  type ProviderFailure,
  type ProviderMetadata,
  type SwarmPlan,
  type ZeroStrategicObservation,
} from '@hexzero/shared';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 250;
const RESPONSE_BODY_MAX_BYTES = 65_536;

export interface SwarmPlanner {
  readonly mode: 'openrouter-swarm' | 'scripted-swarm-test';
  readonly configured: boolean;
  plan(
    observation: ZeroStrategicObservation,
    model: string,
    options?: PlannerOptions,
  ): Promise<SwarmPlanResult>;
}

export interface PlannerOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
  beginAttempt?: SwarmAttemptStarter;
}

export interface SwarmPlanResult {
  plan: SwarmPlan;
  metadata: ProviderMetadata;
}

export interface SwarmAttemptCompletion {
  outcome: 'completed' | 'provider-error' | 'cancelled' | 'timeout';
  provider?: ProviderMetadata;
  failure?: ProviderFailure;
  swarmPlan?: SwarmPlan;
}

export type SwarmAttemptFinalizer = (
  completion: SwarmAttemptCompletion,
) => void;
export type SwarmAttemptStarter = (
  kind: 'initial' | 'automatic-transport-retry',
) => SwarmAttemptFinalizer | null;

export class SwarmPlannerError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly metadata?: ProviderMetadata,
  ) {
    super(failure.message);
    this.name = 'SwarmPlannerError';
  }
}

const openRouterResponseSchema = z.object({
  id: z.string().trim().min(1).max(160).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().trim().min(1).max(80).nullable().optional(),
        message: z.object({
          content: z
            .union([z.string(), z.array(z.object({ text: z.string() }))])
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
});

export interface OpenRouterSwarmPlannerOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/** OpenRouter-backed strategic planner, isolated from AgentProvider. */
export class OpenRouterSwarmPlanner implements SwarmPlanner {
  readonly mode = 'openrouter-swarm' as const;
  readonly configured: boolean;
  readonly #apiKey?: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor({
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImplementation = fetch,
  }: OpenRouterSwarmPlannerOptions = {}) {
    this.#apiKey =
      (apiKey ?? process.env.OPENROUTER_API_KEY)?.trim() || undefined;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImplementation;
    this.configured = Boolean(this.#apiKey);
  }

  async plan(
    observationInput: ZeroStrategicObservation,
    model: string,
    options: PlannerOptions = {},
  ): Promise<SwarmPlanResult> {
    const startedAt = Date.now();
    if (!this.#apiKey)
      throw new SwarmPlannerError(
        failure('configuration', false, model, startedAt),
      );
    const observation = zeroStrategicObservationSchema.parse(observationInput);
    const deadlineAt = Math.min(
      options.deadlineAtMs ?? Infinity,
      startedAt + this.#timeoutMs,
    );
    const requestBody = JSON.stringify(
      buildSwarmPlannerRequest(observation, model),
    );
    for (let index = 0; index < 2; index += 1) {
      if (Date.now() >= deadlineAt)
        throw new SwarmPlannerError(failure('timeout', true, model, startedAt));
      const finalize = options.beginAttempt?.(
        index === 0 ? 'initial' : 'automatic-transport-retry',
      );
      if (finalize === null)
        throw new SwarmPlannerError({
          code: 'budget-exhausted',
          message: 'The planner attempt budget is exhausted.',
          retryable: false,
        });
      let done = false;
      const complete = (result: SwarmAttemptCompletion) => {
        if (!done) {
          done = true;
          finalize?.(result);
        }
      };
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        Math.max(1, deadlineAt - Date.now()),
      );
      const cancel = () => controller.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        let response: Response;
        try {
          response = await this.#fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json',
            },
            body: requestBody,
            signal: controller.signal,
          });
        } catch {
          throw new SwarmPlannerError(
            failure(
              timedOut
                ? 'timeout'
                : options.signal?.aborted
                  ? 'cancelled'
                  : 'network',
              !timedOut && !options.signal?.aborted,
              model,
              startedAt,
            ),
          );
        }
        if (options.signal?.aborted)
          throw new SwarmPlannerError(
            failure('cancelled', false, model, startedAt),
          );
        const metadata = metadataFor(
          model,
          Date.now() - startedAt,
          response.status,
        );
        if (
          (response.status === 429 || response.status === 529) &&
          index === 0
        ) {
          const retryFailure = new SwarmPlannerError(
            {
              ...failure('provider-http', true, model, startedAt),
              httpStatus: response.status,
            },
            metadata,
          );
          complete({
            outcome: 'provider-error',
            provider: metadata,
            failure: retryFailure.failure,
          });
          await delay(
            Math.min(RETRY_DELAY_MS, Math.max(0, deadlineAt - Date.now())),
            options.signal,
          );
          continue;
        }
        if (!response.ok)
          throw new SwarmPlannerError(
            {
              ...failure(
                'provider-http',
                response.status === 429 || response.status === 529,
                model,
                startedAt,
              ),
              httpStatus: response.status,
            },
            metadata,
          );
        let raw: unknown;
        try {
          const body = await response.text();
          if (
            new TextEncoder().encode(body).byteLength > RESPONSE_BODY_MAX_BYTES
          )
            throw new Error('response body limit');
          raw = JSON.parse(body);
        } catch {
          throw new SwarmPlannerError(
            failure('malformed-response', true, model, startedAt),
            metadata,
          );
        }
        if (options.signal?.aborted)
          throw new SwarmPlannerError(
            failure('cancelled', false, model, startedAt),
          );
        const parsed = openRouterResponseSchema.safeParse(raw);
        if (!parsed.success)
          throw new SwarmPlannerError(
            failure('unsupported-response', true, model, startedAt),
            metadata,
          );
        const content = responseText(parsed.data.choices[0]?.message.content);
        if (!content)
          throw new SwarmPlannerError(
            failure('unsupported-response', true, model, startedAt),
            metadata,
          );
        let planRaw: unknown;
        try {
          planRaw = JSON.parse(content);
        } catch {
          throw new SwarmPlannerError(
            failure('malformed-response', true, model, startedAt),
            metadata,
          );
        }
        const plan = swarmPlanSchema.safeParse(planRaw);
        if (!plan.success || !validPlan(plan.data, observation))
          throw new SwarmPlannerError(
            {
              ...failure('invalid-decision', false, model, startedAt),
              message:
                'Agent Zero returned a plan outside the authoritative choices.',
            },
            metadata,
          );
        const safeMetadata = providerMetadataSchema.parse({
          ...metadata,
          requestId: parsed.data.id,
          resolvedModel: parsed.data.model,
          promptTokens: parsed.data.usage?.prompt_tokens,
          completionTokens: parsed.data.usage?.completion_tokens,
          totalTokens: parsed.data.usage?.total_tokens,
        });
        complete({
          outcome: 'completed',
          provider: safeMetadata,
          swarmPlan: plan.data,
        });
        return { plan: plan.data, metadata: safeMetadata };
      } catch (error) {
        const plannerError =
          error instanceof SwarmPlannerError
            ? error
            : new SwarmPlannerError(
                failure('unsupported-response', false, model, startedAt),
              );
        complete({
          outcome:
            plannerError.failure.code === 'cancelled'
              ? 'cancelled'
              : plannerError.failure.code === 'timeout'
                ? 'timeout'
                : 'provider-error',
          provider: plannerError.metadata,
          failure: plannerError.failure,
        });
        throw plannerError;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
      }
    }
    throw new SwarmPlannerError(
      failure('provider-http', true, model, startedAt),
    );
  }
}

export class ScriptedSwarmPlanner implements SwarmPlanner {
  readonly mode = 'scripted-swarm-test' as const;
  readonly configured = true;
  #cursor = 0;
  constructor(private readonly plans: SwarmPlan[]) {
    if (plans.length === 0)
      throw new Error('ScriptedSwarmPlanner requires at least one plan.');
  }
  async plan(
    observationInput: ZeroStrategicObservation,
    model: string,
    options: PlannerOptions = {},
  ): Promise<SwarmPlanResult> {
    const observation = zeroStrategicObservationSchema.parse(observationInput);
    const finalize = options.beginAttempt?.('initial');
    if (finalize === null)
      throw new SwarmPlannerError({
        code: 'budget-exhausted',
        message: 'The planner attempt budget is exhausted.',
        retryable: false,
      });
    const plan = this.plans[this.#cursor++];
    if (!plan || !validPlan(plan, observation)) {
      const error = new SwarmPlannerError({
        code: 'invalid-decision',
        message:
          'The deterministic planner selected a plan outside authoritative choices.',
        retryable: false,
      });
      finalize?.({ outcome: 'provider-error', failure: error.failure });
      throw error;
    }
    const metadata = metadataFor(model, 0);
    finalize?.({ outcome: 'completed', provider: metadata, swarmPlan: plan });
    return { plan, metadata };
  }
}

function buildSwarmPlannerRequest(
  observation: ZeroStrategicObservation,
  model: string,
) {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are Agent Zero, a strategic planner. Return JSON only with strategySummary, directives, and zeroActionCandidateId. Assign intent, never exact worker movement. Each directive targetCell must be one of strategicTargetCells. Issue each directive at the current tick and set expiresAtTick between the current tick and current tick plus 9; normally cover at least five ticks so workers can operate between reviews. Use replanReasons and workerReplanRequests when present. zeroActionCandidateId must be one offered opaque candidate. Do not add fields.',
      },
      { role: 'user', content: JSON.stringify(observation) },
    ],
  };
}

function validPlan(
  plan: SwarmPlan,
  observation: ZeroStrategicObservation,
): boolean {
  const targets = new Set(observation.strategicTargetCells);
  const workers = new Set(
    observation.agents
      .filter(({ agentId }) => agentId !== observation.zeroAgentId)
      .map(({ agentId }) => agentId),
  );
  return (
    observation.legalZeroActions.some(
      ({ id }) => id === plan.zeroActionCandidateId,
    ) &&
    plan.directives.length === workers.size &&
    plan.directives.every(
      (directive) =>
        workers.has(directive.agentId) &&
        directive.issuedAtTick === observation.tickNumber &&
        directive.expiresAtTick >= observation.tickNumber &&
        directive.expiresAtTick <= observation.tickNumber + 9 &&
        (!directive.targetCell || targets.has(directive.targetCell)),
    )
  );
}

function responseText(
  content: string | { text: string }[] | null | undefined,
): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(({ text }) => text).join('');
  return undefined;
}

function metadataFor(
  model: string,
  latencyMs: number,
  httpStatus?: number,
): ProviderMetadata {
  return {
    provider: 'openrouter',
    model,
    selectedModel: model,
    latencyMs: Math.round(latencyMs),
    ...(httpStatus ? { httpStatus } : {}),
  };
}

function failure(
  code: ProviderFailure['code'],
  retryable: boolean,
  model: string,
  startedAt: number,
): ProviderFailure {
  const messages: Partial<Record<ProviderFailure['code'], string>> = {
    configuration:
      'OpenRouter is unavailable. Set OPENROUTER_API_KEY on the Game API server.',
    timeout: 'The Agent Zero planning request timed out.',
    network: 'The Agent Zero planning provider could not be reached.',
    'model-unavailable': 'The requested Agent Zero model is unavailable.',
    'provider-http': 'The Agent Zero planning provider returned an HTTP error.',
    cancelled: 'The Agent Zero planning request was cancelled.',
    'malformed-response':
      'The Agent Zero planning provider returned malformed JSON.',
    'unsupported-response':
      'The Agent Zero planning provider returned an unsupported response.',
    'output-length': 'The Agent Zero planning response was incomplete.',
    'invalid-decision': 'The Agent Zero plan was invalid.',
    'budget-exhausted': 'The planner attempt budget is exhausted.',
  };
  return {
    code,
    message: messages[code] ?? 'The Agent Zero planner failed.',
    retryable,
    model,
    latencyMs: Date.now() - startedAt,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          new SwarmPlannerError({
            code: 'cancelled',
            message: 'The Agent Zero planning request was cancelled.',
            retryable: false,
          }),
        );
      },
      { once: true },
    );
  });
}
