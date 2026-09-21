import { gridDistance } from 'h3-js';
import type {
  CaptureAlert,
  H3Cell,
  SimulatedPlayerEvent,
} from '@hexzero/shared';
import {
  geographicDirectionBetweenCells,
  type GeographicDirection,
} from './geographic-direction';

export const MAX_SWARM_PRESSURE_EVENTS = 6;
export const SWARM_PRESSURE_WINDOW_TICKS = 6;
export const RECENT_CAPTURE_WINDOW_TICKS = 6;

type DisinfectionEvent = Extract<
  SimulatedPlayerEvent,
  { type: 'hex-disinfected' }
>;

export interface LocalPressureContext {
  localPressure: 'low' | 'rising' | 'high';
  pressureDirection: GeographicDirection | null;
  pressureDistance: 'same-cell' | 'adjacent' | 'nearby' | null;
}

/**
 * Combines retained and current public disinfection effects for cognition.
 * Event IDs make this safe when an already-retained event is supplied again.
 */
export function boundedPressureEvents(
  retained: readonly SimulatedPlayerEvent[],
  current: readonly SimulatedPlayerEvent[],
  currentTick: number,
): DisinfectionEvent[] {
  const seen = new Set<string>();
  return [...retained, ...current]
    .filter(
      (event): event is DisinfectionEvent => event.type === 'hex-disinfected',
    )
    .filter(
      (event) =>
        event.originatingTick >=
          currentTick - SWARM_PRESSURE_WINDOW_TICKS + 1 &&
        event.originatingTick <= currentTick,
    )
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .slice(-MAX_SWARM_PRESSURE_EVENTS);
}

/** Bounded public capture effects for the strategic planner. */
export function boundedRecentCaptures(
  retained: readonly SimulatedPlayerEvent[],
  current: readonly SimulatedPlayerEvent[],
  currentTick: number,
): CaptureAlert[] {
  const seen = new Set<string>();
  return [...retained, ...current]
    .filter(
      (
        event,
      ): event is Extract<
        SimulatedPlayerEvent,
        { type: 'simulated-player-agent-captured' }
      > => event.type === 'simulated-player-agent-captured',
    )
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .filter(
      (event) =>
        event.originatingTick >=
          currentTick - RECENT_CAPTURE_WINDOW_TICKS + 1 &&
        event.originatingTick <= currentTick,
    )
    .slice(-4)
    .map(({ capturedAgentId, cell, originatingTick, abandonedCellCount }) => ({
      capturedAgentId,
      cell,
      originatingTick,
      abandonedCellCount,
    }));
}

/** Derives bounded local threat facts from public world effects and H3 geometry. */
export function localPressureAtCell(
  cell: H3Cell,
  events: readonly DisinfectionEvent[],
): LocalPressureContext {
  return localPressureFromCells(
    cell,
    events.map(({ cell: eventCell }) => eventCell),
  );
}

/** Shared geometry semantics for both event and compatibility cell histories. */
export function localPressureFromCells(
  cell: H3Cell,
  pressureCells: readonly H3Cell[],
): LocalPressureContext {
  const nearby = pressureCells
    .map((pressureCell, index) => {
      try {
        return {
          pressureCell,
          distance: gridDistance(cell, pressureCell),
          index,
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        value,
      ): value is {
        pressureCell: H3Cell;
        distance: number;
        index: number;
      } => value !== null && value.distance <= 2,
    )
    .sort(
      (left, right) =>
        left.distance - right.distance || right.index - left.index,
    );
  const nearest = nearby[0];
  if (!nearest)
    return {
      localPressure: 'low',
      pressureDirection: null,
      pressureDistance: null,
    };
  const pressureDistance =
    nearest.distance === 0
      ? ('same-cell' as const)
      : nearest.distance === 1
        ? ('adjacent' as const)
        : ('nearby' as const);
  return {
    localPressure: nearest.distance <= 1 ? 'high' : 'rising',
    pressureDirection:
      nearest.distance === 0
        ? null
        : geographicDirectionBetweenCells(cell, nearest.pressureCell),
    pressureDistance,
  };
}
