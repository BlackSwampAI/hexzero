import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider, ProviderDecision } from '@hexzero/agent-runtime';
import {
  LEGACY_AGENT_DECISION_CONTRACT_VERSION,
  PREVIOUS_AGENT_DECISION_CONTRACT_VERSION,
  FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION,
  experimentExportDocumentSchema,
  type AgentObservation,
  type ExperimentExportDocument,
} from '@hexzero/shared';
import { defaultWorldSetupRequest } from '@hexzero/world-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SimulationService } from '../../../apps/game-api/src/simulation-service.js';
import {
  ArchiveDatabase,
  DATABASE_PATH_ENV,
  ExperimentImportError,
  ExperimentQueryService,
  LEGACY_DATABASE_PATH_ENV,
  ResearchNoteService,
  importExperimentExport,
  resolveArchivePath,
} from './index.js';
import { migrations } from './migrations.js';

const EXPERIMENT_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-08-20T12:00:00.000Z';

afterEach(() => vi.unstubAllEnvs());

function nextUuid() {
  let counter = 10;
  return () => `20000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

async function currentExport(tick = false): Promise<ExperimentExportDocument> {
  let firstOtherAgent: string | undefined;
  const provider: AgentProvider = {
    mode: 'scripted-test',
    model: 'archive-test-model',
    configured: true,
    async decide(observation: AgentObservation): Promise<ProviderDecision> {
      let worldAction: ProviderDecision['decision']['worldAction'] = {
        type: 'wait',
      };
      let communication: ProviderDecision['decision']['communication'];
      if (observation.patientZero.isPatientZero) {
        communication = {
          channel: 'zero',
          message: 'Infect your current cell.',
        };
      } else if (!firstOtherAgent) {
        firstOtherAgent = observation.agentId;
        worldAction = { type: 'infect' };
        communication = {
          channel: 'direct',
          recipientId: observation.patientZero.agentId!,
          message: 'I will infect now.',
        };
      }
      return {
        decision: {
          worldAction,
          communication,
          goalRevision: observation.currentGoal
            ? { operation: 'keep' }
            : {
                operation: 'establish',
                longTermGoal: 'Preserve durable influence.',
                shortTermGoal: 'Secure the current frontier.',
                planSummary: 'Expand methodically.',
                reason: 'Create archive-safe continuity.',
              },
          summary: 'Deterministic archive fixture.',
        },
        metadata: {
          provider: 'scripted-test',
          model: 'archive-test-model',
          latencyMs: 12,
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          costCredits: 0,
        },
      };
    },
  };
  const eventId = nextUuid();
  const simulation = new SimulationService({
    provider,
    now: () => NOW,
    createEventId: eventId,
    createExperimentId: () => EXPERIMENT_ID,
    createAllianceId: eventId,
    createProposalId: eventId,
  });
  const snapshot = simulation.getSnapshot();
  const setup = defaultWorldSetupRequest();
  simulation.applyWorldSetup({
    ...setup,
    patientZeroAgentId: setup.roster[0]!.id,
    modelConfiguration: snapshot.modelConfiguration,
    behaviorConfiguration: snapshot.behaviorConfiguration,
  });
  if (tick) await simulation.executeNextTick();
  else
    for (let index = 0; index < 10; index += 1)
      await simulation.executeNextTurn();
  return simulation.generateExperimentExport({
    agents: { mode: 'all' },
    turns: { mode: 'entire-retained' },
    outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
    actions: ['move', 'infect', 'capture', 'wait'],
    communications: { channel: 'all', status: 'all' },
    level: 'full-safe',
    serialization: 'compact',
  });
}

function temporaryPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'hexzero-archive-')), name);
}

describe('experiment archive', () => {
  it('migrates and queries schema-v10 tick attribution while accepting schema-v9', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const ticked = await currentExport(true);
    const lostTick = structuredClone(ticked);
    lostTick.turns[0]!.outcome = 'lost-tick';
    lostTick.turns[0]!.failure = {
      code: 'timeout',
      message: 'deadline',
      retryable: false,
    };
    lostTick.tickSummaries![0]!.lostTicks = 1;
    lostTick.tickSummaries![0]!.deadlineMisses = 1;
    importExperimentExport(archive, lostTick);
    expect(
      new ExperimentQueryService(archive).turns(EXPERIMENT_ID).rows[0],
    ).toMatchObject({
      tick: 1,
      tickPosition: 1,
      tickIntervalMinutes: ticked.tickSummaries?.[0]?.intervalMinutes,
    });
    expect(
      new ExperimentQueryService(archive).summary(EXPERIMENT_ID),
    ).toMatchObject({
      turns: { failed: 0, lost: 1 },
    });
    const current = await currentExport();
    const legacyDocuments = [
      {
        id: '2f5e8994-cf39-44e0-9424-b829eb246e55',
        includeTopLevelVersion: true,
      },
      {
        id: '3f5e8994-cf39-44e0-9424-b829eb246e55',
        includeTopLevelVersion: false,
      },
    ].map(({ id, includeTopLevelVersion }, index) => {
      const raw = structuredClone(current) as unknown as {
        experiment: Record<string, unknown> & {
          scenario?: Record<string, unknown>;
        };
      };
      raw.experiment.id = id;
      if (includeTopLevelVersion)
        raw.experiment.decisionContractVersion =
          LEGACY_AGENT_DECISION_CONTRACT_VERSION;
      else delete raw.experiment.decisionContractVersion;
      if (raw.experiment.scenario)
        delete raw.experiment.scenario.decisionContractVersion;
      if (index === 0 && raw.experiment.scenario)
        raw.experiment.scenario.patientZeroAgentId = null;
      return experimentExportDocumentSchema.parse(raw);
    });
    for (const legacy of legacyDocuments) {
      expect(legacy.experiment).toMatchObject({
        decisionContractVersion: LEGACY_AGENT_DECISION_CONTRACT_VERSION,
        scenario: {
          decisionContractVersion: LEGACY_AGENT_DECISION_CONTRACT_VERSION,
        },
      });
      expect(() => importExperimentExport(archive, legacy)).not.toThrow();
      const stored = archive.database
        .prepare(
          'SELECT decision_contract_version, scenario_json FROM experiments WHERE id = ?',
        )
        .get(legacy.experiment.id) as {
        decision_contract_version: string;
        scenario_json: string;
      };
      expect(stored.decision_contract_version).toBe(
        LEGACY_AGENT_DECISION_CONTRACT_VERSION,
      );
      expect(JSON.parse(stored.scenario_json)).toMatchObject({
        decisionContractVersion: LEGACY_AGENT_DECISION_CONTRACT_VERSION,
      });
    }
    const nullCoordinator = legacyDocuments[0]!;
    expect(nullCoordinator.experiment.scenario?.patientZeroAgentId).toBeNull();
    expect(
      new ExperimentQueryService(archive).patientZero(
        nullCoordinator.experiment.id,
      ).rows,
    ).toEqual([]);
    const previousRaw = structuredClone(current) as unknown as {
      experiment: Record<string, unknown> & {
        scenario?: Record<string, unknown>;
      };
    };
    previousRaw.experiment.id = '4f5e8994-cf39-44e0-9424-b829eb246e55';
    previousRaw.experiment.decisionContractVersion =
      PREVIOUS_AGENT_DECISION_CONTRACT_VERSION;
    if (previousRaw.experiment.scenario)
      delete previousRaw.experiment.scenario.decisionContractVersion;
    const previous = experimentExportDocumentSchema.parse(previousRaw);
    expect(previous.experiment.scenario?.decisionContractVersion).toBe(
      PREVIOUS_AGENT_DECISION_CONTRACT_VERSION,
    );
    expect(() => importExperimentExport(archive, previous)).not.toThrow();
    expect(
      archive.database
        .prepare(
          'SELECT decision_contract_version FROM experiments WHERE id = ?',
        )
        .get(previous.experiment.id),
    ).toEqual({
      decision_contract_version: PREVIOUS_AGENT_DECISION_CONTRACT_VERSION,
    });
    const fluidRaw = structuredClone(current) as unknown as {
      experiment: Record<string, unknown> & {
        scenario?: Record<string, unknown>;
      };
    };
    fluidRaw.experiment.id = '5f5e8994-cf39-44e0-9424-b829eb246e55';
    fluidRaw.experiment.decisionContractVersion =
      FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION;
    if (fluidRaw.experiment.scenario)
      fluidRaw.experiment.scenario.decisionContractVersion =
        FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION;
    const fluid = experimentExportDocumentSchema.parse(fluidRaw);
    expect(() => importExperimentExport(archive, fluid)).not.toThrow();
    archive.close();
  });

  it('resolves canonical and legacy archive locations without moving either database', () => {
    const root = temporaryPath('workspace');
    mkdirSync(join(root, '.agentborne'), { recursive: true });
    const legacy = join(root, '.agentborne', 'experiments.sqlite');
    writeFileSync(legacy, 'legacy-database');
    vi.stubEnv('INIT_CWD', root);

    expect(resolveArchivePath()).toEqual({
      path: '.agentborne/experiments.sqlite',
      source: 'legacy-default',
    });
    expect(readFileSync(legacy, 'utf8')).toBe('legacy-database');
    expect(
      resolveArchivePath({
        environment: { [LEGACY_DATABASE_PATH_ENV]: 'legacy-env.sqlite' },
      }),
    ).toEqual({
      path: 'legacy-env.sqlite',
      source: 'legacy-environment',
    });
    expect(
      resolveArchivePath({
        environment: {
          [DATABASE_PATH_ENV]: 'canonical.sqlite',
          [LEGACY_DATABASE_PATH_ENV]: 'legacy-env.sqlite',
        },
      }),
    ).toEqual({ path: 'canonical.sqlite', source: 'environment' });

    mkdirSync(join(root, '.hexzero'), { recursive: true });
    writeFileSync(join(root, '.hexzero', 'experiments.sqlite'), 'canonical');
    expect(resolveArchivePath()).toEqual({
      path: '.hexzero/experiments.sqlite',
      source: 'default',
    });
    expect(readFileSync(legacy, 'utf8')).toBe('legacy-database');
  });

  it('defaults a new archive to .hexzero without creating or moving a legacy database', () => {
    const root = temporaryPath('fresh-workspace');
    mkdirSync(root, { recursive: true });
    vi.stubEnv('INIT_CWD', root);
    const archive = new ArchiveDatabase({ environment: {} });
    expect(archive.path).toBe(join(root, '.hexzero', 'experiments.sqlite'));
    expect(() =>
      readFileSync(join(root, '.agentborne', 'experiments.sqlite')),
    ).toThrow();
    archive.close();
  });

  it('warns without exposing values when the legacy archive variable is selected', () => {
    const warn = vi.fn();
    const archive = new ArchiveDatabase({
      environment: { [LEGACY_DATABASE_PATH_ENV]: ':memory:' },
      warn,
    });
    expect(warn).toHaveBeenCalledWith(
      'AGENTBORNE_EXPERIMENT_DB is deprecated; use HEXZERO_EXPERIMENT_DB. Continuing with the legacy setting.',
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain(':memory:');
    archive.close();
  });

  it('migrates a fresh database and reopens it without replaying migrations', () => {
    const path = temporaryPath('archive.sqlite');
    const first = new ArchiveDatabase({ path, clock: () => new Date(NOW) });
    expect(
      first.database
        .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
        .get(),
    ).toEqual({ count: migrations.length });
    expect(first.database.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    });
    first.close();
    const reopened = new ArchiveDatabase({ path, clock: () => new Date(NOW) });
    expect(reopened.database.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(
      reopened.database
        .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
        .get(),
    ).toEqual({ count: migrations.length });
    reopened.close();
  });

  it('imports current JSON exports transactionally, round-trips structured records, and is idempotent', async () => {
    const document = await currentExport();
    const path = temporaryPath('export.json');
    writeFileSync(path, JSON.stringify(document));
    const archive = new ArchiveDatabase({
      path: ':memory:',
      clock: () => new Date(NOW),
    });
    const first = importExperimentExport(archive, path);
    const second = importExperimentExport(archive, path);
    expect(first.inserted).toBeGreaterThan(10);
    expect(first.rejected).toBe(0);
    expect(second).toMatchObject({ inserted: 0, existing: 1, rejected: 0 });
    expect(
      archive.database.prepare('SELECT COUNT(*) AS count FROM turns').get(),
    ).toEqual({ count: 10 });
    expect(
      archive.database
        .prepare('SELECT COUNT(DISTINCT id) AS count FROM communications')
        .get(),
    ).toEqual({ count: 3 });
    expect(
      experimentExportDocumentSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      ),
    ).toEqual(document);
    archive.close();
  });

  it('imports an existing schema-v9 export with the legacy download filename', async () => {
    const path = temporaryPath(
      'agentborne-experiment-existing-full-entire.json',
    );
    writeFileSync(path, JSON.stringify(await currentExport()));
    const archive = new ArchiveDatabase({ path: ':memory:' });
    expect(importExperimentExport(archive, path).rejected).toBe(0);
    archive.close();
  });

  it('rolls back malformed and unsupported exports without leaving partial state', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const malformed = temporaryPath('malformed.json');
    writeFileSync(malformed, '{ nope');
    expect(() => importExperimentExport(archive, malformed)).toThrow(
      ExperimentImportError,
    );
    const unsupported = temporaryPath('unsupported.json');
    writeFileSync(
      unsupported,
      JSON.stringify({ ...(await currentExport()), schemaVersion: 8 }),
    );
    expect(() => importExperimentExport(archive, unsupported)).toThrow(
      ExperimentImportError,
    );
    expect(
      archive.database
        .prepare('SELECT COUNT(*) AS count FROM experiments')
        .get(),
    ).toEqual({ count: 0 });
    archive.close();
  });

  it('uses stable record IDs and prevents duplicates across differently serialized source files', async () => {
    const document = await currentExport();
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, document);
    const pretty = temporaryPath('pretty.json');
    writeFileSync(pretty, JSON.stringify(document, null, 2));
    const report = importExperimentExport(archive, pretty);
    expect(report.existing).toBeGreaterThan(10);
    expect(
      archive.database.prepare('SELECT COUNT(*) AS count FROM turns').get(),
    ).toEqual({ count: 10 });
    expect(
      archive.database
        .prepare('SELECT id FROM turns ORDER BY turn_number LIMIT 1')
        .get(),
    ).toEqual({ id: `${EXPERIMENT_ID}:turn:1` });
    archive.close();
  });

  it('applies deterministic query filters, ordering, and enforced limits', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const document = await currentExport();
    importExperimentExport(archive, document);
    const queries = new ExperimentQueryService(archive);
    const agent = document.agents[0]!.id;
    const filtered = queries.turns(EXPERIMENT_ID, {
      agent,
      fromTurn: 1,
      toTurn: 9,
      action: 'wait',
      outcome: 'accepted',
      limit: 1,
    });
    expect(filtered.limit).toBe(1);
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]).toMatchObject({
      agent,
      action: 'wait',
      outcome: 'accepted',
    });
    expect(queries.turns(EXPERIMENT_ID, { limit: 50_000 }).limit).toBe(500);
    expect(
      queries.communications(EXPERIMENT_ID, {
        channel: 'direct',
        recipient: document.experiment.scenario!.patientZeroAgentId!,
      }).rows,
    ).toEqual([
      expect.objectContaining({ channel: 'direct', status: 'accepted' }),
    ]);
    const ordered = queries.turns(EXPERIMENT_ID).rows.map(({ turn }) => turn);
    expect(ordered).toEqual(
      [...ordered].sort((left, right) => Number(left) - Number(right)),
    );
    archive.close();
  });

  it('derives summaries and normalized comparisons without loading observations', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, await currentExport());
    const queries = new ExperimentQueryService(archive);
    const summary = queries.summary(EXPERIMENT_ID);
    expect(summary).toMatchObject({
      turns: { requested: 10, accepted: 10, failed: 0, lost: 0 },
      retention: { complete: true, archivedTurns: 10 },
      usage: { aggregate: { modelAttempts: 10, totalTokens: 1100 } },
    });
    const comparison = queries.compare(EXPERIMENT_ID, EXPERIMENT_ID);
    expect(comparison.delta).toEqual(
      expect.objectContaining({ communicationsPerTurn: 0, acceptedPerTurn: 0 }),
    );
    archive.close();
  });

  it('defines canonical direction changes as an agreeing sum while retaining inconsistent source evidence', async () => {
    const document = await currentExport();
    document.metrics!.aggregate.directionChangesAfterCommunication = 7;
    document.metrics!.byAgent[0]!.metrics.directionChangesAfterCommunication = 2;
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, document);
    const summary = new ExperimentQueryService(archive).summary(EXPERIMENT_ID);
    expect(summary.directionChangesAfterCommunication).toMatchObject({
      aggregate: 0,
      agreement: true,
    });
    expect(summary.inconsistencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'directionChangesAfterCommunication',
          aggregate: 7,
          perAgentSum: 2,
        }),
      ]),
    );
    const stored = archive.database
      .prepare('SELECT source_metrics_json AS metrics FROM experiments')
      .get() as { metrics: string };
    expect(
      JSON.parse(stored.metrics).aggregate.directionChangesAfterCommunication,
    ).toBe(7);
    archive.close();
  });

  it('distinguishes messages to Patient Zero, replies after directives, and observable compliance', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, await currentExport());
    const rows = new ExperimentQueryService(archive).patientZero(
      EXPERIMENT_ID,
      { limit: 100 },
    ).rows;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'directive' }),
        expect.objectContaining({ kind: 'reply-after-directive' }),
        expect.objectContaining({
          kind: 'observable-compliance',
          classification: 'compliant',
          observedAction: 'infect',
        }),
      ]),
    );
    archive.close();
  });

  it('supports FTS note search, exact status filters, experiment links, and supersession', async () => {
    const archive = new ArchiveDatabase({
      path: ':memory:',
      clock: () => new Date(NOW),
    });
    importExperimentExport(archive, await currentExport());
    const notes = new ResearchNoteService(archive);
    const oldPath = temporaryPath('old.md');
    writeFileSync(
      oldPath,
      '# Communication idea\nTry a noisy broadcast experiment.',
    );
    const old = notes.import(oldPath, {
      type: 'hypothesis',
      status: 'proposed',
      tags: ['communication'],
      experiments: [EXPERIMENT_ID],
      provenance: 'design chat 12',
    });
    const newPath = temporaryPath('new.md');
    writeFileSync(
      newPath,
      '# Communication decision\nUse bounded direct communication.',
    );
    const replacement = notes.import(newPath, {
      type: 'decision',
      status: 'accepted',
      tags: ['communication'],
      experiments: [EXPERIMENT_ID],
      provenance: 'ADR review',
      supersedes: old.id,
    });
    expect(notes.search('communication', { status: 'accepted' }).rows).toEqual([
      expect.objectContaining({
        id: replacement.id,
        status: 'accepted',
        provenance: 'ADR review',
      }),
    ]);
    expect(
      notes.list({ status: 'superseded', experiment: EXPERIMENT_ID }).rows,
    ).toEqual([expect.objectContaining({ id: old.id, status: 'superseded' })]);
    archive.close();
  });

  it('reports incomplete retention and missing selected history explicitly', async () => {
    const document = await currentExport();
    document.retention = {
      ...document.retention,
      totalCompletedTurns: 20,
      droppedRecords: 10,
      complete: false,
      requestedRangeExtendsBeyondRetention: true,
    };
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, document);
    expect(
      new ExperimentQueryService(archive).summary(EXPERIMENT_ID),
    ).toMatchObject({
      retention: {
        complete: false,
        droppedRecords: 10,
        requestedRangeExtendsBeyondRetention: true,
      },
    });
    archive.close();
  });

  it('surfaces persistence failures and never reports a successful import', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const document = await currentExport();
    archive.close();
    expect(() => importExperimentExport(archive, document)).toThrow(
      ExperimentImportError,
    );
  });

  it('rejects credentials and private-reasoning fields from exports and notes', async () => {
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const unsafe = {
      ...(await currentExport()),
      apiKey: 'sk-or-v1-not-allowed-credential',
    } as unknown as ExperimentExportDocument;
    expect(() => importExperimentExport(archive, unsafe)).toThrow(
      /prohibited|Credential/i,
    );
    const notePath = temporaryPath('unsafe.md');
    writeFileSync(
      notePath,
      '# Secret\nBearer abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(() =>
      new ResearchNoteService(archive).import(notePath, {
        type: 'transcript',
        status: 'proposed',
      }),
    ).toThrow(/Credential/i);
    expect(
      archive.database.prepare('SELECT COUNT(*) AS count FROM notes').get(),
    ).toEqual({ count: 0 });
    archive.close();
  });
});
