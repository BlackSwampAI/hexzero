import { describe, expect, it } from 'vitest';
import {
  DeterministicReflexProvider,
  DeterministicSwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  experimentExportDocumentSchema,
  type ExperimentExportDocument,
} from '@hexzero/shared';
import { SimulationService } from '../../../apps/game-api/src/simulation-service.js';
import {
  ArchiveDatabase,
  ExperimentImportError,
  ExperimentQueryService,
  importExperimentExport,
} from './index.js';

async function currentExport(): Promise<ExperimentExportDocument> {
  const simulation = new SimulationService({
    swarmPlanner: new DeterministicSwarmPlanner(),
    reflexProvider: new DeterministicReflexProvider(),
    now: () => '2026-08-20T12:00:00.000Z',
  });
  simulation.applyWorldSetup(simulation.getDefaultWorldSetup());
  await simulation.executeNextTick();
  return simulation.generateExperimentExport({
    agents: { mode: 'all' },
    turns: { mode: 'entire-retained' },
    outcomes: ['accepted', 'rejected', 'provider-error', 'operator-skipped'],
    actions: ['move', 'infect', 'capture', 'wait'],
    level: 'full-safe',
    serialization: 'compact',
  });
}

describe('experiment archive', () => {
  it('archives a current swarm export with swarm-native provenance', async () => {
    const document = await currentExport();
    expect(document.schemaVersion).toBe(14);
    expect(document.experiment).toMatchObject({
      swarmPlannerContractVersion: 'swarm-planner-v2',
      scenario: { swarmArchitectureVersion: 'zero-swarm-v1' },
    });
    expect(document.swarmTicks).toHaveLength(1);

    const archive = new ArchiveDatabase({ path: ':memory:' });
    const report = importExperimentExport(archive, document);
    expect(report).toMatchObject({ inserted: expect.any(Number), rejected: 0 });
    expect(
      archive.database
        .prepare(
          'SELECT decision_contract_version FROM experiments WHERE id = ?',
        )
        .get(document.experiment.id),
    ).toEqual({ decision_contract_version: 'swarm-planner-v2' });
    archive.close();
  });

  it('preserves batch membership while charging the call once and excluding anchor per-agent usage', async () => {
    const document = await currentExport();
    const [anchor, member] = document.agents;
    const attempt = {
      id: '018f3f38-6b7d-7db7-8e95-751b4ce2681e',
      agentId: anchor!.id,
      intendedTurnNumber: 1,
      intendedTickNumber: 1,
      kind: 'initial',
      startedAt: '2026-08-13T12:00:00.000Z',
      completedAt: '2026-08-13T12:00:01.000Z',
      outcome: 'completed',
      modelId: 'jev-1.13.0',
      reasoningProfile: 'provider-default',
      reservedCredits: '0.01',
      actualCostCredits: '0.006',
      provider: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        latencyMs: 12,
        promptTokens: 30,
        completionTokens: 2,
        costCredits: 0.006,
      },
      batch: {
        id: '018f3f38-6b7d-7db7-8e95-751b4ce2681f',
        members: [
          { agentId: anchor!.id, intendedTurnNumber: 1 },
          { agentId: member!.id, intendedTurnNumber: 2 },
        ],
      },
    } as const;
    const batchDocument = experimentExportDocumentSchema.parse({
      ...document,
      providerAttempts: [attempt],
      selection: { ...document.selection, matchingProviderAttemptCount: 1 },
    });
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, batchDocument);
    const query = new ExperimentQueryService(archive);
    const attempts = query.providerAttempts(batchDocument.experiment.id).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      actualCostCredits: '0.006',
      batch: { members: [{ agentId: anchor!.id }, { agentId: member!.id }] },
    });
    expect(
      query.providerAttempts(batchDocument.experiment.id, {
        agent: member!.id,
        fromTurn: 2,
        toTurn: 2,
      }).rows,
    ).toHaveLength(1);
    expect(
      query.providerAttempts(batchDocument.experiment.id, {
        agent: member!.id,
        fromTurn: 1,
        toTurn: 1,
      }).rows,
    ).toHaveLength(0);
    expect(
      query.providerAttempts(batchDocument.experiment.id, {
        fromTurn: 2,
        toTurn: 2,
      }).rows,
    ).toHaveLength(1);
    const report = query.summary(batchDocument.experiment.id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(report)).toContain(member!.id);
    const usage = report.usage as Record<string, unknown>;
    const perAgent = (usage.byAgent ?? []) as Array<Record<string, unknown>>;
    expect(
      perAgent.every(({ providerAttempts }) => Number(providerAttempts) === 0),
    ).toBe(true);
    expect(usage.aggregate).toMatchObject({
      providerAttempts: 1,
      knownCostCredits: 0.006,
    });
    expect(
      query.compare(batchDocument.experiment.id, batchDocument.experiment.id),
    ).toMatchObject({
      left: { absolute: { activeAgents: 2, providerAttempts: 1 } },
    });
    const failedDocument = experimentExportDocumentSchema.parse({
      ...batchDocument,
      providerAttempts: [
        {
          ...attempt,
          id: '018f3f38-6b7d-7db7-8e95-751b4ce26820',
          outcome: 'provider-error',
          failure: {
            code: 'provider-http',
            message: 'Batch unavailable.',
            retryable: false,
          },
        },
      ],
    });
    importExperimentExport(archive, failedDocument);
    expect(
      query.failures(batchDocument.experiment.id, {
        agent: member!.id,
        fromTurn: 2,
        toTurn: 2,
      }).rows[0],
    ).toMatchObject({ batch: attempt.batch });
    expect(
      query.failures(batchDocument.experiment.id, {
        agent: member!.id,
        fromTurn: 1,
        toTurn: 1,
      }).rows,
    ).toHaveLength(0);
    archive.close();
  });

  it('imports the same swarm export idempotently', async () => {
    const document = await currentExport();
    const archive = new ArchiveDatabase({ path: ':memory:' });
    const first = importExperimentExport(archive, document);
    const second = importExperimentExport(archive, document);
    expect(first.rejected).toBe(0);
    expect(second).toMatchObject({ inserted: 0, rejected: 0 });
    expect(
      archive.database
        .prepare('SELECT COUNT(*) AS count FROM swarm_ticks')
        .get(),
    ).toEqual({ count: 1 });
    archive.close();
  });

  it('exposes archived swarm telemetry through the query service', async () => {
    const document = await currentExport();
    const archive = new ArchiveDatabase({ path: ':memory:' });
    importExperimentExport(archive, document);
    expect(
      new ExperimentQueryService(archive).summary(document.experiment.id),
    ).toMatchObject({ experiment: { id: document.experiment.id } });
    archive.close();
  });

  it('rejects credential-like data before persisting an export', async () => {
    const document = structuredClone(await currentExport()) as Record<
      string,
      unknown
    >;
    document.apiKey = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const archive = new ArchiveDatabase({ path: ':memory:' });
    expect(() =>
      importExperimentExport(archive, document as ExperimentExportDocument),
    ).toThrow(ExperimentImportError);
    expect(
      archive.database
        .prepare('SELECT COUNT(*) AS count FROM experiments')
        .get(),
    ).toEqual({ count: 0 });
    archive.close();
  });

  it('does not accept an unknown swarm architecture version', async () => {
    const raw = structuredClone(await currentExport()) as unknown as {
      experiment: { scenario?: Record<string, unknown> };
    };
    raw.experiment.scenario!.swarmArchitectureVersion = 'other-architecture';
    expect(experimentExportDocumentSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects an export document with a non-v14 schema version', async () => {
    const raw = structuredClone(await currentExport()) as unknown as Record<
      string,
      unknown
    >;
    raw.schemaVersion = 13;
    expect(experimentExportDocumentSchema.safeParse(raw).success).toBe(false);
    const archive = new ArchiveDatabase({ path: ':memory:' });
    expect(() =>
      importExperimentExport(
        archive,
        raw as unknown as ExperimentExportDocument,
      ),
    ).toThrow(ExperimentImportError);
    expect(
      archive.database
        .prepare('SELECT COUNT(*) AS count FROM experiments')
        .get(),
    ).toEqual({ count: 0 });
    archive.close();
  });
});
