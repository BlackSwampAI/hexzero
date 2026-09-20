#!/usr/bin/env node
import {
  OpenRouterSwarmPlanner,
  TypeSafeJevReflexProvider,
} from '@hexzero/agent-runtime';
import {
  runLiveComparison,
  type LiveComparisonProviders,
  type LiveComparisonReport,
} from './live-swarm-comparison.js';

const DEFAULT_SEEDS = [
  'worker-capture-spawn',
  'comparison-seed-b',
  'comparison-seed-c',
];
const DEFAULT_TICKS = 20;
const DEFAULT_AGENTS = 8;
const DEFAULT_ATTEMPTS = 200;
const DEFAULT_CREDIT_LIMIT = '3';
const DEFAULT_RESERVATION = '0.02';
const MAX_SEEDS = 5;
const MAX_TICKS = 30;
const MAX_AGENTS = 8;
const MAX_ATTEMPTS = 300;
const MAX_CREDIT_LIMIT = 10;
const MAX_RESERVATION = 0.5;
const MAX_SEED_LENGTH = 80;

export interface LiveComparisonCliOptions {
  confirmProviderCosts: boolean;
  model?: string;
  seeds: readonly string[];
  ticks: number;
  agents: number;
  attempts: number;
  creditLimit: string;
  reservation: string;
  summaryFrom?: string;
}

export interface LiveComparisonCliDependencies {
  runComparison: typeof runLiveComparison;
  readFile: (path: string) => Promise<string>;
  providers: (keys: {
    openRouter: string;
    typeSafe: string;
  }) => LiveComparisonProviders;
  env: NodeJS.ProcessEnv;
}

export function usage(): string {
  return `Usage:
  pnpm compare:live --confirm-provider-costs --model <OpenRouter model> [options]
  pnpm compare:live --summary-from <report.json>

Live mode makes paid provider requests only after the explicit acknowledgement.
It requires OPENROUTER_API_KEY and TYPESAFE_API_KEY after acknowledgement.
Options: --seeds <a,b,c> (max ${MAX_SEEDS}), --ticks <1-${MAX_TICKS}>, --agents <2-${MAX_AGENTS}>,
--attempts <1-${MAX_ATTEMPTS}>, --credit-limit <0-${MAX_CREDIT_LIMIT}>,
--reservation <0-${MAX_RESERVATION}>. Defaults: 3 seeds, ${DEFAULT_TICKS} ticks, ${DEFAULT_AGENTS} agents.`;
}

function integer(
  value: string,
  option: string,
  maximum: number,
  minimum = 1,
): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error(`${option} must be a positive integer.`);
  const number = Number(value);
  if (number < minimum || number > maximum)
    throw new Error(`${option} must be between ${minimum} and ${maximum}.`);
  return number;
}

function credit(value: string, option: string, maximum: number): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !/[1-9]/.test(value))
    throw new Error(`${option} must be a positive decimal.`);
  if (!Number.isFinite(Number(value)) || Number(value) > maximum)
    throw new Error(`${option} must be at most ${maximum}.`);
  return value;
}

function seeds(value: string): string[] {
  const parsed = value.split(',').map((entry) => entry.trim());
  if (
    !parsed.length ||
    parsed.length > MAX_SEEDS ||
    parsed.some(
      (entry) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry) ||
        entry.length > MAX_SEED_LENGTH,
    )
  )
    throw new Error(
      `--seeds must contain 1 to ${MAX_SEEDS} stable identifiers.`,
    );
  const unique = [...new Set(parsed)];
  if (unique.length !== parsed.length)
    throw new Error('--seeds must not contain duplicates.');
  return unique;
}

function modelId(value: string): string {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(value) || value.length > 200)
    throw new Error('--model must be a provider/model identifier.');
  return value;
}

