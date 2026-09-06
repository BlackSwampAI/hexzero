#!/usr/bin/env node
import {
  ArchiveDatabase,
  ExperimentImportError,
  ExperimentQueryService,
  NOTE_STATUSES,
  NOTE_TYPES,
  ResearchNoteService,
  importExperimentExport,
  type DetailFilters,
  type NoteFilters,
  type NoteStatus,
  type NoteType,
} from './index.js';

type OutputFormat = 'table' | 'json' | 'markdown';

interface Arguments {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArguments(input: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = input[index + 1];
    if (!next || next.startsWith('--'))
      throw new Error(`Option --${key} requires a value.`);
    flags.set(key, [...(flags.get(key) ?? []), next]);
    index += 1;
  }
  return { positional, flags };
}

function flag(args: Arguments, key: string): string | undefined {
  return args.flags.get(key)?.at(-1);
}

function integerFlag(args: Arguments, key: string): number | undefined {
  const value = flag(args, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`--${key} must be an integer.`);
  return parsed;
}

function detailFilters(args: Arguments): DetailFilters {
  return {
    agent: flag(args, 'agent'),
    fromTurn: integerFlag(args, 'from-turn'),
    toTurn: integerFlag(args, 'to-turn'),
    action: flag(args, 'action'),
    outcome: flag(args, 'outcome'),
    channel: flag(args, 'channel'),
    sender: flag(args, 'sender'),
    recipient: flag(args, 'recipient'),
    reason: flag(args, 'reason'),
    limit: integerFlag(args, 'limit'),
  };
}

function noteFilters(args: Arguments): NoteFilters {
  const type = flag(args, 'type');
  const status = flag(args, 'status');
  if (type && !NOTE_TYPES.includes(type as NoteType))
    throw new Error(`Unsupported note type: ${type}`);
  if (status && !NOTE_STATUSES.includes(status as NoteStatus))
    throw new Error(`Unsupported note status: ${status}`);
  return {
    type: type as NoteType | undefined,
    status: status as NoteStatus | undefined,
    tag: flag(args, 'tag'),
    experiment: flag(args, 'experiment'),
    limit: integerFlag(args, 'limit'),
  };
}

function format(args: Arguments): OutputFormat {
  const value = flag(args, 'format') ?? 'table';
  if (value !== 'table' && value !== 'json' && value !== 'markdown')
    throw new Error('--format must be table, json, or markdown.');
  return value;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function rowsFor(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value === 'object' && value !== null && 'rows' in value)
    return (value as { rows: Array<Record<string, unknown>> }).rows;
  if (typeof value === 'object' && value !== null)
    return flatten(value as Record<string, unknown>);
  return [{ value }];
}

function flatten(
  value: Record<string, unknown>,
  prefix = '',
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(entry)) {
      if (entry.length === 0) rows.push({ field: path, value: '[]' });
      else
        entry.forEach((item, index) => {
          if (typeof item === 'object' && item !== null)
            rows.push(
              ...flatten(item as Record<string, unknown>, `${path}[${index}]`),
            );
          else rows.push({ field: `${path}[${index}]`, value: item });
        });
    } else if (typeof entry === 'object' && entry !== null)
      rows.push(...flatten(entry as Record<string, unknown>, path));
    else rows.push({ field: path, value: entry });
  }
  return rows;
}

function render(value: unknown, outputFormat: OutputFormat): string {
  if (outputFormat === 'json') return JSON.stringify(value, null, 2);
  const rows = rowsFor(value);
  if (rows.length === 0)
    return outputFormat === 'markdown' ? '_No results._' : 'No results.';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (outputFormat === 'markdown') {
    const escape = (entry: unknown) =>
      scalar(entry).replaceAll('|', '\\|').replaceAll('\n', ' ');
    return [
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...rows.map(
        (row) =>
          `| ${columns.map((column) => escape(row[column])).join(' | ')} |`,
      ),
    ].join('\n');
  }
  const widths = columns.map((column) =>
    Math.min(
      80,
      Math.max(column.length, ...rows.map((row) => scalar(row[column]).length)),
    ),
  );
  const line = (row: Record<string, unknown>) =>
    columns
      .map((column, index) =>
        scalar(row[column]).slice(0, widths[index]!).padEnd(widths[index]!),
      )
      .join('  ')
      .trimEnd();
  return [
    line(Object.fromEntries(columns.map((column) => [column, column]))),
    line(
      Object.fromEntries(
        columns.map((column, index) => [column, '-'.repeat(widths[index]!)]),
      ),
    ),
    ...rows.map(line),
  ].join('\n');
}

