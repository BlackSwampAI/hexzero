import { gridDisk, gridDistance } from 'h3-js';
import {
  AgentProviderError,
  dispatchTickDecisions,
  type AgentProvider,
  type ProviderDecision,
} from '@hexzero/agent-runtime';
import {
  agentIdSchema,
  appliedScenarioSchema,
  assignBehavior,
  behaviorConfigurationSchema,
  agentObservationSchema,
  agentTurnRecordSchema,
  communicationIntentSchema,
  diplomacyIntentSchema,
  experimentIdSchema,
  experimentExportDocumentSchema,
  experimentExportPreviewSchema,
  experimentModelConfigurationSchema,
  modelSupportsReasoningProfile,
  updateExperimentModelsRequestSchema,
  updateExperimentBehaviorRequestSchema,
  h3CellSchema,
  RECENT_DIRECT_MESSAGE_LIMIT,
  RECENT_PUBLIC_MESSAGE_LIMIT,
  RECENT_CONTROL_CHANGE_LIMIT,
  RECENT_ALLIANCE_EVENT_LIMIT,
  RECENT_ZERO_MESSAGE_LIMIT,
  RECENT_ZERO_STRATEGIC_EVENT_LIMIT,
  PERSONALITY_MAX_LENGTH,
  OPENROUTER_PROVIDER_TIMEOUT_MS,
  OPENROUTER_429_FALLBACK_BACKOFF_MS,
  WORLD_SCENARIO_LIMITS,
  PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS,
  personalitySchema,
  simulationSnapshotSchema,
  type Agent,
  type AgentId,
  type AgentObservation,
  type AgentGoalState,
  type GoalRevisionResult,
  type RequestedGoalRevision,
  type AgentTurnRecord,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentId,
  type ExperimentModelConfiguration,
  type BehaviorConfiguration,
  type CompatibleModel,
  type ModelId,
  type ModelAttempt,
  type ExperimentConfigurationEvent,
  type H3Cell,
  type ProviderFailure,
  type ProviderMetadata,
  type ReasoningProfile,
  type SimulationSnapshot,
  type SimulationStatus,
  type WorldEvent,
  type AllianceEvent,
  type AllianceProposalId,
  worldSetupRequestSchema,
  type AppliedScenario,
  type WorldSetupPreviewResponse,
  type WorldSetupRequest,
} from '@hexzero/shared';
import {
  applyCommunication,
  applyDiplomacy,
  applyWorldAction,
  createDevelopmentWorld,
  createDefaultAppliedScenario,
  createWorldFromScenario,
  defaultWorldSetupRequest,
  previewWorldSetup,
  DEVELOPMENT_AGENT_BLUEPRINTS,
  getCaptureEligibility,
  getAgentAlliance,
  getEffectiveAgentColor,
  getProposalTargetEligibility,
  physicalDistanceKm,
  expireAllianceProposals,
  seededTickIntervalMinutes,
  seededTickOrder,
  toWorldState,
  type WorldState,
} from '@hexzero/world-engine';
import {
  createExperimentExport,
  createExperimentPreview,
  type ExperimentSource,
  ExperimentMetricAccumulator,
} from './experiment-export';

const RESET_GENERATED_AT = '2026-08-13T12:00:00.000Z';
const MAX_TURN_HISTORY = 120;
const MAX_WORLD_EVENT_HISTORY = 120;
const DEFAULT_EXPERIMENT_RETENTION = 5_000;

interface PendingFailedTurn {
  turnNumber: number;
  agentId: AgentId;
  startedAt: string;
  observation: AgentObservation;
  failure: ProviderFailure;
  attempts: ModelAttempt[];
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
  | 'invalid_agent_id'
  | 'unknown_agent'
  | 'invalid_personality'
  | 'invalid_model_configuration'
  | 'models_unavailable'
  | 'invalid_behavior_configuration';

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
  provider: AgentProvider;
  now?: () => string;
  createEventId?: () => string;
  createExperimentId?: () => string;
  createAllianceId?: () => string;
  createProposalId?: () => string;
  experimentRetentionLimit?: number;
}

export class SimulationService {
  readonly #provider: AgentProvider;
  readonly #now: () => string;
  readonly #createEventId: () => string;
  readonly #createExperimentId: () => string;
  readonly #createAllianceId: () => string;
  readonly #createProposalId: () => string;
  readonly #experimentRetentionLimit: number;
  #state: WorldState;
  #turns: AgentTurnRecord[] = [];
  #completedTurnCount = 0;
  #completedTickCount = 0;
  #virtualTime = RESET_GENERATED_AT;
  #lastTickIntervalMinutes: number | null = null;
  #resolutionOrder: AgentId[] = [];
  #cursor = 0;
  #busy = false;
  #verificationBusy = false;
  #status: SimulationStatus;
  #activeAgentId: AgentId | null = null;
  #activeRequestController: AbortController | null = null;
  #cancellationRequested = false;
  #pendingFailedTurn: PendingFailedTurn | null = null;
  #experimentId: ExperimentId;
  #experimentStartedAt: string;
  #experimentTurns: AgentTurnRecord[] = [];
  #initialExperimentAgents: Agent[];
  #initialExperimentWorld: SimulationSnapshot['world'];
  #configurationEvents: ExperimentConfigurationEvent[] = [];
  #experimentMetrics: ExperimentMetricAccumulator;
  #modelConfiguration: ExperimentModelConfiguration;
  #behaviorConfiguration: BehaviorConfiguration;
  #scenario: AppliedScenario;
  #availableModelIds = new Set<ModelId>();
  #availableModels = new Map<ModelId, CompatibleModel>();
  #agentGoals = new Map<AgentId, AgentGoalState>();

