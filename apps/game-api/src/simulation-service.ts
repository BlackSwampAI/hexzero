import { gridDisk, gridDistance } from 'h3-js';
import {
  SwarmPlannerError,
  type ReflexProvider,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  experimentIdSchema,
  experimentExportDocumentSchema,
  experimentExportPreviewSchema,
  experimentModelConfigurationSchema,
  modelSupportsReasoningProfile,
  updateExperimentModelsRequestSchema,
  h3CellSchema,
  OPENROUTER_PROVIDER_TIMEOUT_MS,
  WORLD_SCENARIO_LIMITS,
  PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT,
  PATIENT_ZERO_PRESSURE_WINDOW_TICKS,
  swarmDirectiveSchema,
  swarmPlanSchema,
  swarmTickRecordSchema,
  simulationSnapshotSchema,
  type Agent,
  type AgentId,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentId,
  type ExperimentModelConfiguration,
  type CompatibleModel,
  type ModelId,
  type ExperimentConfigurationEvent,
  type H3Cell,
  type ProviderFailure,
  type ProviderMetadata,
  type ReasoningProfile,
  type SimulationSnapshot,
  type SimulationStatus,
  type WorldEvent,
  type SimulatedPlayerEvent,
  type SwarmPlan,
  type CompletedSwarmDirective,
  type SwarmReplanReason,
  type SwarmTickRecord,
  type ZeroStrategicObservation,
  type PatientZeroPressureContext,
  type CaptureAlert,
  worldSetupRequestSchema,
  type AppliedScenario,
  type WorldSetupPreviewResponse,
  type WorldSetupRequest,
} from '@hexzero/shared';
import {
  applyWorldAction,
  createDevelopmentWorld,
  createDefaultAppliedScenario,
  createWorldFromScenario,
  defaultWorldSetupRequest,
  previewWorldSetup,
  seededTickIntervalMinutes,
  seededTickOrder,
  advanceSimulatedPlayer,
  enumerateLegalWorldActions,
  toWorldState,
  type WorldState,
} from '@hexzero/world-engine';
import {
  calculateExperimentMetrics,
  createExperimentExport,
  createExperimentPreview,
  type ExperimentSource,
} from './experiment-export';
import { geographicDirectionBetweenCells } from './geographic-direction';
import {
  boundedPressureEvents,
  boundedRecentCaptures,
  localPressureAtCell,
} from './swarm-pressure';
import { AttemptAccounting } from './attempt-accounting';
import {
  chooseReflexWorldAction,
  compileReflexObservation,
  ReflexSelectionCancelledError,
  type CompiledReflexObservation,
  type ReflexSelection,
} from './reflex-execution';
import {
  isSwarmDirectiveComplete,
  swarmDirectiveIssue,
} from './swarm-directives';

function attemptAccountingForScenario(
  executionLimits: AppliedScenario['executionLimits'],
  retentionLimit = DEFAULT_EXPERIMENT_RETENTION,
): AttemptAccounting {
  return new AttemptAccounting(
    executionLimits.providerAttemptLimit,
    executionLimits.creditLimit,
    executionLimits.reservationCreditsPerAttempt,
    retentionLimit * 2,
  );
}

const RESET_GENERATED_AT = '2026-08-13T12:00:00.000Z';
const MAX_TURN_HISTORY = 120;
const MAX_WORLD_EVENT_HISTORY = 120;
const DEFAULT_EXPERIMENT_RETENTION = 5_000;
export const LOW_PRESSURE_REPLAN_THRESHOLD = 0.8;
export const ELEVATED_PRESSURE_REPLAN_THRESHOLD = 0.5;

export function replanThresholdForPressure(
  pressure: 'low' | 'rising' | 'high',
): number {
  return pressure === 'low'
    ? LOW_PRESSURE_REPLAN_THRESHOLD
    : ELEVATED_PRESSURE_REPLAN_THRESHOLD;
}

function chooseDeterministicWorkerAction(
  compiled: CompiledReflexObservation,
  selectCandidateId: (compiled: CompiledReflexObservation) => string,
): ReflexSelection {
  const action = compiled.actions.get(selectCandidateId(compiled));
  return {
    action: action ?? { type: 'wait' },
    observation: compiled.observation,
    decision: null,
    cognitionSource: 'deterministic-fallback',
  };
}

function selectNeutralFallbackCandidate(
  compiled: CompiledReflexObservation,
  state: WorldState,
): string {
  const choices = [...compiled.actions];
  return (choices.find(([, action]) => action.type === 'infect') ??
    choices.find(([, action]) => action.type === 'capture') ??
    choices.find(
      ([, action]) =>
        action.type === 'move' &&
        state.hexes.get(action.targetCell)?.state === 'open',
    ) ??
    choices.find(([, action]) => action.type === 'wait'))![0];
}

export function selectMostRecentPatientZeroThreats<
  T extends { eventId: string; occurredAt: string },
>(events: readonly T[]): T[] {
  return [...events]
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.eventId.localeCompare(right.eventId),
    )
    .slice(-PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT);
}

export function calculatePatientZeroPressureContext(
  events: readonly WorldEvent[],
  subjectAgentId: AgentId,
  currentTick: number,
): PatientZeroPressureContext {
  const startTick = Math.max(
    1,
    currentTick - PATIENT_ZERO_PRESSURE_WINDOW_TICKS + 1,
  );
  const relevant = events.filter(
    (
      event,
    ): event is Extract<
      WorldEvent,
      { type: 'hex-disinfected' | 'simulated-player-clean-blocked' }
    > =>
      (event.type === 'hex-disinfected' ||
        event.type === 'simulated-player-clean-blocked') &&
      (event.type !== 'hex-disinfected' ||
        event.previousControllerAgentId !== null) &&
      event.originatingTick >= startTick &&
      event.originatingTick <= currentTick,
  );
  const eventSubject = (event: (typeof relevant)[number]): AgentId | null =>
    event.type === 'hex-disinfected'
      ? event.previousControllerAgentId
      : event.blockingAgentId;
  const countsFor = (selected: readonly (typeof relevant)[number][]) => ({
    totalEvents: selected.length,
    disinfections: selected.filter(({ type }) => type === 'hex-disinfected')
      .length,
    blockedCleans: selected.filter(
      ({ type }) => type === 'simulated-player-clean-blocked',
    ).length,
  });
  const subjectEvents = relevant.filter(
    (event) => eventSubject(event) === subjectAgentId,
  );
  const subjectTicks = new Set(
    subjectEvents.map(({ originatingTick }) => originatingTick),
  );
  if (!subjectTicks.has(currentTick))
    throw new Error(
      'Patient Zero pressure context requires a current subject event.',
    );
  let consecutiveAffectedTicks = 0;
  for (
    let tick = currentTick;
    tick >= startTick && subjectTicks.has(tick);
    tick -= 1
  )
    consecutiveAffectedTicks += 1;
  return {
    window: {
      tickCount: currentTick - startTick + 1,
      startTick,
      endTick: currentTick,
    },
    subject: {
      ...countsFor(subjectEvents),
      consecutiveAffectedTicks,
    },
  };
}

