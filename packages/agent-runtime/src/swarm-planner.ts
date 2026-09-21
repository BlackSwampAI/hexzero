import { z } from 'zod';
import {
  providerMetadataSchema,
  swarmPlanSchema,
  OPENROUTER_MAX_OUTPUT_TOKENS,
  WORLD_SCENARIO_LIMITS,
  zeroStrategicObservationSchema,
  type ProviderFailure,
  type ProviderMetadata,
  type ReasoningProfile,
  type SwarmPlan,
  type ZeroStrategicObservation,
} from '@hexzero/shared';
import { normalizeOpenRouterUsage } from './openrouter-usage';

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
  reasoningProfile?: ReasoningProfile;
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
  usage: z.unknown().optional(),
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

const compactPlanSchema = z
  .object({
    strategySummary: z.string().trim().min(1).max(500),
    directives: z
      .array(
        z
          .object({
            workerId: z.string().regex(/^worker_[0-9]+$/),
            mission: z.enum([
              'expand',
              'hold',
              'relocate',
              'reinforce',
              'evade',
            ]),
            targetId: z
              .string()
              .regex(/^target_[0-9]+$/)
              .nullable(),
            priority: z.enum(['low', 'normal', 'high']),
            riskTolerance: z.enum(['low', 'medium', 'high']),
          })
          .strict(),
      )
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    zeroActionCandidateId: z.string().regex(/^zero_action_[0-9]+$/),
  })
  .strict();

export interface OpenRouterSwarmPlannerOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/** OpenRouter-backed strategic planner for Agent Zero. */
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
      buildSwarmPlannerRequest(
        observation,
        model,
        options.reasoningProfile ?? 'provider-default',
      ),
    );
    const sensitiveValues = collectSensitiveValues(
      this.#apiKey,
      observation,
      requestBody,
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
        const errorResponseMetadata = !response.ok
          ? metadataFromResponse(
              metadata,
              await readBoundedJson(response).catch(() => undefined),
              sensitiveValues,
            )
          : undefined;
        if (options.signal?.aborted || timedOut)
          throw new SwarmPlannerError(
            failure(
              timedOut ? 'timeout' : 'cancelled',
              false,
              model,
              startedAt,
            ),
            errorResponseMetadata ?? metadata,
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
            errorResponseMetadata ?? metadata,
          );
          complete({
            outcome: 'provider-error',
            provider: errorResponseMetadata ?? metadata,
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
            errorResponseMetadata ?? metadata,
          );
        let raw: unknown;
        try {
          raw = await readBoundedJson(response);
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
        const responseMetadata = metadataFromResponse(
          metadata,
          raw,
          sensitiveValues,
        );
        const parsed = openRouterResponseSchema.safeParse(raw);
        if (!parsed.success)
          throw new SwarmPlannerError(
            failure('unsupported-response', true, model, startedAt),
            responseMetadata,
          );
        const content = responseText(parsed.data.choices[0]?.message.content);
        if (!content)
          throw new SwarmPlannerError(
            failure('unsupported-response', true, model, startedAt),
            responseMetadata,
          );
        let planRaw: unknown;
        try {
          planRaw = JSON.parse(content);
        } catch {
          throw new SwarmPlannerError(
            failure('malformed-response', true, model, startedAt),
            responseMetadata,
          );
        }
        const decoded = decodePlanChoice(planRaw, observation);
        if (!decoded.plan)
          throw new SwarmPlannerError(
            {
              ...failure('invalid-decision', false, model, startedAt),
              message: `Agent Zero plan rejected: ${decoded.reason}.`,
            },
            responseMetadata,
          );
        const safeMetadata = responseMetadata;
        complete({
          outcome: 'completed',
          provider: safeMetadata,
          swarmPlan: decoded.plan,
        });
        return { plan: decoded.plan, metadata: safeMetadata };
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

/**
 * Repeatable offline planner for browser and end-to-end swarm runs.
 * It derives every choice from the current authoritative observation and does
 * not model a provider or retain a finite response fixture.
 */
export class DeterministicSwarmPlanner implements SwarmPlanner {
  readonly mode = 'scripted-swarm-test' as const;
  readonly configured = true;

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
        message: 'The deterministic planner attempt budget is exhausted.',
        retryable: false,
      });
    const zeroAction =
      observation.legalZeroActions.find(
        ({ action }) => action.type === 'infect',
      ) ??
      observation.legalZeroActions.find(
        ({ action }) => action.type === 'move',
      ) ??
      observation.legalZeroActions.find(
        ({ action }) => action.type === 'wait',
      ) ??
      observation.legalZeroActions[0];
    if (!zeroAction)
      throw new SwarmPlannerError({
        code: 'invalid-decision',
        message: 'The deterministic planner received no legal Zero action.',
        retryable: false,
      });
    const target =
      observation.strategicTargetCells.find(
        (cell) =>
          observation.cells.find((candidate) => candidate.cell === cell)
            ?.state === 'open',
      ) ?? null;
    const plan = swarmPlanSchema.parse({
      strategySummary: 'Deterministic swarm perimeter expansion.',
      zeroActionCandidateId: zeroAction.id,
      directives: observation.agents
        .filter(({ agentId }) => agentId !== observation.zeroAgentId)
        .map(({ agentId }) => ({
          id: `deterministic-${observation.tickNumber}-${agentId}`,
          agentId,
          mission: target ? 'expand' : 'hold',
          targetCell: target,
          priority: 'normal',
          riskTolerance: 'medium',
          issuedAtTick: observation.tickNumber,
          expiresAtTick: observation.tickNumber + 4,
        })),
    });
    const metadata = metadataFor(model, 0);
    finalize?.({ outcome: 'completed', provider: metadata, swarmPlan: plan });
    return { plan, metadata };
  }
}

