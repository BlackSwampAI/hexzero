import { gridDistance } from 'h3-js';
import { type H3Cell, type SwarmDirective } from '@hexzero/shared';
import { type WorldState } from '@hexzero/world-engine';

export interface SwarmDirectiveCompletionContext {
  priorNearbyPressure?: 'low' | 'rising' | 'high';
  recentCleanedCells?: readonly H3Cell[];
}

function gridDistanceOrNull(from: H3Cell, to: H3Cell): number | null {
  try {
    return gridDistance(from, to);
  } catch {
    return null;
  }
}

function isOpenAdjacentToInfected(state: WorldState, target: H3Cell): boolean {
  if (state.hexes.get(target)?.state !== 'open') return false;
  return [...state.hexes.entries()].some(
    ([cell, hex]) =>
      hex.state === 'infected' && gridDistanceOrNull(target, cell) === 1,
  );
}

/**
 * Identifies directives whose objective is already satisfied by authoritative
 * world state. This deliberately has no engine or provider side effects.
 */
export function isSwarmDirectiveComplete(
  state: WorldState,
  directive: SwarmDirective,
  context: SwarmDirectiveCompletionContext = {},
): boolean {
  if (!directive.targetCell) return false;
  const worker = state.agents.get(directive.agentId);
  if (!worker) return false;

  switch (directive.mission) {
    case 'expand': {
      const target = state.hexes.get(directive.targetCell);
      return (
        target?.state === 'infected' &&
        target.controllerAgentId === directive.agentId
      );
    }
    case 'relocate':
    case 'reinforce':
      return worker.currentCell === directive.targetCell;
    case 'evade':
      return (
        worker.currentCell === directive.targetCell ||
        (context.priorNearbyPressure === 'high' &&
          context.recentCleanedCells !== undefined &&
          !context.recentCleanedCells.slice(-6).some((cell) => {
            const distance = gridDistanceOrNull(worker.currentCell, cell);
            return distance !== null && distance <= 1;
          }))
      );
    case 'hold':
      return false;
  }
}

/** Returns a deterministic reason when Zero proposes an incoherent directive. */
export function swarmDirectiveIssue(
  state: WorldState,
  directive: SwarmDirective,
): string | null {
  const worker = state.agents.get(directive.agentId);
  if (!worker) return 'Assigned worker does not exist.';
  if (directive.mission !== 'hold' && !directive.targetCell)
    return 'This mission requires a target cell.';
  if (!directive.targetCell) return null;
  const target = state.hexes.get(directive.targetCell);
  if (!target) return 'Target is outside the current world.';

  if (
    directive.mission === 'expand' &&
    target.state === 'infected' &&
    target.controllerAgentId === directive.agentId
  )
    return 'Expand target is already controlled by this worker.';
  if (
    (directive.mission === 'relocate' ||
      directive.mission === 'reinforce' ||
      directive.mission === 'evade') &&
    directive.targetCell === worker.currentCell
  )
    return 'Target is already the worker’s current cell.';
  if (
    directive.mission === 'reinforce' &&
    target.state !== 'infected' &&
    !isOpenAdjacentToInfected(state, directive.targetCell)
  )
    return 'Reinforce target must be infected or adjacent to infected territory.';
  return null;
}
