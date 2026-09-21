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
    communications: { channel: 'all', status: 'all' },
    level: 'full-safe',
    serialization: 'compact',
  });
}

describe('experiment archive', () => {
  it('archives a current swarm export with swarm-native provenance', async () => {
    const document = await currentExport();
    expect(document.schemaVersion).toBe(11);
    expect(document.experiment).toMatchObject({
      swarmPlannerContractVersion: 'swarm-planner-v1',
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
    ).toEqual({ decision_contract_version: 'swarm-planner-v1' });
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
});