function buildSwarmPlannerRequest(
  observation: ZeroStrategicObservation,
  model: string,
  reasoningProfile: ReasoningProfile,
) {
  const targetChoices = observation.strategicTargetCells.map((cell, index) => ({
    targetId: `target_${index}`,
    cell,
  }));
  const targetIdByCell = new Map(
    targetChoices.map(({ targetId, cell }) => [cell, targetId]),
  );
  const completedDirectiveByAgent = new Map(
    (observation.completedDirectives ?? []).map(({ agentId, directiveId }) => [
      agentId,
      directiveId,
    ]),
  );
  const workers = observation.agents
    .filter(({ agentId }) => agentId !== observation.zeroAgentId)
    .map((agent, index) => ({
      workerId: `worker_${index}`,
      position: agent.position,
      controlledCellCount: agent.controlledCellCount,
      territoryDelta: agent.territoryDelta,
      localPressure: agent.localPressure,
      pressureDirection: agent.pressureDirection,
      pressureDistance: agent.pressureDistance,
      workerStatus: agent.workerStatus ?? 'unknown',
      directiveComplete:
        agent.directive !== null &&
        agent.directive !== undefined &&
        completedDirectiveByAgent.get(agent.agentId) === agent.directive.id,
      activeDirective: agent.directive
        ? {
            mission: agent.directive.mission,
            targetId: agent.directive.targetCell
              ? (targetIdByCell.get(agent.directive.targetCell) ?? null)
              : null,
            priority: agent.directive.priority,
            riskTolerance: agent.directive.riskTolerance,
            ticksRemaining: Math.max(
              0,
              agent.directive.expiresAtTick - observation.tickNumber,
            ),
          }
        : null,
    }));
  const workerIdByAgent = new Map(
    observation.agents
      .filter(({ agentId }) => agentId !== observation.zeroAgentId)
      .map(({ agentId }, index) => [agentId, `worker_${index}`]),
  );
  const zero = observation.agents.find(
    ({ agentId }) => agentId === observation.zeroAgentId,
  )!;
  return {
    model,
    temperature: 0,
    max_tokens: OPENROUTER_MAX_OUTPUT_TOKENS,
    ...(reasoningProfile === 'provider-default'
      ? {}
      : reasoningProfile === 'off'
        ? { reasoning: { enabled: false, exclude: true } }
        : {
            reasoning: {
              enabled: true,
              effort: reasoningProfile,
              exclude: true,
            },
          }),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          "You are Agent Zero, a strategic planner. Return only a JSON object with strategySummary, zeroActionCandidateId, and directives. Return exactly one directive per offered worker, using each workerId once. Each directive has only workerId, mission (expand|hold|relocate|reinforce|evade), targetId (one offered targetId or null), priority (low|normal|high), and riskTolerance (low|medium|high). Select zeroActionCandidateId from legalZeroActions. Assign intent, never exact worker movement. Code supplies directive IDs, agent IDs, target cells, and tick lifetimes; do not output those fields. Use replanReasons, directiveComplete, workerReplanRequests, worker localPressure, spatial pressure categories, and recentCaptures when present. Under trail-hunter pressure, a worker caught by the simulated player is permanently captured and removed, and its controlled territory becomes abandoned. Treat sustained high local pressure as an existential threat. Hold under high pressure only as an intentional defensive or sacrifice choice. Non-hold missions need a target. Expand targets must be open cells. Reinforce targets must be infected or adjacent to infection. Do not assign a relocate, reinforce, or evade target equal to that worker's current position.",
      },
      {
        role: 'user',
        content: JSON.stringify({
          tickNumber: observation.tickNumber,
          virtualTime: observation.virtualTime,
          cells: observation.cells,
          zero: {
            position: zero.position,
            controlledCellCount: zero.controlledCellCount,
            territoryDelta: zero.territoryDelta,
          },
          workers,
          recentPlayerPressure: observation.recentPlayerPressure,
          recentCaptures: observation.recentCaptures ?? [],
          replanReasons: observation.replanReasons ?? [],
          workerReplanRequests: (
            observation.workerReplanRequests ?? []
          ).flatMap(({ agentId, probability }) => {
            const workerId = workerIdByAgent.get(agentId);
            return workerId ? [{ workerId, probability }] : [];
          }),
          legalZeroActions: observation.legalZeroActions,
          targetChoices,
        }),
      },
    ],
  };
}

