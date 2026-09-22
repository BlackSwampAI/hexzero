'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  NEUTRAL_AGENT_COLOR,
  archiveExperimentExportResponseSchema,
  cancelSimulationResponseSchema,
  cancelledTickResponseSchema,
  experimentExportPreviewSchema,
  experimentExportRequestSchema,
  experimentExportResponseSchema,
  modelCatalogResponseSchema,
  resetSimulationResponseSchema,
  reasoningProfilesForModel,
  simulationSnapshotSchema,
  singleTickResponseSchema,
  updateExperimentModelsResponseSchema,
  verifyModelResponseSchema,
  worldSetupPreviewResponseSchema,
  applyWorldSetupResponseSchema,
  generatedAgentResponseSchema,
  locationSearchResponseSchema,
  defaultWorldSetupResponseSchema,
  WORLD_RADIUS_PRESETS,
  type AgentId,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentExportRequest,
  type H3Cell,
  type CompatibleModel,
  type ModelCatalogResponse,
  type ModelVerification,
  type ReasoningProfile,
  type ExperimentModelConfiguration,
  type SimulationSnapshot,
  type WorldSetupRequest,
  type WorldSetupPreviewResponse,
} from '@hexzero/shared';
import { WorldMap } from './world-map';
import { buildModelOptions } from './model-options';
import { resolveAgentColor } from './ui-color';
import {
  SwarmActivityPanel,
  SwarmAgentInspector,
  SwarmRunPanel,
  SwarmStrategyPanel,
} from './swarm-view';

const apiBase =
  process.env.NEXT_PUBLIC_GAME_API_BASE_URL ?? '/api/game/simulation';
const runTargetStorageKey = 'hexzero.world-lab.run-target';
const activityDockStorageKey = 'hexzero.world-lab.activity-dock';
const legacyRunTargetStorageKey = 'agentborne.world-lab.run-target';
const legacyActivityDockStorageKey = 'agentborne.world-lab.activity-dock';
export const runTargets = [5, 10, 25, 50, 100] as const;

function readStoredPreference(
  storage: Storage,
  key: string,
  legacyKey: string,
  valid: (value: string) => boolean,
): string | null {
  const current = storage.getItem(key);
  if (current !== null) return valid(current) ? current : null;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null || !valid(legacy)) return null;
  storage.setItem(key, legacy);
  return legacy;
}

