import { cellToLatLng } from 'h3-js';
import type { H3Cell } from '@hexzero/shared';

export type GeographicDirection = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';

const FULL_CIRCLE_DEGREES = 360;

function normalizeDegrees(degrees: number): number {
  return (
    ((degrees % FULL_CIRCLE_DEGREES) + FULL_CIRCLE_DEGREES) %
    FULL_CIRCLE_DEGREES
  );
}

/**
 * Classifies an initial bearing into six equal 60-degree sectors. Boundaries
 * belong to the clockwise sector: N wraps across [330, 360) and [0, 30), NE
 * is [30, 90), SE is [90, 150), S is [150, 210), SW is [210, 270), and NW
 * is [270, 330).
 */
export function directionFromInitialBearing(
  bearingDegrees: number,
): GeographicDirection {
  if (!Number.isFinite(bearingDegrees))
    throw new Error('Initial bearing must be finite.');

  const normalized = normalizeDegrees(bearingDegrees);
  if (normalized < 30 || normalized >= 330) return 'N';
  if (normalized < 90) return 'NE';
  if (normalized < 150) return 'SE';
  if (normalized < 210) return 'S';
  if (normalized < 270) return 'SW';
  return 'NW';
}

/** Returns the great-circle initial bearing from one coordinate to another. */
export function initialBearingDegrees(
  from: readonly [latitude: number, longitude: number],
  to: readonly [latitude: number, longitude: number],
): number {
  if (from[0] === to[0] && from[1] === to[1])
    throw new Error('Initial bearing is undefined for the same coordinate.');

  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const fromLatitude = toRadians(from[0]);
  const toLatitude = toRadians(to[0]);
  const longitudeDelta = toRadians(
    ((to[1] - from[1] + 540) % FULL_CIRCLE_DEGREES) - 180,
  );
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);

  if (x === 0 && y === 0)
    throw new Error('Initial bearing is undefined for coincident coordinates.');

  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

export function geographicDirectionBetweenCells(
  fromCell: H3Cell,
  toCell: H3Cell,
): GeographicDirection {
  if (fromCell === toCell)
    throw new Error('Move direction requires distinct H3 cells.');

  return directionFromInitialBearing(
    initialBearingDegrees(cellToLatLng(fromCell), cellToLatLng(toCell)),
  );
}
