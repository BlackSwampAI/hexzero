#!/usr/bin/env node
import {
  simulationSnapshotSchema,
  type SimulationSnapshot,
  type WorldAction,
} from '@hexzero/shared';

/** A small, safe projection of an already committed local experiment. */
export function summarizeSwarmSnapshot(snapshot: SimulationSnapshot) {
  const zeroId = snapshot.scenario.patientZeroAgentId;
  const player = snapshot.world.simulatedPlayer;
  const attempts = snapshot.experiment.attemptAccounting;
  const actionCounts = (actions: readonly (WorldAction | undefined)[]) => ({
    move: actions.filter((action) => action?.type === 'move').length,
    infect: actions.filter((action) => action?.type === 'infect').length,
    capture: actions.filter((action) => action?.type === 'capture').length,
    wait: actions.filter((action) => action?.type === 'wait').length,
  });
  return {
    tick: snapshot.tickNumber,
    swarmArchitectureVersion: snapshot.scenario.swarmArchitectureVersion,
    infectedCells: snapshot.world.hexes.filter(
      ({ state }) => state === 'infected',
    ).length,
    zeroModel:
      snapshot.resolvedModels.find(({ agentId }) => agentId === zeroId)
        ?.modelId ?? null,
    player: {
      enabled: snapshot.scenario.simulatedPlayer.enabled,
      profile: snapshot.scenario.simulatedPlayer.profile,
      active: Boolean(player),
      movements: player?.metrics.movements ?? 0,
      cleaned: player?.metrics.cellsDisinfected ?? 0,
      blockedCleans: player?.metrics.blockedDisinfections ?? 0,
    },
    providers: snapshot.swarmProviderStatus ?? null,
    attempts: {
      started: attempts.attemptsStarted,
      finalized: attempts.attemptsFinalized,
      unknownCost: attempts.attemptsWithUnknownCost,
      providerReportedCostCredits: attempts.knownFinalizedCostCredits,
      admissionExposureCredits: attempts.committedCreditExposure,
      reservePerAttemptCredits: attempts.reservationCreditsPerAttempt,
    },
    recentTicks: (snapshot.swarmTicks ?? []).slice(-10).map((tick) => ({
      tick: tick.tickNumber,
      planSource: tick.planSource,
      plannerFailureCode: tick.plannerFailure?.code ?? null,
      zeroAction: tick.zeroAction?.type ?? null,
      zeroAccepted: tick.zeroActionResult?.accepted ?? null,
      workerActions: actionCounts(tick.workers.map(({ action }) => action)),
      jevDecisions: tick.workers.filter(({ source }) => source === 'jev-reflex')
        .length,
      workerFallbacks: tick.workers.filter(
        ({ source }) => source === 'deterministic-fallback',
      ).length,
      workerFailureCodes: tick.workers.flatMap(({ failure }) =>
        failure ? [failure.code] : [],
      ),
      workerFailures: tick.workers.flatMap(({ agentId, failure }) =>
        failure
          ? [{ agentId, code: failure.code, message: failure.message }]
          : [],
      ),
    })),
  };
}

async function main(): Promise<void> {
  const port = process.env.PORT ?? '8787';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535)
    throw new Error('PORT must be a valid local TCP port.');
  const url = `http://127.0.0.1:${port}/api/simulation`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  } catch {
    throw new Error(
      `Game API is unavailable at ${url}. Start pnpm dev and leave it running in another terminal.`,
    );
  }
  if (!response.ok) throw new Error('Game API did not return a snapshot.');
  const snapshot = simulationSnapshotSchema.parse(await response.json());
  process.stdout.write(
    `${JSON.stringify(summarizeSwarmSnapshot(snapshot), null, 2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Swarm diagnostic failed.'}\n`,
    );
    process.exitCode = 1;
  });