function requirePositional(
  args: Arguments,
  index: number,
  description: string,
): string {
  const value = args.positional[index];
  if (!value) throw new Error(`Missing ${description}.`);
  return value;
}

const HELP = `Usage:
  pnpm experiment:db import <export.json> [--db path] [--format table|json|markdown]
  pnpm experiment:db list [--limit n] [--format ...]
  pnpm experiment:db summary <experiment-id> [--format ...]
  pnpm experiment:db compare <experiment-id> <experiment-id> [--format ...]
  pnpm experiment:db turns <experiment-id> [--agent id] [--from-turn n] [--to-turn n] [--action action] [--outcome outcome] [--limit n]
  pnpm experiment:db communications <experiment-id> [--channel channel] [--sender id] [--recipient id] [--reason reason] [--limit n]
  pnpm experiment:db alliance-events <experiment-id> [--agent id] [--from-turn n] [--to-turn n] [--reason reason] [--limit n]
  pnpm experiment:db patient-zero <experiment-id> [--agent id] [--from-turn n] [--to-turn n] [--limit n]
  pnpm experiment:db failures <experiment-id> [--agent id] [--reason code] [--limit n]
  pnpm experiment:db provider-attempts <experiment-id> [--agent id] [--from-turn n] [--to-turn n] [--outcome value] [--limit n]
  pnpm experiment:db notes import <file.md> --type <type> --status <status> [--tag tag] [--experiment id] [--provenance text] [--supersedes note-id]
  pnpm experiment:db notes search <query> [--type type] [--status status] [--tag tag] [--experiment id] [--limit n]
  pnpm experiment:db notes list [filters]

Database path defaults to .hexzero/experiments.sqlite and can also be set with HEXZERO_EXPERIMENT_DB.
Existing .agentborne/experiments.sqlite and AGENTBORNE_EXPERIMENT_DB remain supported with a migration notice.
Detail commands default to 50 rows and enforce a maximum of 500. Arbitrary SQL is not supported.`;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const command = args.positional[0];
  if (!command || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const archive = new ArchiveDatabase({ path: flag(args, 'db') });
  try {
    const queries = new ExperimentQueryService(archive);
    const notes = new ResearchNoteService(archive);
    let result: unknown;
    if (command === 'import') {
      result = importExperimentExport(
        archive,
        requirePositional(args, 1, 'export JSON path'),
      );
    } else if (command === 'list') {
      result = queries.list({ limit: integerFlag(args, 'limit') });
    } else if (command === 'summary') {
      result = queries.summary(requirePositional(args, 1, 'experiment ID'));
    } else if (command === 'compare') {
      result = queries.compare(
        requirePositional(args, 1, 'first experiment ID'),
        requirePositional(args, 2, 'second experiment ID'),
      );
    } else if (command === 'turns') {
      result = queries.turns(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'communications') {
      result = queries.communications(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'alliance-events') {
      result = queries.allianceEvents(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'patient-zero') {
      result = queries.patientZero(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'failures') {
      result = queries.failures(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'provider-attempts') {
      result = queries.providerAttempts(
        requirePositional(args, 1, 'experiment ID'),
        detailFilters(args),
      );
    } else if (command === 'notes') {
      const operation = requirePositional(args, 1, 'notes operation');
      if (operation === 'import') {
        const type = flag(args, 'type');
        const status = flag(args, 'status');
        if (!type || !NOTE_TYPES.includes(type as NoteType))
          throw new Error(
            '--type is required and must be a supported note type.',
          );
        if (!status || !NOTE_STATUSES.includes(status as NoteStatus))
          throw new Error(
            '--status is required and must be a supported note status.',
          );
        result = notes.import(requirePositional(args, 2, 'Markdown path'), {
          type: type as NoteType,
          status: status as NoteStatus,
          title: flag(args, 'title'),
          tags: args.flags.get('tag'),
          provenance: flag(args, 'provenance'),
          experiments: args.flags.get('experiment'),
          supersedes: flag(args, 'supersedes'),
        });
      } else if (operation === 'search') {
        result = notes.search(
          requirePositional(args, 2, 'search query'),
          noteFilters(args),
        );
      } else if (operation === 'list') result = notes.list(noteFilters(args));
      else throw new Error(`Unknown notes operation: ${operation}`);
    } else throw new Error(`Unknown command: ${command}`);
    process.stdout.write(`${render(result, format(args))}\n`);
  } finally {
    archive.close();
  }
}

main().catch((error: unknown) => {
  const details =
    error instanceof ExperimentImportError
      ? ` ${JSON.stringify(error.report)}`
      : '';
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}${details}\n`,
  );
  process.exitCode = 1;
});
