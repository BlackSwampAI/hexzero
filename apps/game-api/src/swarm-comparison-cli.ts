#!/usr/bin/env node
import { runOfflineComparison } from './swarm-comparison.js';

const MAX_TICKS = 60;
const MAX_SEEDS = 16;
const MAX_SEED_LENGTH = 80;

interface Arguments {
  ticks?: number;
  seeds?: string[];
}

function usage(): string {
  return `Usage: pnpm compare:offline [--ticks <1-${MAX_TICKS}>] [--seeds <seed-a,seed-b,...>]

Runs the fixed, offline zero-swarm comparison fixtures and writes one JSON report
to stdout. It does not load provider credentials, contact provider services, or
write an experiment archive.`;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${option} must be an integer.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_TICKS)
    throw new Error(`${option} must be between 1 and ${MAX_TICKS}.`);
  return parsed;
}

function parseSeeds(value: string): string[] {
  const seeds = value.split(',').map((seed) => seed.trim());
  if (
    seeds.length === 0 ||
    seeds.length > MAX_SEEDS ||
    seeds.some(
      (seed) =>
        seed.length === 0 ||
        seed.length > MAX_SEED_LENGTH ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seed),
    )
  ) {
    throw new Error(
      `--seeds must contain 1 to ${MAX_SEEDS} comma-separated identifiers of at most ${MAX_SEED_LENGTH} characters.`,
    );
  }
  return [...new Set(seeds)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function parseArguments(input: readonly string[]): Arguments {
  const parsed: Arguments = {};
  for (let index = 0; index < input.length; index += 1) {
    const option = input[index];
    if (option === '--help' || option === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = input[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Option ${option} requires a value.`);
    if (option === '--ticks') {
      if (parsed.ticks !== undefined)
        throw new Error('--ticks was supplied twice.');
      parsed.ticks = parsePositiveInteger(value, '--ticks');
    } else if (option === '--seeds') {
      if (parsed.seeds !== undefined)
        throw new Error('--seeds was supplied twice.');
      parsed.seeds = parseSeeds(value);
    } else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const report = await runOfflineComparison({
    ...(options.ticks === undefined ? {} : { tickCap: options.ticks }),
    ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${usage()}\n`,
  );
  process.exitCode = 1;
});