export function parseLiveComparisonArguments(
  input: readonly string[],
): LiveComparisonCliOptions {
  const options: LiveComparisonCliOptions = {
    confirmProviderCosts: false,
    seeds: DEFAULT_SEEDS,
    ticks: DEFAULT_TICKS,
    agents: DEFAULT_AGENTS,
    attempts: DEFAULT_ATTEMPTS,
    creditLimit: DEFAULT_CREDIT_LIMIT,
    reservation: DEFAULT_RESERVATION,
  };
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const option = input[index]!;
    if (option === '--confirm-provider-costs') {
      options.confirmProviderCosts = true;
      continue;
    }
    if (option === '--help' || option === '-h') throw new Error('help');
    if (seen.has(option)) throw new Error(`${option} was supplied twice.`);
    seen.add(option);
    const value = input[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Option ${option} requires a value.`);
    if (option === '--model') options.model = modelId(value);
    else if (option === '--seeds') options.seeds = seeds(value);
    else if (option === '--ticks')
      options.ticks = integer(value, option, MAX_TICKS);
    else if (option === '--agents')
      options.agents = integer(value, option, MAX_AGENTS, 2);
    else if (option === '--attempts')
      options.attempts = integer(value, option, MAX_ATTEMPTS);
    else if (option === '--credit-limit')
      options.creditLimit = credit(value, option, MAX_CREDIT_LIMIT);
    else if (option === '--reservation')
      options.reservation = credit(value, option, MAX_RESERVATION);
    else if (option === '--summary-from') options.summaryFrom = value;
    else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }
  if (
    options.summaryFrom &&
    (options.confirmProviderCosts || options.model || seen.size > 1)
  )
    throw new Error('--summary-from cannot be combined with live-run options.');
  return options;
}

export function markdownSummary(report: LiveComparisonReport): string {
  const configuration = report.configuration;
  const variants = report.variants.map((variant) => {
    const aggregate = variant.aggregate as Record<string, unknown>;
    const get = (...names: string[]) =>
      names
        .map((name) => aggregate[name])
        .find((value) => value !== undefined && value !== null) ?? 'unknown';
    return `| ${variant.variant} | ${get('patientZeroCapturedRuns')} | ${get('finalActiveWorkers')} | ${get('totalCaptures', 'captures')} | ${get('totalControlledCells', 'controlledCells', 'finalControlledCells')} | ${get('totalWorkerStalls', 'workerStalls')} | ${get('totalReplanSignals', 'workerReplanSignals')} | ${get('totalGenerativeAttempts', 'zeroPlanningAttempts')} | ${get('totalReflexAttempts', 'jevAttempts')} | ${get('jevFallbacks')} | ${get('knownOpenRouterCostCredits', 'actualOpenRouterCostCredits')} | ${get('attemptsWithUnknownCost', 'unknownProviderCostAttempts')} |`;
  });
  return `# Live swarm comparison\n\nInputs are reproducible; provider outputs are nondeterministic. Model: \`${configuration.modelId}\`. Seeds: ${configuration.seeds.join(', ')}. Tick cap: ${configuration.tickCap}.\n\n| Variant | Patient Zero captures | Final active workers | Captures | Territory | Worker stalls | Replan signals | Zero planning attempts | Jev attempts | Jev fallbacks | Reported OpenRouter cost (credits) | Unknown cost fields |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${variants.join('\n')}\n\nReview survival and captures, territory, stalls, replans, and provider effort/cost separately. This summary does not select a winner.`;
}

function summaryReport(value: unknown): LiveComparisonReport {
  if (!value || typeof value !== 'object')
    throw new Error('Saved report has an invalid shape.');
  const report = value as { configuration?: unknown; variants?: unknown };
  if (
    !report.configuration ||
    typeof report.configuration !== 'object' ||
    !Array.isArray(report.variants)
  )
    throw new Error('Saved report has an invalid shape.');
  const configuration = report.configuration as {
    modelId?: unknown;
    seeds?: unknown;
    tickCap?: unknown;
  };
  if (
    typeof configuration.modelId !== 'string' ||
    configuration.modelId.length > 200 ||
    !/^[a-zA-Z0-9._/:@-]+$/.test(configuration.modelId) ||
    !Array.isArray(configuration.seeds) ||
    !configuration.seeds.every(
      (seed) =>
        typeof seed === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seed),
    ) ||
    !Number.isInteger(configuration.tickCap)
  )
    throw new Error('Saved report has an invalid shape.');
  if (
    !report.variants.every(
      (variant) =>
        variant &&
        typeof variant === 'object' &&
        ['live-zero-jev', 'live-zero-deterministic-workers'].includes(
          (variant as { variant?: unknown }).variant as string,
        ) &&
        typeof (variant as { aggregate?: unknown }).aggregate === 'object' &&
        (variant as { aggregate?: unknown }).aggregate !== null &&
        Object.values(
          (variant as { aggregate: Record<string, unknown> }).aggregate,
        ).every((entry) => safeSummaryValue(entry)),
    )
  )
    throw new Error('Saved report has an invalid shape.');
  return value as LiveComparisonReport;
}

