import { type ReflexProvider, type SwarmPlanner } from '@hexzero/agent-runtime';
import { type CompatibleModel } from '@hexzero/shared';
import { generateDeterministicRoster } from '@hexzero/world-engine';
import { SimulationService } from './simulation-service';
import type { CompiledReflexObservation } from './reflex-execution';

export type LiveComparisonVariant =
  'live-zero-jev' | 'live-zero-deterministic-workers';

/** All limits are deliberately small: this is an opt-in observation run. */
export interface LiveComparisonConfig {
  confirmed: true;
  modelId: string;
  seeds: readonly string[];
  tickCap: number;
  agentCount: number;
  providerAttemptLimit: number;
  creditLimit: string;
  reservationCreditsPerAttempt: string;
}

export interface LiveComparisonProviders {
  createPlanner(): SwarmPlanner;
  createReflex(): ReflexProvider;
}

export interface LiveComparisonTick {
  tick: number;
  activeWorkers: number;
  captures: number;
  patientZeroCaptured: boolean;
  terminalOutcome: string | null;
  infectedCells: number;
  controlledCells: number;
  territoryGained: number;
  territoryLost: number;
  disinfections: number;
  workerStalls: number;
  directiveProgress: Record<string, number>;
  workerReplanSignals: number;
  zeroReplans: number;
  zeroReplanReasons: readonly string[];
  zeroPlanningAttempts: number;
  jevAttempts: number;
  jevFallbacks: number;
  jevConfidence: readonly number[];
  jevActionProbabilities: readonly Readonly<Record<string, number>>[];
  jevReplanProbabilities: readonly number[];
  providerLatencyMs: number;
  openRouterTokens: { prompt: number; completion: number; total: number };
  typeSafeTokens: { input: number; output: number };
  actualOpenRouterCostCredits: string | null;
  unknownProviderCostAttempts: number;
  unknownTypeSafeCostAttempts: number;
}

export interface LiveComparisonRun {
  seed: string;
  ticks: readonly LiveComparisonTick[];
  final: {
    tick: number;
    activeWorkers: number;
    captures: number;
    patientZeroCaptured: boolean;
    terminalOutcome: string | null;
    stoppedReason?:
      'tick-cap' | 'terminal' | 'budget-exhausted' | 'execution-error';
    infectedCells: number;
    controlledCells: number;
  };
  effort: {
    zeroPlanningAttempts: number;
    jevAttempts: number;
    jevFallbacks: number;
    openRouterTokens: {
      prompt: number;
      completion: number;
      total: number;
      unknownFields: readonly string[];
    };
    typeSafeTokens: {
      input: number;
      output: number;
      unknownFields: readonly string[];
    };
    providerLatencyMs: number;
    actualOpenRouterCostCredits: string | null;
    unknownProviderCostAttempts: number;
    typeSafeCostCredits: null;
    unknownTypeSafeCostAttempts: number;
    attemptsWithoutCommittedTick: number;
  };
  attemptAccounting: {
    started: number;
    finalized: number;
    exhausted: boolean;
    exhaustionReason: string | null;
  };
}

export interface LiveComparisonVariantReport {
  variant: LiveComparisonVariant;
  runs: readonly LiveComparisonRun[];
  aggregate: {
    runCount: number;
    captures: number;
    patientZeroCapturedRuns: number;
    terminalRuns: number;
    finalActiveWorkers: number;
    finalControlledCells: number;
    disinfections: number;
    territoryGained: number;
    territoryLost: number;
    workerStalls: number;
    workerReplanSignals: number;
    zeroReplans: number;
    zeroPlanningAttempts: number;
    jevAttempts: number;
    jevFallbacks: number;
    openRouterTokens: { prompt: number; completion: number; total: number };
    typeSafeTokens: { input: number; output: number };
    providerLatencyMs: number;
    meanJevConfidence: number | null;
    meanJevReplanProbability: number | null;
    actualOpenRouterCostCredits: string | null;
    unknownProviderCostAttempts: number;
    unknownTypeSafeCostAttempts: number;
    attemptsWithoutCommittedTick: number;
  };
}

