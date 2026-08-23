import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gridDisk } from 'h3-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DECISION_CONTRACT_VERSION,
  experimentExportDocumentSchema,
  assignBehavior,
  modelCatalogResponseSchema,
  agentTurnRecordSchema,
  simulationSnapshotSchema,
  NEUTRAL_AGENT_COLOR,
  type SimulationSnapshot,
} from '@hexzero/shared';
import {
  createDefaultAppliedScenario,
  createDevelopmentWorld,
  defaultWorldSetupRequest,
  generateDeterministicRoster,
  previewWorldSetup,
} from '@hexzero/world-engine';
import { WorldLab } from './world-lab';
import { PERSONALITY_PRESETS } from './personality-presets';

const mapLibreMock = vi.hoisted(() => ({
  renderMode: 'complete' as 'complete' | 'incomplete',
  rejectSource: false,
  rejectLayers: false,
  duplicateFeatures: false,
  autoRender: true,
  pendingRenderCallbacks: [] as Array<() => void>,
  mapClick: undefined as
    | ((event: { features: Array<{ properties: { cell: string } }> }) => void)
    | undefined,
  mapBackgroundClick: undefined as (() => void) | undefined,
  layers: [] as Array<{
    id: string;
    paint?: Record<string, unknown>;
  }>,
  queryRenderedFeatures: vi.fn(),
  setData: vi.fn(),
  latestSourceData: undefined as unknown,
}));

vi.mock('maplibre-gl', () => {
  class Map {
    source:
      | {
          data: {
            features: Array<{
              properties: { cell: string; state: string; selected: boolean };
            }>;
          };
          setData: (data: unknown) => void;
        }
      | undefined;
    sourceLoaded = false;
    layers = new Set<string>();
    listeners = new globalThis.Map<string, Set<(event?: unknown) => void>>();
    addControl() {}
    addLayer(layer: { id: string; paint?: Record<string, unknown> }) {
      mapLibreMock.layers.push(layer);
      if (!mapLibreMock.rejectLayers) this.layers.add(layer.id);
    }
    addSource(
      id: string,
      source: {
        data: {
          features: Array<{
            properties: { cell: string; state: string; selected: boolean };
          }>;
        };
      },
    ) {
      if (mapLibreMock.rejectSource) return;
      const completeSourceUpdate = () => {
        this.sourceLoaded = true;
        this.emit('sourcedata', { sourceId: id, isSourceLoaded: true });
      };
      this.source = {
        data: source.data,
        setData: (data) => {
          mapLibreMock.setData(data);
          mapLibreMock.latestSourceData = data;
          this.source!.data = data as typeof source.data;
          this.sourceLoaded = false;
          queueMicrotask(completeSourceUpdate);
        },
      };
      mapLibreMock.latestSourceData = source.data;
      queueMicrotask(completeSourceUpdate);
    }
    emit(event: string, eventData?: unknown) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(eventData);
      }
    }
    fitBounds() {}
    getCanvas() {
      return { style: { cursor: '' } };
    }
    getLayer(id: string) {
      return this.layers.has(id) ? { id } : undefined;
    }
    getSource() {
      return this.source;
    }
    isSourceLoaded() {
      return Boolean(this.source) && this.sourceLoaded;
    }
    queryRenderedFeatures(options: { layers: string[] }) {
      mapLibreMock.queryRenderedFeatures(options);
      if (!this.source || !this.layers.has('development-hex-fills')) return [];
      const features =
        mapLibreMock.renderMode === 'incomplete'
          ? this.source.data.features.slice(0, -1)
          : [...this.source.data.features];
      return mapLibreMock.duplicateFeatures && features[0]
        ? [...features, features[0], features[0]]
        : features;
    }
    on(
      event: string,
      layerOrCallback: unknown,
      callback?: (event: {
        features: Array<{ properties: { cell: string } }>;
      }) => void,
    ) {
      if (event === 'style.load' && typeof layerOrCallback === 'function') {
        queueMicrotask(() => layerOrCallback());
      }
      if (event === 'click' && typeof callback === 'function') {
        mapLibreMock.mapClick = callback;
      } else if (event === 'click' && typeof layerOrCallback === 'function') {
        mapLibreMock.mapBackgroundClick = layerOrCallback as () => void;
      } else if (
        event !== 'style.load' &&
        typeof layerOrCallback === 'function'
      ) {
        const listeners =
          this.listeners.get(event) ?? new Set<(event?: unknown) => void>();
        listeners.add(layerOrCallback as (event?: unknown) => void);
        this.listeners.set(event, listeners);
      }
    }
    off(event: string, layerOrCallback: unknown, callback?: () => void) {
      if (typeof layerOrCallback === 'function') {
        this.listeners.get(event)?.delete(layerOrCallback as () => void);
      }
      if (event === 'click' && callback) mapLibreMock.mapClick = undefined;
      if (event === 'click' && !callback)
        mapLibreMock.mapBackgroundClick = undefined;
    }
    triggerRepaint() {
      const completeRender = () => this.emit('render');
      if (mapLibreMock.autoRender) queueMicrotask(completeRender);
      else mapLibreMock.pendingRenderCallbacks.push(completeRender);
    }
    remove() {}
  }
  class Marker {
    constructor(private options: { element: HTMLElement }) {}
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.append(this.options.element);
      return this;
    }
    remove() {
      this.options.element.remove();
    }
  }
  return {
    setWorkerUrl: vi.fn(),
    Map,
    Marker,
    LngLatBounds: class {
      extend() {
        return this;
      }
    },
    NavigationControl: class {},
    AttributionControl: class {},
  };
});

const world = createDevelopmentWorld({
  generatedAt: '2026-08-13T12:00:00.000Z',
});
const HOSTILE_MESSAGE = '<img src=x onerror=alert(1)> Hold position.';
const emptyTerritory = world.agents.map(({ id, name, color }) => ({
  agentId: id,
  name,
  color,
  allianceId: null,
  effectiveColor: NEUTRAL_AGENT_COLOR,
  controlledCellCount: 0,
}));
const initial = simulationSnapshotSchema.parse({
  world,
  scenario: createDefaultAppliedScenario('2026-08-13T12:00:00.000Z'),
  turnNumber: 0,
  nextAgentId: world.agents[0]!.id,
  activeAgentId: null,
  status: 'paused',
  providerMode: 'scripted-test',
  providerConfigured: true,
  modelConfiguration: {
    globalModelId: 'deterministic-script',
    overrides: [],
    locked: false,
  },
  resolvedModels: world.agents.map(({ id }) => ({
    agentId: id,
    modelId: 'deterministic-script',
    source: 'global',
    available: true,
  })),
  turns: [],
  experiment: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: '2026-08-13T12:00:00.000Z',
    totalCompletedTurns: 0,
    retainedTurns: 0,
    droppedRecords: 0,
    complete: true,
    metrics: {
      aggregate: emptyMetrics(),
      byAgent: world.agents.map(({ id }) => ({
        agentId: id,
        metrics: emptyMetrics(),
      })),
    },
    currentTerritory: emptyTerritory,
    currentAlliances: [],
  },
});

function emptyMetrics() {
  return {
    totalTurns: 0,
    accepted: 0,
    rejected: 0,
    providerErrors: 0,
    requestedMoves: 0,
    requestedInfections: 0,
    requestedCaptures: 0,
    requestedWaits: 0,
    acceptedMovements: 0,
    successfullyInfectedCells: 0,
    successfulCaptures: 0,
    acceptedWaits: 0,
    rejectedWorldActions: 0,
    territoryGainedThroughInfection: 0,
    territoryGainedThroughCapture: 0,
    territoryLostThroughCapture: 0,
    publicMessagesRequested: 0,
    publicMessagesAccepted: 0,
    publicMessagesRejected: 0,
    directMessagesRequested: 0,
    directMessagesDelivered: 0,
    directMessagesRejected: 0,
    publicMessagesSent: 0,
    directMessagesSent: 0,
    directMessagesReceived: 0,
    uniqueVisitedCells: 0,
    tokens: {},
    knownCostCredits: 0,
    turnsWithUnknownCost: 0,
  };
}

function afterInfection(): SimulationSnapshot {
  const agent = world.agents[0]!;
  const event = {
    id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
    agentId: agent.id,
    occurredAt: '2026-08-13T12:00:01.000Z',
    type: 'hex-infected' as const,
    cell: agent.currentCell,
    controllerAgentId: agent.id,
  };
  const adjacent = gridDisk(agent.currentCell, 1).find(
    (cell) =>
      cell !== agent.currentCell &&
      world.hexes.some((hex) => hex.cell === cell),
  )!;
  const turn = {
    turnNumber: 1,
    agentId: agent.id,
    startedAt: '2026-08-13T12:00:00.000Z',
    completedAt: '2026-08-13T12:00:01.000Z',
    observation: {
      agentId: agent.id,
      agentName: agent.name,
      personality: agent.personality,
      currentCell: {
        cell: agent.currentCell,
        state: 'open' as const,
        controllerAgentId: null,
        controllerAllianceId: null,
        effectiveColor: null,
      },
      captureEligibility: {
        eligible: false as const,
        blockedReason: 'capture-open-cell' as const,
      },
      actionAvailability: {
        moveTargetCellIds: [adjacent],
        infect: { available: true as const },
        capture: {
          available: false as const,
          reason: 'capture-open-cell' as const,
        },
        wait: { available: true as const },
      },
      adjacentCells: [
        {
          cell: adjacent,
          state: 'open' as const,
          controllerAgentId: null,
          controllerAllianceId: null,
          effectiveColor: null,
        },
      ],
      nearbyAgents: [],
      recentEvents: [],
      recentPublicMessages: [],
      recentDirectMessages: [],
      territoryScoreboard: emptyTerritory,
      actingAllianceId: null,
      actingAlliance: null,
      activeAlliances: [],
      inboundAllianceProposals: [],
      outboundAllianceProposals: [],
      recentAllianceEvents: [],
      recentControlChanges: [],
    },
    outcome: 'accepted' as const,
    worldAction: { type: 'infect' as const },
    summary: 'Infecting this open cell.',
    worldActionResult: { accepted: true as const, event },
    communicationResult: { requested: false as const },
    diplomacyResult: { requested: false as const },
    provider: {
      provider: 'scripted-test' as const,
      model: 'test',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costCredits: 0,
    },
  };
  return simulationSnapshotSchema.parse({
    ...initial,
    world: {
      ...world,
      hexes: world.hexes.map((hex) =>
        hex.cell === agent.currentCell
          ? {
              ...hex,
              state: 'infected' as const,
              controllerAgentId: agent.id,
            }
          : hex,
      ),
      events: [event],
    },
    turnNumber: 1,
    nextAgentId: world.agents[1]!.id,
    turns: [turn],
    experiment: {
      ...initial.experiment,
      totalCompletedTurns: 1,
      retainedTurns: 1,
      firstRetainedTurn: 1,
      lastRetainedTurn: 1,
      metrics: {
        aggregate: {
          ...emptyMetrics(),
          totalTurns: 1,
          accepted: 1,
          requestedInfections: 1,
          successfullyInfectedCells: 1,
          territoryGainedThroughInfection: 1,
          uniqueVisitedCells: 1,
          averageLatencyMs: 0,
        },
        byAgent: initial.experiment.metrics.byAgent.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                metrics: {
                  ...emptyMetrics(),
                  totalTurns: 1,
                  accepted: 1,
                  requestedInfections: 1,
                  successfullyInfectedCells: 1,
                  territoryGainedThroughInfection: 1,
                  uniqueVisitedCells: 1,
                  averageLatencyMs: 0,
                },
              }
            : entry,
        ),
      },
      currentTerritory: emptyTerritory.map((entry, index) => ({
        ...entry,
        controlledCellCount: index === 0 ? 1 : 0,
      })),
    },
  });
}

