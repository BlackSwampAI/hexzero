'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  PERSONALITY_MAX_LENGTH,
  NEUTRAL_AGENT_COLOR,
  PERSONALITY_PROFILES,
  STRATEGY_PROFILES,
  assignBehavior,
  archiveExperimentExportResponseSchema,
  cancelSimulationResponseSchema,
  cancelledTurnResponseSchema,
  experimentExportPreviewSchema,
  experimentExportRequestSchema,
  experimentExportResponseSchema,
  experimentImportResponseSchema,
  modelCatalogResponseSchema,
  personalitySchema,
  resetSimulationResponseSchema,
  reasoningProfilesForModel,
  restoreDefaultPersonalitiesResponseSchema,
  simulationSnapshotSchema,
  singleTickResponseSchema,
  updateAgentPersonalityRequestSchema,
  updateAgentPersonalityResponseSchema,
  updateExperimentModelsResponseSchema,
  updateExperimentBehaviorResponseSchema,
  verifyModelResponseSchema,
  worldSetupPreviewResponseSchema,
  applyWorldSetupResponseSchema,
  generatedAgentResponseSchema,
  locationSearchResponseSchema,
  defaultWorldSetupResponseSchema,
  WORLD_RADIUS_PRESETS,
  type AgentId,
  type AgentTurnRecord,
  type CustomExportOptions,
  type ExperimentExportDocument,
  type ExperimentExportPreview,
  type ExperimentExportRequest,
  type H3Cell,
  type CompatibleModel,
  type ModelCatalogResponse,
  type ModelVerification,
  type ReasoningProfile,
  type ExperimentModelConfiguration,
  type BehaviorConfiguration,
  type SimulationSnapshot,
  type WorldSetupRequest,
  type WorldSetupPreviewResponse,
} from '@hexzero/shared';
import {
  matchingPersonalityPreset,
  PERSONALITY_PRESETS,
} from './personality-presets';
import { WorldMap } from './world-map';
import { buildModelOptions } from './model-options';
import { resolveAgentColor } from './ui-color';
import { BEHAVIOR_TRACE_LIMIT, deriveBehaviorTrace } from './behavior-trace';

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
  const [activityTab, setActivityTab] = useState<
    'chat' | 'private' | 'events' | 'recovery'
  >('chat');
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null);
  const [privateCommsUnread, setPrivateCommsUnread] = useState(0);
  const privateCommCount =
    snapshot?.world.events.filter(
      (event) =>
        event.type === 'direct-message-sent' ||
        event.type === 'alliance-message-sent' ||
        event.type === 'zero-message-sent',
    ).length ?? 0;
  const previousPrivateCommCount = useRef<number | null>(null);
  useEffect(() => {
    if (previousPrivateCommCount.current === null) {
      if (snapshot) previousPrivateCommCount.current = privateCommCount;
      return;
    }
    const added = Math.max(
      0,
      privateCommCount - previousPrivateCommCount.current,
    );
    if (activityTab !== 'private' && added)
      setPrivateCommsUnread((count) => count + added);
    if (activityTab === 'private') setPrivateCommsUnread(0);
    previousPrivateCommCount.current = privateCommCount;
  }, [activityTab, privateCommCount, snapshot]);
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
  const [personalityPending, setPersonalityPending] = useState(false);
  const [personalityNotice, setPersonalityNotice] = useState<string | null>(
    null,
  );
  const [speed, setSpeed] = useState(1_000);
  const [uiError, setUiError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [exportAgentIds, setExportAgentIds] = useState<AgentId[]>([]);
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
  const exportInitializedRef = useRef(false);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const setupTriggerRef = useRef<HTMLElement>(null);
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
        : next.world.agents[0]!.id,
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

  const updateBehavior = async (
    configuration: Omit<BehaviorConfiguration, 'registryVersion' | 'locked'>,
  ): Promise<boolean> => {
    if (configurationPendingRef.current) return false;
    configurationPendingRef.current = true;
    setConfigurationPending(true);
    setUiError(null);
    try {
      const response = await fetch(`${apiBase}/experiment/behavior`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configuration),
      });
      if (!response.ok) throw new Error('behavior update rejected');
      applySnapshot(
        updateExperimentBehaviorResponseSchema.parse(await response.json())
          .snapshot,
      );
      return true;
    } catch {
      setUiError(
        'Behavior assignments could not be saved. They may be locked after turn one.',
      );
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

  const importExperiment = async (file: File): Promise<void> => {
    if (file.size > 5_000_000) {
      setUiError('Experiment import files must be 5 MB or smaller.');
      return;
    }
    try {
      const document = JSON.parse(await file.text()) as unknown;
      const response = await fetch(`${apiBase}/experiment/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document }),
      });
      const body = await response.json();
      if (!response.ok) {
        const error = body as { error?: { message?: string } };
        setUiError(
          error.error?.message ?? 'The experiment import was rejected.',
        );
        return;
      }
      const payload = experimentImportResponseSchema.parse(body);
      applySnapshot(payload.snapshot);
      setPersonalityNotice(payload.message);
    } catch {
      setUiError('The selected file is not a valid experiment export.');
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
        setUiError('Another tick is already in progress.');
        runningRef.current = false;
        setRunning(false);
        setBoundedRunTarget(null);
        boundedRunTargetRef.current = null;
        return;
      }
      if (!response.ok) throw new Error('turn request failed');
      const body: unknown = await response.json();
      const cancellation = cancelledTurnResponseSchema.safeParse(body);
      if (cancellation.success) {
        applySnapshot(cancellation.data.snapshot);
        setUiError('The request was cancelled without consuming a tick.');
        return;
      }
      const payload = singleTickResponseSchema.parse(body);
      applySnapshot(payload.snapshot);
      const lost = payload.records.filter(
        ({ outcome }) => outcome === 'lost-tick',
      );
      if (lost.length)
        setRecoveryNotice(
          `${lost.length} agent${lost.length === 1 ? '' : 's'} lost this tick; all other decisions committed.`,
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
      snapshot.experiment.totalCompletedTurns > 0 &&
      !window.confirm(
        `Reset World will discard ${snapshot.tickNumber} completed ticks (${snapshot.experiment.totalCompletedTurns} agent records) and all unexported telemetry. Continue?`,
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
          : payload.snapshot.world.agents[0]!.id,
      );
    } catch {
      setUiError('Reset failed safely. The existing world was left intact.');
    } finally {
      setResetting(false);
    }
  };

  const updatePersonality = async (
    agentId: AgentId,
    personality: string,
  ): Promise<boolean> => {
    const request = updateAgentPersonalityRequestSchema.safeParse({
      personality,
    });
    if (!request.success) return false;
    setPersonalityPending(true);
    setPersonalityNotice(null);
    setUiError(null);
    try {
      const response = await fetch(`${apiBase}/agents/${agentId}/personality`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.data),
      });
      if (response.status === 409) {
        setUiError(
          'Personality changes are unavailable until the current tick completes.',
        );
        return false;
      }
      if (!response.ok) {
        setUiError('The personality was rejected safely by the Game API.');
        return false;
      }
      const payload = updateAgentPersonalityResponseSchema.parse(
        await response.json(),
      );
      applySnapshot(payload.snapshot);
      setPersonalityNotice(`${payload.agent.name}'s personality was updated.`);
      return true;
    } catch {
      setUiError(
        'Personality update failed safely. The existing personality was left intact.',
      );
      return false;
    } finally {
      setPersonalityPending(false);
    }
  };

  const restoreDefaultPersonalities = async () => {
    if (
      !window.confirm(
        'Restore milestone default personalities for applicable active agents? World progress will be preserved.',
      )
    )
      return;
    setPersonalityPending(true);
    setPersonalityNotice(null);
    setUiError(null);
    try {
      const response = await fetch(
        `${apiBase}/personalities/restore-defaults`,
        {
          method: 'POST',
        },
      );
      if (response.status === 409) {
        setUiError(
          'Default personalities cannot be restored until the current tick completes.',
        );
        return;
      }
      if (!response.ok) throw new Error('restore personalities failed');
      const payload = restoreDefaultPersonalitiesResponseSchema.parse(
        await response.json(),
      );
      applySnapshot(payload.snapshot);
      setPersonalityNotice(
        'Default personalities restored. World progress was preserved.',
      );
    } catch {
      setUiError(
        'Restoring default personalities failed safely. Existing configuration was left intact.',
      );
    } finally {
      setPersonalityPending(false);
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
  const selectedHexAlliance = selectedHexController
    ? snapshot.world.alliances.find(({ memberAgentIds }) =>
        memberAgentIds.includes(selectedHexController.id),
      )
    : undefined;
  const latestTurn = selectedAgent
    ? snapshot.turns.findLast(({ agentId }) => agentId === selectedAgent.id)
    : undefined;
  const status = resetting
    ? 'resetting'
    : reconciling
      ? 'reconciling-request'
      : inFlight
        ? 'waiting-for-model'
        : snapshot.status === 'waiting-for-model' ||
            snapshot.status === 'configuration-error' ||
            snapshot.status === 'provider-error'
          ? snapshot.status
          : running
            ? 'running'
            : 'paused';
  const activeTick = snapshot.status === 'waiting-for-model';
  const personalityControlsDisabled =
    running ||
    inFlight ||
    resetting ||
    personalityPending ||
    snapshot.activeAgentId !== null ||
    activeTick;
  const exportMutationPending =
    running ||
    inFlight ||
    resetting ||
    personalityPending ||
    snapshot.activeAgentId !== null ||
    activeTick;
  const modelsReady = snapshot.resolvedModels.every(
    ({ available }) => available,
  );
  const reasoningUnavailable = snapshot.resolvedModels.some(
    ({ issue }) => issue === 'reasoning-unavailable',
  );
  const publicMessages = snapshot.world.events.filter(
    (
      event,
    ): event is Extract<
      SimulationSnapshot['world']['events'][number],
      { type: 'public-message-sent' }
    > => event.type === 'public-message-sent',
  );

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
            <p className="eyebrow">Developer simulation</p>
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
                snapshot.experiment.metrics.aggregate.knownCostCredits,
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
                <dt>Retained turns</dt>
                <dd>{snapshot.experiment.retainedTurns}</dd>
              </div>
              <div>
                <dt>Patient Zero</dt>
                <dd>
                  {snapshot.world.agents.find(
                    ({ id }) => id === snapshot.scenario.patientZeroAgentId,
                  )?.name ?? 'None'}
                </dd>
              </div>
              <div>
                <dt>Public messages</dt>
                <dd>
                  {snapshot.experiment.metrics.aggregate.publicMessagesSent}
                </dd>
              </div>
              <div>
                <dt>Direct messages</dt>
                <dd>
                  {snapshot.experiment.metrics.aggregate.directMessagesSent}
                </dd>
              </div>
              <div>
                <dt>Known credits</dt>
                <dd>
                  {formatCost(
                    snapshot.experiment.metrics.aggregate.knownCostCredits,
                  )}
                </dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>
                  {snapshot.experiment.metrics.aggregate.tokens.totalTokens ??
                    'Unknown'}
                </dd>
              </div>
            </dl>
            <ExperimentUsageMeter snapshot={snapshot} />
          </div>
        </div>
        <p className="test-provider-summary">
          {snapshot.providerMode === 'openrouter'
            ? `${new Set(snapshot.resolvedModels.map(({ modelId }) => modelId ?? 'unassigned')).size} active model assignment${snapshot.resolvedModels.length === 1 ? '' : 's'}`
            : 'Deterministic test model'}
        </p>
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
                personalityPending ||
                fullyInfected ||
                !snapshot.providerConfigured ||
                !modelsReady
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
              personalityPending ||
              !snapshot.providerConfigured ||
              !modelsReady ||
              snapshot.pendingFailedTurn !== null
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
                personalityPending ||
                !snapshot.providerConfigured ||
                !modelsReady ||
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
                if (!exportInitializedRef.current) {
                  setExportAgentIds(snapshot.world.agents.map(({ id }) => id));
                  exportInitializedRef.current = true;
                }
                if (overflowMenuRef.current)
                  overflowMenuRef.current.open = false;
                setExportOpen(true);
              }}
            >
              <CommandIcon name="export" />
              Export
            </button>
            <button
              disabled={personalityControlsDisabled}
              type="button"
              onClick={() => void restoreDefaultPersonalities()}
            >
              {personalityPending
                ? 'Restoring…'
                : 'Restore default personalities'}
            </button>
            <div className="destructive-actions">
              <button
                className="destructive-command"
                aria-busy={resetting}
                disabled={
                  inFlight || activeTick || resetting || personalityPending
                }
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
        {(!modelsReady || uiError || fullyInfected || personalityNotice) && (
          <div className="command-alert" role="alert">
            {uiError ??
              (fullyInfected
                ? 'Development world fully infected. Automatic playback is paused; Single tick remains a manual cost-incurring diagnostic action.'
                : (personalityNotice ??
                  (reasoningUnavailable
                    ? 'A saved reasoning profile is no longer advertised by its model. Select an available profile before starting.'
                    : 'Select an available compatible model for every agent before starting.')))}
          </div>
        )}
        {!snapshot.providerConfigured && (
          <div className="command-alert" role="alert">
            Model calls unavailable. Set OPENROUTER_API_KEY on the Game API
            server and restart pnpm dev.
          </div>
        )}
      </div>

      <ExperimentExportPanel
        snapshot={snapshot}
        agents={snapshot.world.agents}
        disabled={exportMutationPending}
        open={exportOpen}
        selectedAgentIds={exportAgentIds}
        onOpenChange={setExportOpen}
        onSelectionChange={setExportAgentIds}
        returnFocusRef={exportTriggerRef}
      />
      {setupOpen && (
        <WorldSetupPanel
          open
          snapshot={snapshot}
          apiBase={apiBase}
          returnFocusRef={setupTriggerRef}
          onClose={() => setSetupOpen(false)}
          onApplied={(next) => {
            setSnapshot(next);
            setSelectedCell(null);
            setSelectedAgentId((selected) =>
              next.world.agents.some(({ id }) => id === selected)
                ? selected
                : next.world.agents[0]!.id,
            );
            setExportAgentIds((selected) =>
              selected.filter((id) =>
                next.world.agents.some((agent) => agent.id === id),
              ),
            );
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
                alliances={snapshot.world.alliances}
                patientZeroAgentId={snapshot.scenario.patientZeroAgentId}
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
                  <AgentInspector
                    key={`${selectedAgent.id}:${selectedAgent.personality}`}
                    agent={selectedAgent}
                    snapshot={snapshot}
                    cellState={
                      snapshot.world.hexes.find(
                        ({ cell }) => cell === selectedAgent.currentCell,
                      )!.state
                    }
                    latestTurn={latestTurn}
                    turns={snapshot.turns}
                    directMessages={snapshot.world.events.filter(
                      (
                        event,
                      ): event is Extract<
                        SimulationSnapshot['world']['events'][number],
                        { type: 'direct-message-sent' }
                      > =>
                        event.type === 'direct-message-sent' &&
                        (event.agentId === selectedAgent.id ||
                          event.recipientId === selectedAgent.id),
                    )}
                    agents={snapshot.world.agents}
                    mutationDisabled={personalityControlsDisabled}
                    mutationPending={personalityPending}
                    onApplyPersonality={updatePersonality}
                    onHighlightCell={setSelectedCell}
                    metrics={
                      snapshot.experiment.metrics.byAgent.find(
                        ({ agentId }) => agentId === selectedAgent.id,
                      )?.metrics
                    }
                    controlledCellCount={
                      snapshot.experiment.currentTerritory.find(
                        ({ agentId }) => agentId === selectedAgent.id,
                      )?.controlledCellCount ?? 0
                    }
                    controlChanges={snapshot.world.events.filter(
                      (
                        event,
                      ): event is Extract<
                        SimulationSnapshot['world']['events'][number],
                        { type: 'hex-captured' }
                      > =>
                        event.type === 'hex-captured' &&
                        (event.controllerAgentId === selectedAgent.id ||
                          event.previousControllerAgentId === selectedAgent.id),
                    )}
                  />
                )}
                {inspectorTab === 'hex' && selectedHex && (
                  <HexInspector
                    hex={selectedHex}
                    controller={selectedHexController}
                    alliance={selectedHexAlliance}
                    selectedAgent={selectedAgent}
                  />
                )}
                {inspectorTab === 'scoreboard' && (
                  <>
                    <TerritoryScoreboard
                      entries={snapshot.experiment.currentTerritory}
                    />
                    <AlliancePanel snapshot={snapshot} />
                  </>
                )}
                {inspectorTab === 'run' && (
                  <RunHealthSummary
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
              <div
                className="tab-list"
                role="tablist"
                aria-label="Activity views"
              >
                {(['chat', 'private', 'events', 'recovery'] as const).map(
                  (tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={activityTab === tab}
                      aria-controls={`activity-${tab}`}
                      onClick={() => {
                        setActivityTab(tab);
                        if (tab === 'private') setPrivateCommsUnread(0);
                      }}
                    >
                      {tab === 'chat'
                        ? 'Public chat'
                        : tab === 'private'
                          ? `Private comms${privateCommsUnread ? ` (${privateCommsUnread})` : ''}`
                          : tab === 'events'
                            ? 'Event log'
                            : 'Failures & recovery'}
                    </button>
                  ),
                )}
              </div>
              <button
                type="button"
                aria-expanded={!chatCollapsed}
                onClick={() => setChatCollapsed((collapsed) => !collapsed)}
              >
                {chatCollapsed ? 'Expand activity' : 'Collapse activity'}
              </button>
            </div>
            {!chatCollapsed && activityTab === 'chat' && (
              <PublicWorldChat
                snapshot={snapshot}
                agents={snapshot.world.agents}
                events={publicMessages}
                turns={snapshot.turns}
                collapsed={false}
                onCollapsedChange={setChatCollapsed}
              />
            )}
            {!chatCollapsed && activityTab === 'private' && (
              <PrivateComms
                snapshot={snapshot}
                onSelectAgent={selectAgentForInspection}
              />
            )}
            {!chatCollapsed && activityTab === 'events' && (
              <EventLog
                snapshot={snapshot}
                turns={snapshot.turns}
                agents={snapshot.world.agents}
                collapsed={false}
                onCollapsedChange={setChatCollapsed}
              />
            )}
            {!chatCollapsed && activityTab === 'recovery' && (
              <RecoveryLog snapshot={snapshot} turns={snapshot.turns} />
            )}
          </section>
        </>
      ) : (
        <AgentsWorkspace
          snapshot={snapshot}
          selectedAgentId={inspectionAgentId}
          onSelectAgent={selectAgentForInspection}
          onOpenWorldSetup={() => setSetupOpen(true)}
        >
          {snapshot.providerMode === 'openrouter' ? (
            <ModelConsole
              catalog={catalog}
              loading={catalogLoading || catalog === null}
              snapshot={snapshot}
              disabled={
                personalityControlsDisabled ||
                verifyingModelId !== null ||
                configurationPending
              }
              verifications={modelVerifications}
              verifyingModelId={verifyingModelId}
              onRefresh={refreshCatalog}
              onUpdate={updateModels}
              onUpdateBehavior={updateBehavior}
              onVerify={verifyModel}
              onImport={importExperiment}
            />
          ) : (
            <p className="test-provider-summary">
              Deterministic test model assignments are active.
            </p>
          )}
          {selectedAgent && (
            <AgentInspector
              key={`management:${selectedAgent.id}:${selectedAgent.personality}`}
              agent={selectedAgent}
              snapshot={snapshot}
              cellState={
                snapshot.world.hexes.find(
                  ({ cell }) => cell === selectedAgent.currentCell,
                )!.state
              }
              latestTurn={latestTurn}
              turns={snapshot.turns}
              directMessages={snapshot.world.events.filter(
                (
                  event,
                ): event is Extract<
                  SimulationSnapshot['world']['events'][number],
                  { type: 'direct-message-sent' }
                > =>
                  event.type === 'direct-message-sent' &&
                  (event.agentId === selectedAgent.id ||
                    event.recipientId === selectedAgent.id),
              )}
              agents={snapshot.world.agents}
              mutationDisabled={personalityControlsDisabled}
              mutationPending={personalityPending}
              onApplyPersonality={updatePersonality}
              metrics={
                snapshot.experiment.metrics.byAgent.find(
                  ({ agentId }) => agentId === selectedAgent.id,
                )?.metrics
              }
              controlledCellCount={
                snapshot.experiment.currentTerritory.find(
                  ({ agentId }) => agentId === selectedAgent.id,
                )?.controlledCellCount ?? 0
              }
              controlChanges={snapshot.world.events.filter(
                (
                  event,
                ): event is Extract<
                  SimulationSnapshot['world']['events'][number],
                  { type: 'hex-captured' }
                > =>
                  event.type === 'hex-captured' &&
                  (event.controllerAgentId === selectedAgent.id ||
                    event.previousControllerAgentId === selectedAgent.id),
              )}
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
              Global assignments and explicit overrides apply through the
              existing server-authoritative configuration boundary.
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
  alliance,
  selectedAgent,
}: {
  hex: SimulationSnapshot['world']['hexes'][number];
  controller?: SimulationSnapshot['world']['agents'][number];
  alliance?: SimulationSnapshot['world']['alliances'][number];
  selectedAgent?: SimulationSnapshot['world']['agents'][number];
}) {
  const relationship = !selectedAgent
    ? 'No agent selected'
    : controller?.id === selectedAgent.id
      ? 'Controlled by selected agent'
      : alliance?.memberAgentIds.includes(selectedAgent.id)
        ? 'Controlled by an ally'
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
          <dd>{controller?.name ?? 'None'}</dd>
        </div>
        <div>
          <dt>Alliance</dt>
          <dd>{alliance?.id ?? 'None'}</dd>
        </div>
        <div>
          <dt>Relationship</dt>
          <dd>{relationship}</dd>
        </div>
      </dl>
    </section>
  );
}

function RunHealthSummary({
  snapshot,
  status,
  runTarget,
}: {
  snapshot: SimulationSnapshot;
  status: string;
  runTarget: number;
}) {
  const metrics = snapshot.experiment.metrics.aggregate;
  const elapsedMs = Math.max(
    0,
    Date.parse(
      snapshot.turns.at(-1)?.completedAt ?? snapshot.experiment.startedAt,
    ) - Date.parse(snapshot.experiment.startedAt),
  );
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  return (
    <section className="panel run-health" aria-label="Run health summary">
      <p className="panel-kicker">Long-run telemetry</p>
      <h2>{status.replaceAll('-', ' ')}</h2>
      <dl className="operator-facts">
        <div>
          <dt>Progress</dt>
          <dd>
            {snapshot.tickNumber} / {runTarget} ticks
          </dd>
        </div>
        <div>
          <dt>Virtual time</dt>
          <dd>{new Date(snapshot.virtualTime).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last interval</dt>
          <dd>
            {snapshot.lastTickIntervalMinutes === null
              ? 'Not started'
              : `${snapshot.lastTickIntervalMinutes} min`}
          </dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{elapsedMinutes} min</dd>
        </div>
        <div>
          <dt>Known cost</dt>
          <dd>{formatCost(metrics.knownCostCredits)}</dd>
        </div>
        <div>
          <dt>Successful turns</dt>
          <dd>{metrics.accepted}</dd>
        </div>
        <div>
          <dt>Rejected actions</dt>
          <dd>{metrics.rejectedWorldActions}</dd>
        </div>
        <div>
          <dt>Provider failures</dt>
          <dd>{metrics.providerErrors}</dd>
        </div>
        <div>
          <dt>Lost ticks</dt>
          <dd>{metrics.lostTicks}</dd>
        </div>
        <div>
          <dt>Auto recovered</dt>
          <dd>{metrics.recoveredAutomatically}</dd>
        </div>
        <div>
          <dt>Manual recovered</dt>
          <dd>{metrics.recoveredManually}</dd>
        </div>
        <div>
          <dt>Unattended recovered</dt>
          <dd>{metrics.recoveredByUnattendedRetry}</dd>
        </div>
        <div>
          <dt>Skipped turns</dt>
          <dd>{metrics.operatorSkipped}</dd>
        </div>
      </dl>
    </section>
  );
}

function RecoveryLog({
  snapshot,
  turns,
}: {
  snapshot: SimulationSnapshot;
  turns: AgentTurnRecord[];
}) {
  const failures = turns
    .filter(
      (turn) =>
        turn.outcome === 'provider-error' ||
        turn.outcome === 'lost-tick' ||
        turn.outcome === 'operator-skipped',
    )
    .slice(-40)
    .toReversed();
  return (
    <section
      className="panel recovery-panel"
      id="activity-recovery"
      role="tabpanel"
    >
      {failures.length === 0 ? (
        <p className="muted">No failures or recovery actions recorded.</p>
      ) : (
        <ol aria-label="Failures and recovery log">
          {failures.map((turn) => {
            const agent = snapshot.world.agents.find(
              ({ id }) => id === turn.agentId,
            );
            return (
              <li key={turn.turnNumber}>
                <strong>
                  {formatRecordSequence(turn)} · record {turn.turnNumber} ·{' '}
                  {agent?.name ?? turn.agentId}
                </strong>
                <span>
                  {turn.failure.code} ·{' '}
                  {turn.provider?.model ??
                    turn.failure.model ??
                    'model unavailable'}
                </span>
                <small>
                  {turn.outcome === 'operator-skipped'
                    ? `${turn.skipKind} skip`
                    : turn.outcome === 'lost-tick'
                      ? `final lost tick ${turn.tickNumber}`
                      : 'legacy provider failure'}
                </small>
              </li>
            );
          })}
        </ol>
      )}
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
      locationLabel: scenario.locationLabel,
      center: scenario.center,
      resolution: scenario.resolution,
      radius: scenario.radius,
      worldSeed: scenario.worldSeed,
      rosterSeed: scenario.rosterSeed,
      spawnSeed: scenario.spawnSeed,
      minimumSpawnSeparation: scenario.minimumSpawnSeparation,
      communicationRangeKm: scenario.communicationRangeKm,
      minimumTickIntervalMinutes: scenario.minimumTickIntervalMinutes,
      maximumTickIntervalMinutes: scenario.maximumTickIntervalMinutes,
      patientZeroAgentId: scenario.patientZeroAgentId,
      roster: scenario.roster,
      modelConfiguration: scenario.modelConfiguration,
      behaviorConfiguration: scenario.behaviorConfiguration,
      objectiveVersion: scenario.objectiveVersion,
      capabilities: scenario.capabilities,
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
  const reconcileBehaviorAssignments = (
    roster: WorldSetupRequest['roster'],
    configuration: WorldSetupRequest['behaviorConfiguration'],
    mode = configuration.assignmentMode,
  ) => {
    const generated = assignBehavior(
      roster.map(({ id }) => id),
      configuration.seed,
      mode === 'manual' ? 'balanced-random' : mode,
    );
    if (mode !== 'manual') return generated;
    return generated.map((fallback) => ({
      ...(configuration.assignments.find(
        ({ agentId }) => agentId === fallback.agentId,
      ) ?? fallback),
      manual: true,
    }));
  };
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
        behaviorConfiguration: {
          ...current.behaviorConfiguration,
          assignments: reconcileBehaviorAssignments(
            roster,
            current.behaviorConfiguration,
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
      snapshot.experiment.totalCompletedTurns > 0 &&
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
            Spawn seed
            <input
              value={draft.spawnSeed}
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
            Communication range (km)
            <input
              type="number"
              min="0.1"
              max="100"
              step="0.1"
              value={draft.communicationRangeKm}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  communicationRangeKm: Number(event.target.value),
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
        </div>
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
          Roster seed
          <input
            value={draft.rosterSeed}
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
        <label>
          Behavior mode
          <select
            value={draft.behaviorConfiguration.assignmentMode}
            onChange={(event) => {
              const mode = event.target
                .value as WorldSetupRequest['behaviorConfiguration']['assignmentMode'];
              setDraft({
                ...draft,
                behaviorConfiguration: {
                  ...draft.behaviorConfiguration,
                  assignmentMode: mode,
                  assignments: reconcileBehaviorAssignments(
                    draft.roster,
                    draft.behaviorConfiguration,
                    mode,
                  ),
                },
              });
            }}
          >
            <option value="balanced-random">Balanced random</option>
            <option value="fully-random">Fully random</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <p>
          Model and reasoning assignments are shared with Agent Controller and
          preserved unless an agent is removed.
        </p>
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
  onUpdateBehavior,
  onImport,
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
  onUpdateBehavior: (
    configuration: Omit<BehaviorConfiguration, 'registryVersion' | 'locked'>,
  ) => Promise<boolean>;
  onVerify: (
    modelId: string,
    reasoningProfile: ReasoningProfile,
    force?: boolean,
  ) => Promise<void>;
  onImport: (file: File) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'overview' | 'models' | 'behavior'>('models');
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
  const selected = catalog?.models.find(
    ({ id }) => id === configuration.globalModelId,
  );
  const locked = disabled;
  const verification = configuration.globalModelId
    ? verifications[
        `${configuration.globalModelId}:${configuration.globalReasoningProfile}`
      ]
    : undefined;
  const globalReasoningProfiles = reasoningProfilesForModel(selected);
  const activeAgentIds = new Set(snapshot.scenario.roster.map(({ id }) => id));
  const readyAgentCount = snapshot.resolvedModels.filter(
    ({ agentId, available }) => available && activeAgentIds.has(agentId),
  ).length;
  const activeAgentCount = snapshot.scenario.roster.length;

  const save = (next: Omit<ExperimentModelConfiguration, 'locked'>) =>
    void onUpdate(next);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="model-console">
      <button
        className="agent-setup-trigger"
        ref={toggleRef}
        type="button"
        title={`Agent setup · ${selected?.name ?? configuration.globalModelId ?? 'model needed'}`}
        aria-label={`Open Agent Controller. ${readyAgentCount} of ${activeAgentCount} agents ready. Global model ${selected?.name ?? configuration.globalModelId ?? 'not selected'}.`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="setup-label">
          Agent setup ·{readyAgentCount}/{activeAgentCount} ready
        </span>
        <span className="setup-model">
          Model: {selected?.name ?? configuration.globalModelId ?? 'needed'}
        </span>
      </button>
      <DialogShell
        open={open}
        title="Agent Controller"
        description={`Models and reproducible behavior assignments · ${catalog?.models.length ?? 0} catalog compatible · ${catalog?.filteredOutCount ?? 0} filtered out`}
        label="Model selection"
        closeLabel="Close model selection"
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
          aria-label="Agent Controller sections"
          className="controller-tabs"
        >
          {(['overview', 'models', 'behavior'] as const).map((value) => (
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
            {snapshot.world.agents.map((agent) => {
              const resolved = snapshot.resolvedModels.find(
                ({ agentId }) => agentId === agent.id,
              )!;
              const behavior = snapshot.behaviorConfiguration.assignments.find(
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
                  <strong>{agent.name}</strong>
                  <span>
                    {resolved.modelId ?? 'Model required'} ·{' '}
                    {formatReasoningProfile(resolved.reasoningProfile)}
                  </span>
                  <span>
                    {behavior.personalityId} · {behavior.strategyId}
                  </span>
                  <span>
                    {resolved.available ? 'Ready' : 'Needs configuration'}
                  </span>
                </button>
              );
            })}
          </section>
        )}
        {tab === 'behavior' && (
          <BehaviorPanel snapshot={snapshot} onUpdate={onUpdateBehavior} />
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
              <h3 id="global-model-heading">Global assignment</h3>
              <div className="model-global-grid">
                <label className="model-select-label">
                  Global model
                  <select
                    disabled={locked}
                    value={configuration.globalModelId ?? ''}
                    onChange={(event) =>
                      save({
                        globalModelId: event.target.value || null,
                        globalReasoningProfile: 'provider-default',
                        overrides: configuration.overrides,
                      })
                    }
                  >
                    <option value="">Select a model…</option>
                    {configuration.globalModelId && !selected && (
                      <option value={configuration.globalModelId}>
                        {configuration.globalModelId} — unavailable
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
                  Global reasoning
                  <select
                    disabled={locked || !selected}
                    value={configuration.globalReasoningProfile}
                    onChange={(event) =>
                      save({
                        globalModelId: configuration.globalModelId,
                        globalReasoningProfile: event.target
                          .value as ReasoningProfile,
                        overrides: configuration.overrides,
                      })
                    }
                  >
                    {!globalReasoningProfiles.includes(
                      configuration.globalReasoningProfile,
                    ) && (
                      <option value={configuration.globalReasoningProfile}>
                        {formatReasoningProfile(
                          configuration.globalReasoningProfile,
                        )}{' '}
                        — unavailable
                      </option>
                    )}
                    {globalReasoningProfiles.map((profile) => (
                      <option value={profile} key={profile}>
                        {formatReasoningProfile(profile)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={locked || !configuration.globalModelId}
                  type="button"
                  onClick={() =>
                    save({
                      globalModelId: configuration.globalModelId,
                      globalReasoningProfile:
                        configuration.globalReasoningProfile,
                      overrides: [],
                    })
                  }
                >
                  Apply global model to all agents
                </button>
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
                    ? 'Retry model test'
                    : 'Test selected model'}
              </button>
              <small>
                Sends one genuine, non-mutating OpenRouter request using the
                production decision contract and may incur a small charge.
              </small>
            </div>
            {selected && <ModelFacts model={selected} />}
            <div className="agent-model-overrides">
              <strong>Agent overrides</strong>
              {snapshot.world.agents.map((agent) => {
                const override = configuration.overrides.find(
                  ({ agentId }) => agentId === agent.id,
                );
                const overrideModel = catalog?.models.find(
                  ({ id }) => id === override?.modelId,
                );
                const reasoningProfiles =
                  reasoningProfilesForModel(overrideModel);
                return (
                  <div className="agent-model-override" key={agent.id}>
                    <label>
                      {agent.name}
                      <select
                        disabled={locked}
                        value={override?.modelId ?? ''}
                        onChange={(event) => {
                          const withoutAgent = configuration.overrides.filter(
                            ({ agentId }) => agentId !== agent.id,
                          );
                          save({
                            globalModelId: configuration.globalModelId,
                            globalReasoningProfile:
                              configuration.globalReasoningProfile,
                            overrides: event.target.value
                              ? [
                                  ...withoutAgent,
                                  {
                                    agentId: agent.id,
                                    modelId: event.target.value,
                                    reasoningProfile: 'provider-default',
                                  },
                                ]
                              : withoutAgent,
                          });
                        }}
                      >
                        <option value="">Inherit global</option>
                        {override &&
                          !catalog?.models.some(
                            ({ id }) => id === override.modelId,
                          ) && (
                            <option value={override.modelId}>
                              {override.modelId} — unavailable
                            </option>
                          )}
                        {buildModelOptions(catalog?.models ?? []).map(
                          (option) => (
                            <option value={option.value} key={option.value}>
                              {option.label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      {agent.name} reasoning
                      <select
                        disabled={locked || !overrideModel}
                        value={override?.reasoningProfile ?? 'provider-default'}
                        onChange={(event) => {
                          if (!override) return;
                          save({
                            globalModelId: configuration.globalModelId,
                            globalReasoningProfile:
                              configuration.globalReasoningProfile,
                            overrides: configuration.overrides.map(
                              (candidate) =>
                                candidate.agentId === agent.id
                                  ? {
                                      ...candidate,
                                      reasoningProfile: event.target
                                        .value as ReasoningProfile,
                                    }
                                  : candidate,
                            ),
                          });
                        }}
                      >
                        {override &&
                          !reasoningProfiles.includes(
                            override.reasoningProfile,
                          ) && (
                            <option value={override.reasoningProfile}>
                              {formatReasoningProfile(
                                override.reasoningProfile,
                              )}{' '}
                              — unavailable
                            </option>
                          )}
                        {reasoningProfiles.map((profile) => (
                          <option value={profile} key={profile}>
                            {formatReasoningProfile(profile)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
            <p className="catalog-state">
              Model changes are available between provider requests and are
              recorded at the next turn boundary.
            </p>
            <label className="model-import-label">
              Import saved experiment model assignments
              <input
                disabled={disabled}
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onImport(file);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          </section>
        )}
      </DialogShell>
    </div>
  );
}

function BehaviorPanel({
  snapshot,
  onUpdate,
}: {
  snapshot: SimulationSnapshot;
  onUpdate: (
    configuration: Omit<BehaviorConfiguration, 'registryVersion' | 'locked'>,
  ) => Promise<boolean>;
}) {
  const configuration = snapshot.behaviorConfiguration;
  const locked =
    configuration.locked || snapshot.experiment.totalCompletedTurns > 0;
  const update = (
    next: Omit<BehaviorConfiguration, 'registryVersion' | 'locked'>,
  ) => void onUpdate(next);
  return (
    <section
      role="tabpanel"
      id="controller-behavior"
      aria-labelledby="controller-tab-behavior"
      className="behavior-panel"
    >
      <div className="behavior-toolbar">
        <label>
          Assignment mode
          <select
            disabled={locked}
            value={configuration.assignmentMode}
            onChange={(event) => {
              const assignmentMode = event.target
                .value as BehaviorConfiguration['assignmentMode'];
              update({
                assignmentMode,
                seed: configuration.seed,
                assignments:
                  assignmentMode === 'manual'
                    ? configuration.assignments
                    : assignBehavior(
                        snapshot.world.agents.map(({ id }) => id),
                        configuration.seed,
                        assignmentMode,
                      ),
              });
            }}
          >
            <option value="balanced-random">Balanced random</option>
            <option value="fully-random">Fully random</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label>
          Experiment behavior seed
          <input readOnly value={configuration.seed} />
        </label>
        <button
          type="button"
          disabled={locked || configuration.assignmentMode === 'manual'}
          onClick={() => {
            const seed = crypto.randomUUID();
            update({
              assignmentMode: configuration.assignmentMode,
              seed,
              assignments: assignBehavior(
                snapshot.world.agents.map(({ id }) => id),
                seed,
                configuration.assignmentMode as
                  'balanced-random' | 'fully-random',
              ),
            });
          }}
        >
          Randomize assignments
        </button>
      </div>
      {locked && (
        <p role="status">
          Behavior is locked after turn one so retained experiments remain
          reproducible. Reset starts a new experiment and unlocks setup.
        </p>
      )}
      <div className="behavior-assignments">
        {snapshot.world.agents.map((agent) => {
          const assignment = configuration.assignments.find(
            ({ agentId }) => agentId === agent.id,
          )!;
          const change = (
            field: 'personalityId' | 'strategyId',
            value: string,
          ) =>
            update({
              assignmentMode: 'manual',
              seed: configuration.seed,
              assignments: configuration.assignments.map((candidate) =>
                candidate.agentId === agent.id
                  ? { ...candidate, [field]: value, manual: true }
                  : candidate,
              ),
            });
          return (
            <div key={agent.id}>
              <strong>{agent.name}</strong>
              <label>
                Personality
                <select
                  disabled={locked || configuration.assignmentMode !== 'manual'}
                  value={assignment.personalityId}
                  onChange={(event) =>
                    change('personalityId', event.target.value)
                  }
                >
                  {PERSONALITY_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Strategy
                <select
                  disabled={locked || configuration.assignmentMode !== 'manual'}
                  value={assignment.strategyId}
                  onChange={(event) => change('strategyId', event.target.value)}
                >
                  {STRATEGY_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>
      <div className="profile-reference">
        <div>
          <h3>Personalities</h3>
          {PERSONALITY_PROFILES.map((profile) => (
            <p key={profile.id}>
              <strong>{profile.label}</strong> — {profile.description}
            </p>
          ))}
        </div>
        <div>
          <h3>Strategies</h3>
          {STRATEGY_PROFILES.map((profile) => (
            <p key={profile.id}>
              <strong>{profile.label}</strong> — {profile.description}
            </p>
          ))}
        </div>
      </div>
    </section>
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
        const territory = snapshot.experiment.currentTerritory.find(
          ({ agentId }) => agentId === agent.id,
        );
        const alliance = snapshot.world.alliances.find(({ memberAgentIds }) =>
          memberAgentIds.includes(agent.id),
        );
        const resolved = snapshot.resolvedModels.find(
          ({ agentId }) => agentId === agent.id,
        )!;
        const behavior = snapshot.behaviorConfiguration.assignments.find(
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
                <strong>{agent.name}</strong>
                {agent.id === snapshot.scenario.patientZeroAgentId && (
                  <span className="patient-zero-badge">HEX-0</span>
                )}
              </span>
              <small>
                {alliance ? 'Allied' : 'Unaffiliated'} ·{' '}
                {territory?.controlledCellCount ?? 0} cells
              </small>
              <small className={resolved.available ? '' : 'unavailable'}>
                {resolved.source === 'override' ? 'Override' : 'Global'} ·{' '}
                {resolved.modelId ?? 'model required'} ·{' '}
                {formatReasoningProfile(resolved.reasoningProfile)}
              </small>
              <small
                title={`${behavior.personalityId} personality · ${behavior.strategyId} strategy`}
                aria-label={`${behavior.personalityId} personality and ${behavior.strategyId} strategy`}
              >
                {behavior.personalityId} · {behavior.strategyId}
              </small>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function PrivateComms({
  snapshot,
  onSelectAgent,
}: {
  snapshot: SimulationSnapshot;
  onSelectAgent: (agentId: AgentId) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'direct' | 'alliance' | 'zero'>(
    'all',
  );
  const messages = snapshot.world.events
    .filter(
      (
        event,
      ): event is Extract<
        SimulationSnapshot['world']['events'][number],
        {
          type:
            | 'direct-message-sent'
            | 'alliance-message-sent'
            | 'zero-message-sent';
        }
      > =>
        event.type === 'direct-message-sent' ||
        event.type === 'alliance-message-sent' ||
        event.type === 'zero-message-sent',
    )
    .filter((event) => filter === 'all' || event.channel === filter)
    .toReversed()
    .slice(0, 120);
  const rejections = snapshot.turns
    .filter(
      (turn) =>
        turn.outcome !== 'provider-error' &&
        turn.outcome !== 'lost-tick' &&
        turn.outcome !== 'operator-skipped' &&
        turn.communicationResult.requested &&
        !turn.communicationResult.accepted &&
        turn.communicationResult.attempt.channel !== 'public' &&
        (filter === 'all' ||
          turn.communicationResult.attempt.channel === filter),
    )
    .toReversed()
    .slice(0, 40);
  return (
    <section
      className="panel world-chat-panel"
      id="activity-private"
      role="tabpanel"
      aria-label="Private communications"
    >
      <div className="dock-heading">
        <div>
          <p className="panel-kicker">
            World Lab operator-only · hidden from players
          </p>
          <h2>Private comms</h2>
        </div>
      </div>
      <div className="tab-list" aria-label="Private communication filters">
        {(['all', 'direct', 'alliance', 'zero'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === 'all'
              ? 'All'
              : value === 'direct'
                ? 'Direct'
                : value === 'alliance'
                  ? 'Alliance'
                  : 'Zero'}
          </button>
        ))}
      </div>
      {messages.length === 0 ? (
        <p className="muted">No private communications yet.</p>
      ) : (
        <ol className="world-chat-feed">
          {messages.map((event) => {
            const sender = snapshot.world.agents.find(
              ({ id }) => id === event.agentId,
            );
            const turn = snapshot.turns.find(
              (candidate) =>
                candidate.outcome !== 'provider-error' &&
                candidate.outcome !== 'lost-tick' &&
                candidate.outcome !== 'operator-skipped' &&
                candidate.communicationResult.requested &&
                candidate.communicationResult.accepted &&
                candidate.communicationResult.event.id === event.id,
            );
            const recipient =
              event.type === 'direct-message-sent'
                ? snapshot.world.agents.find(
                    ({ id }) => id === event.recipientId,
                  )
                : undefined;
            return (
              <li
                key={event.id}
                style={{
                  borderLeftColor: resolveAgentColor(snapshot, event.agentId),
                }}
              >
                <div>
                  <button
                    type="button"
                    onClick={() => onSelectAgent(event.agentId)}
                  >
                    {sender?.name ?? event.agentId}
                  </button>
                  <small>
                    {formatRecordSequence(turn)} · Delivered ·{' '}
                    {formatTimestamp(event.occurredAt)}
                  </small>
                </div>
                <p>{event.message}</p>
                <small>
                  {event.type === 'direct-message-sent' ? (
                    <>
                      To{' '}
                      <button
                        type="button"
                        onClick={() => onSelectAgent(event.recipientId)}
                      >
                        {recipient?.name ?? event.recipientId}
                      </button>{' '}
                      · {event.distance.toFixed(2)} km
                      {(event.agentId ===
                        snapshot.scenario.patientZeroAgentId ||
                        event.recipientId ===
                          snapshot.scenario.patientZeroAgentId) &&
                        ' · Patient Zero endpoint'}
                    </>
                  ) : event.type === 'alliance-message-sent' ? (
                    <>
                      Alliance {event.allianceId} · {event.recipientIds.length}{' '}
                      recipient{event.recipientIds.length === 1 ? '' : 's'}
                    </>
                  ) : (
                    <>
                      Zero broadcast · {event.recipientIds.length} recipient
                      {event.recipientIds.length === 1 ? '' : 's'}
                    </>
                  )}
                </small>
              </li>
            );
          })}
        </ol>
      )}
      {rejections.length > 0 && (
        <>
          <h3>Rejected private attempts</h3>
          <ol className="world-chat-feed">
            {rejections.map((turn) => {
              if (
                turn.outcome === 'provider-error' ||
                turn.outcome === 'lost-tick' ||
                turn.outcome === 'operator-skipped' ||
                !turn.communicationResult.requested ||
                turn.communicationResult.accepted
              )
                return null;
              return (
                <li
                  key={`rejected-${turn.turnNumber}`}
                  style={{
                    borderLeftColor: resolveAgentColor(snapshot, turn.agentId),
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectAgent(turn.agentId)}
                  >
                    {snapshot.world.agents.find(({ id }) => id === turn.agentId)
                      ?.name ?? turn.agentId}
                  </button>
                  <p>{turn.communicationResult.attempt.message}</p>
                  <small>
                    {formatRecordSequence(turn)} · Rejected:{' '}
                    {turn.communicationResult.reason} ·{' '}
                    {formatTimestamp(
                      turn.communicationResult.attempt.occurredAt,
                    )}
                  </small>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

function PublicWorldChat({
  snapshot,
  agents,
  events,
  turns,
  collapsed,
  onCollapsedChange,
}: {
  snapshot: SimulationSnapshot;
  agents: SimulationSnapshot['world']['agents'];
  events: Array<
    Extract<
      SimulationSnapshot['world']['events'][number],
      { type: 'public-message-sent' }
    >
  >;
  turns: AgentTurnRecord[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [atTop, setAtTop] = useState(true);
  const [newMessages, setNewMessages] = useState(0);
  const feedRef = useRef<HTMLOListElement | null>(null);
  const previousCount = useRef(events.length);
  const previousScrollHeight = useRef(0);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || collapsed) return;
    const added = Math.max(0, events.length - previousCount.current);
    const heightDelta = feed.scrollHeight - previousScrollHeight.current;
    if (added > 0) {
      if (atTop) {
        feed.scrollTop = 0;
      } else {
        feed.scrollTop += Math.max(0, heightDelta);
        queueMicrotask(() => setNewMessages((count) => count + added));
      }
    } else if (atTop) feed.scrollTop = 0;
    previousCount.current = events.length;
    previousScrollHeight.current = feed.scrollHeight;
  }, [atTop, collapsed, events.length]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!collapsed && feed) {
      previousScrollHeight.current = feed.scrollHeight;
      if (atTop) feed.scrollTop = 0;
    }
  }, [atTop, collapsed]);

  const jumpToNewest = () => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = 0;
    setAtTop(true);
    setNewMessages(0);
  };

  return (
    <section
      className={`panel world-chat-panel${collapsed ? ' chat-collapsed' : ''}`}
      aria-label="Public world chat"
      id="activity-chat"
      role="tabpanel"
    >
      <div className="dock-heading">
        <div>
          <p className="panel-kicker">Visible to every agent</p>
          <h2>Public world chat</h2>
        </div>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} Public world chat`}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {newMessages > 0 && !collapsed && (
        <button
          className="new-message-button"
          type="button"
          onClick={jumpToNewest}
        >
          {newMessages} new {newMessages === 1 ? 'message' : 'messages'} ·
          Return to latest
        </button>
      )}
      {!collapsed && (
        <>
          {events.length === 0 ? (
            <p className="muted">No public messages yet.</p>
          ) : (
            <ol
              className="world-chat-feed"
              ref={feedRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const nearTop = element.scrollTop <= 36;
                setAtTop(nearTop);
                if (nearTop) setNewMessages(0);
              }}
            >
              {events.toReversed().map((event) => {
                const sender = agents.find(({ id }) => id === event.agentId);
                const turn = turns.find(
                  (turn) =>
                    turn.outcome !== 'provider-error' &&
                    turn.outcome !== 'lost-tick' &&
                    turn.outcome !== 'operator-skipped' &&
                    turn.communicationResult.requested &&
                    turn.communicationResult.accepted &&
                    turn.communicationResult.event.id === event.id,
                );
                return (
                  <li
                    key={event.id}
                    style={{
                      borderLeftColor: resolveAgentColor(
                        snapshot,
                        event.agentId,
                      ),
                    }}
                  >
                    <div>
                      <strong
                        style={{
                          color: resolveAgentColor(snapshot, event.agentId),
                        }}
                      >
                        {sender?.name ?? event.agentId}
                      </strong>
                      <small>
                        {formatRecordSequence(turn)} ·{' '}
                        {formatTimestamp(event.occurredAt)}
                      </small>
                    </div>
                    <p>{event.message}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function TerritoryScoreboard({
  entries,
}: {
  entries: SimulationSnapshot['experiment']['currentTerritory'];
}) {
  return (
    <section
      className="panel territory-panel"
      aria-label="Territory scoreboard"
    >
      <p className="panel-kicker">Current authoritative control</p>
      <h2>Territory scoreboard</h2>
      <ol>
        {entries.map((entry) => (
          <li key={entry.agentId}>
            <span
              className="agent-swatch"
              style={{ background: entry.effectiveColor }}
            />
            <span>{entry.name}</span>
            <strong>{entry.controlledCellCount}</strong>
            <span className="sr-only">controlled cells</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AlliancePanel({ snapshot }: { snapshot: SimulationSnapshot }) {
  const unaffiliated = snapshot.world.agents.filter(
    ({ id }) =>
      !snapshot.world.alliances.some(({ memberAgentIds }) =>
        memberAgentIds.includes(id),
      ),
  );
  return (
    <section
      className="panel territory-panel"
      aria-label="Alliance and territory panel"
    >
      <p className="panel-kicker">Formal engine authority</p>
      <h2>Alliances</h2>
      {snapshot.experiment.currentAlliances.length === 0 ? (
        <p className="muted">No active alliances.</p>
      ) : (
        <ol>
          {snapshot.experiment.currentAlliances.map((alliance) => (
            <li key={alliance.allianceId}>
              <span
                className="agent-swatch"
                style={{ background: alliance.color }}
              />
              <span>
                {alliance.members
                  .map(
                    ({ name, controlledCellCount }) =>
                      `${name} (${controlledCellCount})`,
                  )
                  .join(', ')}
              </span>
              <strong>{alliance.totalControlledCellCount}</strong>
              <span className="sr-only">combined controlled cells</span>
            </li>
          ))}
        </ol>
      )}
      <h3>Unaffiliated agents</h3>
      <p>
        {unaffiliated.length
          ? unaffiliated.map(({ name }) => name).join(', ')
          : 'None'}
      </p>
      <h3>Pending proposals</h3>
      {snapshot.world.pendingAllianceProposals.length ? (
        <ol>
          {snapshot.world.pendingAllianceProposals.map((proposal) => (
            <li key={proposal.id}>
              {
                snapshot.world.agents.find(
                  ({ id }) => id === proposal.proposerAgentId,
                )?.name
              }{' '}
              →{' '}
              {
                snapshot.world.agents.find(
                  ({ id }) => id === proposal.recipientAgentId,
                )?.name
              }
              ; expires after{' '}
              {proposal.expirationTick === undefined
                ? `legacy turn ${proposal.expirationTurn}`
                : `tick ${proposal.expirationTick}`}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No pending alliance proposals.</p>
      )}
      <h3>Recent alliance changes</h3>
      <AllianceEventList snapshot={snapshot} />
    </section>
  );
}

function AllianceEventList({
  snapshot,
  agentId,
}: {
  snapshot: SimulationSnapshot;
  agentId?: AgentId;
}) {
  const events = snapshot.world.events
    .filter(
      (event): event is AllianceWorldEvent =>
        event.type === 'alliance-proposed' ||
        event.type === 'alliance-proposal-closed' ||
        event.type === 'alliance-formed' ||
        event.type === 'agent-joined-alliance' ||
        event.type === 'agent-left-alliance' ||
        event.type === 'alliance-dissolved',
    )
    .filter(
      (event) => !agentId || allianceEventParticipants(event).includes(agentId),
    );
  if (!events.length) return <p className="muted">No alliance changes yet.</p>;
  return (
    <ol className="compact-history">
      {events.slice(-8).map((event) => {
        const turn = snapshot.turns.find(
          (candidate) =>
            candidate.outcome !== 'provider-error' &&
            candidate.outcome !== 'lost-tick' &&
            candidate.outcome !== 'operator-skipped' &&
            candidate.allianceEvents.some(({ id }) => id === event.id),
        );
        return (
          <li key={event.id}>
            <span>{formatAllianceEvent(event, snapshot)}</span>
            <small>
              {formatRecordSequence(turn)} · {formatTimestamp(event.occurredAt)}
            </small>
          </li>
        );
      })}
    </ol>
  );
}

function AgentBehaviorTrace({
  agent,
  id,
  turns,
  onHighlightCell,
}: {
  agent: SimulationSnapshot['world']['agents'][number];
  id: string;
  turns: AgentTurnRecord[];
  onHighlightCell?: (cell: H3Cell) => void;
}) {
  const entries = deriveBehaviorTrace(turns, agent.id);
  return (
    <section className="behavior-trace-panel" id={id}>
      <div className="behavior-trace-heading">
        <div>
          <h3>Behavior trace</h3>
          <p>
            Observation evidence and self-reported summaries show correlation,
            not proven causation.
          </p>
        </div>
        <span>
          {entries.length}/{BEHAVIOR_TRACE_LIMIT} retained
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="muted">No retained behavior records for this agent.</p>
      ) : (
        <ol className="behavior-trace" aria-label="Recent behavior trace">
          {entries.map((entry, index) => {
            return (
              <li key={entry.turn.turnNumber}>
                <details open={index === 0}>
                  <summary>
                    <span>
                      {formatRecordSequence(entry.turn)} · record{' '}
                      {entry.turn.turnNumber}
                    </span>
                    <span className={`outcome ${entry.turn.outcome}`}>
                      {entry.turn.outcome}
                    </span>
                  </summary>
                  <div className="behavior-trace-body">
                    <div className="behavior-trace-block">
                      <strong>What changed</strong>
                      <ul>
                        {entry.observedChanges.map((change) => (
                          <li key={change}>{change}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="behavior-trace-block">
                      <strong>
                        {entry.hasPreviousObservation
                          ? 'New retained evidence'
                          : 'Evidence visible at retained baseline'}
                      </strong>
                      {entry.evidence.length ? (
                        <ul>
                          {entry.evidence.map((evidence, evidenceIndex) => (
                            <li key={`${evidence.kind}-${evidenceIndex}`}>
                              {evidence.label}{' '}
                              {evidence.cell && onHighlightCell && (
                                <button
                                  type="button"
                                  className="trace-cell-button"
                                  onClick={() =>
                                    onHighlightCell(evidence.cell!)
                                  }
                                >
                                  Highlight cell
                                </button>
                              )}
                            </li>
                          ))}
                          {entry.evidenceTruncated && (
                            <li>Additional evidence omitted from this view.</li>
                          )}
                        </ul>
                      ) : (
                        <p>
                          {entry.hasPreviousObservation
                            ? 'No new communication or board evidence retained.'
                            : 'No retained communication or board evidence visible.'}
                        </p>
                      )}
                    </div>
                    <div className="behavior-trace-decision">
                      <p>
                        <strong>Observed cell:</strong>{' '}
                        {entry.turn.observation.currentCell.cell}{' '}
                        {onHighlightCell && (
                          <button
                            type="button"
                            className="trace-cell-button"
                            onClick={() =>
                              onHighlightCell(
                                entry.turn.observation.currentCell.cell,
                              )
                            }
                          >
                            Highlight observed cell
                          </button>
                        )}
                      </p>
                      <p>
                        <strong>Legal choices:</strong>{' '}
                        {entry.legalActions.join(' · ')}
                      </p>
                      <p>
                        <strong>Chosen:</strong> {entry.chosenAction}{' '}
                        {entry.chosenCell && onHighlightCell && (
                          <button
                            type="button"
                            className="trace-cell-button"
                            onClick={() => onHighlightCell(entry.chosenCell!)}
                          >
                            Highlight chosen cell
                          </button>
                        )}
                      </p>
                      {entry.actionPattern && (
                        <p>
                          <strong>Pattern:</strong> {entry.actionPattern}
                        </p>
                      )}
                      <p>
                        <strong>
                          Model summary (self-reported, not proof):
                        </strong>{' '}
                        {entry.turn.outcome === 'accepted' ||
                        entry.turn.outcome === 'rejected'
                          ? entry.turn.summary
                          : `${entry.turn.failure.code}: ${entry.turn.failure.message}`}
                      </p>
                    </div>
                    <div className="behavior-trace-block">
                      <strong>Continuity operations</strong>
                      {entry.continuity.length ? (
                        <ul>
                          {entry.continuity.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>
                          No goal, memory, communication, or diplomacy update.
                        </p>
                      )}
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AgentInspector({
  agent,
  snapshot,
  cellState,
  latestTurn,
  turns,
  directMessages,
  agents,
  mutationDisabled,
  mutationPending,
  onApplyPersonality,
  onHighlightCell,
  metrics,
  controlledCellCount,
  controlChanges,
}: {
  agent: SimulationSnapshot['world']['agents'][number];
  snapshot: SimulationSnapshot;
  cellState: 'open' | 'infected';
  latestTurn?: AgentTurnRecord;
  turns: AgentTurnRecord[];
  directMessages: Array<
    Extract<
      SimulationSnapshot['world']['events'][number],
      { type: 'direct-message-sent' }
    >
  >;
  agents: SimulationSnapshot['world']['agents'];
  mutationDisabled: boolean;
  mutationPending: boolean;
  onApplyPersonality: (
    agentId: AgentId,
    personality: string,
  ) => Promise<boolean>;
  onHighlightCell?: (cell: H3Cell) => void;
  metrics?: SimulationSnapshot['experiment']['metrics']['aggregate'];
  controlledCellCount: number;
  controlChanges: Array<
    Extract<
      SimulationSnapshot['world']['events'][number],
      { type: 'hex-captured' }
    >
  >;
}) {
  type CompletedAgentTurnRecord = Extract<
    AgentTurnRecord,
    { outcome: 'accepted' | 'rejected' }
  >;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.personality);
  const [editError, setEditError] = useState<string | null>(null);

  const draftPreset = matchingPersonalityPreset(draft);
  const activePreset = matchingPersonalityPreset(agent.personality);
  const alliance = snapshot.world.alliances.find(({ memberAgentIds }) =>
    memberAgentIds.includes(agent.id),
  );
  const allianceSummary = snapshot.experiment.currentAlliances.find(
    ({ allianceId }) => allianceId === alliance?.id,
  );
  const agentColor = resolveAgentColor(snapshot, agent.id);
  const pendingProposals = snapshot.world.pendingAllianceProposals.filter(
    ({ proposerAgentId, recipientAgentId }) =>
      proposerAgentId === agent.id || recipientAgentId === agent.id,
  );
  const resolvedModel = snapshot.resolvedModels.find(
    ({ agentId }) => agentId === agent.id,
  );
  const currentGoal = snapshot.agentGoals.find(
    ({ agentId }) => agentId === agent.id,
  )?.goal;
  const currentMemory =
    snapshot.agentMemories.find(({ agentId }) => agentId === agent.id)
      ?.entries ?? [];
  const latestGoalTurn = turns.findLast(
    (turn): turn is CompletedAgentTurnRecord =>
      (turn.outcome === 'accepted' || turn.outcome === 'rejected') &&
      turn.agentId === agent.id &&
      turn.goalRevisionResult.requested,
  );
  const latestMemoryTurn = turns.findLast(
    (turn): turn is CompletedAgentTurnRecord =>
      (turn.outcome === 'accepted' || turn.outcome === 'rejected') &&
      turn.agentId === agent.id &&
      turn.memoryOperationResult.requested,
  );
  const inspectorSectionPrefix = `agent-${agent.id}`;

  const apply = async () => {
    const parsed = personalitySchema.safeParse(draft);
    if (!parsed.success) {
      setEditError(
        `Enter a personality between 1 and ${PERSONALITY_MAX_LENGTH} characters.`,
      );
      return;
    }
    setEditError(null);
    if (await onApplyPersonality(agent.id, parsed.data)) setEditing(false);
  };

  return (
    <section className="panel agent-inspector" aria-label="Agent inspector">
      <p className="panel-kicker">Agent inspector</p>
      <h2>
        <span className="agent-swatch" style={{ background: agentColor }} />
        {agent.name}
        {agent.id === snapshot.scenario.patientZeroAgentId && (
          <span className="patient-zero-badge">Patient Zero</span>
        )}
      </h2>
      <nav
        className="agent-inspector-nav"
        aria-label={`${agent.name} inspector sections`}
      >
        <a href={`#${inspectorSectionPrefix}-trace`}>Trace</a>
        <a href={`#${inspectorSectionPrefix}-goals`}>Goals</a>
        <a href={`#${inspectorSectionPrefix}-memories`}>Memories</a>
        <a href={`#${inspectorSectionPrefix}-history`}>History</a>
        <a href={`#${inspectorSectionPrefix}-configuration`}>Configuration</a>
        <a href={`#${inspectorSectionPrefix}-latest`}>Latest</a>
      </nav>
      <dl>
        <div>
          <dt>Patient Zero role</dt>
          <dd>
            {agent.id === snapshot.scenario.patientZeroAgentId
              ? 'Designated coordinator (normal world-action rules)'
              : snapshot.scenario.patientZeroAgentId
                ? 'Field agent'
                : 'Disabled'}
          </dd>
        </div>
        <div>
          <dt>Stable ID</dt>
          <dd>{agent.id}</dd>
        </div>
        <div>
          <dt>Affiliation color</dt>
          <dd>{agentColor}</dd>
        </div>
        <div>
          <dt>Alliance membership</dt>
          <dd>
            {alliance
              ? allianceSummary?.members.map(({ name }) => name).join(', ')
              : 'Unaffiliated'}
          </dd>
        </div>
        <div>
          <dt>Alliance territory</dt>
          <dd>
            {allianceSummary?.totalControlledCellCount ?? 0} controlled cells
          </dd>
        </div>
        <div>
          <dt>Cell</dt>
          <dd>{agent.currentCell}</dd>
        </div>
        <div>
          <dt>Cell state</dt>
          <dd>{cellState}</dd>
        </div>
        <div>
          <dt>Resolved model</dt>
          <dd>
            {resolvedModel?.modelId ?? 'Not selected'} ·{' '}
            {resolvedModel?.source ?? 'missing'}
            {!resolvedModel?.available && ' · unavailable'}
          </dd>
        </div>
      </dl>
      <AgentBehaviorTrace
        agent={agent}
        id={`${inspectorSectionPrefix}-trace`}
        turns={turns}
        onHighlightCell={onHighlightCell}
      />
      <h3 id={`${inspectorSectionPrefix}-goals`}>Goals</h3>
      {currentGoal ? (
        <dl aria-label="Current agent goal">
          <div>
            <dt>Long-term</dt>
            <dd>{currentGoal.longTermGoal}</dd>
          </div>
          <div>
            <dt>Short-term</dt>
            <dd>{currentGoal.shortTermGoal}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{currentGoal.planSummary}</dd>
          </div>
          <div>
            <dt>Attribution</dt>
            <dd>
              Established tick {currentGoal.establishedAtTick}; revised tick{' '}
              {currentGoal.revisedAtTick}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">No active strategic goal.</p>
      )}
      <p aria-label="Latest goal result">
        {latestGoalTurn && latestGoalTurn.goalRevisionResult.requested
          ? `Latest: ${latestGoalTurn.goalRevisionResult.operation} · ${
              latestGoalTurn.goalRevisionResult.accepted
                ? 'accepted'
                : `rejected (${latestGoalTurn.goalRevisionResult.reason})`
            }`
          : 'No goal operation recorded.'}
      </p>
      {latestGoalTurn?.goalRevision &&
        'reason' in latestGoalTurn.goalRevision && (
          <p aria-label="Latest agent goal reason">
            Agent reason: {latestGoalTurn.goalRevision.reason}
          </p>
        )}
      <h3 id={`${inspectorSectionPrefix}-memories`}>Memories</h3>
      {currentMemory.length ? (
        <ol aria-label="Current agent memories">
          {currentMemory.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.text}</strong>
              <br />
              <span className="muted">
                {entry.id} · created tick {entry.createdAtTick} · revised tick{' '}
                {entry.revisedAtTick}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No compact memories.</p>
      )}
      <p aria-label="Latest memory result">
        {latestMemoryTurn && latestMemoryTurn.memoryOperationResult.requested
          ? `Latest: ${latestMemoryTurn.memoryOperationResult.operation} · ${
              latestMemoryTurn.memoryOperationResult.accepted
                ? 'accepted'
                : `rejected (${latestMemoryTurn.memoryOperationResult.reason})`
            }`
          : 'No memory operation recorded.'}
      </p>
      <h3>Relevant pending proposals</h3>
      {pendingProposals.length ? (
        <ol>
          {pendingProposals.map((proposal) => (
            <li key={proposal.id}>
              {
                snapshot.world.agents.find(
                  ({ id }) => id === proposal.proposerAgentId,
                )?.name
              }{' '}
              →{' '}
              {
                snapshot.world.agents.find(
                  ({ id }) => id === proposal.recipientAgentId,
                )?.name
              }
              ; expires after{' '}
              {proposal.expirationTick === undefined
                ? `legacy turn ${proposal.expirationTurn}`
                : `tick ${proposal.expirationTick}`}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No relevant pending proposals.</p>
      )}
      <h3>Recent alliance changes</h3>
      <AllianceEventList snapshot={snapshot} agentId={agent.id} />
      <div className="agent-usage" aria-label="Selected agent usage">
        <strong>Experiment usage</strong>
        <span>{metrics?.totalTurns ?? 0} turns</span>
        <span>{metrics?.publicMessagesSent ?? 0} public sent</span>
        <span>{metrics?.directMessagesSent ?? 0} direct sent</span>
        <span>{metrics?.directMessagesReceived ?? 0} direct received</span>
        <span>{controlledCellCount} controlled cells</span>
        <span>{formatCost(metrics?.knownCostCredits ?? 0)} known cost</span>
        <span>{metrics?.tokens.promptTokens ?? 0} prompt tokens</span>
        <span>{metrics?.tokens.completionTokens ?? 0} completion tokens</span>
        {(metrics?.tokens.reasoningTokens ?? 0) > 0 && (
          <span>
            {metrics?.tokens.reasoningTokens} reasoning tokens reported
          </span>
        )}
        {(metrics?.turnsWithUnknownCost ?? 0) > 0 && (
          <span>
            {metrics?.attemptsWithUnknownCost} unknown-cost attempts across{' '}
            {metrics?.turnsWithUnknownCost} turns
          </span>
        )}
        {(metrics?.attemptsWithUnknownTokenUsage ?? 0) > 0 && (
          <span>
            Partial token totals · {metrics?.attemptsWithUnknownTokenUsage}{' '}
            attempts missing token usage
          </span>
        )}
      </div>
      <h3 id={`${inspectorSectionPrefix}-history`}>
        Recent territory gains and losses
      </h3>
      {controlChanges.length === 0 ? (
        <p className="muted">
          No territory gains or losses for this agent yet.
        </p>
      ) : (
        <ol className="control-history" aria-label="Recent territory changes">
          {controlChanges.slice(-6).map((change) => {
            const gained = change.controllerAgentId === agent.id;
            const otherId = gained
              ? change.previousControllerAgentId
              : change.controllerAgentId;
            const other = agents.find(({ id }) => id === otherId);
            return (
              <li key={change.id}>
                <strong>{gained ? 'Gained' : 'Lost'}</strong> {change.cell}{' '}
                {gained ? 'from' : 'to'} {other?.name ?? otherId}
              </li>
            );
          })}
        </ol>
      )}
      <h3>Direct-message history</h3>
      {directMessages.length === 0 ? (
        <p className="muted">No direct messages for this agent yet.</p>
      ) : (
        <ol
          className="communication-history"
          aria-label="Direct-message history"
        >
          {directMessages.slice(-12).map((communication) => {
            const sender = agents.find(
              ({ id }) => id === communication.agentId,
            );
            const recipient = agents.find(
              ({ id }) => id === communication.recipientId,
            );
            const direction =
              communication.agentId === agent.id ? 'Sent' : 'Received';
            const other =
              communication.agentId === agent.id ? recipient : sender;
            const turn = turns.find(
              (turn) =>
                turn.outcome !== 'provider-error' &&
                turn.outcome !== 'lost-tick' &&
                turn.outcome !== 'operator-skipped' &&
                turn.communicationResult.requested &&
                turn.communicationResult.accepted &&
                turn.communicationResult.event.id === communication.id,
            );
            return (
              <li
                key={communication.id}
                style={{
                  borderLeftColor: resolveAgentColor(
                    snapshot,
                    communication.agentId,
                  ),
                }}
              >
                <div>
                  <strong>{direction}</strong>{' '}
                  <span>
                    {other?.name ??
                      (direction === 'Sent'
                        ? communication.recipientId
                        : communication.agentId)}
                  </span>
                </div>
                <p>{communication.message}</p>
                <small>
                  {formatRecordSequence(turn)} ·{' '}
                  {formatTimestamp(communication.occurredAt)}
                </small>
              </li>
            );
          })}
        </ol>
      )}
      <div
        className="personality-heading"
        id={`${inspectorSectionPrefix}-configuration`}
      >
        <h3>Active personality</h3>
        {!editing && (
          <button
            disabled={mutationDisabled}
            type="button"
            onClick={() => {
              setDraft(agent.personality);
              setEditError(null);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="personality-editor">
          <label>
            Personality preset
            <select
              disabled={mutationDisabled}
              value={draftPreset?.id ?? 'custom'}
              onChange={(event) => {
                const preset = PERSONALITY_PRESETS.find(
                  ({ id }) => id === event.target.value,
                );
                if (preset) {
                  setDraft(preset.personality);
                  setEditError(null);
                }
              }}
            >
              <option value="custom">Custom</option>
              {PERSONALITY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Personality directive
            <textarea
              aria-describedby="personality-character-count personality-edit-help"
              disabled={mutationDisabled}
              maxLength={PERSONALITY_MAX_LENGTH}
              rows={6}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setEditError(null);
              }}
            />
          </label>
          <div className="editor-meta">
            <span id="personality-edit-help">
              Presets populate the editor; Apply commits the change.
            </span>
            <span id="personality-character-count">
              {draft.length}/{PERSONALITY_MAX_LENGTH}
            </span>
          </div>
          {editError && (
            <p className="inline-error" role="alert">
              {editError}
            </p>
          )}
          <div className="editor-actions">
            <button
              disabled={mutationDisabled}
              type="button"
              onClick={() => void apply()}
            >
              {mutationPending ? 'Applying…' : 'Apply'}
            </button>
            <button
              disabled={mutationPending}
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(agent.personality);
                setEditError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          aria-label="Active personality configuration"
          className="active-personality"
          role="group"
        >
          <p>{agent.personality}</p>
          <span>{activePreset?.name ?? 'Custom'}</span>
        </div>
      )}
      {latestTurn ? (
        <div className="turn-detail" id={`${inspectorSectionPrefix}-latest`}>
          <h3>Latest turn</h3>
          <p className={`outcome ${latestTurn.outcome}`}>
            {latestTurn.outcome}
          </p>
          {latestTurn.outcome !== 'provider-error' &&
          latestTurn.outcome !== 'lost-tick' &&
          latestTurn.outcome !== 'operator-skipped' ? (
            <>
              <p>
                <strong>World action:</strong>{' '}
                {formatAction(latestTurn.worldAction)}
                {' · '}
                {latestTurn.worldActionResult.accepted
                  ? 'accepted'
                  : 'rejected'}
              </p>
              <p>
                <strong>Summary:</strong> {latestTurn.summary}
              </p>
              {!latestTurn.worldActionResult.accepted && (
                <p>
                  <strong>World-action rejection:</strong>{' '}
                  {latestTurn.worldActionResult.reason} ·{' '}
                  {latestTurn.worldActionResult.details}
                </p>
              )}
              <div
                className="component-result"
                aria-label="Communication result"
              >
                <strong>Communication:</strong>{' '}
                {!latestTurn.communicationResult.requested
                  ? 'none requested'
                  : latestTurn.communicationResult.accepted
                    ? `${latestTurn.communicationResult.event.channel} accepted`
                    : `${latestTurn.communicationResult.attempt.channel} rejected · ${latestTurn.communicationResult.reason}`}
              </div>
              <div className="component-result" aria-label="Diplomacy result">
                <strong>Diplomacy:</strong>{' '}
                {!latestTurn.diplomacyResult.requested
                  ? 'none requested'
                  : latestTurn.diplomacyResult.accepted
                    ? `${latestTurn.diplomacyResult.intent.type} accepted`
                    : `${latestTurn.diplomacyResult.attempt.type} rejected · ${latestTurn.diplomacyResult.reason}`}
              </div>
              <p className="provider-meta">
                {latestTurn.provider.provider} · {latestTurn.provider.model} ·{' '}
                {latestTurn.provider.resolvedModel &&
                latestTurn.provider.resolvedModel !== latestTurn.provider.model
                  ? `resolved ${latestTurn.provider.resolvedModel} · `
                  : ''}
                {latestTurn.provider.latencyMs}ms ·{' '}
                {latestTurn.provider.promptTokens ?? '—'} prompt /{' '}
                {latestTurn.provider.completionTokens ?? '—'} completion
                {latestTurn.provider.reasoningTokens === undefined
                  ? ''
                  : ` / ${latestTurn.provider.reasoningTokens} reasoning`}
                {latestTurn.provider.costCredits === undefined
                  ? ' · cost unavailable'
                  : ` · ${formatCost(latestTurn.provider.costCredits)}`}
              </p>
            </>
          ) : (
            <>
              <p className="callout error">
                {latestTurn.failure.code}: {latestTurn.failure.message}
                {latestTurn.failure.providerMessage
                  ? ` Provider: ${latestTurn.failure.providerMessage}`
                  : ''}
              </p>
              <p className="provider-meta">
                Model{' '}
                {latestTurn.failure.model ??
                  latestTurn.provider?.model ??
                  'unavailable'}
                {latestTurn.failure.httpStatus
                  ? ` · HTTP ${latestTurn.failure.httpStatus}`
                  : ''}
                {latestTurn.failure.providerCode
                  ? ` · ${latestTurn.failure.providerCode}`
                  : ''}
                {latestTurn.failure.requestId
                  ? ` · request ${latestTurn.failure.requestId}`
                  : ''}
                {latestTurn.failure.finishReason
                  ? ` · finish ${latestTurn.failure.finishReason}`
                  : ''}
                {latestTurn.failure.nativeFinishReason
                  ? ` · native ${latestTurn.failure.nativeFinishReason}`
                  : ''}
              </p>
              {latestTurn.provider && (
                <p className="provider-meta">
                  {latestTurn.provider.provider} · {latestTurn.provider.model} ·{' '}
                  {latestTurn.provider.latencyMs}ms
                  {latestTurn.provider.requestId
                    ? ` · request ${latestTurn.provider.requestId}`
                    : ''}
                  {latestTurn.provider.finishReason
                    ? ` · finish ${latestTurn.provider.finishReason}`
                    : ''}
                </p>
              )}
            </>
          )}
          <details>
            <summary>Latest structured observation</summary>
            <p className="observation-note">
              Immutable input supplied for {formatRecordSequence(latestTurn)} ·
              record {latestTurn.turnNumber}. It is not rewritten when the
              active personality changes.
            </p>
            {latestTurn.observation.personality !== agent.personality && (
              <p className="observation-difference">
                The active personality has changed since this observation.
              </p>
            )}
            <p>
              <strong>Observed personality:</strong>{' '}
              {latestTurn.observation.personality}
            </p>
            <p>
              Current: {latestTurn.observation.currentCell.cell} (
              {latestTurn.observation.currentCell.state})
            </p>
            <p>
              Capture:{' '}
              {latestTurn.observation.captureEligibility.eligible
                ? 'eligible'
                : `blocked · ${latestTurn.observation.captureEligibility.blockedReason}`}
            </p>
            <p>
              Adjacent:{' '}
              {latestTurn.observation.adjacentCells
                .map(({ cell, state }) => `${cell} (${state})`)
                .join(', ')}
            </p>
            <p>
              Nearby:{' '}
              {latestTurn.observation.nearbyAgents
                .map(({ name, distance }) => `${name} (${distance})`)
                .join(', ') || 'none'}
            </p>
            <p>
              Recent public events: {latestTurn.observation.recentEvents.length}
            </p>
            <p>
              Recent public messages:{' '}
              {latestTurn.observation.recentPublicMessages.length}
            </p>
            <ol className="observation-communications">
              {latestTurn.observation.recentPublicMessages.map(
                (communication) => (
                  <li key={communication.eventId}>
                    {communication.senderName}: {communication.message}
                  </li>
                ),
              )}
            </ol>
            <p>
              Recent direct messages:{' '}
              {latestTurn.observation.recentDirectMessages.length}
            </p>
            <ol className="observation-communications">
              {latestTurn.observation.recentDirectMessages.map(
                (communication) => (
                  <li key={communication.eventId}>
                    {communication.direction}: {communication.senderName} →{' '}
                    {communication.recipientName}: {communication.message}
                  </li>
                ),
              )}
            </ol>
          </details>
        </div>
      ) : (
        <p className="muted" id={`${inspectorSectionPrefix}-latest`}>
          No completed turn for this agent yet.
        </p>
      )}
      <h3>Recent records</h3>
      <ol className="compact-history">
        {turns
          .filter(({ agentId }) => agentId === agent.id)
          .slice(-5)
          .toReversed()
          .map((turn) => (
            <li key={turn.turnNumber}>
              {formatRecordSequence(turn)}: {turn.outcome}
            </li>
          ))}
      </ol>
    </section>
  );
}

function ExperimentUsageMeter({ snapshot }: { snapshot: SimulationSnapshot }) {
  const metrics = snapshot.experiment.metrics.aggregate;
  return (
    <div className="usage-meter" aria-label="Current experiment usage">
      <strong>Current experiment</strong>
      <span>{snapshot.experiment.totalCompletedTurns} turns</span>
      <span>{metrics.publicMessagesAccepted} public messages</span>
      <span>{metrics.directMessagesDelivered} direct messages</span>
      <span>{formatCost(metrics.knownCostCredits)} known cost</span>
      <span>
        {metrics.tokens.totalTokens ??
          (metrics.tokens.promptTokens ?? 0) +
            (metrics.tokens.completionTokens ?? 0)}{' '}
        tokens
      </span>
      {metrics.turnsWithUnknownCost > 0 && (
        <span>
          {metrics.attemptsWithUnknownCost} unknown-cost attempts across{' '}
          {metrics.turnsWithUnknownCost} turns
        </span>
      )}
      {metrics.attemptsWithUnknownTokenUsage > 0 && (
        <span>
          Partial token totals · {metrics.attemptsWithUnknownTokenUsage}{' '}
          attempts missing token usage
        </span>
      )}
    </div>
  );
}

const defaultCustomOptions: CustomExportOptions = {
  turnObservations: true,
  personalityTextHistory: true,
  nearbyAgents: true,
  recentEvents: true,
  recentPublicMessages: true,
  recentDirectMessages: true,
  recentControlChanges: true,
  validationDetails: true,
  resultingEvents: true,
  providerUsageMetadata: true,
  initialWorldState: false,
  currentWorldState: true,
  computedMetrics: true,
  communications: true,
  controlChanges: true,
};

function ExperimentExportPanel({
  snapshot,
  agents,
  disabled,
  open,
  selectedAgentIds,
  onOpenChange,
  onSelectionChange,
  returnFocusRef,
}: {
  snapshot: SimulationSnapshot;
  agents: SimulationSnapshot['world']['agents'];
  disabled: boolean;
  open: boolean;
  selectedAgentIds: AgentId[];
  onOpenChange: (open: boolean) => void;
  onSelectionChange: (ids: AgentId[]) => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}) {
  const [level, setLevel] =
    useState<ExperimentExportRequest['level']>('minimal');
  const [serialization, setSerialization] =
    useState<ExperimentExportRequest['serialization']>('compact');
  const [turnMode, setTurnMode] = useState<
    'entire-retained' | 'latest' | 'range'
  >('entire-retained');
  const [latestCount, setLatestCount] = useState<10 | 25 | 50 | 120>(120);
  const [fromTurn, setFromTurn] = useState(1);
  const [toTurn, setToTurn] = useState(120);
  const [outcomes, setOutcomes] = useState<
    Array<
      | 'accepted'
      | 'rejected'
      | 'lost-tick'
      | 'provider-error'
      | 'operator-skipped'
    >
  >([
    'accepted',
    'rejected',
    'lost-tick',
    'provider-error',
    'operator-skipped',
  ]);
  const [actions, setActions] = useState<
    Array<'move' | 'infect' | 'capture' | 'wait'>
  >(['move', 'infect', 'capture', 'wait']);
  const [communicationChannel, setCommunicationChannel] = useState<
    'all' | 'public' | 'direct'
  >('all');
  const [communicationStatus, setCommunicationStatus] = useState<
    'all' | 'accepted' | 'rejected'
  >('all');
  const [custom, setCustom] = useState(defaultCustomOptions);
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
    agents:
      selectedAgentIds.length === agents.length
        ? { mode: 'all' as const }
        : { mode: 'selected' as const, agentIds: selectedAgentIds },
    turns:
      turnMode === 'entire-retained'
        ? { mode: 'entire-retained' as const }
        : turnMode === 'latest'
          ? { mode: 'latest' as const, count: latestCount }
          : { mode: 'range' as const, fromTurn, toTurn },
    outcomes,
    actions,
    communications: {
      channel: communicationChannel,
      status: communicationStatus,
    },
    level,
    serialization,
    ...(level === 'custom' ? { custom } : {}),
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
      const scope =
        document.selection.selectedAgentIds.length === agents.length
          ? 'all-agents'
          : document.selection.selectedAgentIds.length === 1
            ? 'one-agent'
            : `${document.selection.selectedAgentIds.length}-agents`;
      const range =
        document.filters.turns.mode === 'range'
          ? `turns-${document.filters.turns.fromTurn}-${document.filters.turns.toTurn}`
          : document.filters.turns.mode === 'latest'
            ? `latest-${document.filters.turns.count}`
            : 'entire-retained';
      link.href = url;
      link.download = `hexzero-experiment-${document.experiment.id}-${scope}-${range}.json`;
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
      operation !== null ||
      sqlitePendingRef.current
    )
      return;
    sqlitePendingRef.current = true;
    setOperation('sqlite');
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/experiment/export/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document }),
      });
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
      sqlitePendingRef.current = false;
      setOperation(null);
    }
  };

  const toggle = <T extends string>(values: T[], value: T): T[] =>
    values.includes(value)
      ? values.filter((candidate) => candidate !== value)
      : [...values, value];

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
      <fieldset className="export-agent-section">
        <legend>Agents</legend>
        <div className="selection-actions" aria-label="Agent selection actions">
          <button
            type="button"
            onClick={() => onSelectionChange(agents.map(({ id }) => id))}
          >
            Select all
          </button>
          <button type="button" onClick={() => onSelectionChange([])}>
            Clear
          </button>
        </div>
        <div className="export-agent-grid">
          {agents.map((agent) => (
            <label className="checkbox-row" key={agent.id}>
              <input
                checked={selectedAgentIds.includes(agent.id)}
                type="checkbox"
                onChange={() =>
                  onSelectionChange(toggle(selectedAgentIds, agent.id))
                }
              />
              <span
                className="agent-swatch"
                style={{ background: resolveAgentColor(snapshot, agent.id) }}
              />
              {agent.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Export level
        <select
          value={level}
          onChange={(event) =>
            setLevel(event.target.value as ExperimentExportRequest['level'])
          }
        >
          <option value="minimal">Minimal</option>
          <option value="standard">Standard</option>
          <option value="full-safe">Full safe</option>
          <option value="custom">Custom export</option>
        </select>
      </label>
      <fieldset>
        <legend>Advanced JSON options</legend>
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
      </fieldset>
      <label>
        Turn range
        <select
          value={turnMode}
          onChange={(event) =>
            setTurnMode(event.target.value as typeof turnMode)
          }
        >
          <option value="entire-retained">Entire retained experiment</option>
          <option value="latest">Latest matching records</option>
          <option value="range">Custom absolute range</option>
        </select>
      </label>
      {turnMode === 'latest' && (
        <label>
          Latest count
          <select
            value={latestCount}
            onChange={(event) =>
              setLatestCount(Number(event.target.value) as typeof latestCount)
            }
          >
            {[10, 25, 50, 120].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
      )}
      {turnMode === 'range' && (
        <div className="range-row">
          <label>
            From turn
            <input
              min="1"
              type="number"
              value={fromTurn}
              onChange={(event) => setFromTurn(Number(event.target.value))}
            />
          </label>
          <label>
            To turn
            <input
              min="1"
              type="number"
              value={toTurn}
              onChange={(event) => setToTurn(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      <FilterChecks
        label="Outcomes"
        options={[
          'accepted',
          'rejected',
          'lost-tick',
          'provider-error',
          'operator-skipped',
        ]}
        selected={outcomes}
        onToggle={(value) => setOutcomes(toggle(outcomes, value))}
      />
      <FilterChecks
        label="Actions"
        options={['move', 'infect', 'capture', 'wait']}
        selected={actions}
        onToggle={(value) => setActions(toggle(actions, value))}
      />
      <div className="range-row">
        <label>
          Communication channel
          <select
            value={communicationChannel}
            onChange={(event) =>
              setCommunicationChannel(
                event.target.value as typeof communicationChannel,
              )
            }
          >
            <option value="all">All</option>
            <option value="public">Public</option>
            <option value="direct">Direct</option>
          </select>
        </label>
        <label>
          Communication result
          <select
            value={communicationStatus}
            onChange={(event) =>
              setCommunicationStatus(
                event.target.value as typeof communicationStatus,
              )
            }
          >
            <option value="all">All</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      {level === 'custom' && (
        <fieldset>
          <legend>Advanced Custom switches</legend>
          {(Object.keys(custom) as Array<keyof CustomExportOptions>).map(
            (key) => (
              <label className="checkbox-row" key={key}>
                <input
                  checked={custom[key]}
                  disabled={
                    (key === 'nearbyAgents' ||
                      key === 'recentEvents' ||
                      key === 'recentPublicMessages' ||
                      key === 'recentDirectMessages' ||
                      key === 'recentControlChanges') &&
                    !custom.turnObservations
                  }
                  type="checkbox"
                  onChange={() =>
                    setCustom((current) => {
                      const next = { ...current, [key]: !current[key] };
                      if (
                        key === 'turnObservations' &&
                        !next.turnObservations
                      ) {
                        next.nearbyAgents = false;
                        next.recentEvents = false;
                        next.recentPublicMessages = false;
                        next.recentDirectMessages = false;
                        next.recentControlChanges = false;
                      }
                      return next;
                    })
                  }
                />
                {customOptionLabel(key)}
              </label>
            ),
          )}
        </fieldset>
      )}
      {open && !parsedRequest.success && (
        <p className="inline-error" role="alert">
          Select at least one agent, outcome, and action, and enter a valid
          range.
        </p>
      )}
      {disabled && (
        <p className="muted">
          Pause playback and wait for all turn, reset, and personality work to
          finish.
        </p>
      )}
      {preview && (
        <dl className="preview-grid" aria-label="Export preview">
          <div>
            <dt>Matching</dt>
            <dd>{preview.matchingTurnCount} turns</dd>
          </div>
          <div>
            <dt>Communications</dt>
            <dd>{preview.matchingCommunicationCount} matched</dd>
          </div>
          <div>
            <dt>Control changes</dt>
            <dd>{preview.matchingControlChangeCount} matched</dd>
          </div>
          <div>
            <dt>Diplomacy/alliance events</dt>
            <dd>{preview.matchingDiplomacyEventCount} matched</dd>
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
            <dt>Selected cost</dt>
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

function FilterChecks<T extends string>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <fieldset className="filter-checks">
      <legend>{label}</legend>
      <div className="filter-check-grid">
        {options.map((option) => (
          <label className="checkbox-row" key={option}>
            <input
              checked={selected.includes(option)}
              type="checkbox"
              onChange={() => onToggle(option)}
            />
            {option.replaceAll('-', ' ')}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function customOptionLabel(key: keyof CustomExportOptions): string {
  return {
    turnObservations: 'Turn observations',
    personalityTextHistory: 'Personality text and history',
    nearbyAgents: 'Nearby agents',
    recentEvents: 'Recent events',
    recentPublicMessages: 'Recent public messages in observations',
    recentDirectMessages: 'Recent direct messages in observations',
    recentControlChanges: 'Recent control changes in observations',
    validationDetails: 'Validation details',
    resultingEvents: 'Resulting events',
    providerUsageMetadata: 'Provider usage metadata',
    initialWorldState: 'Initial world state',
    currentWorldState: 'Current world state',
    computedMetrics: 'Computed metrics',
    communications: 'Canonical communications',
    controlChanges: 'Canonical control changes',
  }[key];
}

function formatCost(cost: number): string {
  return `${cost.toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0')} credits`;
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

function EventLog({
  snapshot,
  turns,
  agents,
  collapsed,
  onCollapsedChange,
}: {
  snapshot: SimulationSnapshot;
  turns: AgentTurnRecord[];
  agents: SimulationSnapshot['world']['agents'];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  return (
    <section
      className={`panel event-panel${collapsed ? ' dock-collapsed' : ''}`}
      id="activity-events"
      role="tabpanel"
    >
      <div className="dock-heading">
        <div>
          <p className="panel-kicker">World events</p>
          <h2>Event log</h2>
        </div>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} Event log`}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>
      {!collapsed && (
        <ol aria-label="World event log">
          {turns.length === 0 ? (
            <li>
              <time>Initial</time>
              <span>Development world loaded with {agents.length} agents.</span>
            </li>
          ) : (
            turns
              .slice(-20)
              .toReversed()
              .map((turn) => (
                <li
                  data-outcome={turn.outcome}
                  key={turn.turnNumber}
                  style={{
                    borderLeft: `3px solid ${resolveAgentColor(snapshot, turn.agentId)}`,
                    paddingLeft: 8,
                  }}
                >
                  <time>{formatRecordSequence(turn)}</time>
                  <span>{formatTurn(turn, agents)}</span>
                  <small>
                    {agents.find(({ id }) => id === turn.agentId)?.name ??
                      turn.agentId}
                    {' · '}
                    {turn.provider?.model ?? 'model unavailable'}
                  </small>
                </li>
              ))
          )}
        </ol>
      )}
    </section>
  );
}

function formatAction(
  action: Extract<
    AgentTurnRecord,
    { outcome: 'accepted' | 'rejected' }
  >['worldAction'],
) {
  if (action.type === 'move') return `move → ${action.targetCell}`;
  return action.type;
}

function formatTurn(
  turn: AgentTurnRecord,
  agents: SimulationSnapshot['world']['agents'],
) {
  if (turn.outcome === 'lost-tick')
    return `Lost tick ${turn.tickNumber}: ${turn.failure.code}`;
  if (turn.outcome === 'provider-error')
    return `Provider failure · ${turn.failure.message}`;
  if (turn.outcome === 'operator-skipped')
    return `Operator skipped · ${turn.failure.message}`;
  const communication = !turn.communicationResult.requested
    ? ''
    : turn.communicationResult.accepted
      ? ` + ${turn.communicationResult.event.channel} message accepted`
      : ` + ${turn.communicationResult.attempt.channel} message rejected (${turn.communicationResult.reason})`;
  const diplomacy = !turn.diplomacyResult.requested
    ? ''
    : turn.diplomacyResult.accepted
      ? ` + ${turn.diplomacyResult.intent.type} accepted`
      : ` + ${turn.diplomacyResult.attempt.type} rejected (${turn.diplomacyResult.reason})`;
  if (!turn.worldActionResult.accepted)
    return `Rejected ${formatAction(turn.worldAction)} · ${turn.worldActionResult.reason}${communication}${diplomacy}`;
  const event = turn.worldActionResult.event;
  if (event.type === 'agent-moved')
    return `Movement · ${event.toCell}${communication}${diplomacy}`;
  if (event.type === 'hex-infected')
    return `Infection · ${event.cell}${communication}${diplomacy}`;
  if (event.type === 'hex-captured') {
    const capturer = agents.find(({ id }) => id === event.controllerAgentId);
    const previous = agents.find(
      ({ id }) => id === event.previousControllerAgentId,
    );
    return `${capturer?.name ?? event.controllerAgentId} captured ${event.cell} from ${previous?.name ?? event.previousControllerAgentId}.${communication}${diplomacy}`;
  }
  return `Waited${communication}${diplomacy}`;
}

type AllianceWorldEvent = Extract<
  SimulationSnapshot['world']['events'][number],
  {
    type:
      | 'alliance-proposed'
      | 'alliance-proposal-closed'
      | 'alliance-formed'
      | 'agent-joined-alliance'
      | 'agent-left-alliance'
      | 'alliance-dissolved';
  }
>;

function allianceEventParticipants(event: AllianceWorldEvent): AgentId[] {
  if (event.type === 'alliance-proposed')
    return [event.agentId, event.recipientAgentId];
  if (event.type === 'alliance-proposal-closed')
    return [event.proposerAgentId, event.recipientAgentId];
  if (event.type === 'alliance-formed') return event.memberAgentIds;
  if (event.type === 'agent-joined-alliance') return event.memberAgentIds;
  if (event.type === 'agent-left-alliance')
    return [event.leftAgentId, ...event.remainingMemberAgentIds];
  return event.formerMemberAgentIds;
}

function formatAllianceEvent(
  event: AllianceWorldEvent,
  snapshot: SimulationSnapshot,
): string {
  const name = (id: AgentId) =>
    snapshot.world.agents.find((agent) => agent.id === id)?.name ?? id;
  if (event.type === 'alliance-proposed')
    return `${name(event.agentId)} proposed an alliance with ${name(event.recipientAgentId)}.`;
  if (event.type === 'alliance-formed')
    return `${event.memberAgentIds.map(name).join(' and ')} formed an alliance.`;
  if (event.type === 'agent-joined-alliance')
    return `${name(event.joinedAgentId)} joined the alliance.`;
  if (event.type === 'agent-left-alliance')
    return `${name(event.leftAgentId)} left the alliance.`;
  if (event.type === 'alliance-dissolved') return 'The alliance dissolved.';
  return `The proposal from ${name(event.proposerAgentId)} to ${name(event.recipientAgentId)} was ${event.reason}.`;
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatRecordSequence(
  turn?: Pick<AgentTurnRecord, 'tickNumber' | 'turnNumber'>,
): string {
  if (!turn) return 'Record unavailable';
  return turn.tickNumber === undefined
    ? `Turn ${turn.turnNumber}`
    : `Tick ${turn.tickNumber}`;
}