function decodePlanChoice(
  raw: unknown,
  observation: ZeroStrategicObservation,
): { plan: SwarmPlan; reason?: never } | { plan?: never; reason: string } {
  // Valid full plans remain accepted for compatibility with existing callers.
  const full = swarmPlanSchema.safeParse(raw);
  if (full.success) {
    const issue = planAuthorityIssue(full.data, observation);
    return issue ? { reason: issue } : { plan: full.data };
  }
  const compact = compactPlanSchema.safeParse(raw);
  if (!compact.success) {
    const topField = String(compact.error.issues[0]?.path[0] ?? 'object');
    const field = [
      'strategySummary',
      'directives',
      'zeroActionCandidateId',
    ].includes(topField)
      ? topField
      : 'object';
    return { reason: `invalid ${field} format` };
  }
  const workerIds = observation.agents
    .filter(({ agentId }) => agentId !== observation.zeroAgentId)
    .map(({ agentId }, index) => ({ workerId: `worker_${index}`, agentId }));
  if (compact.data.directives.length !== workerIds.length)
    return { reason: 'missing or extra worker directives' };
  const workerMap = new Map(
    workerIds.map(({ workerId, agentId }) => [workerId, agentId]),
  );
  const targetMap = new Map(
    observation.strategicTargetCells.map((cell, index) => [
      `target_${index}`,
      cell,
    ]),
  );
  const seen = new Set<string>();
  for (const directive of compact.data.directives) {
    if (!workerMap.has(directive.workerId) || seen.has(directive.workerId))
      return { reason: 'unknown or repeated worker choice' };
    seen.add(directive.workerId);
    if (directive.targetId !== null && !targetMap.has(directive.targetId))
      return { reason: 'unknown target choice' };
  }
  if (
    !observation.legalZeroActions.some(
      ({ id }) => id === compact.data.zeroActionCandidateId,
    )
  )
    return { reason: 'unknown Zero action choice' };
  const plan = swarmPlanSchema.safeParse({
    strategySummary: compact.data.strategySummary,
    zeroActionCandidateId: compact.data.zeroActionCandidateId,
    directives: compact.data.directives.map((directive) => ({
      id: `directive-${observation.tickNumber}-${directive.workerId}`,
      agentId: workerMap.get(directive.workerId)!,
      mission: directive.mission,
      targetCell:
        directive.targetId === null ? null : targetMap.get(directive.targetId)!,
      priority: directive.priority,
      riskTolerance: directive.riskTolerance,
      issuedAtTick: observation.tickNumber,
      expiresAtTick: observation.tickNumber + 4,
    })),
  });
  return plan.success
    ? { plan: plan.data }
    : { reason: 'directive materialization failed' };
}

