import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  agentTurnRecordSchema,
  type AgentTurnRecord,
} from '@hexzero/shared';
import { BEHAVIOR_TRACE_LIMIT, deriveBehaviorTrace } from './behavior-trace';

const agentId = agentIdSchema.parse('128f3f38-6b7d-4db7-9e95-751b4ce2681e');
const otherAgentId = agentIdSchema.parse(
  '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
);
const currentCell = '892b6b5a2c7ffff';
const adjacentCell = '892b6b5a2d3ffff';

function acceptedTurn(
  turnNumber: number,
  options: {
    move?: boolean;
    inboundMessage?: boolean;
    territoryChange?: boolean;
    continuity?: boolean;
  } = {},
): AgentTurnRecord {
  const move = options.move ?? false;
  const occurredAt = `2026-08-23T12:00:${String(turnNumber).padStart(2, '0')}.000Z`;
  return agentTurnRecordSchema.parse({
    turnNumber,
    agentId,
    startedAt: occurredAt,
    completedAt: occurredAt,
    observation: {
      agentId,
      agentName: 'Ember',
      personality: 'A deliberate test agent.',
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
        moveTargetCellIds: [adjacentCell],
        moveOptions: [
          {
            targetCell: adjacentCell,
            direction: 'NE',
            destinationState: 'open',
            controllerRelationship: 'open',
            recentlyOccupied: false,
            nearbyAgentCount: 1,
          },
        ],
        infect: { available: true },
        capture: { available: false, reason: 'capture-open-cell' },
        wait: { available: true },
      },
      adjacentCells: [
        {
          cell: adjacentCell,
          state: 'open',
          controllerAgentId: null,
          controllerAllianceId: null,
          effectiveColor: null,
        },
      ],
      nearbyAgents: [],
      recentEvents: [],
      recentPublicMessages: [],
      recentDirectMessages: options.inboundMessage
        ? [
            {
              eventId: '67aa21b9-fc78-4b04-9f92-9862bf346f96',
              senderId: otherAgentId,
              senderName: 'Rook',
              recipientId: agentId,
              recipientName: 'Ember',
              direction: 'inbound',
              message: 'Hold the eastern route.',
              occurredAt,
              distance: 2,
            },
          ]
        : [],
      territoryScoreboard: [
        {
          agentId,
          name: 'Ember',
          color: '#d55e00',
          allianceId: null,
          effectiveColor: '#d55e00',
          controlledCellCount: 0,
        },
      ],
      actingAllianceId: null,
      actingAlliance: null,
      activeAlliances: [],
      inboundAllianceProposals: [],
      outboundAllianceProposals: [],
      recentAllianceEvents: [],
      recentControlChanges: options.territoryChange
        ? [
            {
              eventId: '87aa21b9-fc78-4b04-9f92-9862bf346f96',
              direction: 'lost',
              otherAgentId,
              otherAgentName: 'Rook',
              cell: adjacentCell,
              occurredAt,
            },
          ]
        : [],
    },
    outcome: 'accepted',
    worldAction: move
      ? { type: 'move', targetCell: adjacentCell }
      : { type: 'wait' },
    summary: move ? 'Respond to the eastern-route warning.' : 'Hold position.',
    worldActionResult: {
      accepted: true,
      event: move
        ? {
            id: `77bb21b9-fc78-4b04-9f92-9862bf346f9${turnNumber}`,
            type: 'agent-moved',
            agentId,
            fromCell: currentCell,
            toCell: adjacentCell,
            occurredAt,
          }
        : {
            id: `77bb21b9-fc78-4b04-9f92-9862bf346f9${turnNumber}`,
            type: 'agent-waited',
            agentId,
            occurredAt,
          },
    },
    communicationResult: { requested: false },
    diplomacyResult: { requested: false },
    ...(options.continuity
      ? {
          goalRevision: {
            operation: 'establish',
            longTermGoal: 'Hold the eastern corridor.',
            shortTermGoal: 'Wait for a safe route.',
            planSummary: 'Observe before moving.',
            reason: 'Set a retained objective.',
          },
          goalRevisionResult: {
            requested: true,
            accepted: true,
            operation: 'establish',
          },
          memoryOperation: {
            operation: 'remember',
            text: 'Rook contested the eastern route.',
          },
          memoryOperationResult: {
            requested: true,
            accepted: false,
            operation: 'remember',
            reason: 'memory-full',
          },
        }
      : {}),
    provider: {
      provider: 'scripted-test',
      model: 'test',
      latencyMs: 0,
    },
  });
}

describe('deriveBehaviorTrace', () => {
  it('places new evidence beside legal choices, chosen direction, and action change', () => {
    const trace = deriveBehaviorTrace(
      [
        acceptedTurn(1),
        acceptedTurn(2, {
          move: true,
          inboundMessage: true,
          territoryChange: true,
        }),
      ],
      agentId,
    );

    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({
      hasPreviousObservation: true,
      legalActions: ['Move NE', 'Infect', 'Wait'],
      chosenAction: `Move NE → ${adjacentCell}`,
      chosenCell: adjacentCell,
      actionPattern: 'Changed wait → move NE.',
      evidence: [
        {
          kind: 'direct',
          label: 'Inbound from Rook: Hold the eastern route.',
        },
        {
          kind: 'territory',
          label: `Lost ${adjacentCell} to Rook`,
          cell: adjacentCell,
        },
      ],
    });
    expect(trace[0]!.observedChanges).toContain(
      '2 new retained evidence items entered the retained observation.',
    );
    expect(trace[1]!.observedChanges).toEqual([
      'First retained observation for this agent.',
    ]);
  });

  it('stays bounded and newest-first', () => {
    const turns = Array.from({ length: 8 }, (_, index) =>
      acceptedTurn(index + 1),
    );
    const trace = deriveBehaviorTrace(turns, agentId);
    expect(trace).toHaveLength(BEHAVIOR_TRACE_LIMIT);
    expect(trace.map(({ turn }) => turn.turnNumber)).toEqual([
      8, 7, 6, 5, 4, 3,
    ]);
    expect(deriveBehaviorTrace(turns, agentId, 99)).toHaveLength(
      BEHAVIOR_TRACE_LIMIT,
    );
  });

  it('reports repeated actions and independent goal and memory continuity', () => {
    const trace = deriveBehaviorTrace(
      [acceptedTurn(1), acceptedTurn(2, { continuity: true })],
      agentId,
    );
    expect(trace[0]).toMatchObject({
      actionPattern: 'Repeated wait.',
      continuity: [
        'Goal establish: accepted',
        'Memory remember: rejected (memory-full)',
      ],
    });
  });
});
