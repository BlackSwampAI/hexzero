import { gridDisk, latLngToCell } from 'h3-js';
import {
  agentIdSchema,
  agentObservationSchema,
  createMemoryId,
  h3CellSchema,
  type AgentObservation,
} from '@hexzero/shared';
import type { RealProviderSmokeScenario } from './smoke-arguments';

export function buildRealProviderSmokeObservation(
  scenario: RealProviderSmokeScenario,
): AgentObservation {
  const agentId = agentIdSchema.parse('128f3f38-6b7d-4db7-9e95-751b4ce2681e');
  const currentCell = h3CellSchema.parse(latLngToCell(41.6528, -83.5379, 9));
  const adjacentCells = gridDisk(currentCell, 1)
    .filter((cell) => cell !== currentCell)
    .map((cell) => ({
      cell: h3CellSchema.parse(cell),
      state: 'open' as const,
      controllerAgentId: null,
      controllerAllianceId: null,
      effectiveColor: null,
    }));
  const memoryId = createMemoryId(agentId, 1);

  return agentObservationSchema.parse({
    agentId,
    agentName: 'Ember',
    personality:
      'Prefer infecting open cells and moving into uninfected space.',
    ...(scenario === 'stateful'
      ? {
          currentGoal: {
            longTermGoal: 'Build durable influence in this region.',
            shortTermGoal: 'Secure the adjacent open cells.',
            planSummary: 'Expand methodically from the current position.',
            establishedAtTick: 1,
            revisedAtTick: 1,
          },
          goalAvailability: {
            active: true,
            availableOperations: ['keep', 'revise', 'complete', 'abandon'],
          },
          currentMemory: [
            {
              id: memoryId,
              text: 'The nearby route was open at the first observation.',
              createdAtTick: 1,
              revisedAtTick: 1,
            },
          ],
          memoryAvailability: {
            remember: true,
            revisableMemoryIds: [memoryId],
            forgettableMemoryIds: [memoryId],
          },
        }
      : {}),
    currentCell: {
      cell: currentCell,
      state: 'open',
      controllerAgentId: null,
      controllerAllianceId: null,
      effectiveColor: null,
    },
    captureEligibility: {
      eligible: false,
      blockedReason: 'capture-open-cell',
    },
    actionAvailability: {
      moveTargetCellIds: adjacentCells.map(({ cell }) => cell),
      infect: { available: true },
      capture: { available: false, reason: 'capture-open-cell' },
      wait: { available: true },
    },
    adjacentCells,
    nearbyAgents: [],
    recentEvents: [],
    recentPublicMessages: [],
    recentDirectMessages: [],
    territoryScoreboard: [
      [agentId, 'Ember', '#ff6b57'],
      [
        agentIdSchema.parse('2507bb46-7ae4-45ca-8dda-644c4f85ca14'),
        'Rook',
        '#ffd166',
      ],
      [
        agentIdSchema.parse('3ba3ef0b-2142-44cc-b175-f6e5d6e98df5'),
        'Mingle',
        '#63d2ff',
      ],
      [
        agentIdSchema.parse('442a1667-39c8-48e9-8c89-23803f9e2101'),
        'Solace',
        '#c59cff',
      ],
      [
        agentIdSchema.parse('5f812a08-05f2-4950-bf2d-4df59d05e9c2'),
        'Verge',
        '#6ee7a8',
      ],
      [
        agentIdSchema.parse('67a43b5c-ced8-45bd-970f-a89ac57853fc'),
        'Jinx',
        '#ff91c8',
      ],
    ].map(([scoreAgentId, name, color]) => ({
      agentId: scoreAgentId,
      name,
      color,
      allianceId: null,
      effectiveColor: color,
      controlledCellCount: 0,
    })),
    recentControlChanges: [],
    actingAllianceId: null,
    actingAlliance: null,
    activeAlliances: [],
    inboundAllianceProposals: [],
    outboundAllianceProposals: [],
    recentAllianceEvents: [],
  });
}