function safeSummaryValue(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return /^\d+(?:\.\d+)?$/.test(value);
  return (
    depth === 0 &&
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => safeSummaryValue(entry, 1))
  );
}

export function defaultProviders(keys: {
  openRouter: string;
  typeSafe: string;
}): LiveComparisonProviders {
  return {
    createPlanner: () =>
      new OpenRouterSwarmPlanner({ apiKey: keys.openRouter }),
    createReflex: () =>
      new TypeSafeJevReflexProvider({ apiKey: keys.typeSafe }),
  };
}

const defaults: LiveComparisonCliDependencies = {
  runComparison: runLiveComparison,
  readFile: (path) =>
    import('node:fs/promises').then(({ readFile }) => readFile(path, 'utf8')),
  providers: defaultProviders,
  env: process.env,
};

/** Runs only after parsing and acknowledgement checks; no implicit dotenv loading occurs. */
export async function runLiveComparisonCli(
  input: readonly string[],
  dependencies = defaults,
): Promise<string> {
  const options = parseLiveComparisonArguments(input);
  if (options.summaryFrom)
    return markdownSummary(
      summaryReport(
        JSON.parse(await dependencies.readFile(options.summaryFrom)),
      ),
    );
  if (!options.confirmProviderCosts)
    throw new Error(
      'Refusing provider calls: pass --confirm-provider-costs to acknowledge provider costs.',
    );
  if (!options.model?.trim())
    throw new Error(
      '--model is required; select the OpenRouter model explicitly.',
    );
  const openRouter = dependencies.env.OPENROUTER_API_KEY?.trim();
  const typeSafe = dependencies.env.TYPESAFE_API_KEY?.trim();
  if (!openRouter || !typeSafe)
    throw new Error(
      'OPENROUTER_API_KEY and TYPESAFE_API_KEY are required after acknowledgement.',
    );
  const report = await dependencies.runComparison(
    {
      confirmed: true,
      modelId: options.model,
      seeds: options.seeds,
      tickCap: options.ticks,
      agentCount: options.agents,
      providerAttemptLimit: options.attempts,
      creditLimit: options.creditLimit,
      reservationCreditsPerAttempt: options.reservation,
    },
    dependencies.providers({ openRouter, typeSafe }),
  );
  return JSON.stringify(report, null, 2);
}

async function main(): Promise<void> {
  try {
    process.stdout.write(
      `${await runLiveComparisonCli(process.argv.slice(2))}\n`,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'help') {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const message = safeCliError(error);
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

/** Provider errors are deliberately not echoed: a gateway may include a raw body. */
function safeCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Unknown option:')) return 'Unknown option.';
  if (
    /^(?:Option |--(?:model|seeds|ticks|agents|attempts|credit-limit|reservation|summary-from)|Refusing provider calls:|OPENROUTER_API_KEY and TYPESAFE_API_KEY)/.test(
      message,
    )
  )
    return message;
  return 'Live comparison failed without emitting provider response details.';
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