function afterMessage(): SimulationSnapshot {
  const sender = world.agents[0]!;
  const recipient = world.agents[1]!;
  const message = HOSTILE_MESSAGE;
  const event = {
    id: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
    agentId: sender.id,
    recipientId: recipient.id,
    occurredAt: '2026-08-13T12:00:01.000Z',
    type: 'direct-message-sent' as const,
    channel: 'direct' as const,
    message,
    distance: 2,
  };
  const waitEvent = {
    id: '77bb21b9-fc78-4b04-9f92-9862bf346f97',
    agentId: sender.id,
    occurredAt: '2026-08-13T12:00:01.000Z',
    type: 'agent-waited' as const,
  };
  const turn = {
    turnNumber: 1,
    agentId: sender.id,
    startedAt: '2026-08-13T12:00:00.000Z',
    completedAt: '2026-08-13T12:00:01.000Z',
    observation: {
      agentId: sender.id,
      agentName: sender.name,
      personality: sender.personality,
      currentCell: {
        cell: sender.currentCell,
        state: 'open' as const,
        controllerAgentId: null,
        controllerAllianceId: null,
        effectiveColor: null,
      },
      captureEligibility: {
        eligible: false as const,
        blockedReason: 'capture-open-cell' as const,
      },
      actionAvailability: {
        moveTargetCellIds: [world.hexes[1]!.cell],
        infect: { available: true as const },
        capture: {
          available: false as const,
          reason: 'capture-open-cell' as const,
        },
        wait: { available: true as const },
      },
      adjacentCells: [
        {
          cell: world.hexes[1]!.cell,
          state: 'open' as const,
          controllerAgentId: null,
          controllerAllianceId: null,
          effectiveColor: null,
        },
      ],
      nearbyAgents: [
        {
          id: recipient.id,
          name: recipient.name,
          currentCell: recipient.currentCell,
          distance: 2,
          allianceId: null,
        },
      ],
      recentEvents: [],
      recentPublicMessages: [],
      recentDirectMessages: [],
      territoryScoreboard: emptyTerritory,
      actingAllianceId: null,
      actingAlliance: null,
      activeAlliances: [],
      inboundAllianceProposals: [],
      outboundAllianceProposals: [],
      recentAllianceEvents: [],
      recentControlChanges: [],
    },
    outcome: 'accepted' as const,
    worldAction: { type: 'wait' as const },
    communication: {
      channel: 'direct' as const,
      recipientId: recipient.id,
      message,
    },
    summary: 'Sending a nearby message.',
    worldActionResult: { accepted: true as const, event: waitEvent },
    communicationResult: {
      requested: true as const,
      accepted: true as const,
      event,
    },
    diplomacyResult: { requested: false as const },
    provider: {
      provider: 'scripted-test' as const,
      model: 'test',
      latencyMs: 0,
      costCredits: 0,
    },
  };
  return simulationSnapshotSchema.parse({
    ...initial,
    world: { ...world, events: [waitEvent, event] },
    turnNumber: 1,
    nextAgentId: recipient.id,
    turns: [turn],
    experiment: {
      ...initial.experiment,
      totalCompletedTurns: 1,
      retainedTurns: 1,
      firstRetainedTurn: 1,
      lastRetainedTurn: 1,
      metrics: {
        aggregate: {
          ...emptyMetrics(),
          totalTurns: 1,
          accepted: 1,
          requestedWaits: 1,
          acceptedWaits: 1,
          directMessagesRequested: 1,
          directMessagesDelivered: 1,
          directMessagesSent: 1,
          directMessagesReceived: 1,
          uniqueVisitedCells: 1,
          averageLatencyMs: 0,
        },
        byAgent: initial.experiment.metrics.byAgent.map((entry, index) => ({
          ...entry,
          metrics:
            index === 0
              ? {
                  ...emptyMetrics(),
                  totalTurns: 1,
                  accepted: 1,
                  requestedWaits: 1,
                  acceptedWaits: 1,
                  directMessagesRequested: 1,
                  directMessagesDelivered: 1,
                  directMessagesSent: 1,
                  uniqueVisitedCells: 1,
                  averageLatencyMs: 0,
                }
              : index === 1
                ? { ...emptyMetrics(), directMessagesReceived: 1 }
                : entry.metrics,
        })),
      },
    },
  });
}

function afterPublicMessage(): SimulationSnapshot {
  const direct = afterMessage();
  const turn = direct.turns[0]!;
  if (turn.outcome !== 'accepted' || !turn.worldActionResult.accepted)
    throw new Error('Expected accepted fixture turn.');
  const event = {
    id: '88cc21b9-fc78-4b04-9f92-9862bf346f98',
    agentId: turn.agentId,
    occurredAt: turn.completedAt,
    type: 'public-message-sent' as const,
    channel: 'public' as const,
    message: HOSTILE_MESSAGE,
  };
  return simulationSnapshotSchema.parse({
    ...direct,
    world: {
      ...direct.world,
      events: [turn.worldActionResult.event, event],
    },
    turns: [
      {
        ...turn,
        communication: { channel: 'public', message: HOSTILE_MESSAGE },
        communicationResult: {
          requested: true,
          accepted: true,
          event,
        },
      },
    ],
  });
}

function afterCapture(): SimulationSnapshot {
  const infected = afterInfection();
  const previous = world.agents[0]!;
  const capturer = world.agents[1]!;
  const cell = previous.currentCell;
  const controllerDepartureCell = gridDisk(cell, 1).find(
    (candidate) =>
      candidate !== cell && world.hexes.some(({ cell }) => cell === candidate),
  )!;
  const captureEvent = {
    id: '77bb21b9-fc78-4b04-9f92-9862bf346f97',
    agentId: capturer.id,
    occurredAt: '2026-08-13T12:00:02.000Z',
    type: 'hex-captured' as const,
    cell,
    controllerAgentId: capturer.id,
    previousControllerAgentId: previous.id,
  };
  const captureTurn = {
    turnNumber: 2,
    agentId: capturer.id,
    startedAt: '2026-08-13T12:00:01.000Z',
    completedAt: '2026-08-13T12:00:02.000Z',
    observation: {
      agentId: capturer.id,
      agentName: capturer.name,
      personality: capturer.personality,
      currentCell: {
        cell,
        state: 'infected' as const,
        controllerAgentId: previous.id,
        controllerAllianceId: null,
        effectiveColor: previous.color,
      },
      captureEligibility: { eligible: true as const },
      actionAvailability: {
        moveTargetCellIds: [world.hexes[1]!.cell],
        infect: {
          available: false as const,
          reason: 'current-cell-already-infected' as const,
        },
        capture: { available: true as const },
        wait: { available: true as const },
      },
      adjacentCells: [
        {
          ...world.hexes[1]!,
          controllerAllianceId: null,
          effectiveColor: null,
        },
      ],
      nearbyAgents: [
        {
          id: previous.id,
          name: previous.name,
          currentCell: controllerDepartureCell,
          distance: 1,
          allianceId: null,
        },
      ],
      recentEvents: [],
      recentPublicMessages: [],
      recentDirectMessages: [],
      territoryScoreboard: emptyTerritory.map((entry, index) => ({
        ...entry,
        controlledCellCount: index === 0 ? 1 : 0,
      })),
      actingAllianceId: null,
      actingAlliance: null,
      activeAlliances: [],
      inboundAllianceProposals: [],
      outboundAllianceProposals: [],
      recentAllianceEvents: [],
      recentControlChanges: [],
    },
    outcome: 'accepted' as const,
    worldAction: { type: 'capture' as const },
    summary: 'Capturing this contested hex.',
    worldActionResult: { accepted: true as const, event: captureEvent },
    communicationResult: { requested: false as const },
    diplomacyResult: { requested: false as const },
    provider: {
      provider: 'scripted-test' as const,
      model: 'test',
      latencyMs: 0,
      costCredits: 0,
    },
  };
  return simulationSnapshotSchema.parse({
    ...infected,
    world: {
      ...infected.world,
      hexes: infected.world.hexes.map((hex) =>
        hex.cell === cell ? { ...hex, controllerAgentId: capturer.id } : hex,
      ),
      agents: infected.world.agents.map((agent) =>
        agent.id === capturer.id
          ? { ...agent, currentCell: cell }
          : agent.id === previous.id
            ? { ...agent, currentCell: controllerDepartureCell }
            : agent,
      ),
      events: [...infected.world.events, captureEvent],
    },
    turnNumber: 2,
    nextAgentId: world.agents[2]!.id,
    turns: [...infected.turns, captureTurn],
    experiment: {
      ...infected.experiment,
      totalCompletedTurns: 2,
      retainedTurns: 2,
      lastRetainedTurn: 2,
      metrics: {
        aggregate: {
          ...infected.experiment.metrics.aggregate,
          totalTurns: 2,
          accepted: 2,
          requestedCaptures: 1,
          successfulCaptures: 1,
          territoryGainedThroughCapture: 1,
          territoryLostThroughCapture: 1,
        },
        byAgent: infected.experiment.metrics.byAgent.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                metrics: {
                  ...entry.metrics,
                  territoryLostThroughCapture: 1,
                },
              }
            : index === 1
              ? {
                  ...entry,
                  metrics: {
                    ...entry.metrics,
                    totalTurns: 1,
                    accepted: 1,
                    requestedCaptures: 1,
                    successfulCaptures: 1,
                    territoryGainedThroughCapture: 1,
                    uniqueVisitedCells: 1,
                    averageLatencyMs: 0,
                  },
                }
              : entry,
        ),
      },
      currentTerritory: emptyTerritory.map((entry, index) => ({
        ...entry,
        controlledCellCount: index === 1 ? 1 : 0,
      })),
    },
  });
}

function jsonResponse(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
}

