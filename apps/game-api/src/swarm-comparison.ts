import {
  ReflexProviderError,
  type PlannerOptions,
  type ReflexDecisionOptions,
  type ReflexProvider,
  type SwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  assignBehavior,
  reflexDecisionSchema,
  type CompatibleModel,
  type ProviderMetadata,
  type ReflexObservation,
  type SwarmPlan,
  type ZeroStrategicObservation,
} from '@hexzero/shared';
import { gridDistance } from 'h3-js';
import { generateDeterministicRoster } from '@hexzero/world-engine';
import { SimulationService } from './simulation-service';
import type { CompiledReflexObservation } from './reflex-execution';

export type OfflineComparisonVariant =
  'zero-swarm-jev' | 'zero-swarm-deterministic-workers';

export interface OfflineComparisonOptions {
  /** Defaults include a known deterministic capture case. */
  seeds?: readonly string[];
  /** Bounded to protect the offline experiment surface from accidental large runs. */
  tickCap?: number;
}

export interface OfflineComparisonTickSample {
  tick: number;
  infectedCells: number;
  controlledCells: number;
  abandonedCells: number;
  activeAgents: number;
  capturesThisTick: number;
  disinfectionsThisTick: number;
  terminalStatus: string | null;
  attemptsStarted: number;
  attemptsFinalized: number;
  syntheticInputTokens: number;
  syntheticOutputTokens: number;
  syntheticLatencyMs: number;
  generativeAttempts: number;
  zeroPlans: number;
  reflexDecisions: number;
  workerStalls: number;
  replanSignals: number;
  reflexConfidence: readonly number[];
  reflexProbabilityDistributions: readonly Readonly<Record<string, number>>[];
}

export interface OfflineComparisonRun {
  seed: string;
  samples: readonly OfflineComparisonTickSample[];
  final: {
    tick: number;
    infectedCells: number;
    controlledCells: number;
    abandonedCells: number;
    activeAgents: number;
    captures: number;
    disinfections: number;
    terminalStatus: string | null;
  };
  providerAttempts: { started: number; finalized: number };
}

export interface OfflineComparisonAggregate {
  runCount: number;
  totalProviderAttempts: number;
  totalGenerativeAttempts: number;
  totalReflexAttempts: number;
  totalSyntheticInputTokens: number;
  totalSyntheticOutputTokens: number;
  totalSyntheticLatencyMs: number;
  totalCaptures: number;
  totalDisinfections: number;
  totalWorkerStalls: number;
  totalReplanSignals: number;
  terminalRuns: number;
}

export interface OfflineComparisonVariantReport {
  variant: OfflineComparisonVariant;
  providerKind: string;
  runs: readonly OfflineComparisonRun[];
  aggregate: OfflineComparisonAggregate;
}

export interface OfflineComparisonReport {
  formatVersion: 1;
  kind: 'offline-deterministic-comparison';
  seeds: readonly string[];
  tickCap: number;
  providerDisclaimer: string;
  costDisclaimer: string;
  variants: readonly OfflineComparisonVariantReport[];
}

const DEFAULT_SEEDS = [
  'worker-capture-spawn',
  'comparison-seed-b',
  'comparison-seed-c',
];
const DEFAULT_TICK_CAP = 12;
const MAX_TICK_CAP = 60;
const model: CompatibleModel = {
  id: 'offline/comparison-model',
  name: 'Offline comparison model',
  author: 'Hex Zero',
  contextLength: 4_096,
  inputPricePerToken: '0',
  outputPricePerToken: '0',
  supportedParameters: [],
  isFree: true,
  reasoning: { mandatory: false, supportedEfforts: ['low'] },
};

const metadata = (modelId: string): ProviderMetadata => ({
  provider: 'scripted-test',
  model: modelId,
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  costCredits: 0,
});

class OfflinePlanner implements SwarmPlanner {
  readonly mode = 'scripted-swarm-test' as const;
  readonly configured = true;
  async plan(
    observation: ZeroStrategicObservation,
    selectedModel: string,
    options: PlannerOptions = {},
  ) {
    const finalize = options.beginAttempt?.('initial');
    if (finalize === null)
      throw new Error('Offline planner could not obtain an attempt permit.');
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
      observation.legalZeroActions[0]!;
    const openTargets = observation.strategicTargetCells.filter((cell) =>
      observation.cells.some(
        ({ cell: knownCell, state }) => knownCell === cell && state === 'open',
      ),
    );
    const plan: SwarmPlan = {
      strategySummary: 'Deterministic offline perimeter expansion.',
      zeroActionCandidateId: zeroAction.id,
      directives: observation.agents
        .filter(({ agentId }) => agentId !== observation.zeroAgentId)
        .map((agent, index) => {
          const openTarget = nearestTarget(agent.position, openTargets);
          return {
            id: `offline-${observation.tickNumber}-${index}`,
            agentId: agent.agentId,
            mission: openTarget ? ('expand' as const) : ('hold' as const),
            targetCell: openTarget ?? agent.position,
            priority: 'normal' as const,
            riskTolerance: 'medium' as const,
            issuedAtTick: observation.tickNumber,
            // PR D cadence: directives normally cover five ticks, with events
            // still able to bring Zero back sooner.
            expiresAtTick: observation.tickNumber + 4,
          };
        }),
    };
    finalize?.({
      outcome: 'completed',
      provider: metadata(selectedModel),
      swarmPlan: plan,
    });
    return { plan, metadata: metadata(selectedModel) };
  }
}

