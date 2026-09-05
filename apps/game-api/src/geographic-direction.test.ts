import { describe, expect, it } from 'vitest';
import { gridDisk, latLngToCell } from 'h3-js';
import { h3CellSchema } from '@hexzero/shared';
import {
  directionFromInitialBearing,
  geographicDirectionBetweenCells,
  initialBearingDegrees,
} from './geographic-direction';

describe('geographic move directions', () => {
  it('uses explicit clockwise sector boundaries with north wraparound', () => {
    expect(directionFromInitialBearing(0)).toBe('N');
    expect(directionFromInitialBearing(29.999)).toBe('N');
    expect(directionFromInitialBearing(30)).toBe('NE');
    expect(directionFromInitialBearing(90)).toBe('SE');
    expect(directionFromInitialBearing(150)).toBe('S');
    expect(directionFromInitialBearing(210)).toBe('SW');
    expect(directionFromInitialBearing(270)).toBe('NW');
    expect(directionFromInitialBearing(329.999)).toBe('NW');
    expect(directionFromInitialBearing(330)).toBe('N');
    expect(directionFromInitialBearing(360)).toBe('N');
    expect(directionFromInitialBearing(-30)).toBe('N');
  });

  it('calculates geographic initial bearings across longitude wraparound', () => {
    expect(initialBearingDegrees([0, 179.9], [0, -179.9])).toBeCloseTo(90, 8);
    expect(initialBearingDegrees([0, -179.9], [0, 179.9])).toBeCloseTo(270, 8);
    expect(initialBearingDegrees([41, -83], [42, -83])).toBeCloseTo(0, 8);
    expect(initialBearingDegrees([41, -83], [40, -83])).toBeCloseTo(180, 8);
  });

  it('rejects same-cell and same-coordinate bearings deliberately', () => {
    const cell = h3CellSchema.parse(latLngToCell(41.6528, -83.5379, 9));
    expect(() => geographicDirectionBetweenCells(cell, cell)).toThrow(
      'Move direction requires distinct H3 cells.',
    );
    expect(() => initialBearingDegrees([1, 2], [1, 2])).toThrow(
      'Initial bearing is undefined for the same coordinate.',
    );
  });

  it.each([
    ['Toledo', 41.6528, -83.5379, 8],
    ['Toledo', 41.6528, -83.5379, 11],
    ['Sydney', -33.8688, 151.2093, 9],
    ['near the date line', 0.1, 179.999, 10],
  ] as const)(
    'labels neighbors by center bearing independent of traversal position in %s',
    (_name, latitude, longitude, resolution) => {
      const origin = h3CellSchema.parse(
        latLngToCell(latitude, longitude, resolution),
      );
      const neighbors = gridDisk(origin, 1)
        .filter((cell) => cell !== origin)
        .map((cell) => h3CellSchema.parse(cell));

      const labels = new Map(
        neighbors.map((destination) => [
          destination,
          geographicDirectionBetweenCells(origin, destination),
        ]),
      );
      const reversedLabels = new Map(
        neighbors
          .toReversed()
          .map((destination) => [
            destination,
            geographicDirectionBetweenCells(origin, destination),
          ]),
      );

      expect(labels.size).toBe(6);
      expect(new Set(labels.values())).toEqual(
        new Set(['N', 'NE', 'SE', 'S', 'SW', 'NW']),
      );
      expect([...reversedLabels].toSorted()).toEqual([...labels].toSorted());
    },
  );
});