export interface LiveComparisonReport {
  formatVersion: 1;
  kind: 'live-zero-swarm-jev-ablation';
  configuration: {
    modelId: string;
    seeds: readonly string[];
    tickCap: number;
    agentCount: number;
    swarmArchitectureVersion: 'zero-swarm-v1';
    trailHunterProfile: 'trail-hunter-v1';
    rosterSeed: 'worker-capture-roster';
    patientZeroRosterIndex: 1;
    worldSeedPattern: 'offline-world-{seed}';
    planningPolicy: 'zero-swarm-v1-service-default';
    objectiveVersion: 'durable-influence-v3';
    executionLimits: Pick<
      LiveComparisonConfig,
      'providerAttemptLimit' | 'creditLimit' | 'reservationCreditsPerAttempt'
    >;
    reproducibility: 'reproducible-input; provider output is nondeterministic';
  };
  providerCostNote: 'OpenRouter cost is provider-reported when available; TypeSafe monetary cost is unknown.';
  variants: readonly LiveComparisonVariantReport[];
}

const LIMITS = {
  seeds: 5,
  ticks: 30,
  agents: 8,
  attempts: 300,
  credits: 10,
  reservation: 0.5,
} as const;

const selector = (compiled: CompiledReflexObservation): string =>
  (compiled.observation.candidates.find(({ description }) =>
    description.startsWith('Infect'),
  ) ??
    compiled.observation.candidates.find(({ description }) =>
      description.includes('open territory'),
    ) ??
    compiled.observation.candidates[0])!.id;

const modelFor = (id: string): CompatibleModel => ({
  id,
  name: id,
  author: 'operator-selected',
  contextLength: 16_384,
  inputPricePerToken: '0',
  outputPricePerToken: '0',
  supportedParameters: [],
  isFree: false,
  reasoning: { mandatory: false, supportedEfforts: ['low'] },
});

function decimal(value: string, label: string, maximum: number): void {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) ||
    value.length > 80 ||
    !/[1-9]/u.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) > maximum
  )
    throw new Error(`${label} must be a decimal no greater than ${maximum}.`);
}

function validate(config: LiveComparisonConfig): void {
  if (config.confirmed !== true)
    throw new Error(
      'Live comparison requires explicit provider-cost confirmation.',
    );
  if (
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/u.test(config.modelId) ||
    config.modelId.length > 200
  )
    throw new Error('Live comparison requires a safe explicit modelId.');
  if (
    !config.seeds.length ||
    config.seeds.length > LIMITS.seeds ||
    config.seeds.some(
      (seed) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(seed),
    ) ||
    new Set(config.seeds).size !== config.seeds.length
  )
    throw new Error(
      `seeds must contain 1-${LIMITS.seeds} unique non-empty values.`,
    );
  for (const [name, value, minimum, maximum] of [
    ['tickCap', config.tickCap, 1, LIMITS.ticks],
    ['agentCount', config.agentCount, 2, LIMITS.agents],
    ['providerAttemptLimit', config.providerAttemptLimit, 1, LIMITS.attempts],
  ] as const)
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(
        `${name} must be an integer between ${minimum} and ${maximum}.`,
      );
  decimal(config.creditLimit, 'creditLimit', LIMITS.credits);
  decimal(
    config.reservationCreditsPerAttempt,
    'reservationCreditsPerAttempt',
    LIMITS.reservation,
  );
}

function ids(prefix: string) {
  let value = 0;
  return () =>
    `00000000-0000-4000-8000-${prefix}${String(++value).padStart(11, '0')}`;
}

function territory(snapshot: ReturnType<SimulationService['getSnapshot']>) {
  const infected = snapshot.world.hexes.filter(
    (cell) => cell.state === 'infected',
  );
  return {
    infectedCells: infected.length,
    controlledCells: infected.filter((cell) => cell.controllerAgentId !== null)
      .length,
  };
}