export function WorldLab() {
  const [workspaceView, setWorkspaceView] = useState<'live' | 'agents'>('live');
  const [inspectorTab, setInspectorTab] = useState<
    'scoreboard' | 'agent' | 'hex' | 'run'
  >('agent');
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null);
  const [selectedCell, setSelectedCell] = useState<H3Cell | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null);
  const [running, setRunning] = useState(false);
  const [runTarget, setRunTarget] = useState<(typeof runTargets)[number]>(25);
  const [runTargetLoaded, setRunTargetLoaded] = useState(false);
  const [boundedRunTarget, setBoundedRunTarget] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [speed, setSpeed] = useState(1_000);
  const [uiError, setUiError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [configurationPending, setConfigurationPending] = useState(false);
  const [modelVerifications, setModelVerifications] = useState<
    Record<string, ModelVerification>
  >({});
  const [verifyingModelId, setVerifyingModelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [activityDockLoaded, setActivityDockLoaded] = useState(false);
  const inFlightRef = useRef(false);
  const boundedRunTargetRef = useRef<number | null>(null);
  const completedTurnsRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const runningRef = useRef(false);
  const configurationPendingRef = useRef(false);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const setupTriggerRef = useRef<HTMLElement>(null);
  const [setupOpenedFromMode, setSetupOpenedFromMode] = useState(false);
  const overflowMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    boundedRunTargetRef.current = boundedRunTarget;
  }, [boundedRunTarget]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    const collapsed = readStoredPreference(
      window.localStorage,
      activityDockStorageKey,
      legacyActivityDockStorageKey,
      (value) => value === 'collapsed' || value === 'expanded',
    );
    const hydrationTask = window.setTimeout(() => {
      setChatCollapsed(collapsed === 'collapsed');
      setActivityDockLoaded(true);
    }, 0);
    return () => window.clearTimeout(hydrationTask);
  }, []);

  useEffect(() => {
    if (!activityDockLoaded) return;
    window.localStorage.setItem(
      activityDockStorageKey,
      chatCollapsed ? 'collapsed' : 'expanded',
    );
  }, [activityDockLoaded, chatCollapsed]);

  useEffect(() => {
    if (
      !recoveryNotice ||
      recoveryNotice.startsWith('Recovering ') ||
      recoveryNotice.startsWith('Recovery pending ')
    )
      return;
    const timer = window.setTimeout(() => setRecoveryNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [recoveryNotice]);

  useEffect(() => {
    const stored = Number(
      readStoredPreference(
        window.sessionStorage,
        runTargetStorageKey,
        legacyRunTargetStorageKey,
        (value) =>
          runTargets.includes(Number(value) as (typeof runTargets)[number]),
      ),
    );
    const hydrationTask = window.setTimeout(() => {
      if (runTargets.includes(stored as (typeof runTargets)[number])) {
        const storedTarget = stored as (typeof runTargets)[number];
        setRunTarget(
          storedTarget > completedTurnsRef.current
            ? storedTarget
            : (runTargets.find(
                (target) => target > completedTurnsRef.current,
              ) ?? runTargets.at(-1)!),
        );
      }
      setRunTargetLoaded(true);
    }, 0);
    return () => window.clearTimeout(hydrationTask);
  }, []);

  useEffect(() => {
    if (!runTargetLoaded) return;
    window.sessionStorage.setItem(runTargetStorageKey, String(runTarget));
  }, [runTarget, runTargetLoaded]);

  const applySnapshot = useCallback((next: SimulationSnapshot) => {
    completedTurnsRef.current = next.tickNumber;
    setRunTarget((current) =>
      current > next.tickNumber
        ? current
        : (runTargets.find((target) => target > next.tickNumber) ??
          runTargets.at(-1)!),
    );
    setSnapshot(next);
    if (
      next.status === 'configuration-error' ||
      next.status === 'budget-exhausted' ||
      next.status === 'patient-zero-captured' ||
      next.status === 'infection-eliminated' ||
      next.world.hexes.every(({ state }) => state === 'infected') ||
      (boundedRunTargetRef.current !== null &&
        next.tickNumber >= boundedRunTargetRef.current)
    ) {
      runningRef.current = false;
      setRunning(false);
      setBoundedRunTarget(null);
      boundedRunTargetRef.current = null;
    }
    setSelectedAgentId((current) =>
      next.world.agents.some(({ id }) => id === current)
        ? current
        : (next.world.agents[0]?.id ?? null),
    );
  }, []);

  const reconcileAuthoritativeSnapshot = useCallback(async () => {
    setReconciling(true);
    try {
      for (;;) {
        const response = await fetch(apiBase, { cache: 'no-store' });
        if (!response.ok) throw new Error('snapshot request failed');
        const authoritative = simulationSnapshotSchema.parse(
          await response.json(),
        );
        applySnapshot(authoritative);
        if (authoritative.status !== 'waiting-for-model') return authoritative;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    } finally {
      setReconciling(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    let alive = true;
    void fetch(apiBase)
      .then(async (response) => {
        if (!response.ok) throw new Error('The Game API is unavailable.');
        return simulationSnapshotSchema.parse(await response.json());
      })
      .then((next) => {
        if (alive) applySnapshot(next);
      })
      .catch(() => {
        if (alive)
          setUiError('The Game API is unavailable. Start it with pnpm dev.');
      });
    return () => {
      alive = false;
    };
  }, [applySnapshot]);

  const providerMode = snapshot?.providerMode;
  useEffect(() => {
    if (providerMode !== 'openrouter') return;
    let alive = true;
    void fetch(`${apiBase}/models`)
      .then(async (response) => {
        if (!response.ok) throw new Error('The model catalog is unavailable.');
        const nextCatalog = modelCatalogResponseSchema.parse(
          await response.json(),
        );
        if (alive) setCatalog(nextCatalog);
        const snapshotResponse = await fetch(apiBase);
        if (snapshotResponse.ok && alive)
          applySnapshot(
            simulationSnapshotSchema.parse(await snapshotResponse.json()),
          );
      })
      .catch(() => {
        if (alive) setUiError('The model catalog is unavailable.');
      })
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [applySnapshot, providerMode]);

  const refreshCatalog = async () => {
    setCatalogLoading(true);
    try {
      const response = await fetch(`${apiBase}/models/refresh`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('catalog refresh failed');
      setCatalog(modelCatalogResponseSchema.parse(await response.json()));
      const snapshotResponse = await fetch(apiBase);
      if (snapshotResponse.ok)
        applySnapshot(
          simulationSnapshotSchema.parse(await snapshotResponse.json()),
        );
    } catch {
      setUiError(
        'The model catalog refresh failed. A cached catalog may still be available.',
      );
    } finally {
      setCatalogLoading(false);
    }
  };

  const updateModels = async (
    configuration: Omit<ExperimentModelConfiguration, 'locked'>,
  ): Promise<boolean> => {
    if (configurationPendingRef.current) return false;
    configurationPendingRef.current = true;
    setConfigurationPending(true);
    setUiError(null);
    try {
      const response = await fetch(`${apiBase}/experiment/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configuration),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          { error?: { message?: string } } | undefined;
        setUiError(
          payload?.error?.message ?? 'The model assignment was rejected.',
        );
        return false;
      }
      const payload = updateExperimentModelsResponseSchema.parse(
        await response.json(),
      );
      applySnapshot(payload.snapshot);
      return true;
    } catch {
      setUiError('The model assignment could not be saved.');
      return false;
    } finally {
      configurationPendingRef.current = false;
      setConfigurationPending(false);
    }
  };

  const verifyModel = async (
    modelId: string,
    reasoningProfile: ReasoningProfile,
    force = false,
  ) => {
    setVerifyingModelId(modelId);
    setUiError(null);
    try {
      const response = await fetch(`${apiBase}/models/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, reasoningProfile, force }),
      });
      const body = await response.json();
      if (!response.ok) {
        const error = body as { error?: { message?: string } };
        setUiError(error.error?.message ?? 'The compatibility test failed.');
        return;
      }
      const { verification } = verifyModelResponseSchema.parse(body);
      setModelVerifications((current) => ({
        ...current,
        [`${verification.modelId}:${verification.reasoningProfile}`]:
          verification,
      }));
    } catch {
      setUiError('The compatibility test could not be completed.');
    } finally {
      setVerifyingModelId(null);
    }
  };

  const executeTurn = useCallback(async () => {
    if (inFlightRef.current) return;
    if (
      boundedRunTargetRef.current !== null &&
      completedTurnsRef.current >= boundedRunTargetRef.current
    ) {
      setRunning(false);
      setBoundedRunTarget(null);
      boundedRunTargetRef.current = null;
      return;
    }
    inFlightRef.current = true;
    setInFlight(true);
    setUiError(null);
    try {
      mutationSequenceRef.current += 1;
      const mutationId = `mutation_${Date.now()}_${mutationSequenceRef.current}`;
      const turnPath = `${apiBase}/tick`;
      const response = await fetch(
        `${turnPath}?mutationId=${encodeURIComponent(mutationId)}`,
        { method: 'POST' },
      );
      if (response.status === 409) {
        const error = (await response.json().catch(() => undefined)) as
          { error?: { code?: string; message?: string } } | undefined;
        const budgetExhausted =
          error?.error?.code === 'experiment_budget_exhausted';
        setUiError(
          budgetExhausted
            ? 'The experiment provider-attempt limit is exhausted. Reset or apply a new World Setup to continue.'
            : 'Another tick is already in progress.',
        );
        runningRef.current = false;
        setRunning(false);
        setBoundedRunTarget(null);
        boundedRunTargetRef.current = null;
        if (budgetExhausted) {
          try {
            await reconcileAuthoritativeSnapshot();
          } catch {
            setUiError(
              'The provider-attempt limit was reached, but the authoritative snapshot could not be refreshed. Refresh before retrying.',
            );
          }
        }
        return;
      }
      if (!response.ok) throw new Error('tick request failed');
      const body: unknown = await response.json();
      const cancellation = cancelledTickResponseSchema.safeParse(body);
      if (cancellation.success) {
        applySnapshot(cancellation.data.snapshot);
        setUiError('The request was cancelled without consuming a tick.');
        return;
      }
      const payload = singleTickResponseSchema.parse(body);
      applySnapshot(payload.snapshot);
      if (payload.swarmTick?.plannerFailure)
        setRecoveryNotice(
          'Agent Zero fell back to the deterministic directive plan for this tick.',
        );
    } catch {
      setUiError('The response was lost. Reconciling with the Game API…');
      try {
        await reconcileAuthoritativeSnapshot();
        setUiError(null);
      } catch {
        runningRef.current = false;
        setRunning(false);
        setBoundedRunTarget(null);
        boundedRunTargetRef.current = null;
        setUiError(
          'The authoritative state could not be reconciled. Refresh before retrying.',
        );
      }
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [applySnapshot, reconcileAuthoritativeSnapshot]);

  const cancelCurrentRequest = async () => {
    setCancelling(true);
    runningRef.current = false;
    setRunning(false);
    setBoundedRunTarget(null);
    boundedRunTargetRef.current = null;
    try {
      const response = await fetch(`${apiBase}/tick/cancel`, {
        method: 'POST',
      });
      const body = await response.json();
      if (!response.ok) {
        const error = body as { error?: { message?: string } };
        setUiError(
          error.error?.message ?? 'The request could not be cancelled.',
        );
        return;
      }
      applySnapshot(cancelSimulationResponseSchema.parse(body).snapshot);
    } catch {
      setUiError('The cancellation request could not reach the Game API.');
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!running || inFlight || resetting) return;
    if (
      boundedRunTargetRef.current !== null &&
      completedTurnsRef.current >= boundedRunTargetRef.current
    )
      return;
    const timer = window.setTimeout(() => void executeTurn(), speed);
    return () => window.clearTimeout(timer);
  }, [executeTurn, inFlight, resetting, running, snapshot, speed]);

  useEffect(() => {
    if (snapshot?.status !== 'waiting-for-model' || inFlight) return;
    const timer = window.setInterval(() => {
      void fetch(apiBase)
        .then(async (response) => {
          if (!response.ok) return;
          applySnapshot(simulationSnapshotSchema.parse(await response.json()));
        })
        .catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [applySnapshot, inFlight, snapshot?.status]);

  const reset = async () => {
    if (inFlightRef.current) return;
    if (
      snapshot &&
      snapshot.tickNumber > 0 &&
      !window.confirm(
        `Reset World will discard ${snapshot.tickNumber} completed ticks and all unexported telemetry. Continue?`,
      )
    )
      return;
    runningRef.current = false;
    setRunning(false);
    setBoundedRunTarget(null);
    boundedRunTargetRef.current = null;
    setResetting(true);
    setUiError(null);
    try {
      const response = await fetch(`${apiBase}/reset`, { method: 'POST' });
      if (response.status === 409) {
        setUiError('Reset is unavailable until the current tick completes.');
        return;
      }
      if (!response.ok) throw new Error('reset request failed');
      const payload = resetSimulationResponseSchema.parse(
        await response.json(),
      );
      completedTurnsRef.current = payload.snapshot.tickNumber;
      setSnapshot(payload.snapshot);
      setSelectedCell(null);
      setSelectedAgentId((selected) =>
        payload.snapshot.world.agents.some(({ id }) => id === selected)
          ? selected
          : (payload.snapshot.world.agents[0]?.id ?? null),
      );
    } catch {
      setUiError('Reset failed safely. The existing world was left intact.');
    } finally {
      setResetting(false);
    }
  };

  const fullyInfected =
    snapshot?.world.hexes.every(({ state }) => state === 'infected') ?? false;
  if (!snapshot) {
    return (
      <main className="loading-state">
        <h1>World Lab</h1>
        <p role="alert">{uiError ?? 'Loading simulation…'}</p>
      </main>
    );
  }

  const inspectionAgentId = selectedAgentId;
  const selectedAgent = snapshot.world.agents.find(
    ({ id }) => id === inspectionAgentId,
  );
  const selectAgentForInspection = (agentId: AgentId) => {
    setSelectedAgentId(agentId);
    setInspectorTab('agent');
  };
  const selectedHex = snapshot.world.hexes.find(
    ({ cell }) => cell === selectedCell,
  );
  const selectedHexController =
    selectedHex?.state === 'infected'
      ? snapshot.world.agents.find(
          ({ id }) => id === selectedHex.controllerAgentId,
        )
      : undefined;
  const status = resetting
    ? 'resetting'
    : reconciling
      ? 'reconciling-request'
      : inFlight
        ? 'waiting-for-model'
        : snapshot.status === 'patient-zero-captured' ||
            snapshot.status === 'infection-eliminated' ||
            snapshot.status === 'waiting-for-model' ||
            snapshot.status === 'configuration-error' ||
            snapshot.status === 'provider-error' ||
            snapshot.status === 'budget-exhausted'
          ? snapshot.status
          : running
            ? 'running'
            : 'paused';
  const activeTick = snapshot.status === 'waiting-for-model';
  const terminal =
    snapshot.status === 'patient-zero-captured' ||
    snapshot.status === 'infection-eliminated';
  const zeroAgentId = snapshot.scenario.patientZeroAgentId;
  const zeroModel = snapshot.resolvedModels.find(
    ({ agentId }) => agentId === zeroAgentId,
  );
  const exportMutationPending =
    running ||
    inFlight ||
    resetting ||
    snapshot.activeAgentId !== null ||
    activeTick;
  const modelsReady = Boolean(zeroModel?.available);
  const executionReady = modelsReady;

  return (
    <main
      className={`world-lab-shell${chatCollapsed ? ' chat-collapsed' : ''}`}
    >
      <header className="command-navbar" aria-label="World Lab command bar">
        <div className="command-brand">
          <span className="project-mark" aria-hidden="true">
            WL
          </span>
          <div>
            <p className="eyebrow">Swarm experiment</p>
            <h1>World Lab</h1>
          </div>
          <nav className="workspace-switcher" aria-label="World Lab workspaces">
            <button
              type="button"
              aria-current={workspaceView === 'live' ? 'page' : undefined}
              onClick={() => setWorkspaceView('live')}
            >
              Live
            </button>
            <button
              type="button"
              aria-current={workspaceView === 'agents' ? 'page' : undefined}
              onClick={() => setWorkspaceView('agents')}
            >
              Agents
            </button>
          </nav>
        </div>
        <div className="status-popover">
          <button
            type="button"
            aria-label={`Experiment details. Tick ${snapshot.tickNumber}, ${status.replaceAll('-', ' ')}`}
          >
            <span className={`status-dot ${status}`} aria-hidden="true" />
            <strong>
              Tick {snapshot.tickNumber}
              {boundedRunTarget !== null && ` / ${boundedRunTarget}`}
            </strong>
            <span className="navbar-cost">
              {formatCost(
                snapshot.experiment.attemptAccounting.committedCreditExposure,
              )}
            </span>
          </button>
          <div className="command-popover experiment-details">
            <h2>Current experiment</h2>
            <dl>
              <div>
                <dt>State</dt>
                <dd>{status.replaceAll('-', ' ')}</dd>
              </div>
              <div>
                <dt>Retained swarm ticks</dt>
                <dd>{snapshot.swarmTicks?.length ?? 0}</dd>
              </div>
              <div>
                <dt>Provider attempts</dt>
                <dd>
                  {snapshot.experiment.attemptAccounting.attemptsStarted} /{' '}
                  {snapshot.experiment.attemptAccounting.providerAttemptLimit ??
                    'Unlimited'}
                </dd>
              </div>
              <div>
                <dt>In flight / reserved</dt>
                <dd>
                  {snapshot.experiment.attemptAccounting.attemptsInFlight} /{' '}
                  {snapshot.experiment.attemptAccounting.reservedPermits}
                </dd>
              </div>
              <div>
                <dt>Admission exposure (not spend)</dt>
                <dd>
                  {formatCost(
                    snapshot.experiment.attemptAccounting
                      .committedCreditExposure,
                  )}{' '}
                  /{' '}
                  {snapshot.experiment.attemptAccounting.creditLimit === null
                    ? 'Unlimited'
                    : formatCost(
                        snapshot.experiment.attemptAccounting.creditLimit,
                      )}
                </dd>
              </div>
              <div>
                <dt>Unstarted reserved credits</dt>
                <dd>
                  {formatCost(
                    snapshot.experiment.attemptAccounting
                      .unstartedReservedCredits,
                  )}
                </dd>
              </div>
              <div>
                <dt>Provider-reported cost</dt>
                <dd>
                  {formatCost(
                    snapshot.experiment.attemptAccounting
                      .knownFinalizedCostCredits,
                  )}
                </dd>
              </div>
              <div>
                <dt>Unknown-cost attempts</dt>
                <dd>
                  {
                    snapshot.experiment.attemptAccounting
                      .attemptsWithUnknownCost
                  }
                </dd>
              </div>
              {snapshot.experiment.attemptAccounting
                .reservationOverageCredits !== '0' && (
                <div>
                  <dt>Reservation overage</dt>
                  <dd>
                    {formatCost(
                      snapshot.experiment.attemptAccounting
                        .reservationOverageCredits,
                    )}
                  </dd>
                </div>
              )}
              {snapshot.experiment.attemptAccounting.exhaustionReason && (
                <div>
                  <dt>Execution limit</dt>
                  <dd>
                    {attemptExhaustionLabel(
                      snapshot.experiment.attemptAccounting.exhaustionReason,
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <p className="field-help">
              Jev reports tokens but no monetary cost. Its unknown-cost attempts
              retain the configured admission reserve in exposure; that reserve
              is not a provider bill. The reported cost above includes
              OpenRouter amounts only when returned by the provider.
            </p>
          </div>
        </div>
        <button
          className="execution-mode-button"
          ref={modeTriggerRef}
          type="button"
          disabled={inFlight || activeTick || resetting || running}
          aria-label="Current swarm architecture"
          onClick={() => {
            setSetupOpenedFromMode(true);
            setSetupOpen(true);
          }}
        >
          <strong>Architecture: zero-swarm-v1</strong>
          <span className="test-provider-summary">
            {`Zero: ${zeroModel?.modelId ?? 'model required'} · Jev: ${snapshot.swarmProviderStatus?.reflexModel ?? 'deterministic reflex'}`}
          </span>
        </button>
        <nav
          className="command-controls"
          aria-label="Simulation execution controls"
        >
          {running ? (
            <button
              className="primary-command labeled-command"
              aria-label="Pause"
              title="Pause simulation"
              type="button"
              onClick={() => {
                runningRef.current = false;
                setRunning(false);
                setBoundedRunTarget(null);
                boundedRunTargetRef.current = null;
              }}
            >
              <CommandIcon name="pause" />
              <span>Pause</span>
            </button>
          ) : (
            <button
              className="primary-command labeled-command"
              aria-label="Start"
              title="Start simulation"
              disabled={
                inFlight ||
                activeTick ||
                fullyInfected ||
                terminal ||
                !executionReady ||
                snapshot.experiment.attemptAccounting.exhausted ||
                snapshot.status === 'budget-exhausted'
              }
              type="button"
              onClick={() => {
                runningRef.current = true;
                setRunning(true);
              }}
            >
              <CommandIcon name="play" />
              <span>Start</span>
            </button>
          )}
          <button
            className="labeled-command"
            aria-label="Single tick"
            aria-busy={inFlight}
            title="Request one decision from every active agent"
            disabled={
              inFlight ||
              activeTick ||
              running ||
              terminal ||
              !executionReady ||
              snapshot.experiment.attemptAccounting.exhausted ||
              snapshot.status === 'budget-exhausted'
            }
            type="button"
            onClick={() => void executeTurn()}
          >
            {inFlight ? <Spinner /> : <CommandIcon name="step" />}
            <span>Single tick</span>
          </button>
          <label className="run-target-control">
            <span className="sr-only">Tick target</span>
            <CommandIcon name="target" />
            <select
              aria-label="Tick target"
              value={runTarget}
              disabled={
                boundedRunTarget !== null || running || inFlight || activeTick
              }
              onChange={(event) =>
                setRunTarget(
                  Number(event.target.value) as (typeof runTargets)[number],
                )
              }
            >
              {runTargets.map((target) => (
                <option
                  key={target}
                  value={target}
                  disabled={target <= snapshot.tickNumber}
                >
                  {target}
                </option>
              ))}
            </select>
          </label>
          <label className="speed-control compact-speed-control">
            <span>Speed</span>
            <select
              aria-label="Playback speed"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              <option value={2_000}>0.5×</option>
              <option value={1_000}>1×</option>
              <option value={250}>4×</option>
            </select>
          </label>
          {boundedRunTarget === null ? (
            <button
              className="run-command"
              disabled={
                running ||
                inFlight ||
                activeTick ||
                resetting ||
                !executionReady ||
                fullyInfected ||
                snapshot.tickNumber >= runTarget
              }
              type="button"
              onClick={() => {
                boundedRunTargetRef.current = runTarget;
                setBoundedRunTarget(runTarget);
                runningRef.current = true;
                setRunning(true);
              }}
            >
              Run to tick {runTarget}
            </button>
          ) : (
            <button
              className="cancel-run-command"
              type="button"
              disabled={cancelling}
              aria-busy={cancelling}
              onClick={() => {
                runningRef.current = false;
                setRunning(false);
                setBoundedRunTarget(null);
                boundedRunTargetRef.current = null;
                if (inFlight || activeTick) void cancelCurrentRequest();
              }}
            >
              {cancelling ? (
                <>
                  <Spinner /> Cancelling…
                </>
              ) : (
                'Cancel run'
              )}
            </button>
          )}
          <span
            className={`cancel-request-slot${
              inFlight || activeTick ? '' : ' inactive'
            }`}
          >
            <button
              className="secondary-action"
              aria-hidden={!(inFlight || activeTick)}
              disabled={
                cancelling ||
                snapshot.cancellationRequested ||
                !(inFlight || activeTick)
              }
              tabIndex={inFlight || activeTick ? undefined : -1}
              type="button"
              onClick={() => void cancelCurrentRequest()}
            >
              {snapshot.cancellationRequested || cancelling
                ? 'Cancel…'
                : 'Cancel'}
            </button>
          </span>
          <span className="cost-warning">
            Each tick requests every active agent and may incur provider cost.
          </span>
        </nav>
        <details className="overflow-menu" ref={overflowMenuRef}>
          <summary
            ref={setupTriggerRef}
            aria-label="More World Lab actions"
            title="More actions"
          >
            <CommandIcon name="more" />
          </summary>
          <div className="command-popover overflow-content">
            <button
              type="button"
              aria-label="World setup"
              disabled={inFlight || activeTick || resetting || running}
              onClick={() => {
                if (overflowMenuRef.current)
                  overflowMenuRef.current.open = false;
                setSetupOpenedFromMode(false);
                setSetupOpen(true);
              }}
            >
              <CommandIcon name="map" />
              <span>World setup</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (overflowMenuRef.current)
                  overflowMenuRef.current.open = false;
                setWorkspaceView('agents');
              }}
            >
              Agent setup
            </button>
            <button
              type="button"
              data-export-trigger
              ref={exportTriggerRef}
              onClick={() => {
                if (overflowMenuRef.current)
                  overflowMenuRef.current.open = false;
                setExportOpen(true);
              }}
            >
              <CommandIcon name="export" />
              Export
            </button>
            <div className="destructive-actions">
              <button
                className="destructive-command"
                aria-busy={resetting}
                disabled={inFlight || activeTick || resetting}
                type="button"
                onClick={() => void reset()}
              >
                {resetting ? <Spinner /> : <CommandIcon name="reset" />}
                Reset world
              </button>
            </div>
          </div>
        </details>
      </header>
      <div className="command-alerts">
        {recoveryNotice && (
          <div className="command-alert recovery-notice" role="status">
            {recoveryNotice}
          </div>
        )}
        {(!modelsReady || uiError || fullyInfected || terminal) && (
          <div className="command-alert" role="alert">
            {uiError ??
              (fullyInfected
                ? 'Development world fully infected. Automatic playback is paused; Single tick remains a manual cost-incurring diagnostic action.'
                : terminal
                  ? snapshot.status === 'patient-zero-captured'
                    ? 'Patient Zero was captured by the simulated player. This experiment is complete; reset or apply a new World Setup to run again.'
                    : 'All infection has been eliminated. This experiment is complete; reset or apply a new World Setup to run again.'
                  : 'Select an available model for Agent Zero before starting.')}
          </div>
        )}
        {snapshot.swarmProviderStatus &&
          (!snapshot.swarmProviderStatus.plannerConfigured ||
            !snapshot.swarmProviderStatus.reflexConfigured) && (
            <div className="command-alert" role="status">
              {!snapshot.swarmProviderStatus.plannerConfigured &&
              !snapshot.swarmProviderStatus.reflexConfigured
                ? 'Agent Zero and Jev use deterministic fallback while provider credentials are unavailable.'
                : !snapshot.swarmProviderStatus.plannerConfigured
                  ? 'Agent Zero uses deterministic fallback while planner credentials are unavailable.'
                  : 'Jev uses deterministic fallback while reflex credentials are unavailable.'}
            </div>
          )}
      </div>

      <ExperimentExportPanel
        disabled={exportMutationPending}
        open={exportOpen}
        onOpenChange={setExportOpen}
        returnFocusRef={exportTriggerRef}
      />
      {setupOpen && (
        <WorldSetupPanel
          open
          snapshot={snapshot}
          apiBase={apiBase}
          returnFocusRef={
            setupOpenedFromMode ? modeTriggerRef : setupTriggerRef
          }
          onClose={() => setSetupOpen(false)}
          onApplied={(next) => {
            applySnapshot(next);
            setSelectedCell(null);
            setSetupOpen(false);
          }}
        />
      )}

      {workspaceView === 'live' ? (
        <>
          <div className="workspace operator-workspace">
            <AgentRoster
              snapshot={snapshot}
              selectedAgentId={inspectionAgentId}
              onSelect={selectAgentForInspection}
            />
            <section className="map-panel" aria-label="Development world map">
              <WorldMap
                latitude={snapshot.scenario.center.latitude}
                longitude={snapshot.scenario.center.longitude}
                hexes={snapshot.world.hexes}
                agents={snapshot.world.agents}
                patientZeroAgentId={snapshot.scenario.patientZeroAgentId}
                simulatedPlayer={snapshot.world.simulatedPlayer}
                selectedCell={selectedCell}
                selectedAgentId={inspectionAgentId}
                onSelectCell={(cell) => {
                  setSelectedCell(cell);
                  setInspectorTab('hex');
                }}
                onClearCellSelection={() => setSelectedCell(null)}
                onSelectAgent={(agentId) => {
                  setSelectedCell(null);
                  selectAgentForInspection(agentId);
                }}
              />
              <div className="map-caption">
                <span>
                  Development location:{' '}
                  {snapshot.scenario.locationLabel ??
                    `${snapshot.scenario.center.latitude}, ${snapshot.scenario.center.longitude}`}
                </span>
                <span>
                  H3 resolution {snapshot.scenario.resolution} ·{' '}
                  {snapshot.scenario.exactCellCount} cells ·{' '}
                  {snapshot.scenario.areaSquareKilometers.toFixed(2)} km²
                </span>
              </div>
            </section>

            <aside className="sidebar details-sidebar operator-inspector">
              <div className="inspector-heading">
                <div>
                  <p className="panel-kicker">Context</p>
                  <h2>Inspector</h2>
                </div>
              </div>
              <div
                className="tab-list"
                role="tablist"
                aria-label="Inspector views"
              >
                {(['scoreboard', 'agent', 'hex', 'run'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={inspectorTab === tab}
                    aria-controls={`inspector-${tab}`}
                    disabled={
                      (tab === 'agent' && !selectedAgent) ||
                      (tab === 'hex' && !selectedHex)
                    }
                    onClick={() => setInspectorTab(tab)}
                  >
                    {tab[0]!.toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
              <div
                className="inspector-tabpanel"
                role="tabpanel"
                id={`inspector-${inspectorTab}`}
              >
                {inspectorTab === 'agent' && selectedAgent && (
                  <SwarmAgentInspector
                    snapshot={snapshot}
                    agent={selectedAgent}
                    cellState={
                      snapshot.world.hexes.find(
                        ({ cell }) => cell === selectedAgent.currentCell,
                      )!.state
                    }
                    controlledCellCount={
                      snapshot.experiment.currentTerritory.find(
                        ({ agentId }) => agentId === selectedAgent.id,
                      )?.controlledCellCount ?? 0
                    }
                    onHighlightCell={setSelectedCell}
                  />
                )}
                {inspectorTab === 'hex' && selectedHex && (
                  <HexInspector
                    hex={selectedHex}
                    controller={selectedHexController}
                    selectedAgent={selectedAgent}
                  />
                )}
                {inspectorTab === 'scoreboard' && (
                  <SwarmStrategyPanel
                    snapshot={snapshot}
                    onSelectAgent={selectAgentForInspection}
                  />
                )}
                {inspectorTab === 'run' && (
                  <SwarmRunPanel
                    snapshot={snapshot}
                    status={status}
                    runTarget={boundedRunTarget ?? runTarget}
                  />
                )}
              </div>
            </aside>
          </div>
          <section
            className="bottom-dock activity-dock"
            aria-label="Activity dock"
          >
            <div className="activity-dock-header">
              <span className="panel-kicker">Swarm activity</span>
              <button
                type="button"
                aria-expanded={!chatCollapsed}
                onClick={() => setChatCollapsed((collapsed) => !collapsed)}
              >
                {chatCollapsed ? 'Expand activity' : 'Collapse activity'}
              </button>
            </div>
            {!chatCollapsed && <SwarmActivityPanel snapshot={snapshot} />}
          </section>
        </>
      ) : (
        <AgentsWorkspace
          snapshot={snapshot}
          selectedAgentId={inspectionAgentId}
          onSelectAgent={selectAgentForInspection}
          onOpenWorldSetup={() => setSetupOpen(true)}
        >
          <ModelConsole
            catalog={catalog}
            loading={catalogLoading || catalog === null}
            snapshot={snapshot}
            disabled={
              running ||
              inFlight ||
              resetting ||
              snapshot.activeAgentId !== null ||
              activeTick ||
              verifyingModelId !== null ||
              configurationPending
            }
            verifications={modelVerifications}
            verifyingModelId={verifyingModelId}
            onRefresh={refreshCatalog}
            onUpdate={updateModels}
            onVerify={verifyModel}
          />
          {selectedAgent && (
            <SwarmAgentInspector
              snapshot={snapshot}
              agent={selectedAgent}
              cellState={
                snapshot.world.hexes.find(
                  ({ cell }) => cell === selectedAgent.currentCell,
                )!.state
              }
              controlledCellCount={
                snapshot.experiment.currentTerritory.find(
                  ({ agentId }) => agentId === selectedAgent.id,
                )?.controlledCellCount ?? 0
              }
            />
          )}
        </AgentsWorkspace>
      )}
    </main>
  );
}

function AgentsWorkspace({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  onOpenWorldSetup,
  children,
}: {
  snapshot: SimulationSnapshot;
  selectedAgentId: AgentId | null;
  onSelectAgent: (agentId: AgentId) => void;
  onOpenWorldSetup: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className="agents-workspace"
      aria-label="Agent management workspace"
    >
      <AgentRoster
        snapshot={snapshot}
        selectedAgentId={selectedAgentId}
        onSelect={onSelectAgent}
      />
      <div className="agents-configuration">
        <header className="workspace-heading">
          <div>
            <p className="panel-kicker">Experiment assignments</p>
            <h2>Agent configuration</h2>
            <p className="muted">
              The Agent Zero planner model applies through the
              server-authoritative configuration boundary. Jev workers run the
              runtime reflex model.
            </p>
          </div>
          <button type="button" onClick={onOpenWorldSetup}>
            Replace roster in World setup
          </button>
        </header>
        {children}
      </div>
    </section>
  );
}

function HexInspector({
  hex,
  controller,
  selectedAgent,
}: {
  hex: SimulationSnapshot['world']['hexes'][number];
  controller?: SimulationSnapshot['world']['agents'][number];
  selectedAgent?: SimulationSnapshot['world']['agents'][number];
}) {
  const relationship = !selectedAgent
    ? 'No agent selected'
    : controller?.id === selectedAgent.id
      ? 'Controlled by selected agent'
      : controller
        ? 'Controlled by another agent'
        : 'Open';
  return (
    <section
      className="panel compact-inspector"
      aria-label="Selected hex details"
    >
      <p className="panel-kicker">Authoritative cell</p>
      <h2>{hex.cell}</h2>
      <dl className="operator-facts">
        <div>
          <dt>State</dt>
          <dd>{hex.state}</dd>
        </div>
        <div>
          <dt>Controller</dt>
          <dd>
            {controller?.name ??
              (hex.state === 'infected' ? 'Abandoned infection' : 'None')}
          </dd>
        </div>
        <div>
          <dt>Relationship</dt>
          <dd>{relationship}</dd>
        </div>
      </dl>
    </section>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function CommandIcon({
  name,
}: {
  name:
    'play' | 'pause' | 'step' | 'reset' | 'target' | 'map' | 'export' | 'more';
}) {
  const path = {
    play: 'M8 5v14l11-7z',
    pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
    step: 'M6 5v14l9-7zm10 0h3v14h-3z',
    reset: 'M6.3 7.8A7 7 0 1 1 5 14h2a5 5 0 1 0 1-3l3 3H4V7z',
    target:
      'M12 2v3m0 14v3M2 12h3m14 0h3m-5 0a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-3 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
    map: 'M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20zm5.5-2.5v13.5m7-11V20',
    export: 'M12 3v12m-5-5 5 5 5-5M5 17v3h14v-3',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
  }[name];
  return (
    <svg
      className="command-icon"
      data-icon={name}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function WorldSetupPanel({
  open,
  snapshot,
  apiBase,
  returnFocusRef,
  onClose,
  onApplied,
}: {
  open: boolean;
  snapshot: SimulationSnapshot;
  apiBase: string;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
  onApplied: (snapshot: SimulationSnapshot) => void;
}) {
  const initialDraft = useMemo<WorldSetupRequest>(() => {
    const scenario = snapshot.scenario;
    return structuredClone({
      scenarioVersion: scenario.scenarioVersion,
      swarmArchitectureVersion: scenario.swarmArchitectureVersion,
      locationLabel: scenario.locationLabel,
      center: scenario.center,
      resolution: scenario.resolution,
      radius: scenario.radius,
      worldSeed: scenario.worldSeed,
      rosterSeed: scenario.rosterSeed,
      spawnSeed: scenario.spawnSeed,
      minimumSpawnSeparation: scenario.minimumSpawnSeparation,
      minimumTickIntervalMinutes: scenario.minimumTickIntervalMinutes,
      maximumTickIntervalMinutes: scenario.maximumTickIntervalMinutes,
      patientZeroAgentId: scenario.patientZeroAgentId,
      roster: scenario.roster,
      modelConfiguration: scenario.modelConfiguration,
      objectiveVersion: scenario.objectiveVersion,
      capabilities: scenario.capabilities,
      simulatedPlayer: scenario.simulatedPlayer,
      executionLimits: scenario.executionLimits,
    });
  }, [snapshot.scenario]);
  const [draft, setDraft] = useState(initialDraft);
  const [preview, setPreview] = useState<WorldSetupPreviewResponse | null>(
    null,
  );
  const [previewKey, setPreviewKey] = useState('');
  const [pending, setPending] = useState<
    'preview' | 'apply' | 'roster' | 'search' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [desiredAgentCount, setDesiredAgentCount] = useState(
    initialDraft.roster.length,
  );
  const [locations, setLocations] = useState<
    Array<{ label: string; latitude: number; longitude: number }>
  >([]);
  const key = JSON.stringify(draft);
  const fresh = previewKey === key;
  const replaceRoster = (roster: WorldSetupRequest['roster']) =>
    setDraft((current) => {
      const ids = new Set(roster.map(({ id }) => id));
      return {
        ...current,
        roster,
        patientZeroAgentId:
          current.patientZeroAgentId && ids.has(current.patientZeroAgentId)
            ? current.patientZeroAgentId
            : roster[0]!.id,
        modelConfiguration: {
          ...current.modelConfiguration,
          overrides: current.modelConfiguration.overrides.filter(
            ({ agentId }) => ids.has(agentId),
          ),
        },
      };
    });
  const generateRoster = async (count: number, appendOnly = false) => {
    setPending('roster');
    setError(null);
    try {
      const response = await fetch(
        `${apiBase}/experiment/setup/roster/generate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ count, seed: draft.rosterSeed }),
        },
      );
      if (!response.ok) throw new Error('Roster generation failed.');
      const generated = generatedAgentResponseSchema.parse(
        await response.json(),
      ).roster;
      replaceRoster(
        appendOnly ? [...draft.roster, generated.at(-1)!] : generated,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Roster generation failed.',
      );
    } finally {
      setPending(null);
    }
  };
  const doPreview = async () => {
    setPending('preview');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/experiment/setup/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: key,
      });
      if (!response.ok) throw new Error('Scenario preview failed.');
      setPreview(worldSetupPreviewResponseSchema.parse(await response.json()));
      setPreviewKey(key);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Scenario preview failed.',
      );
    } finally {
      setPending(null);
    }
  };
  const apply = async () => {
    if (!preview?.feasible || !fresh) return;
    if (
      snapshot.tickNumber > 0 &&
      !window.confirm(
        'Create a new experiment and discard non-exported telemetry?',
      )
    )
      return;
    setPending('apply');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/experiment/setup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hexzero-mutation-id': `setup-${Date.now()}`,
        },
        body: key,
      });
      if (!response.ok) throw new Error('Scenario application failed.');
      onApplied(
        applyWorldSetupResponseSchema.parse(await response.json()).snapshot,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Scenario application failed.',
      );
    } finally {
      setPending(null);
    }
  };
  const search = async () => {
    setPending('search');
    setError(null);
    try {
      const response = await fetch(
        `${apiBase}/experiment/setup/location-search`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        },
      );
      if (!response.ok) throw new Error('Location search failed.');
      const result = locationSearchResponseSchema.parse(await response.json());
      setLocations(result.results);
      if (result.warning) setError(result.warning.message);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Location search failed.',
      );
    } finally {
      setPending(null);
    }
  };
  const restoreDefault = async () => {
    setPending('roster');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/experiment/setup/default`);
      if (!response.ok) throw new Error('Default scenario is unavailable.');
      setDraft(
        defaultWorldSetupResponseSchema.parse(await response.json()).request,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Default scenario is unavailable.',
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <DialogShell
      open={open}
      title="World Setup"
      description="Create a reproducible authoritative experiment."
      label="World Setup"
      className="world-setup-dialog"
      returnFocusRef={returnFocusRef}
      onClose={pending === 'apply' ? () => {} : onClose}
      footer={
        <>
          <button
            type="button"
            onClick={() => void doPreview()}
            disabled={pending !== null}
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={pending !== null || !fresh || !preview?.feasible}
          >
            {pending === 'apply' ? 'Applying…' : 'Apply / Create Experiment'}
          </button>
        </>
      }
    >
      <section className="setup-section">
        <h3>Swarm architecture</h3>
        <p className="field-help">
          Agent Zero plans for the swarm and Jev workers execute local legal
          actions. Preview and apply to create a new experiment.
        </p>
      </section>
      <section className="setup-section">
        <h3>World</h3>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void restoreDefault()}
        >
          Restore Default Scenario
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label>
            Location search
            <input
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button disabled={pending !== null || query.trim().length < 2}>
            Search
          </button>
        </form>
        {locations.length > 0 && (
          <div>
            <p>© OpenStreetMap contributors</p>
            {locations.map((location) => (
              <button
                type="button"
                key={`${location.latitude}:${location.longitude}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    locationLabel: location.label,
                    center: {
                      latitude: location.latitude,
                      longitude: location.longitude,
                    },
                  }))
                }
              >
                {location.label}
              </button>
            ))}
          </div>
        )}
        <div className="setup-grid">
          <label>
            Latitude
            <input
              type="number"
              step="any"
              value={draft.center.latitude}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  center: {
                    ...draft.center,
                    latitude: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            Longitude
            <input
              type="number"
              step="any"
              value={draft.center.longitude}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  center: {
                    ...draft.center,
                    longitude: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            H3 resolution
            <select
              value={draft.resolution}
              onChange={(event) =>
                setDraft({ ...draft, resolution: Number(event.target.value) })
              }
            >
              {[8, 9, 10, 11].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Radius
            <select
              value={draft.radius}
              onChange={(event) =>
                setDraft({ ...draft, radius: Number(event.target.value) })
              }
            >
              {Object.entries(WORLD_RADIUS_PRESETS).map(([name, preset]) => (
                <option key={name} value={preset.radius}>
                  {name} · normally {preset.expectedCellCount}
                </option>
              ))}
              <option value={draft.radius}>Custom · {draft.radius}</option>
            </select>
          </label>
          <label>
            Custom radius
            <input
              type="number"
              min="0"
              max="40"
              value={draft.radius}
              onChange={(event) =>
                setDraft({ ...draft, radius: Number(event.target.value) })
              }
            />
          </label>
          <label>
            World simulation seed
            <input
              value={draft.worldSeed}
              maxLength={80}
              onChange={(event) =>
                setDraft({ ...draft, worldSeed: event.target.value })
              }
            />
          </label>
          <label>
            Spawn assignment seed
            <input
              value={draft.spawnSeed}
              maxLength={80}
              onChange={(event) =>
                setDraft({ ...draft, spawnSeed: event.target.value })
              }
            />
          </label>
          <label>
            Minimum spawn separation
            <input
              type="number"
              min="0"
              value={draft.minimumSpawnSeparation}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  minimumSpawnSeparation: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Minimum virtual minutes per tick
            <input
              type="number"
              min="1"
              max="60"
              value={draft.minimumTickIntervalMinutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  minimumTickIntervalMinutes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Maximum virtual minutes per tick
            <input
              type="number"
              min="1"
              max="60"
              value={draft.maximumTickIntervalMinutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  maximumTickIntervalMinutes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.executionLimits.providerAttemptLimit === null}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  executionLimits: {
                    ...draft.executionLimits,
                    version: 'execution-limits-v2',
                    providerAttemptLimit: event.target.checked ? null : 1000,
                  },
                })
              }
            />
            Unlimited provider attempts
          </label>
          <label>
            Provider attempt limit
            <input
              type="number"
              min="1"
              max="100000"
              disabled={draft.executionLimits.providerAttemptLimit === null}
              value={draft.executionLimits.providerAttemptLimit ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  executionLimits: {
                    ...draft.executionLimits,
                    version: 'execution-limits-v2',
                    providerAttemptLimit: Number(event.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.executionLimits.creditLimit === null}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  executionLimits: {
                    ...draft.executionLimits,
                    creditLimit: event.target.checked ? null : '1',
                  },
                })
              }
            />
            Unlimited experiment credit admission
          </label>
          <label>
            Experiment credit admission limit
            <input
              type="text"
              inputMode="decimal"
              disabled={draft.executionLimits.creditLimit === null}
              value={draft.executionLimits.creditLimit ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  executionLimits: {
                    ...draft.executionLimits,
                    creditLimit: event.target.value,
                  },
                })
              }
            />
          </label>
          <label>
            Reserved credits per provider attempt
            <input
              type="text"
              inputMode="decimal"
              value={draft.executionLimits.reservationCreditsPerAttempt}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  executionLimits: {
                    ...draft.executionLimits,
                    reservationCreditsPerAttempt: event.target.value,
                  },
                })
              }
            />
          </label>
          <p className="field-help">
            This limits server admission and reserved exposure; it does not
            guarantee the upstream provider bill.
          </p>
          <label>
            <input
              type="checkbox"
              checked={draft.simulatedPlayer.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  simulatedPlayer: {
                    ...draft.simulatedPlayer,
                    enabled: event.target.checked,
                  },
                  capabilities: {
                    ...draft.capabilities,
                    simulatedPlayerPressure: event.target.checked,
                  },
                  objectiveVersion: event.target.checked
                    ? 'durable-influence-v3'
                    : 'durable-influence-v2',
                })
              }
            />
            Enable simulated player pressure
          </label>
          <label>
            Simulated player profile
            <select
              value={draft.simulatedPlayer.profile}
              disabled={!draft.simulatedPlayer.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  simulatedPlayer: {
                    ...draft.simulatedPlayer,
                    profile: event.target.value as
                      'casual-cleaner' | 'trail-hunter-v1',
                  },
                })
              }
            >
              <option value="casual-cleaner">Casual cleaner</option>
              <option value="trail-hunter-v1">Trail hunter v1</option>
            </select>
          </label>
          <label>
            Simulated player seed
            <input
              value={draft.simulatedPlayer.seed}
              maxLength={80}
              disabled={!draft.simulatedPlayer.enabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  simulatedPlayer: {
                    ...draft.simulatedPlayer,
                    seed: event.target.value,
                  },
                })
              }
            />
          </label>
          <label>
            Active objective version (engine-owned)
            <input
              value={draft.objectiveVersion}
              readOnly
              aria-describedby="objective-version-provenance"
            />
          </label>
        </div>
        <p id="objective-version-provenance">
          Engine-owned version provenance. Enabling simulated player pressure
          selects durable-influence-v3; disabling it selects
          durable-influence-v2. This is not a seed and cannot be edited.
        </p>
      </section>
      <section className="setup-section">
        <h3>Roster · {draft.roster.length}</h3>
        <label>
          Desired agent count
          <input
            aria-label="Desired agent count"
            type="number"
            min="1"
            max="32"
            value={desiredAgentCount}
            onChange={(event) =>
              setDesiredAgentCount(Number(event.target.value))
            }
          />
        </label>
        <label>
          Roster generation seed
          <input
            value={draft.rosterSeed}
            maxLength={80}
            onChange={(event) =>
              setDraft({ ...draft, rosterSeed: event.target.value })
            }
          />
        </label>
        <button
          type="button"
          disabled={
            desiredAgentCount < 1 || desiredAgentCount > 32 || pending !== null
          }
          onClick={() => void generateRoster(desiredAgentCount)}
        >
          Generate desired roster
        </button>
        <button
          type="button"
          disabled={draft.roster.length >= 32 || pending !== null}
          onClick={() => void generateRoster(draft.roster.length + 1, true)}
        >
          Add generated agent
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void generateRoster(draft.roster.length)}
        >
          Regenerate roster
        </button>
        <div className="setup-roster">
          {draft.roster.map((agent, index) => (
            <div key={agent.id}>
              <input
                aria-label={`Agent ${index + 1} name`}
                value={agent.name}
                onChange={(event) =>
                  replaceRoster(
                    draft.roster.map((item) =>
                      item.id === agent.id
                        ? { ...item, name: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <span
                aria-label={`${agent.name} starts unaffiliated with neutral color`}
                className="agent-swatch"
                style={{ background: NEUTRAL_AGENT_COLOR }}
              />
              <button
                type="button"
                disabled={draft.roster.length <= 1}
                onClick={() =>
                  replaceRoster(
                    draft.roster.filter(({ id }) => id !== agent.id),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="setup-section">
        <h3>Assignments</h3>
        <label>
          Patient Zero
          <select
            aria-label="Patient Zero"
            value={draft.patientZeroAgentId}
            onChange={(event) =>
              setDraft({
                ...draft,
                patientZeroAgentId: event.target.value as AgentId,
              })
            }
          >
            {draft.roster.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="setup-section">
        <h3>Preview</h3>
        {!fresh && <p>Preview required after setup changes.</p>}
        {fresh && preview?.feasible && (
          <>
            <p>
              {preview.scenario.exactCellCount.toLocaleString()} exact cells ·{' '}
              {preview.scenario.areaSquareKilometers.toFixed(2)} km² ·{' '}
              {preview.scenario.startingCells.length} valid spawns
              {preview.scenario.simulatedPlayer.enabled
                ? ` · 1 seeded ${preview.scenario.simulatedPlayer.profile === 'trail-hunter-v1' ? 'trail hunter' : 'casual cleaner'}`
                : ' · player pressure disabled'}
            </p>
            {preview.scenario.setupWarnings.map((warning) => (
              <p role="status" key={warning.code}>
                {warning.message}
              </p>
            ))}
          </>
        )}
        {fresh &&
          preview &&
          !preview.feasible &&
          preview.errors.map((issue) => (
            <p role="alert" key={issue.code}>
              {issue.message}
            </p>
          ))}
        {error && <p role="alert">{error}</p>}
      </section>
    </DialogShell>
  );
}

function DialogShell({
  open,
  title,
  description,
  label,
  closeLabel,
  className,
  returnFocusRef,
  headerActions,
  footer,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  closeLabel?: string;
  className?: string;
  returnFocusRef?: { current: HTMLElement | null };
  headerActions?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = window.document.body.style.overflow;
    const returnFocusTarget = returnFocusRef?.current;
    window.document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.document.body.style.overflow = previousOverflow;
      window.setTimeout(() => returnFocusTarget?.focus(), 0);
    };
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-panel${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={trapModalFocus}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className="modal-header-actions">
            {headerActions}
            <button
              type="button"
              aria-label={closeLabel ?? `Close ${label}`}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

function ModelConsole({
  catalog,
  loading,
  snapshot,
  disabled,
  verifications,
  verifyingModelId,
  onRefresh,
  onUpdate,
  onVerify,
}: {
  catalog: ModelCatalogResponse | null;
  loading: boolean;
  snapshot: SimulationSnapshot;
  disabled: boolean;
  verifications: Record<string, ModelVerification>;
  verifyingModelId: string | null;
  onRefresh: () => Promise<void>;
  onUpdate: (
    configuration: Omit<ExperimentModelConfiguration, 'locked'>,
  ) => Promise<boolean>;
  onVerify: (
    modelId: string,
    reasoningProfile: ReasoningProfile,
    force?: boolean,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'overview' | 'models'>('models');
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState('');
  const models = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog?.models ?? []).filter(
      ({ id, name, author }) =>
        !query ||
        id.toLowerCase().includes(query) ||
        name.toLowerCase().includes(query) ||
        author.toLowerCase().includes(query),
    );
  }, [catalog, search]);
  const modelOptions = useMemo(() => buildModelOptions(models), [models]);
  const configuration = snapshot.modelConfiguration;
  const zeroAssignment = snapshot.resolvedModels.find(
    ({ agentId }) => agentId === snapshot.scenario.patientZeroAgentId,
  );
  const displayedModelId =
    zeroAssignment?.modelId ?? configuration.globalModelId;
  const displayedReasoningProfile =
    zeroAssignment?.reasoningProfile ?? configuration.globalReasoningProfile;
  const selected = catalog?.models.find(({ id }) => id === displayedModelId);
  const locked = disabled;
  const verification = configuration.globalModelId
    ? verifications[
        `${configuration.globalModelId}:${configuration.globalReasoningProfile}`
      ]
    : undefined;
  const globalReasoningProfiles = reasoningProfilesForModel(selected);

  const save = (next: Omit<ExperimentModelConfiguration, 'locked'>) =>
    void onUpdate(next);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="model-console">
      <button
        className="agent-setup-trigger"
        ref={toggleRef}
        type="button"
        title={`Agent Zero model setup · ${selected?.name ?? displayedModelId ?? 'model needed'}`}
        aria-label={`Open Agent Zero model. Agent Zero model is ${zeroAssignment?.available ? 'ready' : 'not configured'}. Model ${selected?.name ?? displayedModelId ?? 'not selected'}.`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="setup-label">
          Agent Zero model ·{' '}
          {zeroAssignment?.available ? 'Ready' : 'Needs configuration'}
        </span>
        <span className="setup-model">
          Model: {selected?.name ?? displayedModelId ?? 'needed'}
        </span>
      </button>
      <DialogShell
        open={open}
        title="Agent Zero model"
        description={`Agent Zero planner model · ${catalog?.models.length ?? 0} catalog compatible · ${catalog?.filteredOutCount ?? 0} filtered out`}
        label="Agent Zero model selection"
        closeLabel="Close Agent Zero model selection"
        className="model-dialog"
        returnFocusRef={toggleRef}
        onClose={close}
        headerActions={
          <button
            disabled={loading}
            type="button"
            onClick={() => void onRefresh()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      >
        <div
          role="tablist"
          aria-label="Agent Zero model sections"
          className="controller-tabs"
        >
          {(['overview', 'models'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              aria-controls={`controller-${value}`}
              id={`controller-tab-${value}`}
              onClick={() => setTab(value)}
              type="button"
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        {tab === 'overview' && (
          <section
            role="tabpanel"
            id="controller-overview"
            aria-labelledby="controller-tab-overview"
            className="controller-overview"
          >
            {snapshot.world.agents
              .filter(
                (agent) => agent.id === snapshot.scenario.patientZeroAgentId,
              )
              .map((agent) => {
                const resolved = snapshot.resolvedModels.find(
                  ({ agentId }) => agentId === agent.id,
                )!;
                return (
                  <button
                    type="button"
                    key={agent.id}
                    onClick={() => setTab('models')}
                  >
                    <span
                      className="agent-swatch"
                      style={{
                        background: resolveAgentColor(snapshot, agent.id),
                      }}
                    />
                    <strong>Agent Zero</strong>
                    <span>
                      {resolved.modelId ?? 'Model required'} ·{' '}
                      {formatReasoningProfile(resolved.reasoningProfile)}
                    </span>
                    <span>
                      {resolved.available ? 'Ready' : 'Needs configuration'}
                    </span>
                  </button>
                );
              })}
          </section>
        )}
        {tab === 'models' && (
          <section
            role="tabpanel"
            id="controller-models"
            aria-labelledby="controller-tab-models"
          >
            {catalog?.stale && (
              <p className="catalog-state warning">
                Showing the last successful catalog. {catalog.error?.message}
              </p>
            )}
            {loading && !catalog && (
              <p className="catalog-state">Loading compatible models…</p>
            )}
            {!catalog?.stale && catalog?.error && (
              <p className="catalog-state error">{catalog.error.message}</p>
            )}
            {!loading && catalog && catalog.models.length === 0 && (
              <p className="catalog-state">
                No compatible models are currently available.
              </p>
            )}
            <div className="model-filters">
              <label>
                Search
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, slug, or author"
                />
              </label>
            </div>
            <section
              className="model-global-section"
              aria-labelledby="global-model-heading"
            >
              <h3 id="global-model-heading">Agent Zero model</h3>
              <div className="model-global-grid">
                <label className="model-select-label">
                  Zero model
                  <select
                    disabled={locked}
                    value={displayedModelId ?? ''}
                    onChange={(event) =>
                      save({
                        globalModelId: event.target.value || null,
                        globalReasoningProfile: 'provider-default',
                        overrides: [],
                      })
                    }
                  >
                    <option value="">Select a model…</option>
                    {displayedModelId && !selected && (
                      <option value={displayedModelId}>
                        {displayedModelId} — unavailable
                      </option>
                    )}
                    {selected &&
                      !modelOptions.some(
                        ({ value }) => value === selected.id,
                      ) && (
                        <option value={selected.id}>
                          {buildModelOptions([selected])[0]!.label}
                        </option>
                      )}
                    {modelOptions.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="model-select-label">
                  Zero reasoning
                  <select
                    disabled={locked || !selected}
                    value={displayedReasoningProfile}
                    onChange={(event) =>
                      save({
                        globalModelId: displayedModelId,
                        globalReasoningProfile: event.target
                          .value as ReasoningProfile,
                        overrides: [],
                      })
                    }
                  >
                    {!globalReasoningProfiles.includes(
                      displayedReasoningProfile,
                    ) && (
                      <option value={displayedReasoningProfile}>
                        {formatReasoningProfile(displayedReasoningProfile)} —
                        unavailable
                      </option>
                    )}
                    {globalReasoningProfiles.map((profile) => (
                      <option value={profile} key={profile}>
                        {formatReasoningProfile(profile)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
            <div className="model-verification">
              <span>
                Catalog compatible:{' '}
                {selected
                  ? 'yes — required metadata advertised'
                  : 'not selected'}
              </span>
              <span>
                Runtime verified:{' '}
                {verification?.status === 'verified'
                  ? 'yes'
                  : verification?.status === 'failed'
                    ? 'failed'
                    : 'not tested'}
              </span>
              {verification?.failure && (
                <p className="catalog-state error" role="status">
                  {verification.failure.message}
                </p>
              )}
              <button
                disabled={
                  locked ||
                  !configuration.globalModelId ||
                  verifyingModelId === configuration.globalModelId
                }
                type="button"
                onClick={() =>
                  configuration.globalModelId &&
                  void onVerify(
                    configuration.globalModelId,
                    configuration.globalReasoningProfile,
                    verification?.status === 'failed',
                  )
                }
              >
                {verifyingModelId === configuration.globalModelId
                  ? 'Testing model…'
                  : verification?.status === 'failed'
                    ? 'Retry Agent Zero planner test'
                    : 'Test Agent Zero planner'}
              </button>
              <small>
                Sends one genuine, non-mutating OpenRouter request using the
                Agent Zero planner contract and may incur a small charge.
              </small>
            </div>
            {selected && <ModelFacts model={selected} />}
            <p className="catalog-state">
              Model changes are available between provider requests and are
              recorded at the next tick boundary.
            </p>
          </section>
        )}
      </DialogShell>
    </div>
  );
}

function ModelFacts({ model }: { model: CompatibleModel }) {
  return (
    <dl className="model-facts">
      <div>
        <dt>Slug</dt>
        <dd>{model.id}</dd>
      </div>
      <div>
        <dt>Author</dt>
        <dd>{model.author}</dd>
      </div>
      <div>
        <dt>Context</dt>
        <dd>{model.contextLength.toLocaleString()} tokens</dd>
      </div>
      <div>
        <dt>Input</dt>
        <dd>{formatPerMillion(model.inputPricePerToken)}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{formatPerMillion(model.outputPricePerToken)}</dd>
      </div>
      <div>
        <dt>Pricing</dt>
        <dd>{model.isFree ? 'Free' : 'Paid'}</dd>
      </div>
      <div>
        <dt>Capability</dt>
        <dd>Catalog compatible: text and context requirements met</dd>
      </div>
    </dl>
  );
}

function AgentRoster({
  snapshot,
  selectedAgentId,
  onSelect,
}: {
  snapshot: SimulationSnapshot;
  selectedAgentId: AgentId | null;
  onSelect: (agentId: AgentId) => void;
}) {
  return (
    <aside className="agent-roster" aria-label="Agent roster">
      <div className="agent-roster-heading">
        <p className="panel-kicker">Agents</p>
      </div>
      {snapshot.world.agents.map((agent) => {
        const latestSwarmTick = snapshot.swarmTicks?.at(-1);
        const directive =
          latestSwarmTick?.workers.find(({ agentId }) => agentId === agent.id)
            ?.directive ??
          latestSwarmTick?.plan.directives.find(
            ({ agentId }) => agentId === agent.id,
          );
        const resolved = snapshot.resolvedModels.find(
          ({ agentId }) => agentId === agent.id,
        )!;
        return (
          <button
            type="button"
            aria-pressed={selectedAgentId === agent.id}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
          >
            <span
              className="agent-swatch"
              style={{ background: resolveAgentColor(snapshot, agent.id) }}
            />
            <span>
              <span className="agent-row-title">
                <strong>
                  {agent.id === snapshot.scenario.patientZeroAgentId
                    ? 'Zero'
                    : 'Worker'}
                </strong>
                {agent.id === snapshot.scenario.patientZeroAgentId && (
                  <span className="patient-zero-badge">HEX-0</span>
                )}
              </span>
              <small>
                {agent.id === snapshot.scenario.patientZeroAgentId
                  ? 'Swarm planner'
                  : (directive?.mission ?? 'No current directive')}
              </small>
              <small className={resolved.available ? '' : 'unavailable'}>
                {agent.id === snapshot.scenario.patientZeroAgentId
                  ? `Zero model · ${resolved.modelId ?? 'model required'}`
                  : `${snapshot.swarmProviderStatus?.reflexMode === 'scripted-reflex-test' ? 'Scripted reflex' : 'Jev'} · ${snapshot.swarmProviderStatus?.reflexModel ?? 'deterministic reflex'}`}
              </small>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function ExperimentExportPanel({
  disabled,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}) {
  const [serialization, setSerialization] =
    useState<ExperimentExportRequest['serialization']>('compact');
  const [preview, setPreview] = useState<ExperimentExportPreview | null>(null);
  const [document, setDocument] = useState<ExperimentExportDocument | null>(
    null,
  );
  const [generatedRequestJson, setGeneratedRequestJson] = useState<
    string | null
  >(null);
  const [operation, setOperation] = useState<
    'preview' | 'generate' | 'copy' | 'download' | 'sqlite' | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const downloadPendingRef = useRef(false);
  const sqlitePendingRef = useRef(false);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const requestInput = {
    agents: { mode: 'all' as const },
    turns: { mode: 'entire-retained' as const },
    outcomes: [
      'accepted',
      'rejected',
      'lost-tick',
      'provider-error',
      'operator-skipped',
    ] as const,
    actions: ['move', 'infect', 'capture', 'wait'] as const,
    level: 'full-safe' as const,
    serialization,
  };
  const parsedRequest = experimentExportRequestSchema.safeParse(requestInput);
  const pending = operation !== null;
  const generationDisabled = disabled || pending || !parsedRequest.success;
  const currentRequestJson = parsedRequest.success
    ? JSON.stringify(parsedRequest.data)
    : null;
  const documentIsCurrent =
    document !== null && generatedRequestJson === currentRequestJson;
  const generatedArtifactIsStale = document !== null && !documentIsCurrent;

  const requestExport = async (previewOnly: boolean) => {
    if (!parsedRequest.success) return;
    if (operation !== null) return;
    setOperation(previewOnly ? 'preview' : 'generate');
    setNotice(null);
    try {
      const response = await fetch(
        `${apiBase}/experiment/export${previewOnly ? '/preview' : ''}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsedRequest.data),
        },
      );
      if (response.status === 409) {
        setNotice(
          'Pause playback and wait for pending mutations before exporting.',
        );
        return;
      }
      if (!response.ok) throw new Error('export request failed');
      if (previewOnly) {
        setPreview(experimentExportPreviewSchema.parse(await response.json()));
        setNotice(
          'Export preview updated. Generate export to enable copy and download.',
        );
      } else {
        const payload = experimentExportResponseSchema.parse(
          await response.json(),
        );
        setDocument(payload.document);
        setGeneratedRequestJson(JSON.stringify(parsedRequest.data));
        const bytes = new TextEncoder().encode(
          serializeExportDocument(payload.document),
        ).byteLength;
        setNotice(
          `Export ready · schema v${payload.document.schemaVersion} · ${bytes.toLocaleString()} bytes.`,
        );
      }
    } catch {
      setNotice('Export failed safely. Review the selection and try again.');
    } finally {
      setOperation(null);
    }
  };

  const copyJson = async () => {
    if (!document || !documentIsCurrent || operation !== null) return;
    setOperation('copy');
    try {
      await navigator.clipboard.writeText(serializeExportDocument(document));
      setNotice('Export JSON copied to the clipboard.');
    } catch {
      setNotice('Copy failed. Clipboard permission may be unavailable.');
    } finally {
      setOperation(null);
    }
  };

  const downloadJson = async () => {
    if (
      !document ||
      !documentIsCurrent ||
      operation !== null ||
      downloadPendingRef.current
    )
      return;
    downloadPendingRef.current = true;
    setOperation('download');
    try {
      await Promise.resolve();
      const json = serializeExportDocument(document);
      const url = URL.createObjectURL(
        new Blob([json], { type: 'application/json' }),
      );
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `hexzero-experiment-${document.experiment.id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice('Export JSON download started.');
    } catch {
      setNotice('Download failed safely.');
    } finally {
      downloadPendingRef.current = false;
      setOperation(null);
    }
  };

  const saveToSqlite = async () => {
    if (
      !document ||
      !documentIsCurrent ||
      !parsedRequest.success ||
      operation !== null ||
      sqlitePendingRef.current
    )
      return;
    sqlitePendingRef.current = true;
    setOperation('sqlite');
    setNotice(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const sha256 = await sha256Hex(JSON.stringify(document));
      const response = await fetch(`${apiBase}/experiment/export/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: parsedRequest.data,
          generatedAt: document.generatedAt,
          sha256,
        }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        setDocument(null);
        setGeneratedRequestJson(null);
        setNotice(
          'The experiment changed after this export was generated. Generate it again before saving.',
        );
        return;
      }
      if (!response.ok) throw new Error('archive request failed');
      const result = archiveExperimentExportResponseSchema.parse(
        await response.json(),
      );
      setNotice(
        result.idempotent
          ? `Experiment ${result.experimentId} was already saved to SQLite.`
          : `Experiment ${result.experimentId} saved to SQLite · ${result.inserted} imported, ${result.existing} existing, ${result.skipped} skipped.`,
      );
    } catch {
      setNotice(
        'Could not confirm the SQLite save. Retry safely with the same generated export.',
      );
    } finally {
      window.clearTimeout(timeout);
      sqlitePendingRef.current = false;
      setOperation(null);
    }
  };

  return (
    <DialogShell
      open={open}
      title="Experiment Export"
      description="Choose a safe, schema-validated view of retained experiment telemetry."
      label="Experiment export"
      closeLabel="Close export"
      className="export-dialog"
      returnFocusRef={returnFocusRef}
      onClose={close}
      footer={
        <div className="export-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            disabled={generationDisabled}
            aria-busy={operation === 'preview'}
            type="button"
            onClick={() => void requestExport(true)}
          >
            {operation === 'preview' ? 'Previewing…' : 'Preview'}
          </button>
          <button
            className="primary-action"
            disabled={generationDisabled}
            aria-busy={operation === 'generate'}
            type="button"
            onClick={() => void requestExport(false)}
          >
            {operation === 'generate' ? 'Generating…' : 'Generate export'}
          </button>
          <button
            disabled={!documentIsCurrent || pending}
            aria-busy={operation === 'copy'}
            type="button"
            onClick={() => void copyJson()}
          >
            {operation === 'copy' ? 'Copying…' : 'Copy JSON'}
          </button>
          <button
            disabled={!documentIsCurrent || pending}
            aria-busy={operation === 'download'}
            type="button"
            onClick={() => void downloadJson()}
          >
            {operation === 'download' ? 'Downloading…' : 'Download JSON'}
          </button>
          <button
            disabled={!documentIsCurrent || pending}
            aria-busy={operation === 'sqlite'}
            type="button"
            onClick={() => void saveToSqlite()}
          >
            {operation === 'sqlite' ? 'Saving…' : 'Save to SQLite'}
          </button>
        </div>
      }
    >
      <p className="muted">
        Swarm exports include all agents, retained swarm ticks, and provider
        attempts for the entire retained experiment.
      </p>
      <label>
        JSON serialization
        <select
          value={serialization}
          onChange={(event) =>
            setSerialization(
              event.target.value as ExperimentExportRequest['serialization'],
            )
          }
        >
          <option value="compact">Compact · AI sharing default</option>
          <option value="pretty">Pretty · human review</option>
        </select>
      </label>
      {disabled && (
        <p className="muted">
          Pause playback and wait for the active swarm tick or reset to finish.
        </p>
      )}
      {preview && (
        <dl className="preview-grid" aria-label="Export preview">
          <div>
            <dt>Committed swarm ticks</dt>
            <dd>{preview.matchingSwarmTickCount} retained</dd>
          </div>
          <div>
            <dt>Provider attempts</dt>
            <dd>{preview.matchingProviderAttemptCount} retained</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{preview.serializedUtf8Bytes} bytes</dd>
          </div>
          <div>
            <dt>Approx. AI input</dt>
            <dd>{preview.approximateAiInputTokens} tokens</dd>
          </div>
          <div>
            <dt>Retained cost</dt>
            <dd>{formatCost(preview.knownCostCredits)}</dd>
          </div>
        </dl>
      )}
      {notice && (
        <p className="callout" role="status">
          {notice}
        </p>
      )}
      {generatedArtifactIsStale && (
        <p className="callout stale-export" role="status">
          Options changed — regenerate export.
        </p>
      )}
    </DialogShell>
  );
}

function trapModalFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const focusable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && window.document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && window.document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function attemptExhaustionLabel(
  reason: SimulationSnapshot['experiment']['attemptAccounting']['exhaustionReason'],
): string {
  if (reason === 'provider-attempt-limit')
    return 'Provider-attempt limit exhausted';
  if (reason === 'credit-reservation-overrun')
    return 'Reported cost exceeded its reservation; enabled credit admission is stopped';
  return 'Credit admission limit exhausted';
}

function formatCost(cost: number | string): string {
  if (typeof cost === 'string')
    return `${cost.includes('.') ? cost : `${cost}.0`} credits`;
  return `${Number(cost).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0')} credits`;
}

function formatPerMillion(pricePerToken: string): string {
  const value = Number(pricePerToken) * 1_000_000;
  if (!Number.isFinite(value)) return 'Unavailable';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}/M`;
}

function formatReasoningProfile(profile: ReasoningProfile): string {
  if (profile === 'provider-default') return 'Provider default';
  if (profile === 'off') return 'Off';
  return profile === 'xhigh'
    ? 'XHigh'
    : `${profile[0]!.toUpperCase()}${profile.slice(1)}`;
}

function serializeExportDocument(document: ExperimentExportDocument): string {
  return document.filters.serialization === 'pretty'
    ? JSON.stringify(document, null, 2)
    : JSON.stringify(document);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
