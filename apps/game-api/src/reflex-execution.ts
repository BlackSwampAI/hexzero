import { gridDistance } from 'h3-js';
import {
  ReflexProviderError,
  type ReflexProvider,
} from '@hexzero/agent-runtime';
import {
  h3CellSchema,
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
    return 'Capture the abandoned infected current cell from a non-allied controller.';
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

function safeFailure(
  error: unknown,
  model: string,
): {
  failure: ProviderFailure;
  metadata?: ProviderMetadata;
} {
  if (error instanceof ReflexProviderError)
    return { failure: error.failure, metadata: error.metadata };
  return {
    failure: {
      code: 'provider-http',
      message: 'The reflex provider failed.',
      retryable: false,
      model,
    },
  };
}

/** A failed Jev request selects wait; the independent attempt ledger still records it. */
export async function chooseReflexWorldAction(
  state: WorldState,
  directive: SwarmDirective,
  provider: ReflexProvider,
  options: ReflexSelectionOptions = {},
): Promise<ReflexSelection> {
  const compiled = compileReflexObservation(state, directive, options.history);
  const fallback = (failure?: ProviderFailure): ReflexSelection => ({
    action: { type: 'wait' },
    observation: compiled.observation,
    decision: null,
    cognitionSource: 'deterministic-fallback',
    ...(failure ? { failure } : {}),
  });
  if (options.signal?.aborted) throw new ReflexSelectionCancelledError();
  const model = provider.model ?? 'jev-1.13.0';
  const now = options.now ?? (() => new Date().toISOString());
  let startedAttempts = 0;
  try {
    const rawDecision = await provider.decide(compiled.observation, {
      signal: options.signal,
      deadlineAtMs: options.deadlineAtMs,
      beginAttempt: options.accounting
        ? (kind) => {
            const details = {
              agentId: compiled.observation.agentId,
              intendedTurnNumber: options.intendedTurnNumber ?? 1,
              ...(options.intendedTickNumber
                ? { intendedTickNumber: options.intendedTickNumber }
                : {}),
              kind,
              startedAt: now(),
              modelId: model,
              reasoningProfile: 'provider-default',
            } as const;
            const permit =
              kind === 'initial' && options.initialPermitReserved
                ? options.accounting!.startReserved(details)
                : options.accounting!.startAdditional(details);
            if (permit === null) return null;
            startedAttempts += 1;
            return (completion) =>
              options.accounting!.finalize(permit, {
                ...completion,
                completedAt: now(),
              });
          }
        : undefined,
    });
    if (options.accounting && startedAttempts === 0)
      throw new ReflexProviderError({
        code: 'unsupported-response',
        message: 'The reflex provider skipped attempt accounting.',
        retryable: false,
        model,
      });
    const parsed = reflexDecisionSchema.safeParse(rawDecision);
    if (!parsed.success)
      throw new ReflexProviderError({
        code: 'malformed-response',
        message: 'The reflex decision failed schema validation.',
        retryable: false,
        model,
      });
    const decision = parsed.data;
    if (options.signal?.aborted) throw new ReflexSelectionCancelledError();
    if (decision.directiveId !== compiled.observation.directive.id)
      throw new ReflexProviderError({
        code: 'unsupported-response',
        message: 'The reflex decision references another directive.',
        retryable: false,
        model,
      });
    if (decision.cognitionSource !== 'jev-reflex')
      throw new ReflexProviderError({
        code: 'unsupported-response',
        message: 'The reflex decision has incorrect cognition attribution.',
        retryable: false,
        model,
      });
    const action = compiled.actions.get(decision.chosenCandidateId);
    if (!action)
      throw new ReflexProviderError({
        code: 'unsupported-response',
        message: 'The reflex decision selected an unknown candidate.',
        retryable: false,
        model,
      });
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
      throw new ReflexProviderError({
        code: 'unsupported-response',
        message: 'The reflex decision has inconsistent probability telemetry.',
        retryable: false,
        model,
      });
    return {
      action,
      observation: compiled.observation,
      decision,
      cognitionSource: 'jev-reflex',
    };
  } catch (error) {
    const cancelled =
      error instanceof ReflexSelectionCancelledError || options.signal?.aborted;
    const safe = safeFailure(error, model);
    const failure: ProviderFailure = cancelled
      ? {
          code: 'cancelled',
          message: 'The reflex request was cancelled.',
          retryable: false,
          model,
        }
      : safe.failure;
    if (cancelled) throw new ReflexSelectionCancelledError();
    return fallback(failure);
  }
}