function tickSample(
  snapshot: ReturnType<SimulationService['getSnapshot']>,
  zeroId: string,
  baseline: boolean,
  previousControlledCells: number,
): LiveComparisonTick {
  const swarm = snapshot.swarmTicks?.at(-1);
  const current = swarm?.tickNumber === snapshot.tickNumber ? swarm : undefined;
  const events = snapshot.world.events.filter(
    (event) =>
      'originatingTick' in event &&
      event.originatingTick === snapshot.tickNumber,
  );
  const workers = current?.workers ?? [];
  const reflexes = workers.flatMap((worker) =>
    worker.reflexDecision ? [worker.reflexDecision] : [],
  );
  const directiveProgress: Record<string, number> = {};
  for (const worker of workers) {
    const progress = worker.situation?.directiveProgress ?? 'unknown';
    directiveProgress[progress] = (directiveProgress[progress] ?? 0) + 1;
  }
  const metadata = [
    current?.plannerMetadata,
    ...reflexes.map((decision) => ({ latencyMs: decision.latencyMs })),
  ].filter(Boolean) as { latencyMs: number }[];
  return {
    tick: snapshot.tickNumber,
    activeWorkers: snapshot.world.agents.filter((agent) => agent.id !== zeroId)
      .length,
    captures: events.filter(
      (event) => event.type === 'simulated-player-agent-captured',
    ).length,
    patientZeroCaptured: snapshot.status === 'patient-zero-captured',
    terminalOutcome: ['patient-zero-captured', 'infection-eliminated'].includes(
      snapshot.status,
    )
      ? snapshot.status
      : null,
    ...territory(snapshot),
    territoryGained: Math.max(
      0,
      territory(snapshot).controlledCells - previousControlledCells,
    ),
    territoryLost: Math.max(
      0,
      previousControlledCells - territory(snapshot).controlledCells,
    ),
    disinfections: events.filter((event) => event.type === 'hex-disinfected')
      .length,
    workerStalls: workers.filter(
      (worker) =>
        worker.actionResult?.accepted === false ||
        (worker.action?.type === 'wait' && worker.directive.mission !== 'hold'),
    ).length,
    directiveProgress,
    workerReplanSignals: current?.signals?.length ?? 0,
    zeroReplans:
      current?.planSource === 'zero-llm' && snapshot.tickNumber > 1 ? 1 : 0,
    zeroReplanReasons: current?.replanReasons ?? [],
    zeroPlanningAttempts: current?.planSource === 'zero-llm' ? 1 : 0,
    jevAttempts: reflexes.length,
    jevFallbacks: baseline
      ? 0
      : workers.filter((worker) => worker.source !== 'jev-reflex').length,
    jevConfidence: reflexes.map((decision) => decision.confidence),
    jevActionProbabilities: reflexes.map((decision) => decision.probabilities),
    jevReplanProbabilities: reflexes.flatMap((decision) =>
      decision.replanProbability === undefined
        ? []
        : [decision.replanProbability],
    ),
    providerLatencyMs: metadata.reduce(
      (total, entry) => total + entry.latencyMs,
      0,
    ),
    openRouterTokens: { prompt: 0, completion: 0, total: 0 },
    typeSafeTokens: { input: 0, output: 0 },
    actualOpenRouterCostCredits: null,
    unknownProviderCostAttempts: 0,
    unknownTypeSafeCostAttempts: 0,
  };
}

function exportRequest() {
  return {
    agents: { mode: 'all' },
    turns: { mode: 'entire-retained' },
    outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
    actions: ['move', 'infect', 'capture', 'wait'],
    serialization: 'compact',
    level: 'full-safe',
  } as const;
}

function addDecimal(left: string, right: string): string {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const integer = (whole: string, fraction: string) =>
    BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  const raw = (
    integer(leftWhole!, leftFraction) + integer(rightWhole!, rightFraction)
  )
    .toString()
    .padStart(scale + 1, '0');
  return scale === 0
    ? raw
    : `${raw.slice(0, -scale)}.${raw.slice(-scale)}`
        .replace(/0+$/u, '')
        .replace(/\.$/u, '');
}