function completeTickResponse(
  source: SimulationSnapshot,
  tickNumber = Math.max(1, source.tickNumber || 1),
) {
  const template = source.turns.at(-1) ?? afterInfection().turns[0]!;
  const virtualTime = '2026-08-13T12:05:00.000Z';
  const records = source.world.agents.map((agent, index) =>
    agentTurnRecordSchema.parse({
      ...template,
      turnNumber: (tickNumber - 1) * source.world.agents.length + index + 1,
      tickNumber,
      tickPosition: index + 1,
      virtualTime,
      tickIntervalMinutes: 5,
      agentId: agent.id,
      observation: {
        ...template.observation,
        agentId: agent.id,
        agentName: agent.name,
      },
      ...(index === 0
        ? {}
        : {
            outcome: 'accepted',
            worldAction: { type: 'wait' },
            communication: undefined,
            diplomacy: undefined,
            summary: 'Waited for the next tick.',
            worldActionResult: {
              accepted: true,
              event: {
                id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                agentId: agent.id,
                occurredAt: virtualTime,
                type: 'agent-waited',
              },
            },
            communicationResult: { requested: false },
            diplomacyResult: { requested: false },
          }),
    }),
  );
  const snapshot = simulationSnapshotSchema.parse({
    ...source,
    tickNumber,
    turnNumber: records.at(-1)!.turnNumber,
    virtualTime,
    lastTickIntervalMinutes: 5,
    resolutionOrder: records.map(({ agentId }) => agentId),
    turns: records,
    experiment: {
      ...source.experiment,
      totalCompletedTurns: records.length,
      retainedTurns: records.length,
      firstRetainedTurn: 1,
      lastRetainedTurn: records.length,
    },
  });
  return { snapshot, tickNumber, records };
}

const compatibleCatalog = modelCatalogResponseSchema.parse({
  models: [
    {
      id: 'example/alpha',
      name: 'Alpha',
      author: 'example',
      contextLength: 32_768,
      inputPricePerToken: '0.000001',
      outputPricePerToken: '0.000002',
      requestPrice: '0',
      supportedParameters: ['max_tokens'],
      createdAt: '2026-08-01T00:00:00.000Z',
      isFree: false,
      reasoning: {
        mandatory: false,
        supportedEfforts: ['xhigh', 'low', 'medium'],
      },
    },
    {
      id: 'sample/beta',
      name: 'Beta Free',
      author: 'sample',
      contextLength: 65_536,
      inputPricePerToken: '0',
      outputPricePerToken: '0',
      supportedParameters: ['max_tokens'],
      createdAt: '2026-08-02T00:00:00.000Z',
      isFree: true,
    },
  ],
  filteredOutCount: 12,
  fetchedAt: '2026-08-15T12:00:00.000Z',
  expiresAt: '2026-08-15T12:05:00.000Z',
  stale: false,
  requirements: {
    input: 'text',
    output: 'text',
    endpoint: 'chat-completions',
    requiredParameters: ['max_tokens'],
    minimumContextLength: 16_384,
    streaming: false,
  },
});

function openRouterSnapshot(
  globalModelId: string | null = 'example/alpha',
  overrides: SimulationSnapshot['modelConfiguration']['overrides'] = [],
  globalReasoningProfile: SimulationSnapshot['modelConfiguration']['globalReasoningProfile'] = 'provider-default',
): SimulationSnapshot {
  return simulationSnapshotSchema.parse({
    ...initial,
    providerMode: 'openrouter',
    modelConfiguration: {
      globalModelId,
      globalReasoningProfile,
      overrides,
      locked: false,
    },
    resolvedModels: world.agents.map(({ id }) => {
      const override = overrides.find(({ agentId }) => agentId === id);
      const modelId = override?.modelId ?? globalModelId;
      return {
        agentId: id,
        modelId,
        reasoningProfile: override?.reasoningProfile ?? globalReasoningProfile,
        source: override ? 'override' : modelId ? 'global' : 'missing',
        available: Boolean(modelId),
        ...(modelId ? {} : { issue: 'missing' }),
      };
    }),
  });
}

function twelveAgentSnapshot(readyCount = 12): SimulationSnapshot {
  const roster = generateDeterministicRoster(12, 'world-lab-twelve');
  const request = defaultWorldSetupRequest();
  const modelConfiguration = {
    globalModelId:
      'example/alpha' as SimulationSnapshot['modelConfiguration']['globalModelId'],
    globalReasoningProfile: 'provider-default' as const,
    overrides: [],
    locked: false,
  };
  const behaviorConfiguration = {
    ...request.behaviorConfiguration,
    assignments: assignBehavior(
      roster.map(({ id }) => id),
      request.behaviorConfiguration.seed,
      'balanced-random',
    ),
  };
  const preview = previewWorldSetup({
    ...request,
    radius: 12,
    roster,
    patientZeroAgentId: roster[0]!.id,
    modelConfiguration,
    behaviorConfiguration,
  });
  if (!preview.feasible) throw new Error('Expected a feasible test scenario.');
  return simulationSnapshotSchema.parse({
    ...initial,
    world: preview.world,
    scenario: preview.scenario,
    nextAgentId: preview.world.agents[0]!.id,
    providerMode: 'openrouter',
    modelConfiguration,
    behaviorConfiguration,
    resolvedModels: preview.world.agents.map(({ id }, index) => ({
      agentId: id,
      modelId: index < readyCount ? 'example/alpha' : null,
      reasoningProfile: 'provider-default',
      source: index < readyCount ? 'global' : 'missing',
      available: index < readyCount,
      ...(index < readyCount ? {} : { issue: 'missing' }),
    })),
    agentGoals: preview.world.agents.map(({ id }) => ({
      agentId: id,
      goal: null,
    })),
    agentMemories: preview.world.agents.map(({ id }) => ({
      agentId: id,
      entries: [],
    })),
    experiment: {
      ...initial.experiment,
      metrics: {
        aggregate: emptyMetrics(),
        byAgent: preview.world.agents.map(({ id }) => ({
          agentId: id,
          metrics: emptyMetrics(),
        })),
      },
      currentTerritory: preview.world.agents.map(({ id, name, color }) => ({
        agentId: id,
        name,
        color,
        allianceId: null,
        effectiveColor: NEUTRAL_AGENT_COLOR,
        controlledCellCount: 0,
      })),
      currentAlliances: [],
    },
  });
}