function planAuthorityIssue(
  plan: SwarmPlan,
  observation: ZeroStrategicObservation,
): string | null {
  if (
    !observation.legalZeroActions.some(
      ({ id }) => id === plan.zeroActionCandidateId,
    )
  )
    return 'unknown Zero action choice';
  const workers = new Set(
    observation.agents
      .filter(({ agentId }) => agentId !== observation.zeroAgentId)
      .map(({ agentId }) => agentId),
  );
  if (plan.directives.length !== workers.size)
    return 'missing or extra worker directives';
  const targets = new Set(observation.strategicTargetCells);
  for (const directive of plan.directives) {
    if (!workers.delete(directive.agentId))
      return 'unknown or repeated worker choice';
    if (directive.issuedAtTick !== observation.tickNumber)
      return 'invalid directive issue tick';
    if (
      directive.expiresAtTick < observation.tickNumber ||
      directive.expiresAtTick > observation.tickNumber + 9
    )
      return 'invalid directive expiry';
    if (directive.targetCell && !targets.has(directive.targetCell))
      return 'unknown target choice';
  }
  return null;
}

function validPlan(
  plan: SwarmPlan,
  observation: ZeroStrategicObservation,
): boolean {
  return planAuthorityIssue(plan, observation) === null;
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

function metadataFromResponse(
  metadata: ProviderMetadata,
  raw: unknown,
  sensitiveValues: string[],
): ProviderMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return metadata;
  const response = raw as Record<string, unknown>;
  const requestId = safeResponseMetadataValue(
    response.id,
    sensitiveValues,
    160,
  );
  const resolvedModel = safeResponseMetadataValue(
    response.model,
    sensitiveValues,
    200,
  );
  const candidate = {
    ...metadata,
    ...(requestId ? { requestId } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    ...normalizeOpenRouterUsage(response.usage),
  };
  return providerMetadataSchema.safeParse(candidate).success
    ? providerMetadataSchema.parse(candidate)
    : providerMetadataSchema.parse({
        ...metadata,
        ...normalizeOpenRouterUsage(response.usage),
      });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = await readBoundedText(response, RESPONSE_BODY_MAX_BYTES);
  return JSON.parse(body);
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = maximumBytes;
  let output = '';
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const accepted = value.subarray(0, remaining);
      output += decoder.decode(accepted, { stream: true });
      remaining -= accepted.byteLength;
      if (accepted.byteLength < value.byteLength) {
        await reader.cancel();
        throw new Error('response body limit');
      }
    }
    if (remaining === 0) {
      await reader.cancel();
      throw new Error('response body limit');
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function collectSensitiveValues(
  apiKey: string,
  observation: ZeroStrategicObservation,
  requestBody: string,
): string[] {
  const values = new Set<string>([apiKey, requestBody]);
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.length >= 4) values.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(observation);
  return [...values].toSorted((left, right) => right.length - left.length);
}

function safeResponseMetadataValue(
  value: unknown,
  sensitiveValues: string[],
  maximumLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    /Bearer\s+\S+|sk-or-[a-zA-Z0-9_-]+/i.test(normalized) ||
    sensitiveValues.some((sensitive) => normalized.includes(sensitive))
  )
    return undefined;
  return normalized;
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