async function runVariant(
  variant: LiveComparisonVariant,
  seed: string,
  config: LiveComparisonConfig,
  providers: LiveComparisonProviders,
): Promise<LiveComparisonRun> {
  const service = new SimulationService({
    swarmPlanner: providers.createPlanner(),
    reflexProvider: providers.createReflex(),
    ...(variant === 'live-zero-deterministic-workers'
      ? { deterministicWorkerCandidateSelector: selector }
      : {}),
    createEventId: ids('1'),
    createExperimentId: ids('2'),
  });
  service.setCompatibleModels([modelFor(config.modelId)]);
  const request = service.getDefaultWorldSetup();
  const roster = generateDeterministicRoster(
    config.agentCount,
    'worker-capture-roster',
  );
  const zeroAgentId = roster[1]!.id;
  service.applyWorldSetup({
    ...request,
    roster,
    patientZeroAgentId: zeroAgentId,
    worldSeed: `offline-world-${seed}`,
    spawnSeed: seed,
    objectiveVersion: 'durable-influence-v3',
    capabilities: { ...request.capabilities, simulatedPlayerPressure: true },
    simulatedPlayer: { enabled: true, profile: 'trail-hunter-v1', seed },
    executionLimits: {
      version: 'execution-limits-v2',
      providerAttemptLimit: config.providerAttemptLimit,
      creditLimit: config.creditLimit,
      reservationCreditsPerAttempt: config.reservationCreditsPerAttempt,
    },
    modelConfiguration: {
      globalModelId: config.modelId,
      globalReasoningProfile: 'low',
      overrides: [],
      locked: false,
    },
  });
  const ticks: LiveComparisonTick[] = [];
  let stoppedReason: LiveComparisonRun['final']['stoppedReason'] = 'tick-cap';
  for (let index = 0; index < config.tickCap; index += 1) {
    const before = service.getSnapshot();
    if (
      ['patient-zero-captured', 'infection-eliminated'].includes(before.status)
    ) {
      stoppedReason = 'terminal';
      break;
    }
    if (before.status === 'budget-exhausted') {
      stoppedReason = 'budget-exhausted';
      break;
    }
    try {
      await service.executeNextTick();
    } catch {
      stoppedReason =
        service.getSnapshot().status === 'budget-exhausted'
          ? 'budget-exhausted'
          : 'execution-error';
      break;
    }
    ticks.push(
      tickSample(
        service.getSnapshot(),
        zeroAgentId,
        variant === 'live-zero-deterministic-workers',
        territory(before).controlledCells,
      ),
    );
  }
  const snapshot = service.getSnapshot();
  const document = service.generateExperimentExport(exportRequest());
  const attempts = document.providerAttempts ?? [];
  // The roster fixes Zero's identity for the run. This classifies failed
  // attempts too, where a provider may have returned no metadata at all.
  const openRouter = attempts.filter(
    (attempt) => attempt.agentId === zeroAgentId,
  );
  const jev = attempts.filter((attempt) => attempt.agentId !== zeroAgentId);
  const tokenSum = (
    items: typeof attempts,
    field: 'promptTokens' | 'completionTokens' | 'totalTokens',
  ) => items.reduce((total, item) => total + (item.provider?.[field] ?? 0), 0);
  const unknown = (
    items: typeof attempts,
    field: 'promptTokens' | 'completionTokens' | 'totalTokens',
  ) => items.some((item) => item.provider?.[field] === undefined);
  const costs = openRouter.flatMap((attempt) =>
    attempt.actualCostCredits === undefined ? [] : [attempt.actualCostCredits],
  );
  const terminal = ['patient-zero-captured', 'infection-eliminated'].includes(
    snapshot.status,
  )
    ? snapshot.status
    : null;
  for (const tick of ticks) {
    const perTick = attempts.filter(
      (attempt) => attempt.intendedTickNumber === tick.tick,
    );
    const zeroAttempts = perTick.filter(
      (attempt) => attempt.agentId === zeroAgentId,
    );
    const workerAttempts = perTick.filter(
      (attempt) => attempt.agentId !== zeroAgentId,
    );
    tick.zeroPlanningAttempts = zeroAttempts.length;
    tick.jevAttempts = workerAttempts.length;
    tick.providerLatencyMs = perTick.reduce(
      (sum, attempt) =>
        sum + (attempt.provider?.latencyMs ?? attempt.failure?.latencyMs ?? 0),
      0,
    );
    tick.openRouterTokens = {
      prompt: tokenSum(zeroAttempts, 'promptTokens'),
      completion: tokenSum(zeroAttempts, 'completionTokens'),
      total: tokenSum(zeroAttempts, 'totalTokens'),
    };
    tick.typeSafeTokens = {
      input: workerAttempts.reduce(
        (sum, attempt) =>
          sum +
          (attempt.reflexDecision?.inputTokens ??
            attempt.provider?.promptTokens ??
            0),
        0,
      ),
      output: workerAttempts.reduce(
        (sum, attempt) =>
          sum +
          (attempt.reflexDecision?.outputTokens ??
            attempt.provider?.completionTokens ??
            0),
        0,
      ),
    };
    const tickCosts = zeroAttempts.flatMap((attempt) =>
      attempt.actualCostCredits === undefined
        ? []
        : [attempt.actualCostCredits],
    );
    tick.actualOpenRouterCostCredits = tickCosts.length
      ? tickCosts.reduce(addDecimal, '0')
      : null;
    tick.unknownProviderCostAttempts = zeroAttempts.length - tickCosts.length;
    tick.unknownTypeSafeCostAttempts = workerAttempts.length;
  }
  if (terminal) stoppedReason = 'terminal';
  else if (snapshot.status === 'budget-exhausted')
    stoppedReason = 'budget-exhausted';
  return {
    seed,
    ticks,
    final: {
      tick: snapshot.tickNumber,
      activeWorkers: snapshot.world.agents.filter(
        (agent) => agent.id !== zeroAgentId,
      ).length,
      captures: ticks.reduce((sum, tick) => sum + tick.captures, 0),
      patientZeroCaptured: snapshot.status === 'patient-zero-captured',
      terminalOutcome: terminal,
      stoppedReason,
      ...territory(snapshot),
    },
    effort: {
      zeroPlanningAttempts: openRouter.length,
      jevAttempts: jev.length,
      jevFallbacks:
        variant === 'live-zero-deterministic-workers'
          ? 0
          : ticks.reduce((sum, tick) => sum + tick.jevFallbacks, 0),
      openRouterTokens: {
        prompt: tokenSum(openRouter, 'promptTokens'),
        completion: tokenSum(openRouter, 'completionTokens'),
        total: tokenSum(openRouter, 'totalTokens'),
        unknownFields: [
          'promptTokens',
          'completionTokens',
          'totalTokens',
        ].filter((field) => unknown(openRouter, field as 'promptTokens')),
      },
      typeSafeTokens: {
        input: jev.reduce(
          (sum, attempt) =>
            sum +
            (attempt.reflexDecision?.inputTokens ??
              attempt.provider?.promptTokens ??
              0),
          0,
        ),
        output: jev.reduce(
          (sum, attempt) =>
            sum +
            (attempt.reflexDecision?.outputTokens ??
              attempt.provider?.completionTokens ??
              0),
          0,
        ),
        unknownFields: jev.some(
          (attempt) =>
            attempt.reflexDecision === undefined &&
            (attempt.provider?.promptTokens === undefined ||
              attempt.provider?.completionTokens === undefined),
        )
          ? ['inputTokens', 'outputTokens']
          : [],
      },
      providerLatencyMs: attempts.reduce(
        (sum, attempt) =>
          sum +
          (attempt.provider?.latencyMs ?? attempt.failure?.latencyMs ?? 0),
        0,
      ),
      actualOpenRouterCostCredits: costs.length
        ? costs.reduce(addDecimal, '0')
        : null,
      unknownProviderCostAttempts: openRouter.filter(
        (attempt) => attempt.actualCostCredits === undefined,
      ).length,
      typeSafeCostCredits: null,
      unknownTypeSafeCostAttempts: jev.length,
      attemptsWithoutCommittedTick: attempts.filter(
        (attempt) =>
          attempt.intendedTickNumber === undefined ||
          attempt.intendedTickNumber > snapshot.tickNumber,
      ).length,
    },
    attemptAccounting: {
      started: snapshot.experiment.attemptAccounting.attemptsStarted,
      finalized: snapshot.experiment.attemptAccounting.attemptsFinalized,
      exhausted: snapshot.experiment.attemptAccounting.exhausted,
      exhaustionReason: snapshot.experiment.attemptAccounting.exhaustionReason,
    },
  };
}