function captureAlertsFrom(
  events: readonly SimulatedPlayerEvent[],
): CaptureAlert[] {
  return events
    .filter(
      (
        event,
      ): event is Extract<
        SimulatedPlayerEvent,
        { type: 'simulated-player-agent-captured' }
      > => event.type === 'simulated-player-agent-captured',
    )
    .slice(-4)
    .map(({ capturedAgentId, cell, originatingTick, abandonedCellCount }) => ({
      capturedAgentId,
      cell,
      originatingTick,
      abandonedCellCount,
    }));
}

export class SimulationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationConflictError';
  }
}

export class SimulationTurnCancelledError extends Error {
  constructor() {
    super('The active model request was cancelled without consuming a turn.');
    this.name = 'SimulationTurnCancelledError';
  }
}

export type SimulationValidationCode =
  | 'unknown_agent'
  | 'invalid_request'
  | 'invalid_model_configuration'
  | 'models_unavailable'
  | 'experiment_budget_exhausted';

export class SimulationValidationError extends Error {
  constructor(
    readonly code: SimulationValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'SimulationValidationError';
  }
}

export interface SimulationServiceOptions {
  swarmPlanner: SwarmPlanner;
  reflexProvider: ReflexProvider;
  /**
   * Offline comparison seam: choose one opaque, already legal candidate without
   * calling a reflex provider. Production zero-swarm execution leaves this unset.
   */
  deterministicWorkerCandidateSelector?: (
    compiled: CompiledReflexObservation,
  ) => string;
  now?: () => string;
  createEventId?: () => string;
  createExperimentId?: () => string;
  experimentRetentionLimit?: number;
}

export class SimulationService {
  readonly #swarmPlanner: SwarmPlanner;
  readonly #reflexProvider: ReflexProvider;
  readonly #deterministicWorkerCandidateSelector:
    ((compiled: CompiledReflexObservation) => string) | undefined;
  readonly #now: () => string;
  readonly #createEventId: () => string;
  readonly #createExperimentId: () => string;
  readonly #experimentRetentionLimit: number;
  #state: WorldState;
  #completedSwarmDecisionCount = 0;
  #completedTickCount = 0;
  #virtualTime = RESET_GENERATED_AT;
  #lastTickIntervalMinutes: number | null = null;
  #resolutionOrder: AgentId[] = [];
  #busy = false;
  #verificationBusy = false;
  #status: SimulationStatus;
  #activeAgentId: AgentId | null = null;
  #activeRequestController: AbortController | null = null;
  #cancellationRequested = false;
  #experimentId: ExperimentId;
  #experimentStartedAt: string;
  #initialExperimentAgents: Agent[];
  #initialExperimentWorld: SimulationSnapshot['world'];
  #configurationEvents: ExperimentConfigurationEvent[] = [];
  #modelConfiguration: ExperimentModelConfiguration;
  #scenario: AppliedScenario;
  #availableModelIds = new Set<ModelId>();
  #availableModels = new Map<ModelId, CompatibleModel>();
  #simulatedPlayerEvents: SimulatedPlayerEvent[] = [];
  #attemptAccounting: AttemptAccounting;
  #swarmTicks: SwarmTickRecord[] = [];
  #experimentSwarmTicks: SwarmTickRecord[] = [];
  #lastValidSwarmPlan: SwarmPlan | null = null;
  #lastSwarmTerritoryCounts = new Map<AgentId, number>();
  #lastSwarmTerritoryDeltas = new Map<AgentId, number>();
  #lastSwarmPositions = new Map<AgentId, H3Cell>();

