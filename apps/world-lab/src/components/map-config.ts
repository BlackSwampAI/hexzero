import type { StyleSpecification } from 'maplibre-gl';

type RasterSourceSpecification = Extract<
  StyleSpecification['sources'][string],
  { type: 'raster' }
>;
type RasterLayerSpecification = Extract<
  StyleSpecification['layers'][number],
  { type: 'raster' }
>;

export const OSM_RASTER_SOURCE = {
  type: 'raster',
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
} satisfies RasterSourceSpecification;

export const DARK_RASTER_PAINT = {
  'raster-saturation': -1,
  'raster-brightness-min': 0.9,
  'raster-brightness-max': 0.08,
} satisfies NonNullable<RasterLayerSpecification['paint']>;
