import { gridDisk, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  eventIdSchema,
  h3CellSchema,
  type AgentId,
  type H3Cell,
  type WorldAction,
  type WorldActionResult,
} from '@hexzero/shared';
import { calculateExperimentMetrics } from './experiment-export';
import { geographicDirectionBetweenCells } from './geographic-direction';

const agentX = agentIdSchema.parse('00000000-0000-4000-8000-000000000001');
const agentY = agentIdSchema.parse('00000000-0000-4000-8000-000000000002');
const origin = h3CellSchema.parse(latLngToCell(41.6528, -83.5379, 9));

function neighbors(cell: H3Cell): H3Cell[] {
  return gridDisk(cell, 1)
    .filter((candidate) => candidate !== cell)
    .map((candidate) => h3CellSchema.parse(candidate));
}

/**
 * Finds origin -> a -> b where both outbound steps share one direction and
 * both return steps share another.
 */
function straightLine() {
  for (const a of neighbors(origin)) {
    const direction = geographicDirectionBetweenCells(origin, a);
    const opposite = geographicDirectionBetweenCells(a, origin);
    const b = neighbors(a).find(
      (candidate) =>
        candidate !== origin &&
        geographicDirectionBetweenCells(a, candidate) === direction &&
        geographicDirectionBetweenCells(candidate, a) === opposite,
    );
    if (b) return { a, b, direction, opposite };
  }
  throw new Error('No straight two-step H3 line from the origin.');
}

let eventCount = 0;
function moved(tickNumber: number, agentId: AgentId, from: H3Cell, to: H3Cell) {
  eventCount += 1;
  const action: WorldAction = { type: 'move', targetCell: to };
  const actionResult: WorldActionResult = {
    accepted: true,
    event: {
      id: eventIdSchema.parse(
        `00000000-0000-4000-8000-${String(eventCount).padStart(12, '0')}`,
      ),
      agentId,
      occurredAt: '2026-08-13T12:00:00.000Z',
      type: 'agent-moved',
      fromCell: from,
      toCell: to,
    },
  };
  return { tickNumber, agentId, action, actionResult };
}

function rejectedMove(tickNumber: number, agentId: AgentId, to: H3Cell) {
  const action: WorldAction = { type: 'move', targetCell: to };
  const actionResult: WorldActionResult = {
    accepted: false,
    reason: 'not-adjacent',
    details: 'Target is not adjacent.',
  };
  return { tickNumber, agentId, action, actionResult };
}

describe('movement-pattern metrics', () => {
  it('walks each agent path separately for direction streaks and revisits', () => {
    const { a, b, direction, opposite } = straightLine();
    const yTarget = neighbors(origin).find(
      (cell) => geographicDirectionBetweenCells(origin, cell) === direction,
    )!;

    const metrics = calculateExperimentMetrics(
      [
        moved(1, agentX, origin, a),
        // Agent Y moves in the same direction between X's two moves. A single
        // interleaved walk would report a streak of three.
        moved(1, agentY, origin, yTarget),
        rejectedMove(2, agentX, origin),
        moved(3, agentX, a, b),
        moved(4, agentX, b, a),
        moved(5, agentX, a, origin),
      ],
      [agentX, agentY],
    );

    const x = metrics.byAgent.find(({ agentId }) => agentId === agentX)!;
    expect(x.metrics.longestRepeatedDirectionStreak).toBe(2);
    expect(x.metrics.recentCellRevisits).toBe(2);
    expect(x.metrics.movementDirectionDistribution).toEqual(
      expect.arrayContaining([
        { direction, count: 2 },
        { direction: opposite, count: 2 },
      ]),
    );

    expect(metrics.aggregate.longestRepeatedDirectionStreak).toBe(2);
    expect(metrics.aggregate.recentCellRevisits).toBe(2);
    expect(metrics.aggregate.movementDirectionDistribution).toEqual(
      expect.arrayContaining([
        { direction, count: 3 },
        { direction: opposite, count: 2 },
      ]),
    );
  });

  it('reports no movement pattern when no move was accepted', () => {
    const metrics = calculateExperimentMetrics(
      [rejectedMove(1, agentX, origin)],
      [agentX],
    );

    expect(metrics.aggregate.movementDirectionDistribution).toEqual([]);
    expect(metrics.aggregate.longestRepeatedDirectionStreak).toBe(0);
    expect(metrics.aggregate.recentCellRevisits).toBe(0);
  });
});