  constructor({
    swarmPlanner,
    reflexProvider,
    deterministicWorkerCandidateSelector,
    now = () => new Date().toISOString(),
    createEventId = () => crypto.randomUUID(),
    createExperimentId = () => crypto.randomUUID(),
    experimentRetentionLimit = DEFAULT_EXPERIMENT_RETENTION,
  }: SimulationServiceOptions) {
    if (
      !Number.isInteger(experimentRetentionLimit) ||
      experimentRetentionLimit < 1
    )
      throw new Error('Experiment retention limit must be a positive integer.');
    this.#swarmPlanner = swarmPlanner;
    this.#reflexProvider = reflexProvider;
    this.#deterministicWorkerCandidateSelector =
      deterministicWorkerCandidateSelector;
    this.#now = now;
    this.#createEventId = createEventId;
    this.#createExperimentId = createExperimentId;
    this.#experimentRetentionLimit = experimentRetentionLimit;
    this.#state = toWorldState(
      createDevelopmentWorld({ generatedAt: RESET_GENERATED_AT }),
    );
    this.#status =
      swarmPlanner.configured && reflexProvider.configured
        ? 'paused'
        : 'configuration-error';
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    const scriptedModel =
      swarmPlanner.mode === 'scripted-swarm-test'
        ? ('deterministic-script' as ModelId)
        : null;
    this.#modelConfiguration = experimentModelConfigurationSchema.parse({
      globalModelId: scriptedModel,
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    });
    if (scriptedModel) this.#availableModelIds.add(scriptedModel);
    this.#scenario = {
      ...createDefaultAppliedScenario(RESET_GENERATED_AT),
      modelConfiguration: structuredClone(this.#modelConfiguration),
    };
    this.#attemptAccounting = attemptAccountingForScenario(
      this.#scenario.executionLimits,
      this.#experimentRetentionLimit,
    );
  }

  getSnapshot(): SimulationSnapshot {
    const agents = [...this.#state.agents.values()];
    return simulationSnapshotSchema.parse({
      world: this.#worldSnapshot(),
      scenario: this.#scenario,
      tickNumber: this.#completedTickCount,
      virtualTime: this.#virtualTime,
      lastTickIntervalMinutes: this.#lastTickIntervalMinutes,
      resolutionOrder: this.#resolutionOrder,
      activeAgentId: this.#activeAgentId,
      cancellationRequested: this.#cancellationRequested,
      status: this.#status,
      providerMode:
        this.#swarmPlanner.mode === 'openrouter-swarm'
          ? 'openrouter'
          : 'scripted-test',
      providerConfigured:
        this.#swarmPlanner.configured && this.#reflexProvider.configured,
      swarmProviderStatus: {
        plannerMode: this.#swarmPlanner.mode,
        plannerConfigured: this.#swarmPlanner.configured,
        reflexMode: this.#reflexProvider.mode,
        reflexConfigured: this.#reflexProvider.configured,
        ...(this.#reflexProvider.model
          ? { reflexModel: this.#reflexProvider.model }
          : {}),
      },
      modelConfiguration: this.#modelConfiguration,
      resolvedModels: agents.map(({ id }) => this.#resolvedModel(id)),
      swarmTicks: structuredClone(this.#swarmTicks),
      experiment: {
        id: this.#experimentId,
        startedAt: this.#experimentStartedAt,
        attemptAccounting: this.#attemptAccounting.snapshot(),
        metrics: calculateExperimentMetrics(
          [],
          agents.map(({ id }) => id),
        ),
        currentTerritory: this.#territoryScoreboard(),
        simulatedPlayerMetrics: this.#state.simulatedPlayer?.metrics ?? {
          movements: 0,
          cellsDisinfected: 0,
          blockedDisinfections: 0,
        },
      },
    });
  }

  reset(): SimulationSnapshot {
    if (this.#busy || this.#verificationBusy) {
      throw new SimulationConflictError(
        'Reset is unavailable while model execution is in progress.',
      );
    }
    this.#status = 'resetting';
    this.#state = toWorldState(
      createWorldFromScenario(this.#scenario, RESET_GENERATED_AT),
    );
    this.#completedSwarmDecisionCount = 0;
    this.#completedTickCount = 0;
    this.#virtualTime = RESET_GENERATED_AT;
    this.#lastTickIntervalMinutes = null;
    this.#resolutionOrder = [];
    this.#activeAgentId = null;
    this.#activeRequestController = null;
    this.#cancellationRequested = false;
    this.#swarmTicks = [];
    this.#experimentSwarmTicks = [];
    this.#lastValidSwarmPlan = null;
    this.#lastSwarmTerritoryCounts = new Map();
    this.#lastSwarmTerritoryDeltas = new Map();
    this.#lastSwarmPositions = new Map();
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#configurationEvents = [];
    this.#simulatedPlayerEvents = [];
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    this.#attemptAccounting = attemptAccountingForScenario(
      this.#scenario.executionLimits,
      this.#experimentRetentionLimit,
    );
    this.#modelConfiguration = {
      ...structuredClone(this.#scenario.modelConfiguration),
      locked: false,
    };
    this.#status =
      this.#swarmPlanner.configured && this.#reflexProvider.configured
        ? 'paused'
        : 'configuration-error';
    return this.getSnapshot();
  }

  previewWorldSetup(input: unknown): WorldSetupPreviewResponse {
    const parsed = worldSetupRequestSchema.safeParse(input);
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'roster');
      const code =
        field === 'center'
          ? 'invalid-coordinates'
          : field === 'resolution'
            ? 'unsupported-resolution'
            : field === 'radius'
              ? 'invalid-radius'
              : field === 'modelConfiguration'
                ? 'model-agent-mismatch'
                : 'invalid-roster';
      return {
        feasible: false,
        errors: [
          {
            code,
            field,
            message:
              parsed.error.issues[0]?.message ??
              'The scenario request is invalid.',
          },
        ],
        warnings: [],
      };
    }
    const selected = [
      parsed.data.modelConfiguration.globalModelId,
      ...parsed.data.modelConfiguration.overrides.map(({ modelId }) => modelId),
    ].filter((modelId): modelId is ModelId => modelId !== null);
    if (selected.some((modelId) => !this.#availableModelIds.has(modelId)))
      return {
        feasible: false,
        errors: [
          {
            code: 'model-agent-mismatch',
            message: 'The scenario contains an unavailable model assignment.',
          },
        ],
        warnings: [],
      };
    return previewWorldSetup(parsed.data, RESET_GENERATED_AT);
  }

  getDefaultWorldSetup(): WorldSetupRequest {
    const request = defaultWorldSetupRequest();
    const ids = new Set(request.roster.map(({ id }) => id));
    return {
      ...request,
      modelConfiguration: {
        ...structuredClone(this.#modelConfiguration),
        overrides: this.#modelConfiguration.overrides.filter(({ agentId }) =>
          ids.has(agentId),
        ),
        locked: false,
      },
    };
  }

  applyWorldSetup(input: unknown): SimulationSnapshot {
    if (this.#busy || this.#verificationBusy || this.#status === 'resetting')
      throw new SimulationConflictError(
        'World setup is unavailable while another mutation is active.',
      );
    const parsed = worldSetupRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new SimulationValidationError(
        'invalid_request',
        'The scenario request is invalid.',
      );
    const checked = this.previewWorldSetup(parsed.data);
    if (!checked.feasible)
      throw new SimulationValidationError(
        'invalid_model_configuration',
        checked.errors[0]?.message ?? 'The scenario is infeasible.',
      );
    const preview = previewWorldSetup(parsed.data, RESET_GENERATED_AT);
    if (!preview.feasible)
      throw new SimulationValidationError(
        'invalid_request',
        preview.errors[0]?.message ?? 'The scenario is infeasible.',
      );
    const nextState = toWorldState(preview.world);
    const nextModels = experimentModelConfigurationSchema.parse({
      ...preview.scenario.modelConfiguration,
      locked: false,
    });
    this.#state = nextState;
    this.#scenario = {
      ...preview.scenario,
      modelConfiguration: nextModels,
    };
    this.#modelConfiguration = nextModels;
    this.#completedSwarmDecisionCount = 0;
    this.#completedTickCount = 0;
    this.#virtualTime = RESET_GENERATED_AT;
    this.#lastTickIntervalMinutes = null;
    this.#resolutionOrder = [];
    this.#activeAgentId = null;
    this.#activeRequestController = null;
    this.#cancellationRequested = false;
    this.#swarmTicks = [];
    this.#experimentSwarmTicks = [];
    this.#lastValidSwarmPlan = null;
    this.#lastSwarmTerritoryCounts = new Map();
    this.#lastSwarmTerritoryDeltas = new Map();
    this.#lastSwarmPositions = new Map();
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#configurationEvents = [];
    this.#simulatedPlayerEvents = [];
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    this.#attemptAccounting = attemptAccountingForScenario(
      this.#scenario.executionLimits,
      this.#experimentRetentionLimit,
    );
    this.#status =
      this.#swarmPlanner.configured && this.#reflexProvider.configured
        ? 'paused'
        : 'configuration-error';
    return this.getSnapshot();
  }

  setCompatibleModels(models: CompatibleModel[]): void {
    this.#availableModels = new Map(models.map((model) => [model.id, model]));
    this.#availableModelIds = new Set(models.map(({ id }) => id));
    if (this.#swarmPlanner.mode === 'scripted-swarm-test')
      this.#availableModelIds.add('deterministic-script' as ModelId);
  }

  updateModelConfiguration(input: unknown): SimulationSnapshot {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'Model changes are unavailable while model execution is in progress.',
      );
    const parsed = updateExperimentModelsRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'The model assignment is invalid.',
      );
    const agentIds = new Set(this.#state.agents.keys());
    if (parsed.data.overrides.some(({ agentId }) => !agentIds.has(agentId)))
      throw new SimulationValidationError(
        'unknown_agent',
        'A model override references an unknown agent.',
      );
    const selected = [
      parsed.data.globalModelId,
      ...parsed.data.overrides.map(({ modelId }) => modelId),
    ].filter((modelId): modelId is ModelId => modelId !== null);
    if (selected.some((modelId) => !this.#availableModelIds.has(modelId)))
      throw new SimulationValidationError(
        'models_unavailable',
        'One or more selected models are not in the compatible OpenRouter catalog.',
      );
    if (
      (parsed.data.globalModelId !== null &&
        !modelSupportsReasoningProfile(
          this.#availableModels.get(parsed.data.globalModelId),
          parsed.data.globalReasoningProfile,
        )) ||
      parsed.data.overrides.some(
        ({ modelId, reasoningProfile }) =>
          !modelSupportsReasoningProfile(
            this.#availableModels.get(modelId),
            reasoningProfile,
          ),
      )
    )
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'A selected reasoning profile is not advertised by its model.',
      );
    const nextConfiguration = experimentModelConfigurationSchema.parse({
      ...parsed.data,
      locked: false,
    });
    this.#recordModelConfigurationChanges(
      this.#modelConfiguration,
      nextConfiguration,
    );
    this.#modelConfiguration = nextConfiguration;
    this.#scenario = {
      ...this.#scenario,
      modelConfiguration: structuredClone(nextConfiguration),
    };
    return this.getSnapshot();
  }

  previewExperimentExport(request: unknown): ExperimentExportPreview {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'Export is unavailable while model execution is in progress.',
      );
    return experimentExportPreviewSchema.parse(
      createExperimentPreview(this.#experimentSource(), request, this.#now()),
    );
  }

  generateExperimentExport(
    request: unknown,
    generatedAt = this.#now(),
  ): ExperimentExportDocument {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'Export is unavailable while model execution is in progress.',
      );
    return experimentExportDocumentSchema.parse(
      createExperimentExport(this.#experimentSource(), request, generatedAt),
    );
  }

  cancelCurrentRequest(): SimulationSnapshot {
    if (!this.#busy || !this.#activeRequestController)
      throw new SimulationConflictError(
        'There is no active model request to cancel.',
      );
    this.#cancellationRequested = true;
    this.#activeRequestController.abort();
    return this.getSnapshot();
  }

  async verifyModel(
    modelId: ModelId,
    reasoningProfile: ReasoningProfile,
  ): Promise<ProviderMetadata> {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'A provider request is already in progress.',
      );
    const model = this.#availableModels.get(modelId);
    if (!model)
      throw new SimulationValidationError(
        'models_unavailable',
        'The selected model is not in the compatible OpenRouter catalog.',
      );
    if (!modelSupportsReasoningProfile(model, reasoningProfile))
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'The selected reasoning profile is not advertised by this model.',
      );
    const zero = this.#state.agents.get(this.#scenario.patientZeroAgentId);
    if (!zero) throw new Error('The development world has no Agent Zero.');
    this.#verificationBusy = true;
    try {
      const result = await this.#swarmPlanner.plan(
        this.#buildZeroStrategicObservation(
          this.#state,
          zero.id,
          this.#completedTickCount + 1,
          this.#virtualTime,
          [],
          ['initial'],
        ),
        modelId,
        { reasoningProfile },
      );
      return result.metadata;
    } finally {
      this.#verificationBusy = false;
    }
  }

  /** Execute one atomic Zero strategy → worker reflex → world resolution tick. */
  async executeNextTick(): Promise<SwarmTickRecord | null> {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'A simulation tick is already in progress.',
      );
    if (this.#isTerminal())
      throw new SimulationConflictError(
        'This simulation has reached a terminal infection outcome. Reset before running another tick.',
      );
    const zeroAgentId = this.#scenario.patientZeroAgentId;
    const tickNumber = this.#completedTickCount + 1;
    const preTickState = this.#state;
    const interval = seededTickIntervalMinutes(
      this.#scenario.worldSeed,
      tickNumber,
      this.#scenario.minimumTickIntervalMinutes,
      this.#scenario.maximumTickIntervalMinutes,
    );
    const virtualTime = new Date(
      new Date(this.#virtualTime).getTime() + interval * 60_000,
    ).toISOString();
    const playerAdvance = advanceSimulatedPlayer(
      preTickState,
      this.#scenario.simulatedPlayer.seed,
      tickNumber,
      { createEventId: this.#createEventId, now: () => virtualTime },
    );
    const candidate = playerAdvance.state;
    // Include public effects of this advance before workers make their choices.
    // This array is derived only; player events remain committed once below.
    const pressureEvents = boundedPressureEvents(
      this.#simulatedPlayerEvents,
      playerAdvance.events,
      tickNumber,
    );
    const agents = [...candidate.agents.values()];
    const zero = zeroAgentId ? candidate.agents.get(zeroAgentId) : undefined;
    if (!agents.length || !zero) {
      this.#commitTerminalPlayerTick(
        playerAdvance,
        tickNumber,
        virtualTime,
        interval,
      );
      return null;
    }
    const resolvedZero = this.#resolvedModel(zero.id);
    if (!resolvedZero.available || !resolvedZero.modelId)
      throw new SimulationValidationError(
        'models_unavailable',
        'Agent Zero requires an available compatible model.',
      );
    const tickTurnBase = this.#completedSwarmDecisionCount;
    const order = seededTickOrder(
      agents.map(({ id }) => id),
      this.#scenario.worldSeed,
      tickNumber,
    );
    const completedDirectives = this.#completedSwarmDirectives(
      preTickState,
    ).filter(({ agentId }) => candidate.agents.has(agentId));
    const replanReasons = this.#swarmReplanReasons(
      tickNumber,
      playerAdvance.events,
      candidate,
      completedDirectives,
    );
    if (
      agents.length !== preTickState.agents.size &&
      !replanReasons.includes('roster-changed')
    )
      replanReasons.push('roster-changed');
    const replan = replanReasons.length > 0;
    // Planning ticks reserve Zero plus Jev workers. The explicit deterministic
    // comparison seam only reserves Zero's planner call; it never dispatches a
    // reflex provider attempt.
    const requiredAttempts = this.#deterministicWorkerCandidateSelector
      ? replan
        ? 1
        : 0
      : agents.length - (replan ? 0 : 1);
    if (
      requiredAttempts > 0 &&
      !this.#attemptAccounting.reserve(requiredAttempts)
    ) {
      this.#status = 'budget-exhausted';
      throw new SimulationValidationError(
        'experiment_budget_exhausted',
        'The experiment does not have enough provider-attempt or credit-admission capacity for a complete tick.',
      );
    }
    const controller = new AbortController();
    this.#busy = true;
    this.#activeRequestController = controller;
    this.#activeAgentId = zero.id;
    this.#cancellationRequested = false;
    this.#status = 'waiting-for-model';
    const deadlineAtMs = Date.now() + OPENROUTER_PROVIDER_TIMEOUT_MS;
    let plannerFailure: ProviderFailure | undefined;
    try {
      const observation = this.#buildZeroStrategicObservation(
        candidate,
        zero.id,
        tickNumber,
        virtualTime,
        playerAdvance.events,
        replanReasons,
        completedDirectives,
      );
      let plan: SwarmPlan;
      let planSource:
        'zero-llm' | 'deterministic-fallback' | 'directive-reuse' = 'zero-llm';
      let plannerMetadata: ProviderMetadata | undefined;
      let plannerAttempts = 0;
      try {
        if (!replan) {
          planSource = 'directive-reuse';
          plan = this.#reusedSwarmPlan(candidate, zero.id);
        } else {
          const planned = await this.#swarmPlanner.plan(
            observation,
            resolvedZero.modelId,
            {
              signal: controller.signal,
              deadlineAtMs,
              reasoningProfile: resolvedZero.reasoningProfile,
              beginAttempt: (kind) => {
                const startedAt = this.#now();
                const permit =
                  kind === 'initial'
                    ? this.#attemptAccounting.startReserved({
                        agentId: zero.id,
                        intendedTurnNumber:
                          tickTurnBase + order.indexOf(zero.id) + 1,
                        intendedTickNumber: tickNumber,
                        kind,
                        startedAt,
                        modelId: resolvedZero.modelId!,
                        reasoningProfile: resolvedZero.reasoningProfile,
                      })
                    : this.#attemptAccounting.startAdditional({
                        agentId: zero.id,
                        intendedTurnNumber:
                          tickTurnBase + order.indexOf(zero.id) + 1,
                        intendedTickNumber: tickNumber,
                        kind,
                        startedAt,
                        modelId: resolvedZero.modelId!,
                        reasoningProfile: resolvedZero.reasoningProfile,
                      });
                if (permit !== null) plannerAttempts += 1;
                return permit === null
                  ? null
                  : (completion) =>
                      this.#attemptAccounting.finalize(permit, {
                        ...completion,
                        completedAt: this.#now(),
                      });
              },
            },
          );
          if (plannerAttempts === 0)
            throw new Error(
              'The planner returned without provider-attempt accounting.',
            );
          if (controller.signal.aborted)
            throw new SimulationTurnCancelledError();
          plan = swarmPlanSchema.parse(planned.plan);
          plannerMetadata = planned.metadata;
          this.#assertSwarmPlan(
            plan,
            observation,
            candidate,
            zero.id,
            tickNumber,
          );
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          error instanceof SimulationTurnCancelledError
        )
          throw error;
        plannerFailure = this.#providerFailure(error, resolvedZero.modelId);
        planSource = 'deterministic-fallback';
        plan = this.#fallbackSwarmPlan(
          agents,
          zero.id,
          tickNumber,
          candidate,
          completedDirectives,
        );
      }
      const zeroAction = observation.legalZeroActions.find(
        ({ id }) => id === plan.zeroActionCandidateId,
      )?.action ?? { type: 'wait' as const };
      const selected = new Map<
        AgentId,
        Awaited<ReturnType<typeof chooseReflexWorldAction>>
      >();
      const workers = agents.filter(({ id }) => id !== zero.id);
      for (const worker of workers) {
        const directive = plan.directives.find(
          ({ agentId }) => agentId === worker.id,
        )!;
        this.#activeAgentId = worker.id;
        const history = {
          previousCell: this.#lastSwarmPositions.get(worker.id),
          pressureEvents,
          captureAlerts: captureAlertsFrom(playerAdvance.events),
          territoryDelta: this.#lastSwarmTerritoryDeltas.get(worker.id) ?? 0,
          recentActionOutcome: this.#swarmTicks
            .at(-1)
            ?.workers.find(({ agentId }) => agentId === worker.id)?.actionResult
            ?.accepted
            ? ('success' as const)
            : ('unknown' as const),
        };
        const retainedDirective = this.#lastValidSwarmPlan?.directives.some(
          (previous) =>
            previous.agentId === worker.id &&
            previous.expiresAtTick >= tickNumber &&
            !completedDirectives.some(
              ({ directiveId }) => directiveId === previous.id,
            ),
        );
        const choice =
          planSource === 'deterministic-fallback' && !retainedDirective
            ? chooseDeterministicWorkerAction(
                compileReflexObservation(candidate, directive, history),
                (compiled) =>
                  selectNeutralFallbackCandidate(compiled, candidate),
              )
            : this.#deterministicWorkerCandidateSelector
              ? chooseDeterministicWorkerAction(
                  compileReflexObservation(candidate, directive, history),
                  this.#deterministicWorkerCandidateSelector,
                )
              : await chooseReflexWorldAction(
                  candidate,
                  directive,
                  this.#reflexProvider,
                  {
                    history,
                    signal: controller.signal,
                    deadlineAtMs,
                    accounting: this.#attemptAccounting,
                    initialPermitReserved: true,
                    intendedTickNumber: tickNumber,
                    intendedTurnNumber:
                      tickTurnBase + order.indexOf(worker.id) + 1,
                    now: this.#now,
                  },
                );
        selected.set(worker.id, choice);
      }
      if (controller.signal.aborted) throw new SimulationTurnCancelledError();
      let state = candidate;
      const context = {
        now: () => virtualTime,
        createEventId: this.#createEventId,
        patientZeroAgentId: zero.id,
        tickNumber,
      };
      const applied = new Map<
        AgentId,
        ReturnType<typeof applyWorldAction>['result']
      >();
      for (const agentId of order) {
        const action =
          agentId === zero.id ? zeroAction : selected.get(agentId)!.action;
        const result = applyWorldAction(state, agentId, action, context);
        state = result.state;
        applied.set(agentId, result.result);
      }
      if (controller.signal.aborted) throw new SimulationTurnCancelledError();
      const signals = workers.flatMap((worker) => {
        const selection = selected.get(worker.id)!;
        const probability = selection.decision?.replanProbability;
        const pressure = selection.observation.currentSituation.nearbyPressure;
        const threshold = replanThresholdForPressure(pressure);
        return probability !== undefined && probability >= threshold
          ? [
              {
                type: 'worker-replan-requested' as const,
                agentId: worker.id,
                directiveId: selection.observation.directive.id,
                probability,
              },
            ]
          : [];
      });
      const tick = swarmTickRecordSchema.parse({
        tickNumber,
        virtualTime,
        tickIntervalMinutes: interval,
        plan,
        planSource,
        ...(replanReasons.length ? { replanReasons } : {}),
        ...(completedDirectives.length ? { completedDirectives } : {}),
        ...(plannerFailure ? { plannerFailure } : {}),
        ...(plannerMetadata ? { plannerMetadata } : {}),
        zeroAction,
        zeroActionResult: applied.get(zero.id),
        workers: workers.map((worker) => {
          const selection = selected.get(worker.id)!;
          return {
            agentId: worker.id,
            directive: plan.directives.find(
              ({ agentId }) => agentId === worker.id,
            )!,
            situation: selection.observation.currentSituation,
            action: selection.action,
            actionResult: applied.get(worker.id),
            ...(selection.decision
              ? { reflexDecision: selection.decision }
              : {}),
            source: selection.cognitionSource,
            ...(selection.failure ? { failure: selection.failure } : {}),
          };
        }),
        ...(signals.length ? { signals } : {}),
      });
      this.#state = {
        ...state,
        events: state.events.slice(-MAX_WORLD_EVENT_HISTORY),
      };
      this.#pruneCapturedRosterState();
      this.#completedTickCount = tickNumber;
      this.#completedSwarmDecisionCount += order.length;
      this.#virtualTime = virtualTime;
      this.#lastTickIntervalMinutes = interval;
      this.#resolutionOrder = order;
      this.#simulatedPlayerEvents = [
        ...this.#simulatedPlayerEvents,
        ...structuredClone(playerAdvance.events),
      ].slice(-this.#experimentRetentionLimit * 2);
      this.#swarmTicks = [...this.#swarmTicks, tick].slice(-MAX_TURN_HISTORY);
      this.#experimentSwarmTicks = [
        ...this.#experimentSwarmTicks,
        structuredClone(tick),
      ].slice(-this.#experimentRetentionLimit);
      if (planSource === 'zero-llm') this.#lastValidSwarmPlan = plan;
      this.#lastSwarmTerritoryCounts = new Map(
        [...state.agents.keys()].map((agentId) => [
          agentId,
          [...state.hexes.values()].filter(
            (hex) =>
              hex.state === 'infected' && hex.controllerAgentId === agentId,
          ).length,
        ]),
      );
      this.#lastSwarmTerritoryDeltas = new Map(
        [...state.agents.keys()].map((agentId) => [
          agentId,
          [...state.hexes.values()].filter(
            (hex) =>
              hex.state === 'infected' && hex.controllerAgentId === agentId,
          ).length -
            [...preTickState.hexes.values()].filter(
              (hex) =>
                hex.state === 'infected' && hex.controllerAgentId === agentId,
            ).length,
        ]),
      );
      this.#lastSwarmPositions = new Map(
        [...candidate.agents.values()].map(({ id, currentCell }) => [
          id,
          currentCell,
        ]),
      );
      this.#status = this.#attemptAccounting.snapshot().exhausted
        ? 'budget-exhausted'
        : 'paused';
      return tick;
    } catch (error) {
      if (
        controller.signal.aborted ||
        error instanceof ReflexSelectionCancelledError ||
        error instanceof SimulationTurnCancelledError
      ) {
        this.#status = 'paused';
        throw new SimulationTurnCancelledError();
      }
      throw error;
    } finally {
      this.#attemptAccounting.releaseReservations();
      this.#busy = false;
      this.#activeRequestController = null;
      this.#activeAgentId = null;
      this.#cancellationRequested = false;
      if (this.#status === 'waiting-for-model')
        this.#status = this.#attemptAccounting.snapshot().exhausted
          ? 'budget-exhausted'
          : 'paused';
    }
  }

  #isTerminal(): boolean {
    return (
      this.#status === 'patient-zero-captured' ||
      this.#status === 'infection-eliminated'
    );
  }

  /** Commit a deterministic player interval that removed the active swarm. */
  #commitTerminalPlayerTick(
    playerAdvance: ReturnType<typeof advanceSimulatedPlayer>,
    tickNumber: number,
    virtualTime: string,
    interval: number,
  ): void {
    const patientZeroCaptured = playerAdvance.events.some(
      (event) =>
        event.type === 'simulated-player-agent-captured' &&
        event.capturedAgentId === this.#scenario.patientZeroAgentId,
    );
    this.#state = {
      ...playerAdvance.state,
      events: playerAdvance.state.events.slice(-MAX_WORLD_EVENT_HISTORY),
    };
    this.#pruneCapturedRosterState();
    this.#completedTickCount = tickNumber;
    this.#virtualTime = virtualTime;
    this.#lastTickIntervalMinutes = interval;
    this.#resolutionOrder = [];
    this.#activeAgentId = null;
    this.#simulatedPlayerEvents = [
      ...this.#simulatedPlayerEvents,
      ...structuredClone(playerAdvance.events),
    ].slice(-this.#experimentRetentionLimit * 2);
    this.#lastValidSwarmPlan = null;
    this.#lastSwarmTerritoryCounts = new Map();
    this.#lastSwarmTerritoryDeltas = new Map();
    this.#lastSwarmPositions = new Map();
    this.#status =
      this.#state.agents.size === 0
        ? 'infection-eliminated'
        : patientZeroCaptured
          ? 'patient-zero-captured'
          : 'infection-eliminated';
  }

  /** Remove cognition state that belongs to agents captured by the engine. */
  #pruneCapturedRosterState(): void {
    const active = new Set(this.#state.agents.keys());
    this.#modelConfiguration = {
      ...this.#modelConfiguration,
      overrides: this.#modelConfiguration.overrides.filter(({ agentId }) =>
        active.has(agentId),
      ),
    };
  }

  #recordModelConfigurationChanges(
    previous: ExperimentModelConfiguration,
    next: ExperimentModelConfiguration,
  ): void {
    const timestamp = this.#now();
    const effectiveTurn = this.#completedSwarmDecisionCount + 1;
    const events: ExperimentConfigurationEvent[] = [];
    if (
      previous.globalModelId !== next.globalModelId ||
      previous.globalReasoningProfile !== next.globalReasoningProfile
    )
      events.push({
        type: 'model-assignment-changed',
        timestamp,
        scope: 'global',
        previousModelId: previous.globalModelId,
        newModelId: next.globalModelId,
        previousReasoningProfile: previous.globalReasoningProfile,
        newReasoningProfile: next.globalReasoningProfile,
        effectiveTurn,
      });
    const previousOverrides = new Map(
      previous.overrides.map((override) => [override.agentId, override]),
    );
    const nextOverrides = new Map(
      next.overrides.map((override) => [override.agentId, override]),
    );
    for (const agentId of new Set([
      ...previousOverrides.keys(),
      ...nextOverrides.keys(),
    ])) {
      const previousOverride = previousOverrides.get(agentId);
      const nextOverride = nextOverrides.get(agentId);
      if (
        previousOverride?.modelId === nextOverride?.modelId &&
        previousOverride?.reasoningProfile === nextOverride?.reasoningProfile
      )
        continue;
      events.push({
        type: 'model-assignment-changed',
        timestamp,
        scope: 'agent',
        agentId,
        previousModelId: previousOverride?.modelId ?? previous.globalModelId,
        newModelId: nextOverride?.modelId ?? next.globalModelId,
        previousReasoningProfile:
          previousOverride?.reasoningProfile ?? previous.globalReasoningProfile,
        newReasoningProfile:
          nextOverride?.reasoningProfile ?? next.globalReasoningProfile,
        effectiveTurn,
      });
    }
    this.#configurationEvents = [...this.#configurationEvents, ...events];
  }

  #worldSnapshot(): SimulationSnapshot['world'] {
    return {
      generatedAt: RESET_GENERATED_AT,
      hexes: [...this.#state.hexes].map(([cell, hex]) => ({ cell, ...hex })),
      agents: structuredClone([...this.#state.agents.values()]),
      events: structuredClone([...this.#state.events]),
      simulatedPlayer: structuredClone(this.#state.simulatedPlayer ?? null),
    };
  }

  #buildZeroStrategicObservation(
    state: WorldState,
    zeroAgentId: AgentId,
    tickNumber: number,
    virtualTime: string,
    playerEvents: readonly SimulatedPlayerEvent[],
    replanReasons: readonly SwarmReplanReason[] = [],
    completedDirectives: readonly CompletedSwarmDirective[] = [],
  ): ZeroStrategicObservation {
    const counts = new Map<AgentId, number>(
      [...state.agents.keys()].map((id) => [id, 0]),
    );
    for (const hex of state.hexes.values())
      if (hex.state === 'infected' && hex.controllerAgentId !== null)
        counts.set(
          hex.controllerAgentId,
          (counts.get(hex.controllerAgentId) ?? 0) + 1,
        );
    const strategicTargetCells = [
      ...new Set([
        ...(this.#lastValidSwarmPlan?.directives.flatMap(({ targetCell }) =>
          targetCell ? [targetCell] : [],
        ) ?? []),
        ...[...state.agents.values()].map(({ currentCell }) => currentCell),
        ...[...state.hexes.keys()].sort(),
      ]),
    ].slice(0, 80);
    const zero = state.agents.get(zeroAgentId)!;
    const legalZeroActions = enumerateLegalWorldActions(state, zeroAgentId).map(
      (action, index) => ({
        id: `zero_action_${index}`,
        action,
        description:
          action.type === 'move'
            ? `Move ${geographicDirectionBetweenCells(zero.currentCell, action.targetCell)} into an adjacent engine-legal cell.`
            : action.type === 'infect'
              ? 'Infect the current open cell.'
              : action.type === 'capture'
                ? 'Capture the current abandoned infected cell.'
                : 'Wait on the current cell.',
      }),
    );
    const workerReplanRequests = this.#swarmWorkerReplanRequests(state);
    const pressureEvents = boundedPressureEvents(
      this.#simulatedPlayerEvents,
      playerEvents,
      tickNumber,
    );
    const recentCaptures = boundedRecentCaptures(
      this.#simulatedPlayerEvents,
      playerEvents,
      tickNumber,
    );
    return {
      zeroAgentId,
      tickNumber,
      virtualTime,
      cells: [...state.hexes.entries()].map(([cell, hex]) => ({
        cell,
        state: hex.state,
        controllerAgentId:
          hex.state === 'infected' ? hex.controllerAgentId : null,
      })),
      agents: [...state.agents.values()].map((agent) => {
        const localThreat = localPressureAtCell(
          agent.currentCell,
          pressureEvents,
        );
        const priorWorker = this.#swarmTicks
          .at(-1)
          ?.workers.find(({ agentId }) => agentId === agent.id);
        const directive =
          this.#lastValidSwarmPlan?.directives.find(
            ({ agentId }) => agentId === agent.id,
          ) ?? null;
        const previousCell = this.#lastSwarmPositions.get(agent.id);
        let workerStatus:
          'advancing' | 'at-target' | 'stalled' | 'blocked' | 'unknown' =
          'unknown';
        if (priorWorker) {
          if (directive?.targetCell === agent.currentCell)
            workerStatus = 'at-target';
          else if (
            directive?.targetCell &&
            previousCell &&
            gridRingDistance(agent.currentCell, directive.targetCell) <
              gridRingDistance(previousCell, directive.targetCell)
          )
            workerStatus = 'advancing';
          else if (
            priorWorker.source === 'deterministic-fallback' ||
            priorWorker.actionResult?.accepted === false
          )
            workerStatus = 'blocked';
          else workerStatus = 'stalled';
        }
        return {
          agentId: agent.id,
          position: agent.currentCell,
          controlledCellCount: counts.get(agent.id) ?? 0,
          territoryDelta: this.#lastSwarmTerritoryDeltas.get(agent.id) ?? 0,
          localPressure: localThreat.localPressure,
          pressureDirection: localThreat.pressureDirection,
          pressureDistance: localThreat.pressureDistance,
          ...(agent.id === zeroAgentId ? {} : { workerStatus, directive }),
        };
      }),
      recentPlayerPressure: playerEvents.map((event) =>
        event.type === 'hex-disinfected'
          ? 'An infected cell was cleaned this tick.'
          : event.type === 'simulated-player-clean-blocked'
            ? 'Cleaning pressure was blocked by an occupied infected cell.'
            : event.type === 'simulated-player-agent-captured'
              ? `Worker ${event.capturedAgentId} was captured at ${event.cell}; ${event.abandonedCellCount} controlled cells became abandoned.`
              : 'The simulated player moved this tick.',
      ),
      ...(recentCaptures.length ? { recentCaptures } : {}),
      ...(replanReasons.length ? { replanReasons: [...replanReasons] } : {}),
      ...(completedDirectives.length
        ? { completedDirectives: [...completedDirectives] }
        : {}),
      ...(workerReplanRequests.length ? { workerReplanRequests } : {}),
      legalZeroActions,
      strategicTargetCells,
    };
  }

  #completedSwarmDirectives(state: WorldState): CompletedSwarmDirective[] {
    if (!this.#lastValidSwarmPlan) return [];
    const recentCleanedCells = this.#simulatedPlayerEvents
      .filter(
        (
          event,
        ): event is Extract<
          SimulatedPlayerEvent,
          { type: 'hex-disinfected' }
        > => event.type === 'hex-disinfected',
      )
      .slice(-6)
      .map(({ cell }) => cell);
    const latestWorkers = this.#swarmTicks.at(-1)?.workers ?? [];
    return this.#lastValidSwarmPlan.directives.flatMap((directive) => {
      if (
        directive.expiresAtTick < this.#completedTickCount ||
        !state.agents.has(directive.agentId)
      )
        return [];
      const priorNearbyPressure = latestWorkers.find(
        ({ agentId, directive: active }) =>
          agentId === directive.agentId && active.id === directive.id,
      )?.situation?.nearbyPressure;
      return isSwarmDirectiveComplete(state, directive, {
        priorNearbyPressure,
        recentCleanedCells,
      })
        ? [{ agentId: directive.agentId, directiveId: directive.id }]
        : [];
    });
  }

  #swarmReplanReasons(
    tickNumber: number,
    playerEvents: readonly SimulatedPlayerEvent[],
    state: WorldState = this.#state,
    completedDirectives: readonly CompletedSwarmDirective[] = [],
  ): SwarmReplanReason[] {
    if (!this.#lastValidSwarmPlan) return ['initial'];
    const reasons: SwarmReplanReason[] = [];
    const currentWorkers = [...state.agents.keys()]
      .filter((agentId) => agentId !== this.#scenario.patientZeroAgentId)
      .toSorted();
    const plannedWorkers = this.#lastValidSwarmPlan.directives
      .map(({ agentId }) => agentId)
      .toSorted();
    if (
      currentWorkers.length !== plannedWorkers.length ||
      currentWorkers.some((agentId, index) => agentId !== plannedWorkers[index])
    )
      reasons.push('roster-changed');
    if (completedDirectives.length) reasons.push('directive-complete');
    if ((tickNumber - 1) % 5 === 0) reasons.push('periodic-review');
    if (
      this.#lastValidSwarmPlan.directives.some(
        ({ expiresAtTick }) => expiresAtTick < tickNumber,
      )
    )
      reasons.push('directive-expired');
    if (this.#swarmWorkerReplanRequests(state).length)
      reasons.push('worker-request');
    const recent = this.#swarmTicks.slice(-2);
    if (
      recent.length === 2 &&
      [...this.#state.agents.keys()].some((agentId) => {
        if (agentId === this.#scenario.patientZeroAgentId) return false;
        const [previousTick, latestTick] = recent;
        const previous = previousTick!.workers.find(
          ({ agentId: id }) => id === agentId,
        );
        const latest = latestTick!.workers.find(
          ({ agentId: id }) => id === agentId,
        );
        if (
          !previous ||
          !latest ||
          previous.directive.id !== latest.directive.id
        )
          return false;
        const stalled = (worker: NonNullable<typeof latest>) =>
          worker.source === 'deterministic-fallback' ||
          worker.actionResult?.accepted === false ||
          (worker.action?.type === 'wait' &&
            worker.directive.mission !== 'hold');
        return stalled(previous) && stalled(latest);
      })
    )
      reasons.push('worker-stalled');
    if ([...this.#lastSwarmTerritoryDeltas.values()].some((delta) => delta < 0))
      reasons.push('territory-loss');
    const disinfections = playerEvents.filter(
      ({ type }) => type === 'hex-disinfected',
    ).length;
    if (disinfections) reasons.push('player-disinfection');
    const [previousTick, latestTick] = this.#swarmTicks.slice(-2);
    if (
      latestTick?.workers.some((worker) => {
        const previous = previousTick?.workers.find(
          ({ agentId }) => agentId === worker.agentId,
        );
        return (
          worker.situation?.nearbyPressure === 'high' &&
          previous?.situation?.nearbyPressure !== 'high'
        );
      })
    )
      reasons.push('high-pressure');
    return reasons;
  }

  #swarmWorkerReplanRequests(state: WorldState = this.#state): Array<{
    agentId: AgentId;
    directiveId: string;
    probability: number;
  }> {
    return (this.#swarmTicks.at(-1)?.signals ?? [])
      .filter(({ agentId }) => state.agents.has(agentId))
      .map(({ agentId, directiveId, probability }) => ({
        agentId,
        directiveId,
        probability,
      }));
  }

  #reusedSwarmPlan(state: WorldState, zeroAgentId: AgentId): SwarmPlan {
    const retained = this.#lastValidSwarmPlan;
    if (!retained)
      throw new Error('Cannot reuse a swarm plan before a plan is committed.');
    const waitIndex = enumerateLegalWorldActions(state, zeroAgentId).findIndex(
      (action) => action.type === 'wait',
    );
    if (waitIndex < 0)
      throw new Error('The engine must provide a legal wait action.');
    return swarmPlanSchema.parse({
      strategySummary: retained.strategySummary,
      directives: retained.directives,
      zeroActionCandidateId: `zero_action_${waitIndex}`,
    });
  }

  #assertSwarmPlan(
    plan: SwarmPlan,
    observation: ZeroStrategicObservation,
    state: WorldState,
    zeroAgentId: AgentId,
    tickNumber: number,
  ): void {
    const workers = observation.agents
      .filter(({ agentId }) => agentId !== zeroAgentId)
      .map(({ agentId }) => agentId)
      .toSorted();
    const directives = plan.directives.map((directive) =>
      swarmDirectiveSchema.parse(directive),
    );
    if (
      directives.length !== workers.length ||
      directives.some((directive) => !workers.includes(directive.agentId)) ||
      directives.some(
        (directive) =>
          directive.issuedAtTick !== tickNumber ||
          directive.expiresAtTick < tickNumber ||
          directive.expiresAtTick > tickNumber + 9 ||
          (directive.targetCell !== null &&
            !observation.strategicTargetCells.includes(directive.targetCell)),
      )
    )
      throw new Error(
        'The Zero plan does not contain one current, allowlisted directive per worker.',
      );
    for (const directive of directives) {
      const issue = swarmDirectiveIssue(state, directive);
      if (issue)
        throw new SwarmPlannerError({
          code: 'invalid-decision',
          message: `Agent Zero assigned an invalid directive: ${issue}`,
          retryable: false,
        });
    }
    if (
      !observation.legalZeroActions.some(
        ({ id }) => id === plan.zeroActionCandidateId,
      )
    )
      throw new Error(
        'The Zero plan selected an unknown world action candidate.',
      );
  }

  #fallbackSwarmPlan(
    agents: readonly Agent[],
    zeroAgentId: AgentId,
    tickNumber: number,
    state: WorldState,
    completedDirectives: readonly CompletedSwarmDirective[],
  ): SwarmPlan {
    const workers = agents.filter(({ id }) => id !== zeroAgentId);
    const retained = this.#lastValidSwarmPlan?.directives;
    const directives = workers.map(
      (worker) =>
        retained?.find(
          (directive) =>
            directive.agentId === worker.id &&
            directive.expiresAtTick >= tickNumber &&
            !completedDirectives.some(
              ({ directiveId }) => directiveId === directive.id,
            ),
        ) ?? {
          id: `neutral-${tickNumber}-${worker.id}`,
          agentId: worker.id,
          mission: 'expand' as const,
          targetCell: null,
          priority: 'normal' as const,
          riskTolerance: 'low' as const,
          issuedAtTick: tickNumber,
          expiresAtTick: tickNumber,
        },
    );
    const waitIndex = enumerateLegalWorldActions(state, zeroAgentId).findIndex(
      (action) => action.type === 'wait',
    );
    if (waitIndex < 0)
      throw new Error('The engine must provide a legal wait action.');
    return swarmPlanSchema.parse({
      strategySummary: this.#lastValidSwarmPlan
        ? 'Continue prior valid directives while strategic planning is unavailable.'
        : 'Use deterministic local expansion while strategic planning is unavailable.',
      directives,
      zeroActionCandidateId: `zero_action_${waitIndex}`,
    });
  }

  #providerFailure(error: unknown, model: string): ProviderFailure {
    if (error && typeof error === 'object' && 'failure' in error)
      return (error as { failure: ProviderFailure }).failure;
    return {
      code: 'provider-http',
      message: 'Agent Zero planning failed.',
      retryable: false,
      model,
    };
  }

  #experimentSource(): ExperimentSource {
    return {
      id: this.#experimentId,
      startedAt: this.#experimentStartedAt,
      providerMode:
        this.#swarmPlanner.mode === 'openrouter-swarm'
          ? 'openrouter'
          : 'scripted-test',
      retentionLimit: this.#experimentRetentionLimit,
      totalCompletedTicks: this.#completedTickCount,
      initialAgents: this.#initialExperimentAgents,
      currentAgents: [...this.#state.agents.values()],
      configurationEvents: this.#configurationEvents,
      initialWorld: this.#initialExperimentWorld,
      currentWorld: this.#worldSnapshot(),
      modelConfiguration: this.#modelConfiguration,
      scenario: this.#scenario,
      schemaVersion: 11,
      providerAttempts: this.#attemptAccounting.ledger(),
      attemptRetention: this.#attemptAccounting.retention(),
      attemptAccounting: this.#attemptAccounting.snapshot(),
      simulatedPlayerEvents: structuredClone(this.#simulatedPlayerEvents),
      swarmTicks: structuredClone(this.#experimentSwarmTicks),
    };
  }

  #resolvedModel(agentId: AgentId) {
    const override = this.#modelConfiguration.overrides.find(
      (candidate) => candidate.agentId === agentId,
    );
    const modelId = override?.modelId ?? this.#modelConfiguration.globalModelId;
    const reasoningProfile =
      override?.reasoningProfile ??
      this.#modelConfiguration.globalReasoningProfile;
    const source = override
      ? ('override' as const)
      : modelId
        ? ('global' as const)
        : ('missing' as const);
    const modelAvailable =
      modelId !== null && this.#availableModelIds.has(modelId);
    const reasoningAvailable = modelSupportsReasoningProfile(
      modelId === null ? undefined : this.#availableModels.get(modelId),
      reasoningProfile,
    );
    const available = modelAvailable && reasoningAvailable;
    return {
      agentId,
      modelId,
      reasoningProfile,
      source,
      available,
      ...(modelId === null
        ? { issue: 'missing' as const }
        : !modelAvailable
          ? { issue: 'unavailable' as const }
          : available
            ? {}
            : { issue: 'reasoning-unavailable' as const }),
    };
  }

  #territoryScoreboard() {
    const counts = new Map<AgentId, number>(
      [...this.#state.agents.keys()].map((id) => [id, 0]),
    );
    for (const hex of this.#state.hexes.values()) {
      if (hex.state === 'infected' && hex.controllerAgentId !== null)
        counts.set(
          hex.controllerAgentId,
          (counts.get(hex.controllerAgentId) ?? 0) + 1,
        );
    }
    return [...this.#state.agents.values()].map(({ id, name, color }) => ({
      agentId: id,
      name,
      color,
      controlledCellCount: counts.get(id) ?? 0,
    }));
  }
}

function gridRingDistance(from: H3Cell, to: H3Cell): number {
  try {
    return gridDistance(from, to);
  } catch {
    return 999;
  }
}
