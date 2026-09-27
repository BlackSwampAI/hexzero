import { describe, expect, it } from 'vitest';
import { DARK_RASTER_PAINT, OSM_RASTER_SOURCE } from './map-config';

describe('dark OpenStreetMap basemap configuration', () => {
  it('uses standard OSM tiles with attribution and the documented zoom ceiling', () => {
    expect(OSM_RASTER_SOURCE).toMatchObject({
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    });
  });

  it('renders OSM tiles as desaturated dark tiles', () => {
    expect(DARK_RASTER_PAINT['raster-saturation']).toBe(-1);
    expect(DARK_RASTER_PAINT['raster-brightness-min']).toBeGreaterThan(0);
    expect(DARK_RASTER_PAINT['raster-brightness-max']).toBeLessThan(1);
    expect(DARK_RASTER_PAINT['raster-brightness-max']).toBeLessThan(
      DARK_RASTER_PAINT['raster-brightness-min'],
    );
  });
});