function nearestTarget(
  position: ZeroStrategicObservation['agents'][number]['position'],
  targets: readonly ZeroStrategicObservation['strategicTargetCells'][number][],
) {
  return [...targets].sort((left, right) => {
    const leftDistance = safeDistance(position, left);
    const rightDistance = safeDistance(position, right);
    return leftDistance - rightDistance || left.localeCompare(right);
  })[0];
}

function safeDistance(left: string, right: string): number {
  try {
    return gridDistance(left, right);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Select from the server's opaque legal candidate map without a provider call. */
function selectGreedyCandidate(compiled: CompiledReflexObservation): string {
  return (compiled.observation.candidates.find(({ description }) =>
    description.startsWith('Infect'),
  ) ??
    compiled.observation.candidates.find(({ description }) =>
      description.includes('open territory'),
    ) ??
    compiled.observation.candidates[0])!.id;
}

class OfflineReflex implements ReflexProvider {
  readonly mode = 'scripted-reflex-test' as const;
  readonly configured = true;
  readonly model: string;
  constructor(private readonly strategy: 'semantic' | 'greedy') {
    this.model = `offline-${strategy}-reflex`;
  }

  async decide(
    observation: ReflexObservation,
    options: ReflexDecisionOptions = {},
  ) {
    const finalize = options.beginAttempt?.('initial');
    if (finalize === null)
      throw new ReflexProviderError({
        code: 'budget-exhausted',
        message: 'Offline reflex could not obtain an attempt permit.',
        retryable: false,
      });
    const candidates = observation.candidates;
    const selected =
      this.strategy === 'semantic'
        ? (candidates.find(({ description }) =>
            description.startsWith('Infect'),
          ) ??
          candidates.find(({ description }) =>
            description.includes('advances toward'),
          ) ??
          candidates.find(({ description }) =>
            description.startsWith('Remain'),
          ) ??
          candidates[0])
        : (candidates.find(({ description }) =>
            description.startsWith('Infect'),
          ) ??
          candidates.find(({ description }) =>
            description.includes('open territory'),
          ) ??
          candidates[0]);
    if (!selected)
      throw new Error('Offline reflex received no legal candidates.');
    const remainder =
      candidates.length > 1 ? 0.25 / (candidates.length - 1) : 0;
    const probabilities = Object.fromEntries(
      candidates.map(({ id }) => [id, id === selected.id ? 0.75 : remainder]),
    );
    // Correct the single-candidate case while retaining an exact distribution.
    if (candidates.length === 1) probabilities[selected.id] = 1;
    const decision = reflexDecisionSchema.parse({
      chosenCandidateId: selected.id,
      confidence: candidates.length === 1 ? 1 : 0.75,
      probabilities,
      replanProbability:
        observation.currentSituation.directiveProgress === 'blocked'
          ? 0.85
          : 0.05,
      model: this.model,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      directiveId: observation.directive.id,
      cognitionSource: 'jev-reflex',
    });
    finalize?.({
      outcome: 'completed',
      provider: metadata(this.model),
      reflexDecision: decision,
    });
    return decision;
  }
}

function deterministicIds(prefix: string) {
  let sequence = 0;
  return () =>
    `00000000-0000-4000-8000-${prefix}${String(++sequence).padStart(11, '0')}`;
}

function territory(snapshot: ReturnType<SimulationService['getSnapshot']>) {
  const infected = snapshot.world.hexes.filter(
    ({ state }) => state === 'infected',
  );
  return {
    infectedCells: infected.length,
    controlledCells: infected.filter(
      ({ controllerAgentId }) => controllerAgentId !== null,
    ).length,
    abandonedCells: infected.filter(
      ({ controllerAgentId }) => controllerAgentId === null,
    ).length,
  };
}

function sample(
  snapshot: ReturnType<SimulationService['getSnapshot']>,
): OfflineComparisonTickSample {
  const playerEvents = snapshot.world.events.filter(
    (
      event,
    ): event is Extract<
      (typeof snapshot.world.events)[number],
      {
        type:
          | 'simulated-player-moved'
          | 'hex-disinfected'
          | 'simulated-player-clean-blocked'
          | 'simulated-player-agent-captured';
      }
    > =>
      (event.type === 'simulated-player-moved' ||
        event.type === 'hex-disinfected' ||
        event.type === 'simulated-player-clean-blocked' ||
        event.type === 'simulated-player-agent-captured') &&
      event.originatingTick === snapshot.tickNumber,
  );
  const latestSwarm = snapshot.swarmTicks?.at(-1);
  const swarm =
    latestSwarm?.tickNumber === snapshot.tickNumber ? latestSwarm : undefined;
  const reflex =
    swarm?.workers.flatMap(({ reflexDecision }) =>
      reflexDecision ? [reflexDecision] : [],
    ) ?? [];
  const providerMetadata = [
    ...(swarm?.plannerMetadata ? [swarm.plannerMetadata] : []),
    ...reflex.map(({ latencyMs, inputTokens, outputTokens, model }) => ({
      ...metadata(model),
      latencyMs,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    })),
  ];
  return {
    tick: snapshot.tickNumber,
    ...territory(snapshot),
    activeAgents: snapshot.world.agents.length,
    capturesThisTick: playerEvents.filter(
      ({ type }) => type === 'simulated-player-agent-captured',
    ).length,
    disinfectionsThisTick: playerEvents.filter(
      ({ type }) => type === 'hex-disinfected',
    ).length,
    terminalStatus:
      snapshot.status === 'patient-zero-captured' ||
      snapshot.status === 'infection-eliminated'
        ? snapshot.status
        : null,
    attemptsStarted: snapshot.experiment.attemptAccounting.attemptsStarted,
    attemptsFinalized: snapshot.experiment.attemptAccounting.attemptsFinalized,
    syntheticInputTokens: providerMetadata.reduce(
      (total, item) => total + (item.promptTokens ?? 0),
      0,
    ),
    syntheticOutputTokens: providerMetadata.reduce(
      (total, item) => total + (item.completionTokens ?? 0),
      0,
    ),
    syntheticLatencyMs: providerMetadata.reduce(
      (total, item) => total + item.latencyMs,
      0,
    ),
    generativeAttempts: swarm?.planSource === 'zero-llm' ? 1 : 0,
    zeroPlans: swarm?.planSource === 'zero-llm' ? 1 : 0,
    reflexDecisions: reflex.length,
    workerStalls:
      swarm?.workers.filter(
        (worker) =>
          worker.actionResult?.accepted === false ||
          (worker.action?.type === 'wait' &&
            worker.directive.mission !== 'hold'),
      ).length ?? 0,
    replanSignals: swarm?.signals?.length ?? 0,
    reflexConfidence: reflex.map(({ confidence }) => confidence),
    reflexProbabilityDistributions: reflex.map(
      ({ probabilities }) => probabilities,
    ),
  };
}

function createService(variant: OfflineComparisonVariant, seed: string) {
  const planner = new OfflinePlanner();
  const service = new SimulationService({
    swarmPlanner: planner,
    // Kept for the ordinary swarm variant and snapshot provider status. The
    // deterministic baseline uses the explicit server-side selector below and
    // never invokes this provider.
    reflexProvider: new OfflineReflex('semantic'),
    ...(variant === 'zero-swarm-deterministic-workers'
      ? { deterministicWorkerCandidateSelector: selectGreedyCandidate }
      : {}),
    now: () => '2026-08-13T12:00:00.000Z',
    createEventId: deterministicIds('1'),
    createExperimentId: deterministicIds('2'),
  });
  service.setCompatibleModels([model]);
  const request = service.getDefaultWorldSetup();
  // Preserve the original comparison shape: one Zero and seven workers.
  const roster = generateDeterministicRoster(8, 'worker-capture-roster');
  service.applyWorldSetup({
    ...request,
    roster,
    patientZeroAgentId: roster[1]!.id,
    worldSeed: `offline-world-${seed}`,
    spawnSeed: seed,
    objectiveVersion: 'durable-influence-v3',
    capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
    simulatedPlayer: { enabled: true, profile: 'trail-hunter-v1', seed },
    modelConfiguration: {
      globalModelId: model.id,
      globalReasoningProfile: 'low',
      overrides: [],
      locked: false,
    },
    // This transitional scenario field remains required until PR 2 removes
    // legacy behavior configuration from the shared world setup schema.
    behaviorConfiguration: {
      ...request.behaviorConfiguration,
      assignments: assignBehavior(
        roster.map(({ id }) => id),
        `offline-behavior-${seed}`,
        'balanced-random',
      ),
    },
  });
  return service;
}

async function runVariant(
  variant: OfflineComparisonVariant,
  seed: string,
  tickCap: number,
): Promise<OfflineComparisonRun> {
  const service = createService(variant, seed);
  const samples: OfflineComparisonTickSample[] = [];
  for (let tick = 0; tick < tickCap; tick += 1) {
    const before = service.getSnapshot();
    if (
      before.status === 'patient-zero-captured' ||
      before.status === 'infection-eliminated'
    )
      break;
    await service.executeNextTick();
    samples.push(sample(service.getSnapshot()));
  }
  const snapshot = service.getSnapshot();
  const latest = samples.at(-1);
  const captures = samples.reduce(
    (total, entry) => total + entry.capturesThisTick,
    0,
  );
  const disinfections = samples.reduce(
    (total, entry) => total + entry.disinfectionsThisTick,
    0,
  );
  return {
    seed,
    samples,
    final: {
      tick: snapshot.tickNumber,
      ...territory(snapshot),
      activeAgents: snapshot.world.agents.length,
      captures,
      disinfections,
      terminalStatus: latest?.terminalStatus ?? null,
    },
    providerAttempts: {
      started: snapshot.experiment.attemptAccounting.attemptsStarted,
      finalized: snapshot.experiment.attemptAccounting.attemptsFinalized,
    },
  };
}

function aggregate(
  runs: readonly OfflineComparisonRun[],
): OfflineComparisonAggregate {
  const samples = runs.flatMap(({ samples: entries }) => entries);
  return {
    runCount: runs.length,
    totalProviderAttempts: runs.reduce(
      (total, run) => total + run.providerAttempts.started,
      0,
    ),
    totalGenerativeAttempts: samples.reduce(
      (total, entry) => total + entry.generativeAttempts,
      0,
    ),
    totalReflexAttempts: samples.reduce(
      (total, entry) => total + entry.reflexDecisions,
      0,
    ),
    totalSyntheticInputTokens: samples.reduce(
      (total, entry) => total + entry.syntheticInputTokens,
      0,
    ),
    totalSyntheticOutputTokens: samples.reduce(
      (total, entry) => total + entry.syntheticOutputTokens,
      0,
    ),
    totalSyntheticLatencyMs: samples.reduce(
      (total, entry) => total + entry.syntheticLatencyMs,
      0,
    ),
    totalCaptures: runs.reduce((total, run) => total + run.final.captures, 0),
    totalDisinfections: runs.reduce(
      (total, run) => total + run.final.disinfections,
      0,
    ),
    totalWorkerStalls: samples.reduce(
      (total, entry) => total + entry.workerStalls,
      0,
    ),
    totalReplanSignals: samples.reduce(
      (total, entry) => total + entry.replanSignals,
      0,
    ),
    terminalRuns: runs.filter(({ final }) => final.terminalStatus !== null)
      .length,
  };
}

/** Run the Jev and deterministic-worker variants without a network call. */
export async function runOfflineComparison(
  options: OfflineComparisonOptions = {},
): Promise<OfflineComparisonReport> {
  const seeds = [...(options.seeds ?? DEFAULT_SEEDS)];
  const tickCap = options.tickCap ?? DEFAULT_TICK_CAP;
  if (!seeds.length || seeds.some((seed) => !seed.trim()))
    throw new Error('Offline comparison requires at least one non-empty seed.');
  if (!Number.isInteger(tickCap) || tickCap < 1 || tickCap > MAX_TICK_CAP)
    throw new Error(
      `tickCap must be an integer between 1 and ${MAX_TICK_CAP}.`,
    );
  const variants: OfflineComparisonVariant[] = [
    'zero-swarm-jev',
    'zero-swarm-deterministic-workers',
  ];
  return {
    formatVersion: 1,
    kind: 'offline-deterministic-comparison',
    seeds,
    tickCap,
    providerDisclaimer:
      'All providers in this report are deterministic offline fakes. Token and latency fields describe only fake-provider telemetry, never live inference usage.',
    costDisclaimer:
      'Fake-provider costCredits are accounting fixtures only. This report contains no authoritative billed monetary cost.',
    variants: await Promise.all(
      variants.map(async (variant) => {
        const runs = await Promise.all(
          seeds.map((seed) => runVariant(variant, seed, tickCap)),
        );
        return {
          variant,
          providerKind:
            variant === 'zero-swarm-jev'
              ? 'OfflinePlanner + semantic OfflineReflex'
              : 'OfflinePlanner + deterministic legal-candidate selector',
          runs,
          aggregate: aggregate(runs),
        };
      }),
    ),
  };
}