  constructor({
    provider,
    now = () => new Date().toISOString(),
    createEventId = () => crypto.randomUUID(),
    createExperimentId = () => crypto.randomUUID(),
    createAllianceId = () => crypto.randomUUID(),
    createProposalId = () => crypto.randomUUID(),
    experimentRetentionLimit = DEFAULT_EXPERIMENT_RETENTION,
  }: SimulationServiceOptions) {
    if (
      !Number.isInteger(experimentRetentionLimit) ||
      experimentRetentionLimit < 1
    )
      throw new Error('Experiment retention limit must be a positive integer.');
    this.#provider = provider;
    this.#now = now;
    this.#createEventId = createEventId;
    this.#createExperimentId = createExperimentId;
    this.#createAllianceId = createAllianceId;
    this.#createProposalId = createProposalId;
    this.#experimentRetentionLimit = experimentRetentionLimit;
    this.#state = toWorldState(
      createDevelopmentWorld({ generatedAt: RESET_GENERATED_AT }),
    );
    this.#status = provider.configured ? 'paused' : 'configuration-error';
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    this.#experimentMetrics = new ExperimentMetricAccumulator([
      ...this.#state.agents.keys(),
    ]);
    const scriptedModel =
      (provider.model as ModelId | undefined) ??
      (provider.mode === 'scripted-test'
        ? ('deterministic-script' as ModelId)
        : null);
    this.#modelConfiguration = experimentModelConfigurationSchema.parse({
      globalModelId: scriptedModel,
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    });
    if (scriptedModel) this.#availableModelIds.add(scriptedModel);
    this.#behaviorConfiguration = behaviorConfigurationSchema.parse({
      registryVersion: 1,
      assignmentMode: 'balanced-random',
      seed: this.#experimentId,
      assignments: assignBehavior(
        [...this.#state.agents.keys()],
        this.#experimentId,
        'balanced-random',
      ),
      locked: false,
    });
    this.#scenario = {
      ...createDefaultAppliedScenario(RESET_GENERATED_AT),
      modelConfiguration: structuredClone(this.#modelConfiguration),
      behaviorConfiguration: structuredClone(this.#behaviorConfiguration),
    };
  }

  getSnapshot(): SimulationSnapshot {
    const agents = [...this.#state.agents.values()];
    const next = agents[this.#cursor % agents.length];
    if (!next) throw new Error('The development world has no agents.');
    const droppedRecords =
      this.#completedTurnCount - this.#experimentTurns.length;
    return simulationSnapshotSchema.parse({
      world: this.#worldSnapshot(),
      scenario: this.#scenario,
      turnNumber: this.#completedTurnCount,
      tickNumber: this.#completedTickCount,
      virtualTime: this.#virtualTime,
      lastTickIntervalMinutes: this.#lastTickIntervalMinutes,
      resolutionOrder: this.#resolutionOrder,
      nextAgentId: next.id,
      activeAgentId: this.#activeAgentId,
      cancellationRequested: this.#cancellationRequested,
      pendingFailedTurn: this.#pendingFailedTurn
        ? {
            turnNumber: this.#pendingFailedTurn.turnNumber,
            agentId: this.#pendingFailedTurn.agentId,
            failure: this.#pendingFailedTurn.failure,
            attempts: this.#pendingFailedTurn.attempts,
          }
        : null,
      status: this.#status,
      providerMode: this.#provider.mode,
      providerConfigured: this.#provider.configured,
      modelConfiguration: this.#modelConfiguration,
      behaviorConfiguration: this.#behaviorConfiguration,
      resolvedModels: agents.map(({ id }) => this.#resolvedModel(id)),
      agentGoals: agents.map(({ id }) => ({
        agentId: id,
        goal: structuredClone(this.#agentGoals.get(id) ?? null),
      })),
      turns: this.#turns,
      experiment: {
        id: this.#experimentId,
        startedAt: this.#experimentStartedAt,
        totalCompletedTurns: this.#completedTurnCount,
        retainedTurns: this.#experimentTurns.length,
        firstRetainedTurn: this.#experimentTurns[0]?.turnNumber,
        lastRetainedTurn: this.#experimentTurns.at(-1)?.turnNumber,
        droppedRecords,
        complete: droppedRecords === 0,
        metrics: this.#experimentMetrics.snapshot(agents.map(({ id }) => id)),
        currentTerritory: this.#territoryScoreboard(),
        currentAlliances: this.#allianceTerritorySummaries(),
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
    this.#turns = [];
    this.#completedTurnCount = 0;
    this.#completedTickCount = 0;
    this.#virtualTime = RESET_GENERATED_AT;
    this.#lastTickIntervalMinutes = null;
    this.#resolutionOrder = [];
    this.#cursor = 0;
    this.#activeAgentId = null;
    this.#activeRequestController = null;
    this.#cancellationRequested = false;
    this.#pendingFailedTurn = null;
    this.#agentGoals = new Map();
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#experimentTurns = [];
    this.#configurationEvents = [];
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    this.#experimentMetrics = new ExperimentMetricAccumulator([
      ...this.#state.agents.keys(),
    ]);
    this.#modelConfiguration = {
      ...structuredClone(this.#scenario.modelConfiguration),
      locked: false,
    };
    this.#behaviorConfiguration = {
      ...structuredClone(this.#scenario.behaviorConfiguration),
      locked: false,
    };
    this.#status = this.#provider.configured ? 'paused' : 'configuration-error';
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
                : field === 'behaviorConfiguration'
                  ? 'behavior-coverage-mismatch'
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
        'invalid_behavior_configuration',
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
        'invalid_behavior_configuration',
        preview.errors[0]?.message ?? 'The scenario is infeasible.',
      );
    const nextState = toWorldState(preview.world);
    const nextModels = experimentModelConfigurationSchema.parse({
      ...preview.scenario.modelConfiguration,
      locked: false,
    });
    const nextBehavior = behaviorConfigurationSchema.parse({
      ...preview.scenario.behaviorConfiguration,
      locked: false,
    });
    this.#state = nextState;
    this.#scenario = {
      ...preview.scenario,
      modelConfiguration: nextModels,
      behaviorConfiguration: nextBehavior,
    };
    this.#modelConfiguration = nextModels;
    this.#behaviorConfiguration = nextBehavior;
    this.#turns = [];
    this.#completedTurnCount = 0;
    this.#completedTickCount = 0;
    this.#virtualTime = RESET_GENERATED_AT;
    this.#lastTickIntervalMinutes = null;
    this.#resolutionOrder = [];
    this.#cursor = 0;
    this.#activeAgentId = null;
    this.#activeRequestController = null;
    this.#cancellationRequested = false;
    this.#pendingFailedTurn = null;
    this.#agentGoals = new Map();
    this.#experimentId = experimentIdSchema.parse(this.#createExperimentId());
    this.#experimentStartedAt = this.#now();
    this.#experimentTurns = [];
    this.#configurationEvents = [];
    this.#initialExperimentAgents = structuredClone([
      ...this.#state.agents.values(),
    ]);
    this.#initialExperimentWorld = this.#worldSnapshot();
    this.#experimentMetrics = new ExperimentMetricAccumulator([
      ...this.#state.agents.keys(),
    ]);
    this.#status = this.#provider.configured ? 'paused' : 'configuration-error';
    return this.getSnapshot();
  }

  setCompatibleModels(models: CompatibleModel[]): void {
    this.#availableModels = new Map(models.map((model) => [model.id, model]));
    this.#availableModelIds = new Set(models.map(({ id }) => id));
    if (this.#provider.mode === 'scripted-test')
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

  updateBehaviorConfiguration(input: unknown): SimulationSnapshot {
    if (this.#busy || this.#verificationBusy || this.#completedTurnCount > 0)
      throw new SimulationConflictError(
        'Behavior is locked after the experiment begins. Reset to create new assignments.',
      );
    const parsed = updateExperimentBehaviorRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new SimulationValidationError(
        'invalid_behavior_configuration',
        'The behavior configuration is invalid.',
      );
    const agentIds = [...this.#state.agents.keys()];
    const assignments =
      parsed.data.assignmentMode === 'manual'
        ? parsed.data.assignments.map((assignment) => ({
            ...assignment,
            manual: true,
          }))
        : assignBehavior(
            agentIds,
            parsed.data.seed,
            parsed.data.assignmentMode,
          );
    if (
      assignments.length !== agentIds.length ||
      assignments.some(({ agentId }) => !this.#state.agents.has(agentId))
    )
      throw new SimulationValidationError(
        'invalid_behavior_configuration',
        'Behavior assignments must cover the current roster exactly.',
      );
    this.#behaviorConfiguration = behaviorConfigurationSchema.parse({
      registryVersion: 1,
      ...parsed.data,
      assignments,
      locked: false,
    });
    this.#scenario = {
      ...this.#scenario,
      behaviorConfiguration: structuredClone(this.#behaviorConfiguration),
    };
    return this.getSnapshot();
  }

  importModelConfiguration(document: unknown): {
    snapshot: SimulationSnapshot;
    legacy: boolean;
    message: string;
  } {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'Import is unavailable while a model request is active.',
      );
    if (
      typeof document !== 'object' ||
      document === null ||
      Array.isArray(document)
    )
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'The experiment import is invalid.',
      );
    const root = document as Record<string, unknown>;
    const version = root.schemaVersion;
    if (
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10
    )
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'Only schema-version 5 through 10 experiment exports can be imported.',
      );
    if (version === 5) {
      const legacyConfiguration: ExperimentModelConfiguration = {
        globalModelId: null,
        globalReasoningProfile: 'provider-default',
        overrides: [],
        locked: false,
      };
      this.#recordModelConfigurationChanges(
        this.#modelConfiguration,
        legacyConfiguration,
      );
      this.#modelConfiguration = legacyConfiguration;
      return {
        snapshot: this.getSnapshot(),
        legacy: true,
        message:
          'Legacy experiment preserved. Select compatible models before continuing.',
      };
    }
    const experiment =
      typeof root.experiment === 'object' && root.experiment !== null
        ? (root.experiment as Record<string, unknown>)
        : undefined;
    const configuration = experimentModelConfigurationSchema.safeParse(
      experiment?.modelConfiguration,
    );
    if (!configuration.success)
      throw new SimulationValidationError(
        'invalid_model_configuration',
        'The imported model assignment is invalid.',
      );
    const importedPatientZero =
      (version === 9 || version === 10) &&
      typeof experiment?.scenario === 'object' &&
      experiment.scenario !== null
        ? (appliedScenarioSchema.safeParse(experiment.scenario).data
            ?.patientZeroAgentId ?? null)
        : null;
    const knownAgents = new Set(this.#state.agents.keys());
    if (importedPatientZero && !knownAgents.has(importedPatientZero))
      throw new SimulationValidationError(
        'unknown_agent',
        'The imported Patient Zero designation references an unknown agent.',
      );
    if (
      configuration.data.overrides.some(
        ({ agentId }) => !knownAgents.has(agentId),
      )
    )
      throw new SimulationValidationError(
        'unknown_agent',
        'The imported model assignment references an unknown agent.',
      );
    const importedConfiguration: ExperimentModelConfiguration = {
      globalModelId: configuration.data.globalModelId,
      globalReasoningProfile: configuration.data.globalReasoningProfile,
      overrides: structuredClone(configuration.data.overrides),
      locked: false,
    };
    if (
      (version === 8 || version === 9 || version === 10) &&
      experiment?.behaviorConfiguration !== undefined
    ) {
      const importedBehavior = behaviorConfigurationSchema.safeParse(
        experiment.behaviorConfiguration,
      );
      const knownBehaviorAgents = new Set(this.#state.agents.keys());
      if (
        !importedBehavior.success ||
        importedBehavior.data.assignments.some(
          ({ agentId }) => !knownBehaviorAgents.has(agentId),
        )
      )
        throw new SimulationValidationError(
          'invalid_behavior_configuration',
          'The imported behavior assignment contains an unknown or unsupported profile.',
        );
      this.#behaviorConfiguration = {
        ...structuredClone(importedBehavior.data),
        locked: this.#completedTurnCount > 0,
      };
    }
    this.#recordModelConfigurationChanges(
      this.#modelConfiguration,
      importedConfiguration,
    );
    this.#modelConfiguration = importedConfiguration;
    this.#scenario = {
      ...this.#scenario,
      patientZeroAgentId:
        importedPatientZero ?? this.#scenario.patientZeroAgentId,
    };
    return {
      snapshot: this.getSnapshot(),
      legacy: false,
      message: this.getSnapshot().resolvedModels.every(
        ({ available }) => available,
      )
        ? 'Model assignments imported.'
        : 'Model assignments imported; unavailable models or reasoning profiles require explicit replacement.',
    };
  }

  updateAgentPersonality(
    agentIdInput: unknown,
    personalityInput: unknown,
  ): Agent {
    if (this.#busy || this.#verificationBusy) {
      throw new SimulationConflictError(
        'Personality changes are unavailable while model execution is in progress.',
      );
    }
    const agentIdResult = agentIdSchema.safeParse(agentIdInput);
    if (!agentIdResult.success) {
      throw new SimulationValidationError(
        'invalid_agent_id',
        'The agent ID is invalid.',
      );
    }
    const personalityResult = personalitySchema.safeParse(personalityInput);
    if (!personalityResult.success) {
      throw new SimulationValidationError(
        'invalid_personality',
        `Personality must contain 1 to ${PERSONALITY_MAX_LENGTH} characters.`,
      );
    }
    const agent = this.#state.agents.get(agentIdResult.data);
    if (!agent) {
      throw new SimulationValidationError(
        'unknown_agent',
        'The requested agent does not exist.',
      );
    }
    const updated = { ...agent, personality: personalityResult.data };
    const agents = new Map(this.#state.agents);
    agents.set(agent.id, updated);
    this.#state = { ...this.#state, agents };
    this.#scenario = {
      ...this.#scenario,
      roster: this.#scenario.roster.map((entry) =>
        entry.id === updated.id
          ? { ...entry, personality: updated.personality }
          : entry,
      ),
    };
    if (agent.personality !== updated.personality) {
      this.#configurationEvents = [
        ...this.#configurationEvents,
        {
          timestamp: this.#now(),
          agentId: agent.id,
          previousPersonality: agent.personality,
          newPersonality: updated.personality,
          operation: 'custom-edit',
        },
      ];
    }
    return updated;
  }

  restoreDefaultPersonalities(): SimulationSnapshot {
    if (this.#busy || this.#verificationBusy) {
      throw new SimulationConflictError(
        'Personality changes are unavailable while model execution is in progress.',
      );
    }
    const defaults = new Map(
      DEVELOPMENT_AGENT_BLUEPRINTS.map(({ id, personality }) => [
        agentIdSchema.parse(id),
        personality,
      ]),
    );
    const configurationEvents: ExperimentConfigurationEvent[] = [];
    this.#state = {
      ...this.#state,
      agents: new Map(
        [...this.#state.agents].map(([id, agent]) => {
          const personality = defaults.get(id) ?? agent.personality;
          if (personality !== agent.personality)
            configurationEvents.push({
              timestamp: this.#now(),
              agentId: id,
              previousPersonality: agent.personality,
              newPersonality: personality,
              operation: 'restore-default',
            });
          return [id, { ...agent, personality }];
        }),
      ),
    };
    this.#configurationEvents = [
      ...this.#configurationEvents,
      ...configurationEvents,
    ];
    this.#scenario = {
      ...this.#scenario,
      roster: [...this.#state.agents.values()].map(
        ({ currentCell: _currentCell, ...agent }) => agent,
      ),
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

  generateExperimentExport(request: unknown): ExperimentExportDocument {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'Export is unavailable while model execution is in progress.',
      );
    return experimentExportDocumentSchema.parse(
      createExperimentExport(this.#experimentSource(), request, this.#now()),
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
    const agents = [...this.#state.agents.values()];
    const agent = agents[this.#cursor % agents.length];
    if (!agent) throw new Error('The development world has no agents.');
    this.#verificationBusy = true;
    try {
      const result = await this.#provider.decide(
        structuredClone(this.#buildObservation(agent.id)),
        modelId,
        { reasoningProfile },
      );
      return result.metadata;
    } finally {
      this.#verificationBusy = false;
    }
  }

  async executeNextTurn(): Promise<AgentTurnRecord> {
    if (this.#completedTickCount > 0)
      throw new SimulationConflictError(
        'Legacy sequential turns cannot run after a simultaneous tick.',
      );
    if (this.#pendingFailedTurn)
      throw new SimulationConflictError(
        'The failed turn must be retried or skipped before starting another turn.',
      );
    return this.#executeTurnAttempt('initial');
  }

  /** Execute one atomic simultaneous tick for every active agent. */
  async executeNextTick(): Promise<AgentTurnRecord[]> {
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError(
        'A simulation tick is already in progress.',
      );
    if (
      this.#pendingFailedTurn ||
      (this.#completedTurnCount > 0 && this.#completedTickCount === 0)
    )
      throw new SimulationConflictError(
        'A simultaneous tick cannot start inside a legacy sequential experiment. Reset first.',
      );
    const agents = [...this.#state.agents.values()];
    const unresolved = agents
      .map(({ id }) => this.#resolvedModel(id))
      .filter(({ available }) => !available);
    if (unresolved.length)
      throw new SimulationValidationError(
        'models_unavailable',
        'Every agent requires an available compatible model before the experiment can run.',
      );

    const tickNumber = this.#completedTickCount + 1;
    const preTickState = this.#state;
    const observations = new Map(
      agents.map(({ id }) => [id, structuredClone(this.#buildObservation(id))]),
    );
    const order = seededTickOrder(
      agents.map(({ id }) => id),
      this.#scenario.worldSeed,
      tickNumber,
    );
    const interval = seededTickIntervalMinutes(
      this.#scenario.worldSeed,
      tickNumber,
      this.#scenario.minimumTickIntervalMinutes,
      this.#scenario.maximumTickIntervalMinutes,
    );
    const virtualTime = new Date(
      new Date(this.#virtualTime).getTime() + interval * 60_000,
    ).toISOString();
    const controller = new AbortController();
    this.#busy = true;
    this.#activeRequestController = controller;
    this.#activeAgentId = null;
    this.#cancellationRequested = false;
    this.#status = 'waiting-for-model';
    const deadlineAtMs = Date.now() + OPENROUTER_PROVIDER_TIMEOUT_MS;
    try {
      const dispatched = await dispatchTickDecisions(
        this.#provider,
        agents.map(({ id }) => {
          const resolved = this.#resolvedModel(id);
          return {
            agentId: id,
            observation: observations.get(id)!,
            modelId: resolved.modelId!,
            reasoningProfile: resolved.reasoningProfile,
          };
        }),
        {
          concurrency: Math.min(8, agents.length),
          deadlineAtMs,
          signal: controller.signal,
          now: this.#now,
        },
      );
      if (controller.signal.aborted) throw new SimulationTurnCancelledError();
      const byAgent = new Map(
        dispatched.map((result) => [result.agentId, result]),
      );
      const context = {
        now: () => virtualTime,
        createEventId: this.#createEventId,
        createAllianceId: this.#createAllianceId,
        createProposalId: this.#createProposalId,
        communicationRangeKm: this.#scenario.communicationRangeKm,
        patientZeroAgentId: this.#scenario.patientZeroAgentId,
        tickNumber,
        diplomacyRangeState: preTickState,
      };
      const recordOrdinal = new Map(
        order.map((agentId, index) => [
          agentId,
          this.#completedTurnCount + index + 1,
        ]),
      );
      let state = preTickState;
      const actionResults = new Map<
        AgentId,
        ReturnType<typeof applyWorldAction>['result']
      >();
      for (const agentId of order) {
        const result = byAgent.get(agentId)!;
        if (result.outcome === 'lost-tick') continue;
        const applied = applyWorldAction(
          state,
          agentId,
          result.decision.decision.worldAction,
          context,
        );
        state = applied.state;
        actionResults.set(agentId, applied.result);
      }
      const communicationResults = new Map<
        AgentId,
        ReturnType<typeof applyCommunication>['result']
      >();
      for (const agentId of order) {
        const result = byAgent.get(agentId)!;
        if (result.outcome === 'lost-tick') continue;
        const applied = applyCommunication(
          state,
          preTickState,
          agentId,
          result.decision.decision.communication,
          context,
        );
        state = applied.state;
        communicationResults.set(agentId, applied.result);
      }
      const diplomacyResults = new Map<
        AgentId,
        ReturnType<typeof applyDiplomacy>['result']
      >();
      const diplomacyEvents = new Map<AgentId, AllianceEvent[]>();
      for (const agentId of order) {
        const result = byAgent.get(agentId)!;
        if (result.outcome === 'lost-tick') continue;
        const before = state;
        const applied = applyDiplomacy(
          state,
          agentId,
          result.decision.decision.diplomacy,
          recordOrdinal.get(agentId)!,
          context,
        );
        state = applied.state;
        diplomacyResults.set(agentId, applied.result);
        diplomacyEvents.set(agentId, allianceEventsSince(before, state));
      }
      const beforeExpiration = state;
      state = expireAllianceProposals(
        state,
        recordOrdinal.get(order.at(-1)!)!,
        context,
      );
      const expirationEvents = allianceEventsSince(beforeExpiration, state);
      if (expirationEvents.length) {
        const finalAgentId = order.at(-1)!;
        diplomacyEvents.set(finalAgentId, [
          ...(diplomacyEvents.get(finalAgentId) ?? []),
          ...expirationEvents,
        ]);
      }
      state = {
        ...state,
        events: state.events.slice(-MAX_WORLD_EVENT_HISTORY),
      };
      const nextGoals = new Map(this.#agentGoals);
      const goalResults = new Map<AgentId, GoalRevisionResult>();
      for (const agentId of order) {
        const result = byAgent.get(agentId)!;
        if (result.outcome === 'lost-tick') continue;
        const applied = applyGoalRevision(
          this.#agentGoals.get(agentId),
          result.decision.decision.goalRevision,
          tickNumber,
        );
        goalResults.set(agentId, applied.result);
        if (applied.goal) nextGoals.set(agentId, applied.goal);
        else nextGoals.delete(agentId);
      }

      const records = order.map((agentId, index) => {
        const result = byAgent.get(agentId)!;
        const base = {
          turnNumber: this.#completedTurnCount + index + 1,
          tickNumber,
          tickPosition: index + 1,
          virtualTime,
          tickIntervalMinutes: interval,
          agentId,
          startedAt: result.attempts[0]?.startedAt ?? this.#now(),
          completedAt: result.attempts.at(-1)?.completedAt ?? this.#now(),
          observation: observations.get(agentId)!,
          behavior: this.#behaviorFor(agentId),
          modelAttempts: result.attempts,
          allianceEvents: diplomacyEvents.get(agentId) ?? [],
        };
        if (result.outcome === 'lost-tick')
          return agentTurnRecordSchema.parse({
            ...base,
            outcome: 'lost-tick',
            failure: result.failure,
            provider: result.attempts.at(-1)?.provider,
          });
        const decision = result.decision.decision;
        const actionResult = actionResults.get(agentId)!;
        return agentTurnRecordSchema.parse({
          ...base,
          outcome: actionResult.accepted ? 'accepted' : 'rejected',
          worldAction: decision.worldAction,
          communication: communicationIntentSchema.safeParse(
            decision.communication,
          ).data,
          diplomacy: diplomacyIntentSchema.safeParse(decision.diplomacy).data,
          goalRevision: decision.goalRevision,
          goalRevisionResult: goalResults.get(agentId),
          summary: decision.summary,
          worldActionResult: actionResult,
          communicationResult: communicationResults.get(agentId)!,
          diplomacyResult: diplomacyResults.get(agentId)!,
          provider: result.decision.metadata,
        });
      });
      if (controller.signal.aborted) throw new SimulationTurnCancelledError();
      this.#commitCompletedTick(
        records,
        state,
        tickNumber,
        virtualTime,
        interval,
        order,
        nextGoals,
      );
      this.#status = 'paused';
      return records;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error &&
          typeof error === 'object' &&
          'failure' in error &&
          (error as { failure?: ProviderFailure }).failure?.code ===
            'cancelled')
      ) {
        this.#status = 'paused';
        throw new SimulationTurnCancelledError();
      }
      throw error;
    } finally {
      this.#busy = false;
      this.#activeRequestController = null;
      this.#activeAgentId = null;
      this.#cancellationRequested = false;
      if (this.#status === 'waiting-for-model') this.#status = 'paused';
    }
  }

  #commitCompletedTick(
    records: AgentTurnRecord[],
    state: WorldState,
    tickNumber: number,
    virtualTime: string,
    interval: number,
    order: AgentId[],
    goals: Map<AgentId, AgentGoalState>,
  ): void {
    this.#state = state;
    this.#completedTickCount = tickNumber;
    this.#virtualTime = virtualTime;
    this.#lastTickIntervalMinutes = interval;
    this.#resolutionOrder = [...order];
    this.#agentGoals = goals;
    this.#completedTurnCount = records.at(-1)!.turnNumber;
    this.#turns = retainCompleteTickGroups(
      [...this.#turns, ...records],
      MAX_TURN_HISTORY,
    );
    this.#experimentTurns = retainCompleteTickGroups(
      [...this.#experimentTurns, ...structuredClone(records)],
      this.#experimentRetentionLimit,
    );
    for (const record of records) this.#experimentMetrics.add(record);
    this.#behaviorConfiguration = {
      ...this.#behaviorConfiguration,
      locked: true,
    };
    this.#modelConfiguration = { ...this.#modelConfiguration, locked: false };
  }

  async retryFailedTurn(
    kind: 'manual-retry' | 'unattended-retry' = 'manual-retry',
  ): Promise<AgentTurnRecord> {
    if (this.#completedTickCount > 0)
      throw new SimulationConflictError(
        'Legacy retry is unavailable after a simultaneous tick.',
      );
    if (!this.#pendingFailedTurn)
      throw new SimulationConflictError(
        'There is no failed turn awaiting a manual retry.',
      );
    return this.#executeTurnAttempt(kind);
  }

  skipFailedTurn(
    skipKind: 'manual' | 'unattended' = 'manual',
  ): AgentTurnRecord {
    if (this.#completedTickCount > 0)
      throw new SimulationConflictError(
        'Legacy skip is unavailable after a simultaneous tick.',
      );
    if (this.#busy || this.#verificationBusy)
      throw new SimulationConflictError('A model request is still active.');
    const pending = this.#pendingFailedTurn;
    if (!pending)
      throw new SimulationConflictError(
        'There is no failed turn awaiting an operator decision.',
      );
    const agents = [...this.#state.agents.values()];
    const record = agentTurnRecordSchema.parse({
      turnNumber: pending.turnNumber,
      agentId: pending.agentId,
      startedAt: pending.startedAt,
      completedAt: this.#now(),
      observation: pending.observation,
      behavior: this.#behaviorFor(pending.agentId),
      outcome: 'operator-skipped',
      skipKind,
      failure: pending.failure,
      provider: pending.attempts.at(-1)?.provider,
      modelAttempts: pending.attempts,
      allianceEvents: [],
    });
    this.#pendingFailedTurn = null;
    this.#commitCompletedTurn(record, this.#state, agents.length);
    this.#status = 'paused';
    return record;
  }

  async #executeTurnAttempt(
    attemptKind: 'initial' | 'manual-retry' | 'unattended-retry',
  ): Promise<AgentTurnRecord> {
    if (this.#busy || this.#verificationBusy) {
      throw new SimulationConflictError(
        'Model execution is already in progress.',
      );
    }
    const agents = [...this.#state.agents.values()];
    const unresolved = agents
      .map(({ id }) => this.#resolvedModel(id))
      .filter(({ available }) => !available);
    if (unresolved.length)
      throw new SimulationValidationError(
        'models_unavailable',
        'Every agent requires an available compatible model before the experiment can run.',
      );
    const pending = this.#pendingFailedTurn;
    const agent = pending
      ? agents.find(({ id }) => id === pending.agentId)
      : agents[this.#cursor % agents.length];
    if (!agent) throw new Error('The development world has no agents.');

    this.#busy = true;
    this.#activeAgentId = agent.id;
    this.#activeRequestController = new AbortController();
    this.#cancellationRequested = false;
    this.#status = 'waiting-for-model';
    const startedAt = pending?.startedAt ?? this.#now();
    const observation =
      pending?.observation ?? this.#buildObservation(agent.id);
    const turnNumber = pending?.turnNumber ?? this.#completedTurnCount + 1;
    const attemptStartedAt = this.#now();
    let successfulAttemptStartedAt = attemptStartedAt;
    const resolvedModel = this.#resolvedModel(agent.id);
    const selectedModel = resolvedModel.modelId!;
    let providerResult: ProviderDecision | undefined;
    const attemptHistory = [...(pending?.attempts ?? [])];
    const deadlineAtMs = Date.now() + OPENROUTER_PROVIDER_TIMEOUT_MS;

    try {
      const providerObservation = structuredClone(observation);

      const automaticRecoveryAllowed = attemptKind === 'initial';
      let nextKind: ModelAttempt['kind'] = attemptKind;
      let validationFeedback: ProviderFailure['validationCodes'] =
        pending?.failure.validationCodes;
      for (let automaticCall = 0; automaticCall < 2; automaticCall += 1) {
        const currentAttemptStartedAt = this.#now();
        successfulAttemptStartedAt = currentAttemptStartedAt;
        try {
          providerResult = await this.#provider.decide(
            providerObservation,
            selectedModel,
            {
              reasoningProfile: resolvedModel.reasoningProfile,
              signal: this.#activeRequestController.signal,
              deadlineAtMs,
              validationFeedback,
            },
          );
          if (this.#activeRequestController.signal.aborted)
            throw new AgentProviderError({
              code: 'cancelled',
              message: 'The model request was cancelled by the operator.',
              retryable: false,
              model: selectedModel,
            });
          break;
        } catch (error) {
          const providerError = asProviderError(error);
          if (providerError.failure.code === 'cancelled') {
            this.#status = 'paused';
            throw new SimulationTurnCancelledError();
          }
          const attemptProvider = providerError.metadata ?? {
            provider: this.#provider.mode,
            model: providerError.failure.model ?? selectedModel,
            latencyMs: providerError.failure.latencyMs ?? 0,
          };
          const attempt = {
            attemptNumber: attemptHistory.length + 1,
            kind: nextKind,
            startedAt: currentAttemptStartedAt,
            completedAt: this.#now(),
            modelId: selectedModel,
            reasoningProfile: resolvedModel.reasoningProfile,
            failure: providerError.failure,
            provider: attemptProvider,
          } satisfies ModelAttempt;
          attemptHistory.push(attempt);
          const formatFailure = Boolean(
            providerError.failure.validationCodes?.length,
          );
          const transientFailure =
            providerError.failure.retryable &&
            (providerError.failure.code === 'network' ||
              providerError.failure.code === 'timeout' ||
              providerError.failure.code === 'malformed-response' ||
              providerError.failure.code === 'unsupported-response' ||
              (providerError.failure.code === 'provider-http' &&
                [408, 429, 500, 502, 503, 504].includes(
                  providerError.failure.httpStatus ?? 0,
                )));
          const retryDelayMs = automaticRetryDelayMs(
            providerError.failure,
            deadlineAtMs,
          );
          const canRetry =
            automaticRecoveryAllowed &&
            automaticCall === 0 &&
            Date.now() < deadlineAtMs &&
            Date.now() + retryDelayMs < deadlineAtMs &&
            (formatFailure || transientFailure);
          if (canRetry) {
            if (retryDelayMs > 0) {
              try {
                await waitForRetryBackoff(
                  retryDelayMs,
                  this.#activeRequestController.signal,
                  selectedModel,
                );
              } catch (error) {
                if (
                  error instanceof AgentProviderError &&
                  error.failure.code === 'cancelled'
                ) {
                  this.#status = 'paused';
                  throw new SimulationTurnCancelledError();
                }
                throw error;
              }
            }
            validationFeedback = providerError.failure.validationCodes;
            nextKind = formatFailure
              ? 'automatic-repair'
              : 'automatic-transport-retry';
            continue;
          }
          this.#pendingFailedTurn = {
            turnNumber,
            agentId: agent.id,
            startedAt,
            observation,
            failure: providerError.failure,
            attempts: attemptHistory,
          };
          const record = agentTurnRecordSchema.parse({
            turnNumber,
            agentId: agent.id,
            startedAt,
            completedAt: this.#now(),
            observation,
            behavior: this.#behaviorFor(agent.id),
            outcome: 'provider-error',
            failure: providerError.failure,
            provider: attemptProvider,
            modelAttempts: attemptHistory,
            allianceEvents: [],
          });
          this.#status =
            providerError.failure.code === 'configuration'
              ? 'configuration-error'
              : 'provider-error';
          return record;
        }
      }

      if (!providerResult)
        throw new Error('The provider completed without a decision result.');

      const preActionState = this.#state;
      const occurredAt = this.#now();
      const communicationInput =
        providerResult.decision.communication ?? undefined;
      const diplomacyInput = providerResult.decision.diplomacy ?? undefined;
      const parsedCommunication =
        communicationIntentSchema.safeParse(communicationInput);
      const communication = parsedCommunication.success
        ? parsedCommunication.data
        : undefined;
      const parsedDiplomacy = diplomacyIntentSchema.safeParse(diplomacyInput);
      const diplomacy = parsedDiplomacy.success
        ? parsedDiplomacy.data
        : undefined;
      const context = {
        now: () => occurredAt,
        createEventId: this.#createEventId,
        createAllianceId: this.#createAllianceId,
        createProposalId: this.#createProposalId,
        communicationRangeKm: this.#scenario.communicationRangeKm,
        patientZeroAgentId: this.#scenario.patientZeroAgentId,
        diplomacyRangeState: preActionState,
      };
      const appliedAction = applyWorldAction(
        preActionState,
        agent.id,
        providerResult.decision.worldAction,
        context,
      );
      const appliedCommunication = applyCommunication(
        appliedAction.state,
        preActionState,
        agent.id,
        communicationInput,
        context,
      );
      const appliedDiplomacy = applyDiplomacy(
        appliedCommunication.state,
        agent.id,
        diplomacyInput,
        turnNumber,
        context,
      );
      const stateAfterExpiration = expireAllianceProposals(
        appliedDiplomacy.state,
        turnNumber,
        context,
      );
      const candidateState = {
        ...stateAfterExpiration,
        events: stateAfterExpiration.events.slice(-MAX_WORLD_EVENT_HISTORY),
      };
      const appliedGoal = applyGoalRevision(
        this.#agentGoals.get(agent.id),
        providerResult.decision.goalRevision,
        turnNumber,
      );

      const completed = {
        turnNumber,
        agentId: agent.id,
        startedAt,
        completedAt: this.#now(),
        observation,
        behavior: this.#behaviorFor(agent.id),
        worldAction: providerResult.decision.worldAction,
        communication,
        diplomacy,
        goalRevision: providerResult.decision.goalRevision,
        goalRevisionResult: appliedGoal.result,
        summary: providerResult.decision.summary,
        worldActionResult: appliedAction.result,
        communicationResult: appliedCommunication.result,
        diplomacyResult: appliedDiplomacy.result,
        allianceEvents: allianceEventsSince(
          preActionState,
          stateAfterExpiration,
        ),
        provider: providerResult.metadata,
        modelAttempts: [
          ...attemptHistory,
          {
            attemptNumber: attemptHistory.length + 1,
            kind: nextKind,
            startedAt: successfulAttemptStartedAt,
            completedAt: this.#now(),
            modelId: selectedModel,
            reasoningProfile: resolvedModel.reasoningProfile,
            provider: providerResult.metadata,
          },
        ],
      };
      const record = agentTurnRecordSchema.parse(
        appliedAction.result.accepted
          ? {
              ...completed,
              outcome: 'accepted',
              worldActionResult: appliedAction.result,
            }
          : {
              ...completed,
              outcome: 'rejected',
              worldActionResult: appliedAction.result,
            },
      );

      this.#pendingFailedTurn = null;
      this.#commitCompletedTurn(record, candidateState, agents.length, {
        agentId: agent.id,
        goal: appliedGoal.goal,
      });
      this.#status = 'paused';
      return record;
    } catch (error) {
      if (
        error instanceof SimulationTurnCancelledError ||
        !(error instanceof Error) ||
        error.name !== 'ZodError'
      )
        throw error;
      const failure: ProviderFailure = {
        code: 'simulation-validation',
        message: 'The model decision failed post-provider validation.',
        retryable: true,
        model: selectedModel,
      };
      const attempt = {
        attemptNumber: attemptHistory.length + 1,
        kind: attemptKind,
        startedAt: attemptStartedAt,
        completedAt: this.#now(),
        modelId: selectedModel,
        reasoningProfile: resolvedModel.reasoningProfile,
        failure,
        provider: {
          provider: this.#provider.mode,
          model: selectedModel,
          latencyMs: 0,
        },
      } satisfies ModelAttempt;
      const attempts = [...attemptHistory, attempt];
      this.#pendingFailedTurn = {
        turnNumber,
        agentId: agent.id,
        startedAt,
        observation,
        failure,
        attempts,
      };
      this.#status = 'provider-error';
      return agentTurnRecordSchema.parse({
        turnNumber,
        agentId: agent.id,
        startedAt,
        completedAt: this.#now(),
        observation,
        behavior: this.#behaviorFor(agent.id),
        outcome: 'provider-error',
        failure,
        provider: attempt.provider,
        modelAttempts: attempts,
        allianceEvents: [],
      });
    } finally {
      this.#busy = false;
      this.#activeAgentId = null;
      this.#activeRequestController = null;
      this.#cancellationRequested = false;
      if (this.#status === 'waiting-for-model') {
        this.#status = this.#provider.configured
          ? 'paused'
          : 'configuration-error';
      }
    }
  }

  #commitCompletedTurn(
    record: AgentTurnRecord,
    state: WorldState,
    agentCount: number,
    goalCommit?: { agentId: AgentId; goal: AgentGoalState | undefined },
  ): void {
    const turns = [...this.#turns, record].slice(-MAX_TURN_HISTORY);
    const cursor = (this.#cursor + 1) % agentCount;

    this.#state = state;
    if (goalCommit?.goal)
      this.#agentGoals.set(goalCommit.agentId, goalCommit.goal);
    else if (goalCommit) this.#agentGoals.delete(goalCommit.agentId);
    this.#behaviorConfiguration = {
      ...this.#behaviorConfiguration,
      locked: true,
    };
    this.#turns = turns;
    this.#experimentTurns = [
      ...this.#experimentTurns,
      structuredClone(record),
    ].slice(-this.#experimentRetentionLimit);
    this.#experimentMetrics.add(record);
    this.#completedTurnCount = record.turnNumber;
    this.#cursor = cursor;
    this.#modelConfiguration = { ...this.#modelConfiguration, locked: false };
  }

  #recordModelConfigurationChanges(
    previous: ExperimentModelConfiguration,
    next: ExperimentModelConfiguration,
  ): void {
    const timestamp = this.#now();
    const effectiveTurn = this.#completedTurnCount + 1;
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
      alliances: structuredClone([...(this.#state.alliances?.values() ?? [])]),
      pendingAllianceProposals: structuredClone([
        ...(this.#state.pendingAllianceProposals?.values() ?? []),
      ]),
    };
  }

  #experimentSource(): ExperimentSource {
    return {
      id: this.#experimentId,
      startedAt: this.#experimentStartedAt,
      providerMode: this.#provider.mode,
      retentionLimit: this.#experimentRetentionLimit,
      totalCompletedTurns: this.#completedTurnCount,
      turns: this.#experimentTurns,
      initialAgents: this.#initialExperimentAgents,
      currentAgents: [...this.#state.agents.values()],
      configurationEvents: this.#configurationEvents,
      initialWorld: this.#initialExperimentWorld,
      currentWorld: this.#worldSnapshot(),
      modelConfiguration: this.#modelConfiguration,
      behaviorConfiguration: this.#behaviorConfiguration,
      scenario: this.#scenario,
      schemaVersion:
        this.#completedTickCount > 0 || this.#completedTurnCount === 0 ? 10 : 9,
      agentGoals: [...this.#state.agents.keys()].map((agentId) => ({
        agentId,
        goal: structuredClone(this.#agentGoals.get(agentId) ?? null),
      })),
    };
  }

  #behaviorFor(agentId: AgentId) {
    const assignment = this.#behaviorConfiguration.assignments.find(
      (candidate) => candidate.agentId === agentId,
    );
    if (!assignment) throw new Error('The agent has no behavior assignment.');
    return assignment;
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

  #buildObservation(agentId: AgentId): AgentObservation {
    const agent = this.#state.agents.get(agentId);
    if (!agent) throw new Error('The active agent does not exist.');
    const currentGoal = this.#agentGoals.get(agentId) ?? null;
    const stateFor = (cell: H3Cell) => {
      const state = this.#state.hexes.get(cell);
      if (!state) throw new Error('Observation cell is outside the world.');
      if (state.state === 'open')
        return {
          cell,
          ...state,
          controllerAllianceId: null,
          effectiveColor: null,
        } as const;
      return {
        cell,
        ...state,
        controllerAllianceId:
          getAgentAlliance(this.#state, state.controllerAgentId)?.id ?? null,
        effectiveColor: getEffectiveAgentColor(
          this.#state,
          state.controllerAgentId,
        ),
      } as const;
    };
    const adjacentCells = gridDisk(agent.currentCell, 1)
      .filter((cell) => cell !== agent.currentCell)
      .map((cell) => h3CellSchema.parse(cell))
      .filter((cell) => this.#state.hexes.has(cell))
      .map(stateFor)
      .toSorted(
        (a, b) =>
          stableOrder(
            `${this.#scenario.worldSeed}:${agent.id}:${this.#completedTurnCount + 1}:${a.cell}`,
          ) -
          stableOrder(
            `${this.#scenario.worldSeed}:${agent.id}:${this.#completedTurnCount + 1}:${b.cell}`,
          ),
      );
    const recentMovements = this.#state.events
      .filter(
        (event): event is Extract<WorldEvent, { type: 'agent-moved' }> =>
          event.type === 'agent-moved' && event.agentId === agent.id,
      )
      .slice(-6)
      .map(({ fromCell, toCell, occurredAt }) => ({
        fromCell,
        toCell,
        occurredAt,
      }));
    const captureEligibility = getCaptureEligibility(this.#state, agent.id);
    const actingAlliance = getAgentAlliance(this.#state, agent.id);
    const patientZeroAgentId = this.#scenario.patientZeroAgentId;
    const territory = this.#territoryScoreboard();
    const nearbyAgents = [...this.#state.agents.values()]
      .filter((candidate) => candidate.id !== agent.id)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        currentCell: candidate.currentCell,
        distanceKm:
          physicalDistanceKm(agent.currentCell, candidate.currentCell) ??
          Number.POSITIVE_INFINITY,
        distance: gridRingDistance(agent.currentCell, candidate.currentCell),
        allianceId: getAgentAlliance(this.#state, candidate.id)?.id ?? null,
        allianceRelationship: actingAlliance?.memberAgentIds.includes(
          candidate.id,
        )
          ? ('allied' as const)
          : ('not-allied' as const),
        controlledCellCount:
          territory.find(({ agentId }) => agentId === candidate.id)
            ?.controlledCellCount ?? 0,
      }))
      .filter(
        ({ id, distanceKm, allianceRelationship }) =>
          allianceRelationship === 'allied' ||
          distanceKm <= this.#scenario.communicationRangeKm ||
          id === patientZeroAgentId ||
          agent.id === patientZeroAgentId,
      )
      .map((entry) => ({
        ...entry,
        directMessageLegal:
          entry.distanceKm <= this.#scenario.communicationRangeKm ||
          entry.id === patientZeroAgentId ||
          agent.id === patientZeroAgentId,
      }))
      .sort(
        (a, b) =>
          Number(b.id === patientZeroAgentId) -
            Number(a.id === patientZeroAgentId) ||
          a.distanceKm - b.distanceKm ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 8);
    const recentEvents = this.#state.events
      .filter(
        (
          event,
        ): event is Extract<
          WorldEvent,
          {
            type:
              'agent-moved' | 'hex-infected' | 'hex-captured' | 'agent-waited';
          }
        > =>
          event.type === 'agent-moved' ||
          event.type === 'hex-infected' ||
          event.type === 'hex-captured' ||
          event.type === 'agent-waited',
      )
      .slice(-8)
      .map((event) => ({
        type: event.type,
        agentId: event.agentId,
        occurredAt: event.occurredAt,
        summary: summarizeEvent(event, this.#state),
      }));
    const recentPublicMessages = this.#state.events
      .filter(
        (
          event,
        ): event is Extract<WorldEvent, { type: 'public-message-sent' }> =>
          event.type === 'public-message-sent',
      )
      .slice(-RECENT_PUBLIC_MESSAGE_LIMIT)
      .map((event) => {
        const sender = this.#state.agents.get(event.agentId);
        if (!sender) throw new Error('A public-message sender does not exist.');
        return {
          eventId: event.id,
          senderId: sender.id,
          senderName: sender.name,
          message: event.message,
          occurredAt: event.occurredAt,
        };
      });
    const recentDirectMessages = this.#state.events
      .filter(
        (
          event,
        ): event is Extract<WorldEvent, { type: 'direct-message-sent' }> =>
          event.type === 'direct-message-sent' &&
          (event.agentId === agent.id || event.recipientId === agent.id),
      )
      .slice(-RECENT_DIRECT_MESSAGE_LIMIT)
      .map((event) => {
        const sender = this.#state.agents.get(event.agentId);
        const recipient = this.#state.agents.get(event.recipientId);
        if (!sender || !recipient)
          throw new Error('A communication participant does not exist.');
        return {
          eventId: event.id,
          senderId: sender.id,
          senderName: sender.name,
          recipientId: recipient.id,
          recipientName: recipient.name,
          direction: event.agentId === agent.id ? 'outbound' : 'inbound',
          message: event.message,
          occurredAt: event.occurredAt,
          distance: event.distance,
        } as const;
      });
    const recentAllianceMessages = this.#state.events
      .filter(
        (
          event,
        ): event is Extract<WorldEvent, { type: 'alliance-message-sent' }> =>
          event.type === 'alliance-message-sent' &&
          (event.agentId === agent.id || event.recipientIds.includes(agent.id)),
      )
      .slice(-RECENT_DIRECT_MESSAGE_LIMIT)
      .map((event) => {
        const sender = this.#state.agents.get(event.agentId);
        if (!sender)
          throw new Error('An alliance-message sender does not exist.');
        return {
          eventId: event.id,
          senderId: sender.id,
          senderName: sender.name,
          allianceId: event.allianceId,
          message: event.message,
          occurredAt: event.occurredAt,
        };
      });
    const recentZeroMessages = this.#state.events
      .filter(
        (event): event is Extract<WorldEvent, { type: 'zero-message-sent' }> =>
          event.type === 'zero-message-sent' &&
          (event.agentId === agent.id || event.recipientIds.includes(agent.id)),
      )
      .slice(-RECENT_ZERO_MESSAGE_LIMIT)
      .map((event) => {
        const sender = this.#state.agents.get(event.agentId);
        if (!sender) throw new Error('A Zero-message sender does not exist.');
        return {
          eventId: event.id,
          senderId: sender.id,
          senderName: sender.name,
          recipientCount: event.recipientIds.length,
          message: event.message,
          occurredAt: event.occurredAt,
        };
      });
    const recentControlChanges = this.#state.events
      .filter(
        (event): event is Extract<WorldEvent, { type: 'hex-captured' }> =>
          event.type === 'hex-captured' &&
          (event.controllerAgentId === agent.id ||
            event.previousControllerAgentId === agent.id),
      )
      .slice(-RECENT_CONTROL_CHANGE_LIMIT)
      .map((event) => {
        const gained = event.controllerAgentId === agent.id;
        const otherAgentId = gained
          ? event.previousControllerAgentId
          : event.controllerAgentId;
        const otherAgent = this.#state.agents.get(otherAgentId);
        if (!otherAgent)
          throw new Error('A control-change participant does not exist.');
        return {
          eventId: event.id,
          direction: gained ? ('gained' as const) : ('lost' as const),
          otherAgentId,
          otherAgentName: otherAgent.name,
          cell: event.cell,
          occurredAt: event.occurredAt,
        };
      });
    return agentObservationSchema.parse({
      agentId: agent.id,
      agentName: agent.name,
      personality: agent.personality,
      behavior: this.#behaviorFor(agent.id),
      currentGoal: structuredClone(currentGoal),
      goalAvailability: currentGoal
        ? {
            active: true,
            availableOperations: ['keep', 'revise', 'complete', 'abandon'],
          }
        : { active: false, availableOperations: ['establish'] },
      currentCell: stateFor(agent.currentCell),
      captureEligibility,
      actionAvailability: {
        moveTargetCellIds: adjacentCells.map(({ cell }) => cell),
        moveOptions: adjacentCells.map((destination) => {
          const controllerAlliance = destination.controllerAgentId
            ? getAgentAlliance(this.#state, destination.controllerAgentId)
            : undefined;
          const relationship =
            destination.state === 'open'
              ? ('open' as const)
              : destination.controllerAgentId === agent.id
                ? ('self' as const)
                : actingAlliance && controllerAlliance?.id === actingAlliance.id
                  ? ('allied' as const)
                  : ('other' as const);
          const directions = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const;
          const canonicalIndex = gridDisk(agent.currentCell, 1)
            .filter((cell) => cell !== agent.currentCell)
            .indexOf(destination.cell);
          return {
            targetCell: destination.cell,
            direction: directions[Math.max(0, canonicalIndex)]!,
            destinationState: destination.state,
            controllerRelationship: relationship,
            recentlyOccupied: recentMovements.some(
              ({ toCell }) => toCell === destination.cell,
            ),
            nearbyAgentCount: nearbyAgents.filter(
              ({ currentCell }) => currentCell === destination.cell,
            ).length,
          };
        }),
        infect:
          this.#state.hexes.get(agent.currentCell)?.state === 'open'
            ? { available: true }
            : {
                available: false,
                reason: 'current-cell-already-infected',
              },
        capture: captureEligibility.eligible
          ? { available: true }
          : { available: false, reason: captureEligibility.blockedReason },
        wait: { available: true },
      },
      diplomacyAvailability: this.#diplomacyAvailability(agent.id),
      communicationAvailability: {
        public: { available: true, playerVisible: true },
        direct: {
          eligibleRecipientAgentIds: nearbyAgents
            .filter(({ directMessageLegal }) => directMessageLegal)
            .map(({ id }) => id),
        },
        alliance: actingAlliance
          ? { available: true, allianceId: actingAlliance.id }
          : { available: false, allianceId: null },
        zero: { available: agent.id === patientZeroAgentId },
      },
      adjacentCells,
      nearbyAgents,
      recentEvents,
      recentPublicMessages,
      recentDirectMessages,
      recentAllianceMessages,
      recentZeroMessages,
      patientZero: {
        agentId: patientZeroAgentId,
        agentName:
          (patientZeroAgentId
            ? this.#state.agents.get(patientZeroAgentId)?.name
            : null) ?? null,
        isPatientZero: agent.id === patientZeroAgentId,
        directRangeBypass: patientZeroAgentId !== null,
      },
      patientZeroGlobalView:
        agent.id === patientZeroAgentId
          ? {
              agents: [...this.#state.agents.values()].map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                currentCell: candidate.currentCell,
                allianceId:
                  getAgentAlliance(this.#state, candidate.id)?.id ?? null,
                controlledCellCount:
                  territory.find(({ agentId: id }) => id === candidate.id)
                    ?.controlledCellCount ?? 0,
                personality: candidate.personality,
                strategyId: this.#behaviorFor(candidate.id).strategyId,
              })),
              individualTerritory: territory,
              allianceTerritory: this.#allianceTerritorySummaries(),
              alliances: [...(this.#state.alliances?.values() ?? [])],
              activeAllianceProposals: [
                ...(this.#state.pendingAllianceProposals?.values() ?? []),
              ],
              diplomacyFeasibility: [],
              diplomacySummary: this.#patientZeroDiplomacySummary(),
              recentStrategicEvents: this.#state.events
                .filter(isAllianceEvent)
                .slice(-RECENT_ZERO_STRATEGIC_EVENT_LIMIT)
                .map((event) => ({
                  event,
                  summary: summarizeAllianceEvent(event, this.#state),
                })),
              recentTerritoryChanges: this.#state.events
                .filter(
                  (
                    event,
                  ): event is Extract<WorldEvent, { type: 'hex-captured' }> =>
                    event.type === 'hex-captured',
                )
                .slice(-RECENT_CONTROL_CHANGE_LIMIT),
            }
          : null,
      territoryScoreboard: this.#territoryScoreboard(),
      actingAllianceId: getAgentAlliance(this.#state, agent.id)?.id ?? null,
      actingAlliance:
        this.#allianceTerritorySummaries().find(
          ({ allianceId }) =>
            allianceId === getAgentAlliance(this.#state, agent.id)?.id,
        ) ?? null,
      activeAlliances: this.#allianceTerritorySummaries(),
      inboundAllianceProposals: [
        ...(this.#state.pendingAllianceProposals?.values() ?? []),
      ].filter(({ recipientAgentId }) => recipientAgentId === agent.id),
      outboundAllianceProposals: [
        ...(this.#state.pendingAllianceProposals?.values() ?? []),
      ].filter(({ proposerAgentId }) => proposerAgentId === agent.id),
      recentAllianceEvents: this.#state.events
        .filter(isAllianceEvent)
        .slice(-RECENT_ALLIANCE_EVENT_LIMIT)
        .map((event) => ({
          event,
          summary: summarizeAllianceEvent(event, this.#state),
        })),
      recentControlChanges,
      recentMovements,
    });
  }

  #diplomacyAvailability(
    agentId: AgentId,
    blockedRecipientLimit: number = WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations,
  ) {
    const proposals = [
      ...(this.#state.pendingAllianceProposals?.values() ?? []),
    ];
    const actingAlliance = getAgentAlliance(this.#state, agentId);
    const hasOutgoing = proposals.some(
      ({ proposerAgentId }) => proposerAgentId === agentId,
    );
    const eligibleRecipientAgentIds: AgentId[] = [];
    const blockedRecipients: Array<{
      agentId: AgentId;
      reason:
        | 'current-ally'
        | 'out-of-range'
        | 'outgoing-proposal-exists'
        | 'incoming-proposal-exists'
        | 'alliance-to-alliance-merge';
    }> = [];
    for (const candidateId of [...this.#state.agents.keys()].toSorted()) {
      let reason: (typeof blockedRecipients)[number]['reason'] | null = null;
      if (candidateId === agentId) continue;
      const eligibility = getProposalTargetEligibility(
        this.#state,
        agentId,
        candidateId,
        this.#scenario.communicationRangeKm,
        this.#state,
      );
      if (!eligibility.eligible) reason = eligibility.reason;
      if (reason) {
        if (blockedRecipients.length < blockedRecipientLimit)
          blockedRecipients.push({ agentId: candidateId, reason });
      } else eligibleRecipientAgentIds.push(candidateId);
    }
    const acceptableProposalIds = proposals
      .filter((proposal) => {
        if (proposal.recipientAgentId !== agentId) return false;
        const proposerAlliance = getAgentAlliance(
          this.#state,
          proposal.proposerAgentId,
        );
        return (
          (proposal.proposerAllianceId === null
            ? !proposerAlliance
            : proposerAlliance?.id === proposal.proposerAllianceId) &&
          (proposal.recipientAllianceId === null
            ? !actingAlliance
            : actingAlliance?.id === proposal.recipientAllianceId) &&
          !(proposerAlliance && actingAlliance)
        );
      })
      .map(({ id }) => id);
    return {
      neutral: { available: true as const },
      propose: eligibleRecipientAgentIds.length
        ? {
            available: true as const,
            eligibleRecipientAgentIds,
            blockedRecipients,
          }
        : {
            available: false as const,
            eligibleRecipientAgentIds: [],
            blockedRecipients,
            reason: hasOutgoing
              ? 'A pending outgoing formal proposal already exists.'
              : 'No eligible formal proposal recipient is available.',
          },
      accept: acceptableProposalIds.length
        ? { available: true as const, acceptableProposalIds }
        : {
            available: false as const,
            acceptableProposalIds: [],
            reason: 'No acceptable inbound formal alliance proposal exists.',
          },
      leave: actingAlliance
        ? { available: true as const, allianceId: actingAlliance.id }
        : {
            available: false as const,
            allianceId: null,
            reason: 'The agent is not currently in an alliance.',
          },
    };
  }

  #patientZeroDiplomacySummary() {
    const eligiblePairs: Array<{
      proposerId: AgentId;
      recipientId: AgentId;
    }> = [];
    const acceptableProposals: Array<{
      agentId: AgentId;
      proposalId: AllianceProposalId;
    }> = [];
    const leaveAvailableAgentIds: AgentId[] = [];
    const blockedCounts = new Map<string, number>();
    const blockers: Array<{
      proposerId: AgentId;
      recipientId: AgentId;
      reason:
        | 'current-ally'
        | 'out-of-range'
        | 'outgoing-proposal-exists'
        | 'incoming-proposal-exists'
        | 'alliance-to-alliance-merge';
    }> = [];
    for (const proposerAgentId of [...this.#state.agents.keys()].toSorted()) {
      const availability = this.#diplomacyAvailability(
        proposerAgentId,
        WORLD_SCENARIO_LIMITS.maximumAgents,
      );
      for (const recipientAgentId of availability.propose
        .eligibleRecipientAgentIds)
        eligiblePairs.push({
          proposerId: proposerAgentId,
          recipientId: recipientAgentId,
        });
      for (const blocked of availability.propose.blockedRecipients) {
        blockedCounts.set(
          blocked.reason,
          (blockedCounts.get(blocked.reason) ?? 0) + 1,
        );
        blockers.push({
          proposerId: proposerAgentId,
          recipientId: blocked.agentId,
          reason: blocked.reason,
        });
      }
      for (const proposalId of availability.accept.acceptableProposalIds)
        acceptableProposals.push({
          agentId: proposerAgentId,
          proposalId,
        });
      if (availability.leave.available)
        leaveAvailableAgentIds.push(proposerAgentId);
    }
    const blockerPriority = [
      'out-of-range',
      'alliance-to-alliance-merge',
      'current-ally',
      'incoming-proposal-exists',
      'outgoing-proposal-exists',
    ] as const;
    blockers.sort(
      (a, b) =>
        blockerPriority.indexOf(a.reason) - blockerPriority.indexOf(b.reason) ||
        a.proposerId.localeCompare(b.proposerId) ||
        a.recipientId.localeCompare(b.recipientId),
    );
    const displayedEligiblePairs: typeof eligiblePairs = [];
    const proposerBuckets = [...this.#state.agents.keys()]
      .toSorted()
      .map((proposerAgentId) => ({
        proposerAgentId,
        recipientAgentIds: eligiblePairs
          .filter((pair) => pair.proposerId === proposerAgentId)
          .map(({ recipientId }) => recipientId),
      }))
      .filter(({ recipientAgentIds }) => recipientAgentIds.length > 0);
    if (proposerBuckets.length) {
      const offset =
        (this.#completedTickCount *
          PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.displayedEligiblePairs) %
        proposerBuckets.length;
      const rotated = [
        ...proposerBuckets.slice(offset),
        ...proposerBuckets.slice(0, offset),
      ];
      for (
        let recipientIndex = 0;
        displayedEligiblePairs.length <
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.displayedEligiblePairs;
        recipientIndex += 1
      ) {
        let added = false;
        for (const bucket of rotated) {
          const recipientAgentId = bucket.recipientAgentIds[recipientIndex];
          if (!recipientAgentId) continue;
          displayedEligiblePairs.push({
            proposerId: bucket.proposerAgentId,
            recipientId: recipientAgentId,
          });
          added = true;
          if (
            displayedEligiblePairs.length ===
            PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.displayedEligiblePairs
          )
            break;
        }
        if (!added) break;
      }
    }
    return {
      eligiblePairCount: eligiblePairs.length,
      displayedEligiblePairs,
      eligiblePairsTruncated:
        eligiblePairs.length > displayedEligiblePairs.length,
      acceptableProposals: acceptableProposals.slice(
        0,
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.acceptableProposals,
      ),
      acceptableProposalCount: acceptableProposals.length,
      acceptableProposalsTruncated:
        acceptableProposals.length >
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.acceptableProposals,
      leaveAvailableAgentIds: leaveAvailableAgentIds.slice(
        0,
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.leaveAvailableAgentIds,
      ),
      leaveAvailableCount: leaveAvailableAgentIds.length,
      leaveAvailableTruncated:
        leaveAvailableAgentIds.length >
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.leaveAvailableAgentIds,
      blockedCounts: blockerPriority.flatMap((reason) => {
        const count = blockedCounts.get(reason);
        return count ? [{ reason, count }] : [];
      }),
      blockerExamples: blockers.slice(
        0,
        PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.blockerExamples,
      ),
    };
  }

  #territoryScoreboard() {
    const counts = new Map<AgentId, number>(
      [...this.#state.agents.keys()].map((id) => [id, 0]),
    );
    for (const hex of this.#state.hexes.values()) {
      if (hex.state === 'infected')
        counts.set(
          hex.controllerAgentId,
          (counts.get(hex.controllerAgentId) ?? 0) + 1,
        );
    }
    return [...this.#state.agents.values()].map(({ id, name, color }) => ({
      agentId: id,
      name,
      color,
      allianceId: getAgentAlliance(this.#state, id)?.id ?? null,
      effectiveColor: getEffectiveAgentColor(this.#state, id),
      controlledCellCount: counts.get(id) ?? 0,
    }));
  }

  #allianceTerritorySummaries() {
    const scoreboard = this.#territoryScoreboard();
    return [...(this.#state.alliances?.values() ?? [])].map((alliance) => {
      const members = alliance.memberAgentIds.map((agentId) => {
        const entry = scoreboard.find(
          (candidate) => candidate.agentId === agentId,
        );
        if (!entry) throw new Error('An alliance member does not exist.');
        return {
          agentId,
          name: entry.name,
          controlledCellCount: entry.controlledCellCount,
        };
      });
      return {
        allianceId: alliance.id,
        color: alliance.color,
        totalControlledCellCount: members.reduce(
          (sum, member) => sum + member.controlledCellCount,
          0,
        ),
        members,
      };
    });
  }
}

export function selectDiplomacyBlockerExamples<
  T extends { agentId: AgentId; reason: string },
>(
  state: WorldState,
  actingAgentId: AgentId,
  blockers: readonly T[],
  reasonPriority: readonly T['reason'][],
): T[] {
  const actingAlliance = getAgentAlliance(state, actingAgentId);
  const relationshipPriority = (blockedAgentId: AgentId) => {
    const blockedAlliance = getAgentAlliance(state, blockedAgentId);
    if (!actingAlliance) return blockedAlliance ? 1 : 0;
    if (!blockedAlliance) return 0;
    return blockedAlliance.id === actingAlliance.id ? 2 : 1;
  };
  return blockers
    .toSorted(
      (left, right) =>
        relationshipPriority(left.agentId) -
          relationshipPriority(right.agentId) ||
        reasonPriority.indexOf(left.reason) -
          reasonPriority.indexOf(right.reason) ||
        left.agentId.localeCompare(right.agentId),
    )
    .slice(0, 4);
}

function isAllianceEvent(event: WorldEvent): event is AllianceEvent {
  return (
    event.type === 'alliance-proposed' ||
    event.type === 'alliance-proposal-closed' ||
    event.type === 'alliance-formed' ||
    event.type === 'alliance-dissolved' ||
    event.type === 'agent-joined-alliance' ||
    event.type === 'agent-left-alliance'
  );
}

function allianceEventsSince(
  before: WorldState,
  after: WorldState,
): AllianceEvent[] {
  return after.events.slice(before.events.length).filter(isAllianceEvent);
}

function stableOrder(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function gridRingDistance(from: H3Cell, to: H3Cell): number {
  try {
    return gridDistance(from, to);
  } catch {
    return 999;
  }
}

function summarizeEvent(
  event: Extract<
    WorldEvent,
    {
      type: 'agent-moved' | 'hex-infected' | 'hex-captured' | 'agent-waited';
    }
  >,
  state: WorldState,
): string {
  const name = state.agents.get(event.agentId)?.name ?? 'An agent';
  if (event.type === 'agent-moved') return `${name} moved to ${event.toCell}.`;
  if (event.type === 'hex-infected') return `${name} infected ${event.cell}.`;
  if (event.type === 'hex-captured') {
    const previous =
      state.agents.get(event.previousControllerAgentId)?.name ??
      'another agent';
    return `${name} captured ${event.cell} from ${previous}.`;
  }
  return `${name} waited.`;
}

function summarizeAllianceEvent(
  event: AllianceEvent,
  state: WorldState,
): string {
  const name = (id: AgentId) => state.agents.get(id)?.name ?? 'An agent';
  if (event.type === 'alliance-proposed')
    return `${name(event.agentId)} proposed an alliance with ${name(event.recipientAgentId)}.`;
  if (event.type === 'alliance-formed')
    return `${event.memberAgentIds.map(name).join(' and ')} formed an alliance.`;
  if (event.type === 'agent-joined-alliance')
    return `${name(event.joinedAgentId)} joined the alliance.`;
  if (event.type === 'agent-left-alliance')
    return `${name(event.leftAgentId)} left the alliance.`;
  if (event.type === 'alliance-dissolved') return 'The alliance dissolved.';
  return `The proposal from ${name(event.proposerAgentId)} to ${name(event.recipientAgentId)} was ${event.reason}.`;
}

function automaticRetryDelayMs(
  failure: ProviderFailure,
  deadlineAtMs: number,
): number {
  if (failure.code !== 'provider-http' || failure.httpStatus !== 429) return 0;
  const retryAfterMs = failure.retryAfterMs;
  if (retryAfterMs !== undefined && Date.now() + retryAfterMs < deadlineAtMs)
    return retryAfterMs;
  return OPENROUTER_429_FALLBACK_BACKOFF_MS;
}

function waitForRetryBackoff(
  delayMs: number,
  signal: AbortSignal,
  model: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledBackoffError(model));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delayMs);
    const cancel = () => {
      clearTimeout(timeout);
      reject(cancelledBackoffError(model));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function cancelledBackoffError(model: string): AgentProviderError {
  return new AgentProviderError({
    code: 'cancelled',
    message: 'The model request was cancelled by the operator.',
    retryable: false,
    model,
  });
}

function asProviderError(error: unknown): {
  failure: ProviderFailure;
  metadata?: AgentProviderError['metadata'];
} {
  if (error instanceof AgentProviderError) {
    return { failure: error.failure, metadata: error.metadata };
  }
  return {
    failure: {
      code: 'network',
      message: 'The model provider failed unexpectedly.',
      retryable: true,
    },
  };
}

function retainCompleteTickGroups(
  records: AgentTurnRecord[],
  limit: number,
): AgentTurnRecord[] {
  if (records.length <= limit) return records;
  const groups = new Map<number, AgentTurnRecord[]>();
  for (const record of records) {
    const key = record.tickNumber ?? record.turnNumber;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const retained: AgentTurnRecord[] = [];
  for (const group of [...groups.values()].reverse()) {
    if (retained.length > 0 && retained.length + group.length > limit) break;
    retained.unshift(...group);
  }
  return retained;
}

export function applyGoalRevision(
  current: AgentGoalState | undefined,
  requested: RequestedGoalRevision | undefined,
  tick: number,
): { goal: AgentGoalState | undefined; result: GoalRevisionResult } {
  if (!requested) return { goal: current, result: { requested: false } };
  if (requested.operation === 'establish') {
    if (current)
      return {
        goal: current,
        result: {
          requested: true,
          accepted: false,
          operation: requested.operation,
          reason: 'goal-already-active',
        },
      };
    return {
      goal: {
        longTermGoal: requested.longTermGoal,
        shortTermGoal: requested.shortTermGoal,
        planSummary: requested.planSummary,
        establishedAtTick: tick,
        revisedAtTick: tick,
      },
      result: {
        requested: true,
        accepted: true,
        operation: requested.operation,
      },
    };
  }
  if (!current)
    return {
      goal: undefined,
      result: {
        requested: true,
        accepted: false,
        operation: requested.operation,
        reason: 'goal-not-active',
      },
    };
  if (requested.operation === 'keep')
    return {
      goal: current,
      result: {
        requested: true,
        accepted: true,
        operation: requested.operation,
      },
    };
  if (requested.operation === 'revise')
    return {
      goal: {
        longTermGoal: requested.longTermGoal,
        shortTermGoal: requested.shortTermGoal,
        planSummary: requested.planSummary,
        establishedAtTick: current.establishedAtTick,
        revisedAtTick: tick,
      },
      result: {
        requested: true,
        accepted: true,
        operation: requested.operation,
      },
    };
  return {
    goal: undefined,
    result: { requested: true, accepted: true, operation: requested.operation },
  };
}
