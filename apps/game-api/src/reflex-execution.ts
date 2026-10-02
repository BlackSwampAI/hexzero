import { gridDistance } from 'h3-js';
import {
  ReflexProviderError,
  type ReflexBatchDecisionResult,
  type ReflexAttemptCompletion,
  type ReflexProvider,
} from '@hexzero/agent-runtime';
import {
  h3CellSchema,
  providerFailureSchema,
  providerMetadataSchema,
  reflexBatchResultEnvelopeSchema,
  reflexDecisionSchema,
  reflexObservationSchema,
  swarmDirectiveSchema,
  type H3Cell,
  type CaptureAlert,
  type SimulatedPlayerEvent,
  type ProviderFailure,
  type ProviderMetadata,
  type ReflexDecision,
  type ReflexObservation,
  type SwarmDirective,
  type WorldAction,
} from '@hexzero/shared';
import {
  enumerateLegalWorldActions,
  type WorldState,
} from '@hexzero/world-engine';
import { AttemptAccounting } from './attempt-accounting';
import { geographicDirectionBetweenCells } from './geographic-direction';
import { localPressureAtCell, localPressureFromCells } from './swarm-pressure';

export interface ReflexLocalHistory {
  previousCell?: H3Cell;
  recentCleanedCells?: readonly H3Cell[];
  /** Public disinfection effects, already bounded by the tick executor. */
  pressureEvents?: readonly Extract<
    SimulatedPlayerEvent,
    { type: 'hex-disinfected' }
  >[];
  territoryDelta?: number;
  recentActionOutcome?: 'success' | 'rejected' | 'unknown';
  captureAlerts?: readonly CaptureAlert[];
}

export interface CompiledReflexObservation {
  observation: ReflexObservation;
  /** Authoritative mapping stays inside the server. */
  actions: ReadonlyMap<string, WorldAction>;
}

function distance(from: H3Cell, to: H3Cell): number | null {
  try {
    return gridDistance(from, to);
  } catch {
    return null;
  }
}

function cellStatus(
  state: WorldState,
  cell: H3Cell,
  agentId: SwarmDirective['agentId'],
) {
  const hex = state.hexes.get(cell);
  if (!hex || hex.state === 'open') return 'open' as const;
  return hex.controllerAgentId === agentId
    ? ('friendly-infected' as const)
    : ('other-infected' as const);
}

function actionDescription(
  state: WorldState,
  directive: SwarmDirective,
  action: WorldAction,
): string {
  const agent = state.agents.get(directive.agentId)!;
  if (action.type === 'wait')
    return 'Remain on the current cell for this tick.';
  if (action.type === 'infect')
    return 'Infect the current open cell and establish local territory.';
  if (action.type === 'capture')
    return 'Capture the abandoned infected current cell from another controller.';
  const status = cellStatus(state, action.targetCell, directive.agentId);
  const terrain =
    status === 'open'
      ? 'open territory'
      : status === 'friendly-infected'
        ? 'friendly infected territory'
        : 'infected territory controlled by another agent';
  const currentDistance = directive.targetCell
    ? distance(agent.currentCell, directive.targetCell)
    : null;
  const nextDistance = directive.targetCell
    ? distance(action.targetCell, directive.targetCell)
    : null;
  const progress =
    currentDistance === null || nextDistance === null
      ? 'No target-distance comparison is available.'
      : nextDistance < currentDistance
        ? 'This advances toward the assigned target.'
        : nextDistance > currentDistance
          ? 'This moves away from the assigned target.'
          : 'This maintains the current target distance.';
  const direction = geographicDirectionBetweenCells(
    agent.currentCell,
    action.targetCell,
  );
  return `Move ${direction} into adjacent ${terrain}. ${progress}`;
}