function withPersonality(
  snapshot: SimulationSnapshot,
  agentId: string,
  personality: string,
): SimulationSnapshot {
  return simulationSnapshotSchema.parse({
    ...snapshot,
    world: {
      ...snapshot.world,
      agents: snapshot.world.agents.map((agent) =>
        agent.id === agentId ? { ...agent, personality } : agent,
      ),
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mapLibreMock.renderMode = 'complete';
  mapLibreMock.rejectSource = false;
  mapLibreMock.rejectLayers = false;
  mapLibreMock.duplicateFeatures = false;
  mapLibreMock.autoRender = true;
  mapLibreMock.pendingRenderCallbacks = [];
  mapLibreMock.mapClick = undefined;
  mapLibreMock.mapBackgroundClick = undefined;
  mapLibreMock.layers = [];
  mapLibreMock.queryRenderedFeatures.mockReset();
  mapLibreMock.setData.mockReset();
  mapLibreMock.latestSourceData = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => jsonResponse(initial)),
  );
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openOverflow(user: ReturnType<typeof userEvent.setup>) {
  const menu = await screen.findByLabelText('More World Lab actions');
  if (!menu.closest('details')?.hasAttribute('open')) await user.click(menu);
}

async function openAgentsWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Agents' }));
}

describe('WorldLab', () => {
  it('migrates supported legacy browser preferences and rejects retired targets', async () => {
    window.localStorage.setItem('agentborne.world-lab.follow-turn', 'false');
    window.localStorage.setItem(
      'agentborne.world-lab.activity-dock',
      'collapsed',
    );
    window.sessionStorage.setItem('agentborne.world-lab.run-target', '500');
    const first = render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    await waitFor(() => {
      expect(window.localStorage.getItem('hexzero.world-lab.follow-turn')).toBe(
        'false',
      );
      expect(
        window.localStorage.getItem('hexzero.world-lab.activity-dock'),
      ).toBe('collapsed');
      expect(
        window.sessionStorage.getItem('hexzero.world-lab.run-target'),
      ).toBe('25');
    });
    first.unmount();

    window.localStorage.setItem('agentborne.world-lab.follow-turn', 'true');
    const second = render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    expect(window.localStorage.getItem('hexzero.world-lab.follow-turn')).toBe(
      'false',
    );

    second.unmount();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
  });

  it('renders all controls, status, H3 readiness, and eight visible markers', async () => {
    render(<WorldLab />);
    expect(
      await screen.findByText(
        /H3 overlay ready · 127\/127 rendered cells · 8 agents/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('world-map')).toHaveAttribute(
      'data-rendered-h3-cell-count',
      '127',
    );
    expect(mapLibreMock.queryRenderedFeatures).toHaveBeenCalledWith({
      layers: ['development-hex-fills'],
    });
    expect(
      screen.getByRole('heading', { name: 'World Lab' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Single tick' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText('More World Lab actions'));
    expect(screen.getByRole('button', { name: 'Reset world' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Restore default personalities' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('Playback speed')).toBeInTheDocument();
    expect(
      screen.getByRole('banner', { name: 'World Lab command bar' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.command-bar')).not.toBeInTheDocument();
    expect(document.querySelector('.provider-badge')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Export this agent' }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole('option', { name: /^(5|10|25|50|100)$/ })
        .map((option) => Number((option as HTMLOptionElement).value)),
    ).toEqual([5, 10, 25, 50, 100]);
    expect(
      screen.getByLabelText('Experiment details. Tick 0, paused'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Experiment details. Tick 0, paused'),
    ).toHaveTextContent('0.0 credits');
    expect(
      await screen.findAllByRole('button', { name: /Select agent/ }),
    ).toHaveLength(8);
    expect(screen.getByText('Deterministic test model')).toBeInTheDocument();
  });

  it('opens World setup only from the top-right overflow menu with map semantics', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    const executionControls = screen.getByRole('navigation', {
      name: 'Simulation execution controls',
    });
    expect(
      within(executionControls).queryByRole('button', { name: /world setup/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /gps|locate|location|crosshair/i }),
    ).not.toBeInTheDocument();

    const overflowTrigger = screen.getByLabelText('More World Lab actions');
    await user.click(overflowTrigger);
    const setupTrigger = screen.getByRole('button', { name: 'World setup' });
    expect(setupTrigger.querySelector('[data-icon="map"]')).not.toBeNull();
    await user.click(setupTrigger);

    expect(
      screen.getByRole('dialog', { name: 'World Setup' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Minimum virtual minutes per tick'),
    ).toHaveValue(5);
    expect(
      screen.getByLabelText('Maximum virtual minutes per tick'),
    ).toHaveValue(10);
    expect(overflowTrigger.closest('details')).not.toHaveAttribute('open');
  });

  it('shows Patient Zero in the roster, marker, inspector, setup selector, and private filter', async () => {
    const patientZero = initial.world.agents[0]!;
    const designated = simulationSnapshotSchema.parse({
      ...initial,
      scenario: { ...initial.scenario, patientZeroAgentId: patientZero.id },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(designated)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    expect(await screen.findByText('HEX-0')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: `Select agent ${patientZero.name}, Patient Zero`,
      }),
    ).toHaveClass('patient-zero');
    await user.click(
      within(
        screen.getByRole('complementary', { name: 'Agent roster' }),
      ).getByRole('button', { name: new RegExp(patientZero.name) }),
    );
    expect(screen.getByText('Patient Zero role')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Private comms/ }));
    expect(screen.getByRole('button', { name: 'Zero' })).toBeInTheDocument();
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'World setup' }));
    const selector = screen.getByLabelText('Patient Zero');
    expect(selector).toHaveValue(patientZero.id);
    expect(within(selector).queryByRole('option', { name: 'None' })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(selector).toHaveValue(initial.world.agents[1]!.id);
  });

  it('removes sequential recovery controls and explains per-tick provider cost', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByLabelText('More World Lab actions'));
    expect(screen.queryByText('Unattended recovery')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Skip turn' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Each tick requests every active agent/),
    ).toBeInTheDocument();
  });

  it.each([
    {
      snapshot: openRouterSnapshot('example/alpha'),
      expected: '8/8 ready',
      accessible: /8 of 8 agents ready/,
    },
    {
      snapshot: twelveAgentSnapshot(),
      expected: '12/12 ready',
      accessible: /12 of 12 agents ready/,
    },
    {
      snapshot: twelveAgentSnapshot(10),
      expected: '10/12 ready',
      accessible: /10 of 12 agents ready/,
    },
  ])(
    'reports authoritative active-roster readiness as $expected',
    async ({ snapshot, expected, accessible }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          String(input).endsWith('/models')
            ? jsonResponse(compatibleCatalog)
            : jsonResponse(snapshot),
        ),
      );
      const user = userEvent.setup();
      render(<WorldLab />);
      await openAgentsWorkspace(user);
      const trigger = await screen.findByRole('button', { name: accessible });
      expect(trigger.querySelector('.setup-label')).toHaveTextContent(expected);
    },
  );

  it('does not count unapplied roster edits and reconciles readiness after reset without reload', async () => {
    const twelve = twelveAgentSnapshot();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) return jsonResponse(compatibleCatalog);
        if (url.endsWith('/reset'))
          return jsonResponse({
            snapshot: openRouterSnapshot('example/alpha'),
          });
        return jsonResponse(twelve);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openAgentsWorkspace(user);
    let setupStatus = await screen.findByRole('button', {
      name: /12 of 12 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '12/12 ready',
    );
    await user.click(screen.getByLabelText('More World Lab actions'));
    await user.click(screen.getByRole('button', { name: 'World setup' }));
    await user.clear(screen.getByLabelText('Desired agent count'));
    await user.type(screen.getByLabelText('Desired agent count'), '20');
    setupStatus = screen.getByRole('button', {
      name: /12 of 12 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '12/12 ready',
    );
    await user.click(screen.getByRole('button', { name: 'Close World Setup' }));
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Reset world' }));
    setupStatus = await screen.findByRole('button', {
      name: /8 of 8 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '8/8 ready',
    );
  });

  it('updates readiness from the authoritative applied scenario response without reload', async () => {
    const eight = openRouterSnapshot('example/alpha');
    const twelve = twelveAgentSnapshot();
    const generatedRoster = twelve.scenario.roster;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models')) return jsonResponse(compatibleCatalog);
        if (url.endsWith('/roster/generate'))
          return jsonResponse({ roster: generatedRoster });
        if (url.endsWith('/setup/preview')) {
          const preview = previewWorldSetup(JSON.parse(String(init?.body)));
          return jsonResponse(preview);
        }
        if (url.endsWith('/experiment/setup'))
          return jsonResponse({ snapshot: twelve });
        return jsonResponse(eight);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openAgentsWorkspace(user);
    let setupStatus = await screen.findByRole('button', {
      name: /8 of 8 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '8/8 ready',
    );
    await user.click(screen.getByLabelText('More World Lab actions'));
    await user.click(screen.getByRole('button', { name: 'World setup' }));
    await user.clear(screen.getByLabelText('Desired agent count'));
    await user.type(screen.getByLabelText('Desired agent count'), '12');
    await user.click(
      screen.getByRole('button', { name: 'Generate desired roster' }),
    );
    setupStatus = screen.getByRole('button', {
      name: /8 of 8 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '8/8 ready',
    );
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText(/12 valid spawns/);
    await user.click(
      screen.getByRole('button', { name: 'Apply / Create Experiment' }),
    );
    setupStatus = await screen.findByRole('button', {
      name: /12 of 12 agents ready/,
    });
    expect(setupStatus.querySelector('.setup-label')).toHaveTextContent(
      '12/12 ready',
    );
  });

  it('runs exactly 19 additional ticks from tick 6 and never schedules tick 26', async () => {
    vi.useFakeTimers();
    const at6 = completeTickResponse(initial, 6).snapshot;
    let turnRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        if (turnRequests === 0) {
          turnRequests += 1;
          return jsonResponse(at6);
        }
        const turnNumber = 6 + turnRequests;
        turnRequests += 1;
        if (turnNumber > 25)
          return Promise.reject(new Error('tick 26 must not be requested'));
        return jsonResponse(completeTickResponse(at6, turnNumber));
      }),
    );

    try {
      render(<WorldLab />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('Tick 6')).toBeInTheDocument();

      await act(async () => {
        screen.getByRole('button', { name: 'Run to tick 25' }).click();
      });
      for (let expectedTurn = 7; expectedTurn <= 25; expectedTurn += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }

      expect(screen.getByText('Tick 25')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
      expect(turnRequests - 1).toBe(19);
      expect(fetch).toHaveBeenCalledTimes(20);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(turnRequests - 1).toBe(19);
      expect(fetch).toHaveBeenCalledTimes(20);
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('keeps run targets absolute and makes current or past targets unavailable', async () => {
    window.sessionStorage.setItem('hexzero.world-lab.run-target', '25');
    const at50 = simulationSnapshotSchema.parse({
      ...initial,
      turnNumber: 400,
      tickNumber: 50,
      virtualTime: '2026-08-13T16:10:00.000Z',
      lastTickIntervalMinutes: 5,
      resolutionOrder: initial.world.agents.map(({ id }) => id),
      experiment: { ...initial.experiment, totalCompletedTurns: 400 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(at50)),
    );
    render(<WorldLab />);
    const selector = await screen.findByLabelText('Tick target');
    expect(screen.getByRole('option', { name: '25' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '50' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '100' })).toBeEnabled();
    expect(selector).toHaveValue('100');
  });

  it('derives allied marker and existing-territory colors while retaining individual ownership labels', async () => {
    const progressed = afterInfection();
    const [ember, rook] = progressed.world.agents;
    const allianceId = 'a1111111-1111-4111-8111-111111111111';
    const allianceColor = '#0072B2' as const;
    const formedEvent = {
      id: 'd4444444-4444-4444-8444-444444444444',
      agentId: rook!.id,
      occurredAt: '2026-08-13T12:00:02.000Z',
      turnNumber: 2,
      type: 'alliance-formed' as const,
      allianceId,
      allianceColor,
      memberAgentIds: [ember!.id, rook!.id],
    };
    const allied = simulationSnapshotSchema.parse({
      ...progressed,
      world: {
        ...progressed.world,
        alliances: [
          {
            id: allianceId,
            color: allianceColor,
            memberAgentIds: [ember!.id, rook!.id],
          },
        ],
        events: [...progressed.world.events, formedEvent],
      },
      experiment: {
        ...progressed.experiment,
        currentTerritory: progressed.experiment.currentTerritory.map((entry) =>
          entry.agentId === ember!.id || entry.agentId === rook!.id
            ? { ...entry, allianceId, effectiveColor: allianceColor }
            : entry,
        ),
        currentAlliances: [
          {
            allianceId,
            color: allianceColor,
            totalControlledCellCount: 1,
            members: [
              { agentId: ember!.id, name: ember!.name, controlledCellCount: 1 },
              { agentId: rook!.id, name: rook!.name, controlledCellCount: 0 },
            ],
          },
        ],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(allied)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    const markers = await screen.findAllByRole('button', {
      name: /Select agent (Ember|Rook)/,
    });
    expect(markers).toHaveLength(2);
    expect(
      markers.every(
        (marker) => marker.dataset.effectiveColor === allianceColor,
      ),
    ).toBe(true);
    expect(
      screen.getByTestId('world-map').getAttribute('data-controller-colors'),
    ).toContain(allianceColor);
    await user.click(screen.getByRole('tab', { name: 'Scoreboard' }));
    expect(
      screen.getByLabelText('Alliance and territory panel'),
    ).toHaveTextContent('Ember (1), Rook (0)');
    expect(
      screen.getAllByText('Ember and Rook formed an alliance.'),
    ).toHaveLength(1);
  });

  it('deduplicates rendered H3 features before reporting readiness', async () => {
    mapLibreMock.duplicateFeatures = true;
    render(<WorldLab />);
    expect(
      await screen.findByText(/H3 overlay ready · 127\/127 rendered cells/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('world-map')).toHaveAttribute(
      'data-rendered-h3-cell-count',
      '127',
    );
  });

  it('waits for an H3 source update and render cycle before inspecting readiness', async () => {
    mapLibreMock.autoRender = false;
    render(<WorldLab />);
    await screen.findByRole('button', {
      name: 'Select agent Ember, Patient Zero',
    });
    expect(screen.getByText(/H3 overlay initializing/)).toBeInTheDocument();
    expect(mapLibreMock.queryRenderedFeatures).not.toHaveBeenCalled();

    act(() => {
      const pendingRenders = mapLibreMock.pendingRenderCallbacks.splice(0);
      for (const completeRender of pendingRenders) {
        completeRender();
      }
    });

    expect(
      await screen.findByText(/H3 overlay ready · 127\/127 rendered cells/),
    ).toBeInTheDocument();
  });

  it.each([
    {
      scenario: 'incomplete rendering',
      configure: () => (mapLibreMock.renderMode = 'incomplete'),
      expectedStatus: 'incomplete',
      expectedCount: '126',
    },
    {
      scenario: 'rejected layers',
      configure: () => (mapLibreMock.rejectLayers = true),
      expectedStatus: 'failed',
      expectedCount: '0',
    },
  ])(
    'does not report readiness for $scenario',
    async ({ configure, expectedCount, expectedStatus }) => {
      configure();
      render(<WorldLab />);
      expect(
        await screen.findByText(/H3 overlay (?:incomplete|failed)/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/H3 overlay ready/)).not.toBeInTheDocument();
      expect(screen.getByTestId('world-map')).not.toHaveAttribute(
        'data-overlay-status',
        'ready',
      );
      expect(screen.getByTestId('world-map')).toHaveAttribute(
        'data-overlay-status',
        expectedStatus,
      );
      expect(screen.getByTestId('world-map')).toHaveAttribute(
        'data-rendered-h3-cell-count',
        expectedCount,
      );
    },
  );

  it('uses explicit boolean assertions in every conditional paint expression', async () => {
    render(<WorldLab />);
    await screen.findByText(/H3 overlay ready/);
    const conditions = mapLibreMock.layers.flatMap(({ paint = {} }) =>
      Object.values(paint)
        .filter(
          (expression): expression is unknown[] =>
            Array.isArray(expression) && expression[0] === 'case',
        )
        .map((expression) => expression[1]),
    );
    expect(conditions).toHaveLength(3);
    expect(conditions).toEqual(
      Array(3).fill(['boolean', ['get', 'selected'], false]),
    );
  });

  it('selects an agent and populates its inspector', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', { name: 'Select agent Rook' }),
    );
    expect(screen.getByRole('heading', { name: /Rook/ })).toBeInTheDocument();
    expect(screen.getByText(world.agents[1]!.personality)).toBeInTheDocument();
    expect(screen.getByText(world.agents[1]!.id)).toBeInTheDocument();
    expect(
      screen.getByText('No direct messages for this agent yet.'),
    ).toBeInTheDocument();
  });

  it('defaults Follow latest on and selects the latest resolved record', async () => {
    const scheduled = afterInfection();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(scheduled)),
    );
    render(<WorldLab />);
    const roster = await screen.findByLabelText('Agent roster');
    expect(
      within(roster).getByRole('checkbox', { name: 'Follow latest' }),
    ).toBeChecked();
    expect(within(roster).getByText('Latest')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: new RegExp(world.agents[0]!.name) }),
    ).toBeInTheDocument();
  });

  it('returns to the latest resolved agent when following is re-enabled', async () => {
    const base = afterInfection();
    const active = simulationSnapshotSchema.parse({
      ...base,
      turns: [{ ...afterInfection().turns[0]!, agentId: world.agents[3]!.id }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(active)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    const roster = await screen.findByLabelText('Agent roster');
    expect(within(roster).getByText('Latest')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: new RegExp(world.agents[3]!.name) }),
    ).toBeInTheDocument();
    await user.click(
      within(roster).getByRole('button', {
        name: new RegExp(world.agents[1]!.name),
      }),
    );
    expect(
      within(roster).getByRole('checkbox', { name: 'Follow latest' }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('heading', { name: new RegExp(world.agents[1]!.name) }),
    ).toBeInTheDocument();
    expect(within(roster).getByText('Latest')).toBeInTheDocument();
    await user.click(
      within(roster).getByRole('checkbox', { name: 'Follow latest' }),
    );
    expect(
      screen.getByRole('heading', { name: new RegExp(world.agents[3]!.name) }),
    ).toBeInTheDocument();
  });

  it('keyboard roster selection disables following and persists the preference locally only', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    const roster = await screen.findByLabelText('Agent roster');
    const row = within(roster).getByRole('button', {
      name: new RegExp(world.agents[4]!.name),
    });
    row.focus();
    await user.keyboard('{Enter}');
    expect(
      within(roster).getByRole('checkbox', { name: 'Follow latest' }),
    ).not.toBeChecked();
    expect(window.localStorage.getItem('hexzero.world-lab.follow-turn')).toBe(
      'false',
    );
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(
      screen.getByRole('dialog', { name: 'Experiment export' }),
    ).not.toHaveTextContent('Follow latest');
  });

  it.each([
    ['paused between turns', 'paused', null, 1],
    ['manual Retry completion', 'paused', null, 2],
    ['operator Skip completion', 'paused', null, 3],
    ['cancelled request reconciliation', 'paused', null, 4],
    ['reset snapshot', 'paused', null, 0],
    ['provider error', 'provider-error', null, 5],
    ['lost-response reconciliation', 'paused', null, 6],
    ['request in progress', 'running', 7, 0],
  ] as const)(
    'selects the latest resolved agent after %s',
    async (_label, status, activeIndex, nextIndex) => {
      const current = simulationSnapshotSchema.parse({
        ...initial,
        status,
        activeAgentId:
          activeIndex === null ? null : world.agents[activeIndex]!.id,
        nextAgentId: world.agents[nextIndex]!.id,
        turns: [
          {
            ...afterInfection().turns[0]!,
            agentId: world.agents[nextIndex]!.id,
          },
        ],
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => jsonResponse(current)),
      );
      render(<WorldLab />);
      const expected = world.agents[nextIndex]!;
      expect(
        await screen.findByRole('heading', { name: new RegExp(expected.name) }),
      ).toBeInTheDocument();
      expect(
        within(screen.getByLabelText('Agent roster')).getByText('Latest'),
      ).toBeInTheDocument();
    },
  );

  it('renders accepted messages, directions, and hostile-looking text as plain text', async () => {
    const changed = afterMessage();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(initial))
        .mockImplementationOnce(() =>
          jsonResponse(completeTickResponse(changed)),
        ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Single tick' }),
    );
    await user.click(screen.getByRole('tab', { name: 'Event log' }));
    expect(
      await screen.findByText(/Waited.*direct message accepted/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Direct-message history')).toHaveTextContent(
      'Sent Rook',
    );
    expect(screen.getAllByText(HOSTILE_MESSAGE).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Select agent Rook' }));
    expect(screen.getByLabelText('Direct-message history')).toHaveTextContent(
      'Received Ember',
    );
  });

  it('renders bounded public world chat with sender, turn, time, and plain text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(afterPublicMessage())),
    );
    render(<WorldLab />);
    const feed = await screen.findByLabelText('Public world chat');
    expect(feed).toHaveTextContent('Ember');
    expect(feed).toHaveTextContent('Turn 1');
    expect(feed).toHaveTextContent(HOSTILE_MESSAGE);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('renders public chat newest first in DOM order', async () => {
    const first = afterPublicMessage();
    const original = first.world.events.find(
      ({ type }) => type === 'public-message-sent',
    )!;
    const newer = {
      ...original,
      id: '99cc21b9-fc78-4b04-9f92-9862bf346f99',
      occurredAt: '2026-08-13T12:00:02.000Z',
      message: 'Newest public message.',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(
          simulationSnapshotSchema.parse({
            ...first,
            world: { ...first.world, events: [...first.world.events, newer] },
          }),
        ),
      ),
    );
    render(<WorldLab />);
    const items = within(
      await screen.findByLabelText('Public world chat'),
    ).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Newest public message.');
    expect(items[1]).toHaveTextContent(HOSTILE_MESSAGE);
  });

  it('keeps direct communication in the operator-only private feed with filters and inspection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(afterMessage())),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    const activityTabs = await screen.findByRole('tablist', {
      name: 'Activity views',
    });
    expect(
      within(activityTabs)
        .getAllByRole('tab')
        .map(({ textContent }) => textContent),
    ).toEqual([
      'Public chat',
      'Private comms',
      'Event log',
      'Failures & recovery',
    ]);
    expect(
      await screen.findByLabelText('Public world chat'),
    ).not.toHaveTextContent(HOSTILE_MESSAGE);
    await user.click(screen.getByRole('tab', { name: 'Private comms' }));
    const privateFeed = screen.getByLabelText('Private communications');
    expect(privateFeed).toHaveTextContent('Ember');
    expect(privateFeed).toHaveTextContent('Rook');
    expect(privateFeed).toHaveTextContent('Turn 1 · Delivered');
    expect(privateFeed).toHaveTextContent('2.00 km');
    await user.click(
      within(privateFeed).getByRole('button', { name: 'Alliance' }),
    );
    expect(privateFeed).toHaveTextContent('No private communications yet.');
    await user.click(
      within(privateFeed).getByRole('button', { name: 'Direct' }),
    );
    await user.click(within(privateFeed).getByRole('button', { name: 'Rook' }));
    expect(
      within(screen.getByLabelText('Agent inspector')).getByRole('heading', {
        name: /Rook/,
      }),
    ).toBeInTheDocument();
  });

  it('shows empty and active strategic goal state in the agent inspector', async () => {
    const agent = initial.world.agents[0]!;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(initial)),
    );
    const emptyUser = userEvent.setup();
    const emptyRender = render(<WorldLab />);
    await emptyUser.click(
      await screen.findByRole('button', {
        name: new RegExp(`Select agent ${agent.name}`),
      }),
    );
    const emptyInspector = screen.getByLabelText('Agent inspector');
    expect(
      within(emptyInspector).getByText('No active strategic goal.'),
    ).toBeVisible();
    expect(
      within(emptyInspector).getByText('No goal operation recorded.'),
    ).toBeVisible();
    expect(
      within(emptyInspector).getByText('No compact memories.'),
    ).toBeVisible();
    expect(
      within(emptyInspector).getByText('No memory operation recorded.'),
    ).toBeVisible();
    emptyRender.unmount();

    const base = afterInfection();
    const active = simulationSnapshotSchema.parse({
      ...base,
      agentGoals: base.world.agents.map(({ id }) => ({
        agentId: id,
        goal:
          id === agent.id
            ? {
                longTermGoal: 'Hold a durable corridor.',
                shortTermGoal: 'Secure the frontier.',
                planSummary: 'Expand methodically.',
                establishedAtTick: 1,
                revisedAtTick: 2,
              }
            : null,
      })),
      agentMemories: base.world.agents.map(({ id }) => ({
        agentId: id,
        entries:
          id === agent.id
            ? [
                {
                  id: `memory:${id}:1`,
                  text: 'The northern route was blocked.',
                  createdAtTick: 1,
                  revisedAtTick: 2,
                },
              ]
            : [],
      })),
      turns: base.turns.map((turn) =>
        turn.agentId === agent.id && turn.outcome === 'accepted'
          ? {
              ...turn,
              goalRevision: {
                operation: 'establish',
                longTermGoal: 'Hold a durable corridor.',
                shortTermGoal: 'Secure the frontier.',
                planSummary: 'Expand methodically.',
                reason: 'Start continuity.',
              },
              goalRevisionResult: {
                requested: true,
                accepted: true,
                operation: 'establish',
              },
              memoryOperation: {
                operation: 'remember',
                text: 'The northern route was blocked.',
              },
              memoryOperationResult: {
                requested: true,
                accepted: true,
                operation: 'remember',
                memoryId: `memory:${agent.id}:1`,
              },
            }
          : turn,
      ),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(active)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`Select agent ${agent.name}`),
      }),
    );
    const inspector = screen.getByLabelText('Agent inspector');
    expect(
      within(inspector).getByText('Hold a durable corridor.'),
    ).toBeVisible();
    expect(
      within(inspector).getByText('Latest: establish · accepted'),
    ).toBeVisible();
    expect(
      within(inspector).getByText('Agent reason: Start continuity.'),
    ).toBeVisible();
    expect(
      within(inspector).getByText('The northern route was blocked.'),
    ).toBeVisible();
    expect(
      within(inspector).getByText('Latest: remember · accepted'),
    ).toBeVisible();
  });

  it('shows a bounded read-only behavior trace and highlights observed cells', async () => {
    const changed = afterInfection();
    const agent = changed.world.agents[0]!;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(changed)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`Select agent ${agent.name}`),
      }),
    );

    const inspector = screen.getByLabelText('Agent inspector');
    const trace = within(inspector).getByLabelText('Recent behavior trace');
    const sectionNavigation = within(inspector).getByRole('navigation', {
      name: `${agent.name} inspector sections`,
    });
    for (const section of [
      'Trace',
      'Goals',
      'Memories',
      'History',
      'Configuration',
      'Latest',
    ])
      expect(
        within(sectionNavigation).getByRole('link', { name: section }),
      ).toBeVisible();
    expect(within(inspector).getByText('1/6 retained')).toBeVisible();
    expect(trace).toHaveTextContent(
      'First retained observation for this agent.',
    );
    expect(trace).toHaveTextContent('1 legal move target · Infect · Wait');
    expect(trace).toHaveTextContent('Chosen: Infect');
    expect(trace).toHaveTextContent(
      'Model summary (self-reported, not proof): Infecting this open cell.',
    );
    expect(inspector).toHaveTextContent(
      'Observation evidence and self-reported summaries show correlation, not proven causation.',
    );

    await user.click(
      within(trace).getByRole('button', { name: 'Highlight observed cell' }),
    );
    await waitFor(() =>
      expect(mapLibreMock.latestSourceData).toEqual(
        expect.objectContaining({
          features: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                cell: agent.currentCell,
                selected: true,
              }),
            }),
          ]),
        }),
      ),
    );
  });

  it('clears visible communications after reset', async () => {
    const changed = afterMessage();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(changed))
        .mockImplementationOnce(() => jsonResponse({ snapshot: initial })),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    expect(
      await screen.findByLabelText('Direct-message history'),
    ).toHaveTextContent('Sent Rook');
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Reset world' }));
    expect(
      await screen.findByText('No direct messages for this agent yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(HOSTILE_MESSAGE)).not.toBeInTheDocument();
  });

  it('executes one turn and renders infection and decision details safely', async () => {
    const changed = afterInfection();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(initial))
        .mockImplementationOnce(() =>
          jsonResponse(completeTickResponse(changed)),
        ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Single tick' }),
    );
    await user.click(screen.getByRole('tab', { name: 'Event log' }));
    expect(
      await screen.findByText('Infection · ' + world.agents[0]!.currentCell),
    ).toBeInTheDocument();
    const latestTurn = screen
      .getByRole('heading', { name: 'Latest turn' })
      .closest('.turn-detail');
    expect(latestTurn).toHaveTextContent('Summary: Infecting this open cell.');
    await user.click(screen.getByText('Latest structured observation'));
    expect(
      screen.getByText('Latest structured observation').closest('details'),
    ).toHaveTextContent('Capture: blocked · capture-open-cell');
    await waitFor(() =>
      expect(screen.getByTestId('world-map')).toHaveAttribute(
        'data-rendered-infected-cell-count',
        '1',
      ),
    );
    expect(screen.getByTestId('infected-count')).toHaveTextContent(
      '1 rendered infected',
    );
    expect(mapLibreMock.setData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        features: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ state: 'infected' }),
          }),
        ]),
      }),
    );
    expect(screen.queryByText(/chain-of-thought/i)).not.toBeInTheDocument();
  });

  it('renders controller identity, territory totals, capture events, and both gain/loss views', async () => {
    const user = userEvent.setup();
    const captured = afterCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(captured)),
    );
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Scoreboard' }));
    expect(
      await screen.findByRole('heading', { name: 'Territory scoreboard' }),
    ).toBeInTheDocument();
    const scoreboard = screen.getByLabelText('Territory scoreboard');
    expect(scoreboard).toHaveTextContent('Ember0');
    expect(scoreboard).toHaveTextContent('Rook1');
    await user.click(screen.getByRole('tab', { name: 'Event log' }));
    expect(screen.getByText(/Rook captured .* from Ember/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByLabelText('Recent territory changes')).toHaveTextContent(
      'Lost',
    );
    expect(screen.getAllByText('0 controlled cells').length).toBeGreaterThan(0);
    await user.click(
      await screen.findByRole('button', { name: 'Select agent Rook' }),
    );
    expect(
      within(screen.getByLabelText('Agent inspector')).getByRole('heading', {
        name: /Rook/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Recent territory changes')).toHaveTextContent(
      'Gained',
    );
    expect(screen.getByText('1 controlled cells')).toBeInTheDocument();
    await user.click(screen.getByText('Latest structured observation'));
    expect(
      screen.getByText('Latest structured observation').closest('details'),
    ).toHaveTextContent('Capture: eligible');
    await waitFor(() =>
      expect(mapLibreMock.latestSourceData).toEqual(
        expect.objectContaining({
          features: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                controllerColor: NEUTRAL_AGENT_COLOR,
                controllerName: 'Rook',
              }),
            }),
          ]),
        }),
      ),
    );
  });

  it('starts, pauses, and changes playback speed without overlapping immediately', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Playback speed'), '250');
    await user.click(screen.getByRole('button', { name: 'Agents' }));
    expect(
      screen.getByRole('region', { name: 'Agent management workspace' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getByTestId('world-map')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('routes agent and hex selections to semantic inspector tabs and keeps scoreboard reachable', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(
      (await screen.findAllByRole('button', { name: /Select agent/ }))[0]!,
    );
    expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: 'Scoreboard' }));
    expect(screen.getByLabelText('Territory scoreboard')).toBeInTheDocument();
  });

  it('bounds recovery activity and exposes newest failures through the dock tab', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByRole('button', { name: 'Start' });
    await user.click(screen.getByRole('tab', { name: 'Failures & recovery' }));
    expect(
      screen.getByText('No failures or recovery actions recorded.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Failures and recovery log'),
    ).not.toBeInTheDocument();
  });

  it('resets turn history and UI selections', async () => {
    const changed = afterInfection();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(changed))
        .mockImplementationOnce(() => jsonResponse({ snapshot: initial })),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await waitFor(() =>
      expect(screen.getByTestId('world-map')).toHaveAttribute(
        'data-rendered-infected-cell-count',
        '1',
      ),
    );
    await user.click(screen.getByRole('tab', { name: 'Event log' }));
    expect(
      await screen.findByText('Infection · ' + world.agents[0]!.currentCell),
    ).toBeInTheDocument();
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Reset world' }));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('unexported telemetry'),
    );
    await waitFor(() =>
      expect(
        screen.getByText('Development world loaded with 8 agents.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Tick 0')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('world-map')).toHaveAttribute(
        'data-rendered-infected-cell-count',
        '0',
      ),
    );
  });

  it('supports hex selection independently of agent selection', async () => {
    render(<WorldLab />);
    await screen.findByRole('button', {
      name: 'Select agent Ember, Patient Zero',
    });
    const target = world.hexes[1]!.cell;
    act(() => {
      mapLibreMock.mapClick?.({
        features: [{ properties: { cell: target } }],
      });
      mapLibreMock.mapBackgroundClick?.();
    });
    expect(screen.getByLabelText('Selected hex details')).toHaveTextContent(
      target,
    );
    expect(screen.getByRole('tab', { name: 'Hex' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByRole('heading', { name: /Ember/ })).toBeInTheDocument();
    act(() => mapLibreMock.mapBackgroundClick?.());
    expect(
      screen.queryByLabelText('Selected hex details'),
    ).not.toBeInTheDocument();
  });

  it('renders missing configuration without enabling cost-incurring controls', async () => {
    const unconfigured = simulationSnapshotSchema.parse({
      ...initial,
      status: 'configuration-error',
      providerMode: 'openrouter',
      providerConfigured: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(unconfigured)),
    );
    render(<WorldLab />);
    expect(
      await screen.findByText(/Model calls unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Single tick' })).toBeDisabled();
  });

  it('reserves a compact cancel slot when no request is active', async () => {
    render(<WorldLab />);
    await screen.findByRole('button', {
      name: 'Select agent Ember, Patient Zero',
    });
    const cancel = document.querySelector<HTMLButtonElement>(
      '.cancel-request-slot button',
    );
    expect(cancel).toHaveTextContent('Cancel');
    expect(cancel).toBeDisabled();
    expect(cancel?.closest('.cancel-request-slot')).toHaveClass('inactive');
  });

  it('renders catalog facts and preserves overrides until Apply to all is explicit', async () => {
    const emberId = world.agents[0]!.id;
    let current = openRouterSnapshot('example/alpha', [
      {
        agentId: emberId,
        modelId: 'sample/beta',
        reasoningProfile: 'provider-default',
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/experiment/models')) {
          const body = JSON.parse(String(init?.body)) as {
            globalModelId: string | null;
            globalReasoningProfile: SimulationSnapshot['modelConfiguration']['globalReasoningProfile'];
            overrides: SimulationSnapshot['modelConfiguration']['overrides'];
          };
          current = openRouterSnapshot(
            body.globalModelId,
            body.overrides,
            body.globalReasoningProfile,
          );
          return jsonResponse({ snapshot: current });
        }
        if (url.endsWith('/models')) return jsonResponse(compatibleCatalog);
        return jsonResponse(current);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openAgentsWorkspace(user);
    const summary = await screen.findByText('Model: Alpha');
    await user.click(summary);
    const modelConsole = within(summary.closest('.model-console')!);
    expect(screen.getByText(/12 filtered out/)).toBeInTheDocument();
    expect(screen.getByText('$1/M')).toBeInTheDocument();
    expect(screen.getByText('$2/M')).toBeInTheDocument();
    expect(screen.getByText('32,768 tokens')).toBeInTheDocument();
    expect(
      screen.getByText(/Catalog compatible: text and context requirements met/),
    ).toBeInTheDocument();
    expect(
      within(modelConsole.getByLabelText('Global reasoning'))
        .getAllByRole('option')
        .map(({ textContent }) => textContent),
    ).toEqual(['Provider default', 'Off', 'Low', 'Medium', 'XHigh']);
    await user.selectOptions(
      modelConsole.getByLabelText('Global reasoning'),
      'xhigh',
    );

    await user.selectOptions(
      modelConsole.getByLabelText('Global model'),
      'sample/beta',
    );
    await screen.findByText('Model: Beta Free');
    expect(modelConsole.getByLabelText('Ember')).toHaveValue('sample/beta');
    const firstUpdate = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/experiment/models'));
    expect(
      JSON.parse(String(firstUpdate?.[1]?.body)).globalReasoningProfile,
    ).toBe('xhigh');
    expect(JSON.parse(String(firstUpdate?.[1]?.body)).overrides).toEqual([
      {
        agentId: emberId,
        modelId: 'sample/beta',
        reasoningProfile: 'provider-default',
      },
    ]);

    await user.click(
      screen.getByRole('button', { name: 'Apply global model to all agents' }),
    );
    await waitFor(() =>
      expect(modelConsole.getByLabelText('Ember')).toHaveValue(''),
    );
    const updates = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/experiment/models'));
    expect(JSON.parse(String(updates.at(-1)?.[1]?.body)).overrides).toEqual([]);

    await user.selectOptions(
      modelConsole.getByLabelText('Ember'),
      'example/alpha',
    );
    expect(
      within(modelConsole.getByLabelText('Ember reasoning'))
        .getAllByRole('option')
        .map(({ textContent }) => textContent),
    ).toEqual(['Provider default', 'Off', 'Low', 'Medium', 'XHigh']);
    await user.selectOptions(
      modelConsole.getByLabelText('Ember reasoning'),
      'low',
    );
    const finalUpdate = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/experiment/models'))
      .at(-1);
    expect(JSON.parse(String(finalUpdate?.[1]?.body)).overrides).toEqual([
      {
        agentId: emberId,
        modelId: 'example/alpha',
        reasoningProfile: 'low',
      },
    ]);
    await user.click(
      screen.getByRole('button', { name: 'Close model selection' }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Model selection' }),
    ).toBeNull();
    const agentControllerTrigger = screen.getByRole('button', {
      name: /Open Agent Controller.*Beta Free/,
    });
    expect(agentControllerTrigger).toHaveFocus();
    await user.click(agentControllerTrigger);
    fireEvent.mouseDown(
      screen.getByRole('dialog', { name: 'Model selection' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Model selection' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Model selection' }),
    ).toBeNull();
  });

  it('recovers from a failed compatibility probe without changing the world', async () => {
    const current = openRouterSnapshot('example/alpha');
    let probeCalls = 0;
    const probeProfiles: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/models/verify')) {
          probeCalls += 1;
          probeProfiles.push(
            JSON.parse(String(init?.body)).reasoningProfile as string,
          );
          return jsonResponse({
            verification: {
              modelId: 'example/alpha',
              contractVersion: AGENT_DECISION_CONTRACT_VERSION,
              status: probeCalls === 1 ? 'failed' : 'verified',
              testedAt: '2026-08-15T12:00:00.000Z',
              ...(probeCalls === 1
                ? {
                    failure: {
                      code: 'invalid-json',
                      message: 'The model returned no usable JSON decision.',
                    },
                  }
                : {
                    provider: {
                      provider: 'openrouter',
                      model: 'example/alpha',
                      latencyMs: 20,
                    },
                  }),
            },
          });
        }
        if (url.endsWith('/models')) return jsonResponse(compatibleCatalog);
        return jsonResponse(current);
      }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openAgentsWorkspace(user);
    await user.click(await screen.findByText('Model: Alpha'));
    await user.click(
      screen.getByRole('button', { name: 'Test selected model' }),
    );
    expect(
      await screen.findByText(/returned no usable JSON decision/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Global model')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry model test' }));
    expect(
      await screen.findByText('Runtime verified: yes'),
    ).toBeInTheDocument();
    expect(screen.getByText(/may incur a small charge/)).toBeInTheDocument();
    expect(screen.getByText('Tick 0')).toBeInTheDocument();
    expect(probeProfiles).toEqual(['provider-default', 'provider-default']);
  });

  it('shows stale catalog and unavailable saved-model states without substitution', async () => {
    const unavailable = openRouterSnapshot('retired/model');
    unavailable.resolvedModels.forEach((entry) => {
      entry.available = false;
      entry.issue = 'unavailable';
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith('/models')
          ? jsonResponse({
              ...compatibleCatalog,
              stale: true,
              error: {
                code: 'timeout',
                message: 'The OpenRouter model catalog request timed out.',
              },
            })
          : jsonResponse(unavailable),
      ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openAgentsWorkspace(user);
    await user.click(await screen.findByText('Model: retired/model'));
    expect(
      screen.getByText(/Showing the last successful catalog/),
    ).toHaveTextContent('timed out');
    expect(screen.getByLabelText('Global model')).toHaveValue('retired/model');
    expect(
      screen.getByText(/Select an available compatible model/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('renders a final lost tick without sequential recovery controls', async () => {
    const current = openRouterSnapshot('example/alpha');
    const completed = completeTickResponse(current);
    const failure = {
      code: 'timeout' as const,
      message: 'The shared tick deadline elapsed.',
      retryable: false,
      model: 'example/alpha',
    };
    const lost = agentTurnRecordSchema.parse({
      ...completed.records[0],
      outcome: 'lost-tick',
      failure,
      provider: undefined,
    });
    const records = [lost, ...completed.records.slice(1)];
    const snapshot = simulationSnapshotSchema.parse({
      ...completed.snapshot,
      turns: records,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/tick?mutationId=')
          ? jsonResponse({ snapshot, tickNumber: 1, records })
          : jsonResponse(current),
      ),
    );
    render(<WorldLab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Single tick' }));
    expect(
      await screen.findByText(/1 agent lost this tick/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Skip turn' }),
    ).not.toBeInTheDocument();
  });

  it('reconciles a lost tick response from the authoritative snapshot without resubmitting', async () => {
    const initial = simulationSnapshotSchema.parse({
      ...afterInfection(),
      turnNumber: 0,
      turns: [],
      experiment: {
        ...afterInfection().experiment,
        totalCompletedTurns: 0,
        retainedTurns: 0,
        firstRetainedTurn: undefined,
        lastRetainedTurn: undefined,
      },
    });
    const completed = completeTickResponse(initial).snapshot;
    let turnRequests = 0;
    let snapshotRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/models')) return jsonResponse(compatibleCatalog);
        if (url.includes('/tick?mutationId=')) {
          turnRequests += 1;
          return Promise.reject(new TypeError('ECONNRESET'));
        }
        snapshotRequests += 1;
        return jsonResponse(snapshotRequests === 1 ? initial : completed);
      }),
    );
    render(<WorldLab />);
    await screen.findByText('Tick 0');
    fireEvent.click(screen.getByRole('button', { name: 'Single tick' }));
    await screen.findByText('Tick 1');
    expect(turnRequests).toBe(1);
    expect(screen.getByRole('button', { name: 'Single tick' })).toBeEnabled();
    expect(screen.queryByText('Reconciling request…')).not.toBeInTheDocument();
  });

  it('polls and disables conflicting controls for an externally active tick with no active agent', async () => {
    vi.useFakeTimers();
    const active = simulationSnapshotSchema.parse({
      ...initial,
      status: 'waiting-for-model',
      activeAgentId: null,
    });
    const completed = completeTickResponse(initial).snapshot;
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(requests++ === 0 ? active : completed)),
    );
    render(<WorldLab />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByLabelText('Experiment details. Tick 0, waiting for model'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Single tick' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Run to tick 25' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText('More World Lab actions'));
    expect(screen.getByRole('button', { name: 'World setup' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset world' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByText('Tick 1')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('collapses and expands the bounded activity dock', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(afterPublicMessage())),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await screen.findByLabelText('Public world chat');
    expect(document.querySelector('main')).toHaveClass('world-lab-shell');
    await user.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(document.querySelector('main')).toHaveClass('chat-collapsed');
    expect(
      screen.queryByLabelText('Public world chat'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('World event log')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(document.querySelector('main')).not.toHaveClass('chat-collapsed');
    expect(screen.getByLabelText('Public world chat')).toHaveTextContent(
      HOSTILE_MESSAGE,
    );
  });

  it('pauses chat auto-scroll and offers a jump when new messages arrive above the bottom', async () => {
    const first = afterPublicMessage();
    const nextEvent = {
      ...first.world.events.find(({ type }) => type === 'public-message-sent')!,
      id: '99cc21b9-fc78-4b04-9f92-9862bf346f99',
      occurredAt: '2026-08-13T12:00:02.000Z',
      message: 'A newer public message.',
    };
    const next = simulationSnapshotSchema.parse({
      ...first,
      world: { ...first.world, events: [...first.world.events, nextEvent] },
    });
    let scrollHeight = 1_000;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(first))
        .mockImplementationOnce(() => {
          scrollHeight = 1_100;
          return jsonResponse(completeTickResponse(next));
        }),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    const chat = await screen.findByLabelText('Public world chat');
    const feed = within(chat).getByRole('list');
    Object.defineProperties(feed, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    fireEvent.scroll(feed);
    await act(async () => undefined);
    await user.click(screen.getByRole('button', { name: 'Single tick' }));
    const jump = await screen.findByRole('button', {
      name: '1 new message · Return to latest',
    });
    expect(feed.scrollTop).toBe(300);
    await user.click(jump);
    expect(feed.scrollTop).toBe(0);
    expect(screen.queryByText(/new message · Jump/)).not.toBeInTheDocument();
  });

  it('enters and cancels explicit personality editing without a request', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox', {
      name: 'Personality directive',
    });
    expect(textarea).toHaveValue(world.agents[0]!.personality);
    await user.type(textarea, ' unsaved');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(world.agents[0]!.personality)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('applies a trimmed custom personality only after Apply', async () => {
    const custom = 'Choose open adjacent cells before waiting.';
    const changed = withPersonality(initial, world.agents[0]!.id, custom);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(initial))
        .mockImplementationOnce(() =>
          jsonResponse({ snapshot: changed, agent: changed.world.agents[0] }),
        ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox', {
      name: 'Personality directive',
    });
    await user.clear(textarea);
    await user.type(textarea, `  ${custom}  `);
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(custom)).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith(
      `${apiBaseForTest()}/agents/${world.agents[0]!.id}/personality`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ personality: custom }),
      }),
    );
  });

  it.each(PERSONALITY_PRESETS)(
    'selects and applies the $name preset explicitly',
    async (preset) => {
      const changed = withPersonality(
        initial,
        world.agents[0]!.id,
        preset.personality,
      );
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementationOnce(() => jsonResponse(initial))
          .mockImplementationOnce(() =>
            jsonResponse({
              snapshot: changed,
              agent: changed.world.agents[0],
            }),
          ),
      );
      const user = userEvent.setup();
      render(<WorldLab />);
      await user.click(await screen.findByRole('button', { name: 'Edit' }));
      await user.selectOptions(
        screen.getByLabelText('Personality preset'),
        preset.id,
      );
      expect(
        screen.getByRole('textbox', { name: 'Personality directive' }),
      ).toHaveValue(preset.personality);
      expect(fetch).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Apply' }));
      expect(await screen.findByText(preset.personality)).toBeInTheDocument();
      expect(screen.getByText(preset.name)).toBeInTheDocument();
    },
  );

  it('shows character count, empty validation, and Custom preset state', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const textarea = screen.getByRole('textbox', {
      name: 'Personality directive',
    });
    expect(
      screen.getByText(`${world.agents[0]!.personality.length}/600`),
    ).toBeInTheDocument();
    expect(textarea).toHaveAttribute('maxlength', '600');
    expect(screen.getByLabelText('Personality preset')).toHaveValue('custom');
    await user.clear(textarea);
    expect(screen.getByText('0/600')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a personality between 1 and 600 characters.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('disables personality mutations during playback and pending requests', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      screen.getByRole('textbox', { name: 'Personality directive' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await openOverflow(user);
    expect(
      screen.getByRole('button', { name: 'Restore default personalities' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    let resolveUpdate!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise((resolve) => (resolveUpdate = resolve)),
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    await openOverflow(user);
    expect(screen.getByRole('button', { name: 'Reset world' })).toBeDisabled();
    resolveUpdate(
      new Response(
        JSON.stringify({ snapshot: initial, agent: initial.world.agents[0] }),
        { status: 200 },
      ),
    );
    await screen.findByRole('button', { name: 'Edit' });
  });

  it('keeps an edited personality through world reset', async () => {
    const edited = withPersonality(
      afterInfection(),
      world.agents[0]!.id,
      'Persistent lab edit.',
    );
    const resetWithEdit = withPersonality(
      initial,
      world.agents[0]!.id,
      'Persistent lab edit.',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(edited))
        .mockImplementationOnce(() =>
          jsonResponse({ snapshot: resetWithEdit }),
        ),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await openOverflow(user);
    await user.click(
      await screen.findByRole('button', { name: 'Reset world' }),
    );
    expect(await screen.findByText('Persistent lab edit.')).toBeInTheDocument();
    expect(screen.getByText('Tick 0')).toBeInTheDocument();
  });

  it('confirms restoring defaults and preserves current world progress', async () => {
    const progressed = completeTickResponse(
      withPersonality(afterInfection(), world.agents[0]!.id, 'Temporary edit.'),
    ).snapshot;
    const restored = simulationSnapshotSchema.parse({
      ...progressed,
      world: {
        ...progressed.world,
        agents: progressed.world.agents.map((agent, index) => ({
          ...agent,
          personality: world.agents[index]!.personality,
        })),
      },
    });
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse(progressed))
        .mockImplementationOnce(() => jsonResponse({ snapshot: restored })),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    await openOverflow(user);
    const restore = await screen.findByRole('button', {
      name: 'Restore default personalities',
    });
    await user.click(restore);
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(restore);
    expect(
      await screen.findByRole('group', {
        name: 'Active personality configuration',
      }),
    ).toHaveTextContent(world.agents[0]!.personality);
    expect(screen.getByText('Tick 1')).toBeInTheDocument();
    expect(screen.getByTestId('infected-count')).toHaveTextContent(
      '1 rendered infected',
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an active edit from the immutable latest observation', async () => {
    const changed = completeTickResponse(
      withPersonality(
        afterInfection(),
        world.agents[0]!.id,
        'New active personality.',
      ),
    ).snapshot;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(changed)),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    expect(
      await screen.findByText('New active personality.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(world.agents[0]!.personality, { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Immutable input supplied for tick 1 record 1/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The active personality has changed since this observation.',
      ),
    ).toBeInTheDocument();
  });

  it('shows current and selected-agent experiment usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(afterInfection())),
    );
    const user = userEvent.setup();
    render(<WorldLab />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Select agent Ember, Patient Zero',
      }),
    );
    expect(
      await screen.findByLabelText('Current experiment usage'),
    ).toHaveTextContent('1 turns');
    expect(screen.getByLabelText('Current experiment usage')).toHaveTextContent(
      '0.0 credits known cost',
    );
    expect(screen.getByLabelText('Selected agent usage')).toHaveTextContent(
      '1 turns',
    );
  });

  it('supports agent selection and previews server-owned export', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('checkbox', { name: /Ember/ }));
    expect(screen.getByRole('checkbox', { name: /Ember/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Rook/ })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: /Rook/ }));
    vi.mocked(fetch).mockImplementationOnce(() =>
      jsonResponse({
        experimentId: initial.experiment.id,
        matchingTurnCount: 0,
        matchingCommunicationCount: 0,
        matchingControlChangeCount: 0,
        matchingDiplomacyEventCount: 0,
        selectedAgentCount: 2,
        retention: {
          limit: 5000,
          totalCompletedTurns: 0,
          retainedTurns: 0,
          droppedRecords: 0,
          complete: true,
          requestedRangeExtendsBeyondRetention: false,
        },
        knownCostCredits: 0,
        turnsWithUnknownCost: 0,
        serializedUtf8Bytes: 900,
        approximateAiInputTokens: 225,
        tokenEstimateMethod: 'ceil(UTF-8 bytes / 4)',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByLabelText('Export preview')).toHaveTextContent(
      '900 bytes',
    );
    const request = JSON.parse(
      String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body),
    );
    expect(request.agents).toEqual({
      mode: 'selected',
      agentIds: [world.agents[0]!.id, world.agents[1]!.id],
    });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    for (const agent of world.agents)
      expect(
        screen.getByRole('checkbox', { name: new RegExp(agent.name) }),
      ).toBeChecked();
  });

  it('keeps export out of the details panel and dismisses its modal without losing settings', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await openOverflow(user);
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(
      screen.queryByRole('dialog', { name: 'Experiment export' }),
    ).toBeNull();
    await user.click(exportButton);
    await user.selectOptions(screen.getByLabelText('Export level'), 'standard');
    await user.click(screen.getByRole('button', { name: 'Close export' }));
    expect(
      screen.queryByRole('dialog', { name: 'Experiment export' }),
    ).toBeNull();
    expect(exportButton).toHaveFocus();
    await openOverflow(user);
    await user.click(exportButton);
    expect(screen.getByLabelText('Export level')).toHaveValue('standard');
    const reopenedDialog = screen.getByRole('dialog', {
      name: 'Experiment export',
    });
    fireEvent.mouseDown(reopenedDialog);
    expect(
      screen.getByRole('dialog', { name: 'Experiment export' }),
    ).toBeInTheDocument();
    expect(reopenedDialog.querySelector('.modal-body')).toBeInTheDocument();
    expect(reopenedDialog.querySelector('.modal-footer')).toBeInTheDocument();
    fireEvent.mouseDown(reopenedDialog.closest('.modal-backdrop')!);
    expect(
      screen.queryByRole('dialog', { name: 'Experiment export' }),
    ).toBeNull();
    await openOverflow(user);
    await user.click(exportButton);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Experiment export' }),
    ).toBeNull();
  });

  it('offers every tier, turn selector, outcome/action filters, and dependent Custom switches', async () => {
    const user = userEvent.setup();
    render(<WorldLab />);
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const level = screen.getByLabelText('Export level');
    expect(level).toHaveTextContent('Minimal');
    expect(level).toHaveTextContent('Standard');
    expect(level).toHaveTextContent('Full safe');
    expect(level).toHaveTextContent('Custom');
    expect(screen.getByLabelText('JSON serialization')).toHaveValue('compact');
    expect(screen.getByLabelText('Communication channel')).toHaveValue('all');
    expect(screen.getByLabelText('Communication result')).toHaveValue('all');
    expect(screen.getByRole('checkbox', { name: 'lost tick' })).toBeChecked();
    await user.selectOptions(
      screen.getByLabelText('Communication channel'),
      'direct',
    );
    await user.selectOptions(
      screen.getByLabelText('Communication result'),
      'rejected',
    );
    expect(screen.getByLabelText('Communication channel')).toHaveValue(
      'direct',
    );
    expect(screen.getByLabelText('Communication result')).toHaveValue(
      'rejected',
    );
    await user.selectOptions(
      screen.getByLabelText('JSON serialization'),
      'pretty',
    );
    await user.selectOptions(level, 'custom');
    expect(screen.getByText('Advanced Custom switches')).toBeInTheDocument();
    const observations = screen.getByRole('checkbox', {
      name: 'Turn observations',
    });
    await user.click(observations);
    expect(
      screen.getByRole('checkbox', { name: 'Nearby agents' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Recent events' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', {
        name: 'Recent public messages in observations',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', {
        name: 'Recent direct messages in observations',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Canonical communications' }),
    ).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('Turn range'), 'range');
    expect(screen.getByLabelText('From turn')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'accepted' }));
    await user.click(screen.getByRole('checkbox', { name: 'rejected' }));
    await user.click(screen.getByRole('checkbox', { name: 'provider error' }));
    await user.click(screen.getByRole('checkbox', { name: 'lost tick' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'operator skipped' }),
    );
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('copies and downloads the exact same validated generated JSON and revokes its URL', async () => {
    const user = userEvent.setup();
    const progressed = afterInfection();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(progressed)),
    );
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const createObjectURL = vi.fn(() => 'blob:experiment');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    let downloadedFilename: string | undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedFilename = this.download;
      });
    render(<WorldLab />);
    await openOverflow(user);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Download JSON' }),
    ).toBeDisabled();
    const document = minimalExportDocument(progressed);
    vi.mocked(fetch).mockImplementationOnce(() => jsonResponse({ document }));
    await user.click(screen.getByRole('button', { name: 'Generate export' }));
    await user.click(await screen.findByRole('button', { name: 'Copy JSON' }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      JSON.stringify(experimentExportDocumentSchema.parse(document)),
    );
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy JSON' }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download JSON' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:experiment');
    expect(click).toHaveBeenCalledTimes(1);
    expect(downloadedFilename).toMatch(
      /^hexzero-experiment-.+-one-agent-entire-retained\.json$/,
    );
    await user.selectOptions(
      screen.getByLabelText('JSON serialization'),
      'pretty',
    );
    expect(screen.getByRole('button', { name: 'Copy JSON' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Download JSON' }),
    ).toBeDisabled();
    expect(
      screen.getByText('Options changed — regenerate export.'),
    ).toBeInTheDocument();
    click.mockRestore();
  });

  it('auto-pauses a fully infected world and disables automatic Start only', async () => {
    const infected = simulationSnapshotSchema.parse({
      ...initial,
      world: {
        ...initial.world,
        hexes: initial.world.hexes.map((hex) => ({
          ...hex,
          state: 'infected' as const,
          controllerAgentId: initial.world.agents[0]!.id,
        })),
      },
      experiment: {
        ...initial.experiment,
        currentTerritory: initial.experiment.currentTerritory.map(
          (entry, index) => ({
            ...entry,
            controlledCellCount: index === 0 ? 127 : 0,
          }),
        ),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(infected)),
    );
    render(<WorldLab />);
    expect(
      await screen.findByText(/Development world fully infected/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Single tick' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText('More World Lab actions'));
    expect(screen.getByRole('button', { name: 'Reset world' })).toBeEnabled();
  });
});

function minimalExportDocument(snapshot: SimulationSnapshot) {
  const turn = snapshot.turns[0]!;
  const agent = snapshot.world.agents[0]!;
  return {
    schemaVersion: 9 as const,
    generatedAt: '2026-08-13T12:00:02.000Z',
    experiment: {
      id: snapshot.experiment.id,
      startedAt: snapshot.experiment.startedAt,
      providerMode: snapshot.providerMode,
    },
    retention: {
      limit: 5000,
      totalCompletedTurns: 1,
      retainedTurns: 1,
      firstRetainedTurn: 1,
      lastRetainedTurn: 1,
      droppedRecords: 0,
      complete: true,
      requestedRangeExtendsBeyondRetention: false,
    },
    filters: {
      agents: { mode: 'selected' as const, agentIds: [agent.id] },
      turns: { mode: 'entire-retained' as const },
      outcomes: ['accepted', 'rejected', 'provider-error'] as const,
      actions: ['move', 'infect', 'capture', 'wait'] as const,
      communications: { channel: 'all' as const, status: 'all' as const },
      level: 'minimal' as const,
    },
    selection: {
      selectedAgentIds: [agent.id],
      matchingTurnCount: 1,
      matchingCommunicationCount: 0,
      matchingControlChangeCount: 0,
      matchingDiplomacyEventCount: 0,
      firstMatchingTurn: 1,
      lastMatchingTurn: 1,
    },
    agents: [agent],
    metrics: {
      aggregate: snapshot.experiment.metrics.aggregate,
      byAgent: [snapshot.experiment.metrics.byAgent[0]!],
    },
    currentTerritory: snapshot.experiment.currentTerritory,
    currentAlliances: snapshot.experiment.currentAlliances,
    communications: [],
    controlChanges: [],
    allianceEvents: [],
    turns: [
      {
        turnNumber: turn.turnNumber,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        agentId: turn.agentId,
        outcome: turn.outcome,
        ...(turn.outcome === 'accepted'
          ? {
              worldAction: turn.worldAction,
              summary: turn.summary,
              worldActionSummary: `Infected ${agent.currentCell}.`,
              provider: turn.provider,
            }
          : {}),
      },
    ],
  };
}

function apiBaseForTest() {
  return process.env.NEXT_PUBLIC_GAME_API_BASE_URL ?? '/api/game/simulation';
}