function aggregate(
  runs: readonly LiveComparisonRun[],
): LiveComparisonVariantReport['aggregate'] {
  const ticks = runs.flatMap((run) => run.ticks);
  const confidences = ticks.flatMap((tick) => tick.jevConfidence);
  const replanProbabilities = ticks.flatMap(
    (tick) => tick.jevReplanProbabilities,
  );
  const costs = runs.flatMap((run) =>
    run.effort.actualOpenRouterCostCredits === null
      ? []
      : [run.effort.actualOpenRouterCostCredits],
  );
  return {
    runCount: runs.length,
    captures: runs.reduce((sum, run) => sum + run.final.captures, 0),
    patientZeroCapturedRuns: runs.filter((run) => run.final.patientZeroCaptured)
      .length,
    terminalRuns: runs.filter((run) => run.final.terminalOutcome !== null)
      .length,
    finalActiveWorkers: runs.reduce(
      (sum, run) => sum + run.final.activeWorkers,
      0,
    ),
    finalControlledCells: runs.reduce(
      (sum, run) => sum + run.final.controlledCells,
      0,
    ),
    disinfections: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.disinfections, 0),
    territoryGained: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.territoryGained, 0),
    territoryLost: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.territoryLost, 0),
    workerStalls: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.workerStalls, 0),
    workerReplanSignals: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.workerReplanSignals, 0),
    zeroReplans: runs
      .flatMap((run) => run.ticks)
      .reduce((sum, tick) => sum + tick.zeroReplans, 0),
    zeroPlanningAttempts: runs.reduce(
      (sum, run) => sum + run.effort.zeroPlanningAttempts,
      0,
    ),
    jevAttempts: runs.reduce((sum, run) => sum + run.effort.jevAttempts, 0),
    jevFallbacks: runs.reduce((sum, run) => sum + run.effort.jevFallbacks, 0),
    openRouterTokens: {
      prompt: runs.reduce(
        (sum, run) => sum + run.effort.openRouterTokens.prompt,
        0,
      ),
      completion: runs.reduce(
        (sum, run) => sum + run.effort.openRouterTokens.completion,
        0,
      ),
      total: runs.reduce(
        (sum, run) => sum + run.effort.openRouterTokens.total,
        0,
      ),
    },
    typeSafeTokens: {
      input: runs.reduce(
        (sum, run) => sum + run.effort.typeSafeTokens.input,
        0,
      ),
      output: runs.reduce(
        (sum, run) => sum + run.effort.typeSafeTokens.output,
        0,
      ),
    },
    providerLatencyMs: runs.reduce(
      (sum, run) => sum + run.effort.providerLatencyMs,
      0,
    ),
    meanJevConfidence: confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null,
    meanJevReplanProbability: replanProbabilities.length
      ? replanProbabilities.reduce((sum, value) => sum + value, 0) /
        replanProbabilities.length
      : null,
    actualOpenRouterCostCredits: costs.length
      ? costs.reduce(addDecimal, '0')
      : null,
    unknownProviderCostAttempts: runs.reduce(
      (sum, run) => sum + run.effort.unknownProviderCostAttempts,
      0,
    ),
    unknownTypeSafeCostAttempts: runs.reduce(
      (sum, run) => sum + run.effort.unknownTypeSafeCostAttempts,
      0,
    ),
    attemptsWithoutCommittedTick: runs.reduce(
      (sum, run) => sum + run.effort.attemptsWithoutCommittedTick,
      0,
    ),
  };
}