/** Compile only engine-legal actions from one frozen world state. */
export function compileReflexObservation(
  state: WorldState,
  directiveInput: SwarmDirective,
  history: ReflexLocalHistory = {},
): CompiledReflexObservation {
  const directive = swarmDirectiveSchema.parse(directiveInput);
  const agent = state.agents.get(directive.agentId);
  if (!agent) throw new Error('The assigned worker does not exist.');
  if (directive.targetCell && !state.hexes.has(directive.targetCell))
    throw new Error('The directive target is outside the current world.');
  const actions = new Map<string, WorldAction>();
  const candidates = enumerateLegalWorldActions(state, directive.agentId).map(
    (action, index) => {
      const id = `action_${index}`;
      actions.set(id, action);
      return { id, description: actionDescription(state, directive, action) };
    },
  );
  const current = agent.currentCell;
  const currentDistance = directive.targetCell
    ? distance(current, directive.targetCell)
    : null;
  const previousDistance =
    history.previousCell && directive.targetCell
      ? distance(h3CellSchema.parse(history.previousCell), directive.targetCell)
      : null;
  const hasForwardMove =
    currentDistance !== null &&
    [...actions.values()].some(
      (action) =>
        action.type === 'move' &&
        (distance(action.targetCell, directive.targetCell!) ?? Infinity) <
          currentDistance,
    );
  let directiveProgress: 'advancing' | 'at-target' | 'stalled' | 'blocked' =
    'stalled';
  if (directive.targetCell && currentDistance === 0)
    directiveProgress = 'at-target';
  else if (
    previousDistance !== null &&
    currentDistance !== null &&
    currentDistance < previousDistance
  )
    directiveProgress = 'advancing';
  else if (directive.targetCell && currentDistance !== 0 && !hasForwardMove)
    directiveProgress = 'blocked';
  const nearbyPressure = history.pressureEvents
    ? localPressureAtCell(current, history.pressureEvents).localPressure
    : localPressureFromCells(
        current,
        (history.recentCleanedCells ?? []).slice(-6),
      ).localPressure;
  const territoryTrend =
    (history.territoryDelta ?? 0) > 0
      ? ('growing' as const)
      : (history.territoryDelta ?? 0) < 0
        ? ('shrinking' as const)
        : ('stable' as const);
  const observation = reflexObservationSchema.parse({
    agentId: directive.agentId,
    directive,
    currentSituation: {
      cellStatus: cellStatus(state, current, directive.agentId),
      directiveProgress,
      nearbyPressure,
      recentTerritoryTrend: territoryTrend,
      recentActionOutcome: history.recentActionOutcome ?? 'unknown',
    },
    ...(history.captureAlerts?.length
      ? { captureAlerts: [...history.captureAlerts].slice(-4) }
      : {}),
    candidates,
  });
  return { observation, actions };
}

export interface ReflexSelection {
  action: WorldAction;
  observation: ReflexObservation;
  decision: ReflexDecision | null;
  cognitionSource: 'jev-reflex' | 'deterministic-fallback';
  failure?: ProviderFailure;
}

export class ReflexSelectionCancelledError extends Error {
  constructor() {
    super('The reflex selection was cancelled.');
    this.name = 'ReflexSelectionCancelledError';
  }
}

export interface ReflexSelectionOptions {
  history?: ReflexLocalHistory;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  accounting?: AttemptAccounting;
  /** First HTTP dispatch consumes a permit reserved for the whole tick. */
  initialPermitReserved?: boolean;
  intendedTickNumber?: number;
  intendedTurnNumber?: number;
  now?: () => string;
}

function failureForCode(
  code: ProviderFailure['code'],
  model: string,
): ProviderFailure {
  const messages: Record<ProviderFailure['code'], string> = {
    configuration: 'The reflex provider is not configured.',
    timeout: 'The reflex provider request timed out.',
    network: 'The reflex provider could not be reached.',
    'model-unavailable': 'The reflex model is unavailable.',
    'provider-http': 'The reflex provider returned an error.',
    cancelled: 'The reflex provider request was cancelled.',
    'malformed-response': 'The reflex provider returned malformed data.',
    'unsupported-response': 'The reflex provider returned unsupported data.',
    'output-length': 'The reflex provider response exceeded its limit.',
    'missing-text-output': 'The reflex provider returned no decision.',
    'invalid-json': 'The reflex provider returned invalid JSON.',
    'missing-tool-call': 'The reflex provider returned no decision.',
    'multiple-tool-calls': 'The reflex provider returned ambiguous data.',
    'wrong-tool': 'The reflex provider returned an unsupported decision.',
    'invalid-tool-arguments': 'The reflex provider returned invalid data.',
    'invalid-decision': 'The reflex provider returned an invalid decision.',
    'simulation-validation': 'The reflex decision failed validation.',
    'budget-exhausted': 'The reflex provider attempt budget is exhausted.',
  };
  return { code, message: messages[code], retryable: false, model };
}

function safeFailure(
  error: unknown,
  model: string,
): { failure: ProviderFailure; metadata?: ProviderMetadata } {
  if (error instanceof ReflexProviderError) {
    const parsedFailure = providerFailureSchema.safeParse(error.failure);
    const parsedMetadata = error.metadata
      ? providerMetadataSchema.safeParse(error.metadata)
      : undefined;
    return {
      failure: failureForCode(
        parsedFailure.success ? parsedFailure.data.code : 'provider-http',
        model,
      ),
      ...(parsedMetadata?.success ? { metadata: parsedMetadata.data } : {}),
    };
  }
  return { failure: failureForCode('provider-http', model) };
}

function normalizeAttemptCompletion(
  input: unknown,
  model: string,
  includeDecision: boolean,
): ReflexAttemptCompletion {
  const raw =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  const outcome =
    raw.outcome === 'completed' ||
    raw.outcome === 'provider-error' ||
    raw.outcome === 'cancelled' ||
    raw.outcome === 'timeout'
      ? raw.outcome
      : 'provider-error';
  const provider = raw.provider
    ? providerMetadataSchema.safeParse(raw.provider)
    : undefined;
  const reportedFailure = raw.failure
    ? providerFailureSchema.safeParse(raw.failure)
    : undefined;
  const failureCode =
    outcome === 'cancelled'
      ? 'cancelled'
      : outcome === 'timeout'
        ? 'timeout'
        : outcome === 'completed'
          ? undefined
          : reportedFailure?.success
            ? reportedFailure.data.code
            : 'provider-http';
  const decision =
    includeDecision && outcome === 'completed'
      ? reflexDecisionSchema.safeParse(raw.reflexDecision)
      : undefined;
  return {
    outcome,
    ...(provider?.success ? { provider: provider.data } : {}),
    ...(failureCode ? { failure: failureForCode(failureCode, model) } : {}),
    ...(decision?.success ? { reflexDecision: decision.data } : {}),
  };
}

function fallbackSelection(
  compiled: CompiledReflexObservation,
  failure?: ProviderFailure,
): ReflexSelection {
  return {
    action: { type: 'wait' },
    observation: compiled.observation,
    decision: null,
    cognitionSource: 'deterministic-fallback',
    ...(failure ? { failure } : {}),
  };
}

function validateReflexDecision(
  compiled: CompiledReflexObservation,
  rawDecision: unknown,
  model: string,
): ReflexSelection {
  const parsed = reflexDecisionSchema.safeParse(rawDecision);
  if (!parsed.success)
    throw new ReflexProviderError(failureForCode('malformed-response', model));
  const decision = parsed.data;
  if (decision.directiveId !== compiled.observation.directive.id)
    throw new ReflexProviderError(
      failureForCode('unsupported-response', model),
    );
  if (decision.cognitionSource !== 'jev-reflex')
    throw new ReflexProviderError(
      failureForCode('unsupported-response', model),
    );
  const action = compiled.actions.get(decision.chosenCandidateId);
  if (!action)
    throw new ReflexProviderError(
      failureForCode('unsupported-response', model),
    );
  const probabilityIds = Object.keys(decision.probabilities);
  const probabilityTotal = Object.values(decision.probabilities).reduce(
    (total, value) => total + value,
    0,
  );
  if (
    probabilityIds.length !== compiled.actions.size ||
    probabilityIds.some((id) => !compiled.actions.has(id)) ||
    Math.abs(probabilityTotal - 1) > 0.001 ||
    Object.values(decision.probabilities).some(
      (value) => value > decision.probabilities[decision.chosenCandidateId]!,
    )
  )
    throw new ReflexProviderError(
      failureForCode('unsupported-response', model),
    );
  return {
    action,
    observation: compiled.observation,
    decision,
    cognitionSource: 'jev-reflex',
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}

function freezeObservation(input: ReflexObservation): ReflexObservation {
  return deepFreeze(reflexObservationSchema.parse(structuredClone(input)));
}

export class ReflexSelectionDeadlineError extends Error {
  constructor() {
    super('The reflex selection exceeded the tick deadline.');
    this.name = 'ReflexSelectionDeadlineError';
  }
}

export interface ReflexBatchSelectionInput {
  compiled: CompiledReflexObservation;
  intendedTickNumber?: number;
  intendedTurnNumber: number;
  /** The initial request consumes a permit reserved before the tick began. */
  initialPermitReserved?: boolean;
}

export interface ReflexBatchSelectionOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
  accounting?: AttemptAccounting;
  /** Bounds scalar-provider adapters; native batch providers make one call. */
  concurrencyLimit?: number;
  now?: () => string;
}