/** Runs the primary Jev ablation with real providers supplied by the caller. */
export async function runLiveComparison(
  config: LiveComparisonConfig,
  providers: LiveComparisonProviders,
): Promise<LiveComparisonReport> {
  validate(config);
  const variants: LiveComparisonVariant[] = [
    'live-zero-jev',
    'live-zero-deterministic-workers',
  ];
  const reports: LiveComparisonVariantReport[] = [];
  for (const variant of variants) {
    const runs: LiveComparisonRun[] = [];
    for (const seed of config.seeds)
      runs.push(await runVariant(variant, seed, config, providers));
    reports.push({ variant, runs, aggregate: aggregate(runs) });
  }
  return {
    formatVersion: 1,
    kind: 'live-zero-swarm-jev-ablation',
    configuration: {
      modelId: config.modelId,
      seeds: [...config.seeds],
      tickCap: config.tickCap,
      agentCount: config.agentCount,
      swarmArchitectureVersion: 'zero-swarm-v1',
      trailHunterProfile: 'trail-hunter-v1',
      rosterSeed: 'worker-capture-roster',
      patientZeroRosterIndex: 1,
      worldSeedPattern: 'offline-world-{seed}',
      planningPolicy: 'zero-swarm-v1-service-default',
      objectiveVersion: 'durable-influence-v3',
      executionLimits: {
        providerAttemptLimit: config.providerAttemptLimit,
        creditLimit: config.creditLimit,
        reservationCreditsPerAttempt: config.reservationCreditsPerAttempt,
      },
      reproducibility:
        'reproducible-input; provider output is nondeterministic',
    },
    providerCostNote:
      'OpenRouter cost is provider-reported when available; TypeSafe monetary cost is unknown.',
    variants: reports,
  };
}