const MAX_REFLEX_BATCH_WORKERS = 31;
const MAX_REFLEX_BATCH_RESULTS = 64;

function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 8)
    throw new RangeError(
      'Reflex concurrencyLimit must be an integer from 1 to 8.',
    );
  return value;
}

/** Selects each worker independently while sharing one native batch dispatch. */
export async function chooseReflexWorldActions(
  inputs: readonly ReflexBatchSelectionInput[],
  provider: ReflexProvider,
  options: ReflexBatchSelectionOptions = {},
): Promise<ReflexSelection[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_REFLEX_BATCH_WORKERS)
    throw new RangeError(
      `A reflex batch may contain at most ${MAX_REFLEX_BATCH_WORKERS} workers.`,
    );
  const agentIds = inputs.map(({ compiled }) => compiled.observation.agentId);
  if (new Set(agentIds).size !== agentIds.length)
    throw new Error('A reflex batch cannot contain duplicate worker IDs.');
  const intendedTicks = new Set(
    inputs.flatMap(({ intendedTickNumber }) =>
      intendedTickNumber === undefined ? [] : [intendedTickNumber],
    ),
  );
  if (intendedTicks.size > 1)
    throw new Error('A reflex batch must belong to one intended tick.');
  if (
    provider.decideBatch &&
    options.accounting &&
    inputs.some(({ intendedTickNumber }) => intendedTickNumber === undefined)
  )
    throw new Error(
      'Accounted native batches require an intended tick number.',
    );
  if (options.signal?.aborted) throw new ReflexSelectionCancelledError();
  if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    throw new ReflexSelectionDeadlineError();
  const concurrency = validateConcurrency(options.concurrencyLimit ?? 1);
  if (
    concurrency > 1 &&
    !provider.decideBatch &&
    options.accounting &&
    (inputs.some(({ initialPermitReserved }) => !initialPermitReserved) ||
      options.accounting.snapshot().reservedPermits < inputs.length)
  )
    throw new Error(
      'Concurrent scalar reflex selection requires a reserved initial permit for every worker.',
    );
  const reservedRetryCount =
    concurrency > 1 && !provider.decideBatch && options.accounting
      ? options.accounting.reserveUpTo(inputs.length)
      : 0;
  const model = provider.model ?? 'jev-1.13.0';
  const observations = inputs.map(({ compiled }) =>
    freezeObservation(compiled.observation),
  );
  const frozenCompiled = inputs.map((input, index) => ({
    ...input.compiled,
    observation: observations[index]!,
  }));
  const controller = new AbortController();
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;
  let abortReason: 'cancelled' | 'timeout' | undefined;
  const openFinalizers = new Map<
    (completion: SafeBatchCompletion) => void,
    { finalize: (completion: SafeBatchCompletion) => void; agentId?: string }
  >();
  type SafeBatchCompletion = {
    outcome: 'completed' | 'provider-error' | 'cancelled' | 'timeout';
    provider?: ProviderMetadata;
    failure?: ProviderFailure;
    reflexDecision?: ReflexDecision;
    completedAt: string;
  };
  const closeOpenAttempts = (
    outcome: 'cancelled' | 'timeout' | 'provider-error',
  ) => {
    closed = true;
    for (const { finalize } of [...openFinalizers.values()])
      finalize({
        outcome,
        failure:
          outcome === 'provider-error'
            ? failureForCode('unsupported-response', model)
            : failureForCode(outcome, model),
        completedAt: now(),
      });
    openFinalizers.clear();
  };
  let expireDeadline: () => void = () => undefined;
  const finalizeOpenForAgent = (agentId: string, outcome: 'provider-error') => {
    for (const [key, entry] of [...openFinalizers]) {
      if (entry.agentId !== agentId) continue;
      entry.finalize({
        outcome,
        failure: failureForCode('unsupported-response', model),
        completedAt: now(),
      });
      openFinalizers.delete(key);
    }
  };
  const startAttempt = (
    kind: 'initial' | 'automatic-transport-retry',
    members: readonly ReflexBatchSelectionInput[],
    batchId: string,
    reserved: boolean,
  ) => {
    if (!options.accounting) return null;
    if (
      closed ||
      controller.signal.aborted ||
      (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    ) {
      if (
        !closed &&
        options.deadlineAtMs !== undefined &&
        Date.now() >= options.deadlineAtMs
      )
        expireDeadline();
      return null;
    }
    const first = members[0]!;
    const details = {
      agentId: first.compiled.observation.agentId,
      intendedTurnNumber: first.intendedTurnNumber,
      ...(first.intendedTickNumber === undefined
        ? {}
        : { intendedTickNumber: first.intendedTickNumber }),
      kind,
      startedAt: now(),
      modelId: model,
      reasoningProfile: 'provider-default',
      batch: {
        id: batchId,
        members: members.map((member) => ({
          agentId: member.compiled.observation.agentId,
          intendedTurnNumber: member.intendedTurnNumber,
        })),
      },
    } as const;
    const permit =
      kind === 'initial' && reserved
        ? options.accounting.startReserved(details)
        : options.accounting.startAdditional(details);
    if (permit === null) return null;
    let finalized = false;
    const finalize = (completion: SafeBatchCompletion) => {
      if (finalized) return;
      finalized = true;
      openFinalizers.delete(finalize);
      options.accounting!.finalize(permit, completion);
    };
    openFinalizers.set(finalize, { finalize });
    return (completion: unknown) => {
      if (closed || finalized) return;
      finalize({
        ...normalizeAttemptCompletion(completion, model, false),
        completedAt: now(),
      });
    };
  };
  const scalarBeginAttempt = (
    input: ReflexBatchSelectionInput,
    inputIndex: number,
    onStarted: () => void,
    isSettled: () => boolean,
  ) => {
    const startedKinds = new Set<string>();
    const finalizedKinds = new Set<string>();
    return (kind: 'initial' | 'automatic-transport-retry') => {
      if (isSettled() || startedKinds.has(kind)) return null;
      if (
        kind === 'automatic-transport-retry' &&
        !finalizedKinds.has('initial')
      )
        return null;
      if (!options.accounting) return null;
      if (
        closed ||
        controller.signal.aborted ||
        (options.deadlineAtMs !== undefined &&
          Date.now() >= options.deadlineAtMs)
      ) {
        if (
          !closed &&
          options.deadlineAtMs !== undefined &&
          Date.now() >= options.deadlineAtMs
        )
          expireDeadline();
        return null;
      }
      const details = {
        agentId: input.compiled.observation.agentId,
        intendedTurnNumber: input.intendedTurnNumber,
        ...(input.intendedTickNumber === undefined
          ? {}
          : { intendedTickNumber: input.intendedTickNumber }),
        kind,
        startedAt: now(),
        modelId: model,
        reasoningProfile: 'provider-default',
      } as const;
      const permit =
        kind === 'initial' && input.initialPermitReserved
          ? options.accounting.startReserved(details)
          : kind === 'automatic-transport-retry' && concurrency > 1
            ? inputIndex < reservedRetryCount
              ? options.accounting.startReserved(details)
              : null
            : options.accounting.startAdditional(details);
      if (permit === null) return null;
      startedKinds.add(kind);
      onStarted();
      let finalized = false;
      const finalize = (completion: SafeBatchCompletion) => {
        if (finalized) return;
        finalized = true;
        finalizedKinds.add(kind);
        openFinalizers.delete(finalize);
        options.accounting!.finalize(permit, completion);
      };
      openFinalizers.set(finalize, {
        finalize,
        agentId: input.compiled.observation.agentId,
      });
      return (completion: unknown) => {
        if (closed || finalized || isSettled()) return;
        finalize({
          ...normalizeAttemptCompletion(completion, model, true),
          completedAt: now(),
        });
      };
    };
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectLifecycle!: (error: Error) => void;
  const lifecycle = new Promise<never>((_, reject) => {
    rejectLifecycle = reject;
  });
  // The deadline may already be expired before the provider operation starts.
  // Keep early rejection handled until the racing await is attached below.
  void lifecycle.catch(() => undefined);
  const onExternalAbort = () => {
    if (closed) return;
    abortReason = 'cancelled';
    controller.abort();
    closeOpenAttempts('cancelled');
    rejectLifecycle(new ReflexSelectionCancelledError());
  };
  expireDeadline = () => {
    if (closed) return;
    abortReason = 'timeout';
    controller.abort();
    closeOpenAttempts('timeout');
    rejectLifecycle(new ReflexSelectionDeadlineError());
  };
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  if (options.deadlineAtMs !== undefined) {
    const remaining = options.deadlineAtMs - Date.now();
    if (remaining <= 0) {
      expireDeadline();
    } else {
      deadlineTimer = setTimeout(() => {
        expireDeadline();
      }, remaining);
    }
  }

  const invoke = async (): Promise<readonly ReflexBatchDecisionResult[]> => {
    if (closed || controller.signal.aborted) {
      if (abortReason === 'timeout') throw new ReflexSelectionDeadlineError();
      throw new ReflexSelectionCancelledError();
    }
    if (
      options.deadlineAtMs !== undefined &&
      Date.now() >= options.deadlineAtMs
    ) {
      expireDeadline();
      throw new ReflexSelectionDeadlineError();
    }
    if (provider.decideBatch) {
      const batchId = crypto.randomUUID();
      let attemptsStarted = 0;
      let settled = false;
      const startedKinds = new Set<string>();
      const finalizedKinds = new Set<string>();
      const result = await provider
        .decideBatch(observations, {
          signal: controller.signal,
          deadlineAtMs: options.deadlineAtMs,
          beginAttempt: options.accounting
            ? (kind) => {
                if (settled || startedKinds.has(kind)) return null;
                if (
                  kind === 'automatic-transport-retry' &&
                  !finalizedKinds.has('initial')
                )
                  return null;
                const finalize = startAttempt(
                  kind,
                  inputs,
                  batchId,
                  inputs[0]?.initialPermitReserved ?? false,
                );
                if (finalize === null) return null;
                attemptsStarted += 1;
                startedKinds.add(kind);
                return (completion) => {
                  if (settled) return;
                  finalize(completion);
                  finalizedKinds.add(kind);
                };
              }
            : undefined,
        })
        .finally(() => {
          settled = true;
        });
      if (options.accounting && attemptsStarted === 0)
        return inputs.map(({ compiled }) => ({
          agentId: compiled.observation.agentId,
          status: 'failed' as const,
          failure: failureForCode('unsupported-response', model),
        }));
      return result;
    }

    const results: ReflexBatchDecisionResult[] = new Array(inputs.length);
    const countableInputs = inputs.map((input) => ({ ...input }));
    let cursor = 0;
    const invokeOne = async (index: number) => {
      const input = countableInputs[index]!;
      let attemptsStarted = 0;
      let settled = false;
      try {
        const decision = await provider
          .decide(observations[index]!, {
            signal: controller.signal,
            deadlineAtMs: options.deadlineAtMs,
            beginAttempt: options.accounting
              ? scalarBeginAttempt(
                  input,
                  index,
                  () => attemptsStarted++,
                  () => settled,
                )
              : undefined,
          })
          .finally(() => {
            settled = true;
          });
        results[index] =
          attemptsStarted === 0 && options.accounting
            ? {
                agentId: input.compiled.observation.agentId,
                status: 'failed' as const,
                failure: failureForCode('unsupported-response', model),
              }
            : {
                agentId: input.compiled.observation.agentId,
                status: 'completed' as const,
                decision,
              };
        finalizeOpenForAgent(
          input.compiled.observation.agentId,
          'provider-error',
        );
      } catch (error) {
        const safe = safeFailure(error, model);
        finalizeOpenForAgent(
          input.compiled.observation.agentId,
          'provider-error',
        );
        results[index] = {
          agentId: input.compiled.observation.agentId,
          status: 'failed' as const,
          failure: safe.failure,
        };
      }
    };
    cursor = 0;
    const boundedWorkers = Array.from(
      { length: Math.min(concurrency, inputs.length) },
      async () => {
        while (!closed) {
          if (
            options.deadlineAtMs !== undefined &&
            Date.now() >= options.deadlineAtMs
          ) {
            expireDeadline();
            return;
          }
          const index = cursor++;
          if (index >= inputs.length) return;
          await invokeOne(index);
        }
      },
    );
    await Promise.all(boundedWorkers);
    return results.filter(
      (result): result is ReflexBatchDecisionResult => result !== undefined,
    );
  };

  try {
    const providerOperation = invoke();
    const rawResults = await Promise.race([providerOperation, lifecycle]);
    if (
      abortReason === 'timeout' ||
      (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    ) {
      closeOpenAttempts('timeout');
      throw new ReflexSelectionDeadlineError();
    }
    if (options.signal?.aborted) throw new ReflexSelectionCancelledError();
    closeOpenAttempts('provider-error');
    return mapBatchResults(frozenCompiled, rawResults, model);
  } catch (error) {
    if (error instanceof ReflexSelectionCancelledError) throw error;
    if (error instanceof ReflexSelectionDeadlineError) throw error;
    if (options.signal?.aborted || abortReason === 'cancelled')
      throw new ReflexSelectionCancelledError();
    if (
      abortReason === 'timeout' ||
      (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    ) {
      expireDeadline();
      throw new ReflexSelectionDeadlineError();
    }
    closeOpenAttempts('provider-error');
    return frozenCompiled.map((compiled) =>
      fallbackSelection(compiled, safeFailure(error, model).failure),
    );
  } finally {
    closed = true;
    controller.abort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function mapBatchResults(
  compiled: readonly CompiledReflexObservation[],
  rawResults: unknown,
  model: string,
): ReflexSelection[] {
  const byAgent = new Map<string, unknown[]>();
  if (
    Array.isArray(rawResults) &&
    rawResults.length <= MAX_REFLEX_BATCH_RESULTS
  ) {
    for (const raw of rawResults) {
      if (!raw || typeof raw !== 'object') continue;
      const agentId = (raw as { agentId?: unknown }).agentId;
      if (typeof agentId !== 'string') continue;
      const matches = byAgent.get(agentId) ?? [];
      matches.push(raw);
      byAgent.set(agentId, matches);
    }
  }
  return compiled.map((item) => {
    const agentId = item.observation.agentId;
    const matches = byAgent.get(agentId) ?? [];
    if (
      !Array.isArray(rawResults) ||
      rawResults.length > MAX_REFLEX_BATCH_RESULTS ||
      matches.length !== 1
    )
      return fallbackSelection(
        item,
        failureForCode('unsupported-response', model),
      );
    const parsedResult = reflexBatchResultEnvelopeSchema.safeParse(matches[0]);
    if (!parsedResult.success)
      return fallbackSelection(
        item,
        failureForCode('unsupported-response', model),
      );
    const result = parsedResult.data;
    if (result.status === 'failed') {
      const parsed = providerFailureSchema.safeParse(result.failure);
      return fallbackSelection(
        item,
        failureForCode(
          parsed.success ? parsed.data.code : 'provider-http',
          model,
        ),
      );
    }
    try {
      return validateReflexDecision(item, result.decision, model);
    } catch (error) {
      return fallbackSelection(item, safeFailure(error, model).failure);
    }
  });
}

/** A failed Jev request selects wait; the independent attempt ledger records it. */
export async function chooseReflexWorldAction(
  state: WorldState,
  directive: SwarmDirective,
  provider: ReflexProvider,
  options: ReflexSelectionOptions = {},
): Promise<ReflexSelection> {
  const compiled = compileReflexObservation(state, directive, options.history);
  const scalarProvider: ReflexProvider = {
    mode: provider.mode,
    model: provider.model,
    configured: provider.configured,
    decide: provider.decide.bind(provider),
  };
  const [selection] = await chooseReflexWorldActions(
    [
      {
        compiled,
        intendedTurnNumber: options.intendedTurnNumber ?? 1,
        ...(options.intendedTickNumber === undefined
          ? {}
          : { intendedTickNumber: options.intendedTickNumber }),
        initialPermitReserved: options.initialPermitReserved,
      },
    ],
    scalarProvider,
    {
      signal: options.signal,
      deadlineAtMs: options.deadlineAtMs,
      accounting: options.accounting,
      now: options.now,
    },
  );
  return selection!;
}
