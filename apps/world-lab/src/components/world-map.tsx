'use client';

import { useEffect, useRef, useState } from 'react';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import {
  AttributionControl,
  LngLatBounds,
  type GeoJSONSource,
  Map,
  type MapLayerMouseEvent,
  type MapSourceDataEvent,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type {
  AgentId,
  AgentProfile,
  H3Cell,
  Hex,
  HexState,
  Alliance,
  SimulationSnapshot,
  SimulatedPlayerState,
} from '@hexzero/shared';
import { resolveAgentColor } from './ui-color';
import { DARK_TILE_ATTRIBUTION, DARK_TILE_URLS } from './map-config';

interface WorldMapProps {
  latitude: number;
  longitude: number;
  hexes: Hex[];
  agents: AgentProfile[];
  alliances: Alliance[];
  patientZeroAgentId: AgentId | null;
  simulatedPlayer: SimulatedPlayerState | null;
  selectedCell: H3Cell | null;
  selectedAgentId: AgentId | null;
  onSelectCell: (cell: H3Cell) => void;
  onClearCellSelection: () => void;
  onSelectAgent: (agentId: AgentId) => void;
}

const sourceId = 'development-hexes';
const fillLayerId = 'development-hex-fills';
const lineLayerId = 'development-hex-lines';

setWorkerUrl('/maplibre-worker/maplibre-gl-worker.mjs');

type OverlayStatus = 'initializing' | 'ready' | 'incomplete' | 'failed';

interface OverlayDiagnostics {
  status: OverlayStatus;
  renderedCellCount: number;
  renderedInfectedCellCount: number;
  detail: string;
}

const initialOverlayDiagnostics: OverlayDiagnostics = {
  status: 'initializing',
  renderedCellCount: 0,
  renderedInfectedCellCount: 0,
  detail: 'Waiting for the H3 source and layers to render.',
};

function asGeoJson(
  hexes: WorldMapProps['hexes'],
  agents: AgentProfile[],
  alliances: Alliance[],
  selectedCell: H3Cell | null,
) {
  const agentById = new globalThis.Map(
    agents.map((agent) => [agent.id, agent]),
  );
  const colorState = { world: { agents, alliances } } as unknown as Pick<
    SimulationSnapshot,
    'world'
  >;
  const effectiveColor = (agentId: AgentId) =>
    resolveAgentColor(colorState, agentId);
  return {
    type: 'FeatureCollection' as const,
    features: hexes.map((hex) => ({
      type: 'Feature' as const,
      properties: {
        cell: hex.cell,
        state: hex.state,
        controllerColor:
          hex.state === 'infected'
            ? (effectiveColor(hex.controllerAgentId) ?? '#e44f45')
            : '#4a8178',
        controllerName:
          hex.state === 'infected'
            ? (agentById.get(hex.controllerAgentId)?.name ?? 'Unknown agent')
            : 'Uncontrolled',
        selected: hex.cell === selectedCell,
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [closedBoundary(hex.cell)],
      },
    })),
  };
}

function closedBoundary(cell: H3Cell): number[][] {
  const coordinates = cellToBoundary(cell).map(([lat, lng]) => [lng, lat]);
  const first = coordinates[0];
  return first ? [...coordinates, first] : coordinates;
}

export function WorldMap(props: WorldMapProps) {
  const {
    latitude,
    longitude,
    hexes,
    agents,
    alliances,
    patientZeroAgentId,
    simulatedPlayer,
    selectedCell,
    selectedAgentId,
    onSelectCell,
    onClearCellSelection,
    onSelectAgent,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const onSelectCellRef = useRef(onSelectCell);
  const onClearCellSelectionRef = useRef(onClearCellSelection);
  const onSelectAgentRef = useRef(onSelectAgent);
  const initialHexes = useRef(hexes);
  const initialAgents = useRef(agents);
  const initialAlliances = useRef(alliances);
  const initialSelectedCell = useRef(selectedCell);
  const currentHexesRef = useRef(hexes);
  const fittedWorldRef = useRef(hexes.map(({ cell }) => cell).join(','));
  const scheduleOverlayInspectionRef = useRef<(() => void) | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [overlayDiagnostics, setOverlayDiagnostics] = useState(
    initialOverlayDiagnostics,
  );

  useEffect(() => {
    currentHexesRef.current = hexes;
  }, [hexes]);

  useEffect(() => {
    onSelectCellRef.current = onSelectCell;
    onClearCellSelectionRef.current = onClearCellSelection;
    onSelectAgentRef.current = onSelectAgent;
  }, [onClearCellSelection, onSelectAgent, onSelectCell]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new Map({
      container: containerRef.current,
      center: [longitude, latitude],
      zoom: 13,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [...DARK_TILE_URLS],
            tileSize: 256,
            attribution: DARK_TILE_ATTRIBUTION,
          },
        },
        layers: [{ id: 'carto-dark', type: 'raster', source: 'carto-dark' }],
      },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }));
    const inspectOverlay = () => {
      if (
        !map.getSource(sourceId) ||
        !map.getLayer(fillLayerId) ||
        !map.getLayer(lineLayerId)
      ) {
        setOverlayDiagnostics({
          status: 'failed',
          renderedCellCount: 0,
          renderedInfectedCellCount: 0,
          detail: 'MapLibre rejected the H3 source or one of its layers.',
        });
        return;
      }

      if (!map.isSourceLoaded(sourceId)) {
        return;
      }

      try {
        const expectedCells = new Set(
          currentHexesRef.current.map(({ cell }) => cell),
        );
        const renderedCells = new globalThis.Map<H3Cell, HexState>();
        for (const feature of map.queryRenderedFeatures({
          layers: [fillLayerId],
        })) {
          const cell = feature.properties?.cell;
          const state = feature.properties?.state;
          if (
            typeof cell === 'string' &&
            (state === 'open' || state === 'infected')
          ) {
            renderedCells.set(cell as H3Cell, state);
          }
        }
        const renderedCellCount = renderedCells.size;
        const renderedInfectedCellCount = [...renderedCells.values()].filter(
          (state) => state === 'infected',
        ).length;
        const ready =
          expectedCells.size === currentHexesRef.current.length &&
          renderedCellCount === currentHexesRef.current.length &&
          [...expectedCells].every((cell) => renderedCells.has(cell));
        setOverlayDiagnostics({
          status: ready ? 'ready' : 'incomplete',
          renderedCellCount,
          renderedInfectedCellCount,
          detail: ready
            ? 'All expected H3 cells were returned by MapLibre.'
            : `MapLibre rendered ${renderedCellCount} of ${currentHexesRef.current.length} expected H3 cells.`,
        });
      } catch {
        setOverlayDiagnostics({
          status: 'failed',
          renderedCellCount: 0,
          renderedInfectedCellCount: 0,
          detail: 'MapLibre could not inspect the rendered H3 layer.',
        });
      }
    };
    let inspectionPending = false;
    const inspectAfterRender = () => {
      if (!inspectionPending) return;
      if (
        !map.getSource(sourceId) ||
        !map.getLayer(fillLayerId) ||
        !map.getLayer(lineLayerId)
      ) {
        inspectionPending = false;
        inspectOverlay();
        return;
      }
      if (!map.isSourceLoaded(sourceId)) return;
      inspectionPending = false;
      inspectOverlay();
    };
    const scheduleOverlayInspection = () => {
      inspectionPending = true;
      map.triggerRepaint();
    };
    const inspectLoadedH3Source = (event: MapSourceDataEvent) => {
      if (event.sourceId === sourceId && inspectionPending) {
        map.triggerRepaint();
      }
    };
    let cellSelectedThisClick = false;
    const selectRenderedCell = (event: MapLayerMouseEvent) => {
      const cell = event.features?.[0]?.properties?.cell;
      if (typeof cell === 'string') {
        cellSelectedThisClick = true;
        onSelectCellRef.current(cell as H3Cell);
      }
    };
    const clearSelectedCell = () => {
      if (!cellSelectedThisClick) onClearCellSelectionRef.current();
      cellSelectedThisClick = false;
    };
    const showCellCursor = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const clearCellCursor = () => {
      map.getCanvas().style.cursor = '';
    };
    const initializeOverlay = () => {
      try {
        map.addSource(sourceId, {
          type: 'geojson',
          data: asGeoJson(
            initialHexes.current,
            initialAgents.current,
            initialAlliances.current,
            initialSelectedCell.current,
          ),
        });
        map.addLayer({
          id: fillLayerId,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': ['get', 'controllerColor'],
            'fill-opacity': [
              'case',
              ['boolean', ['get', 'selected'], false],
              0.78,
              0.48,
            ],
          },
        });
        map.addLayer({
          id: lineLayerId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': [
              'case',
              ['boolean', ['get', 'selected'], false],
              '#ede5a6',
              '#b2d3a8',
            ],
            'line-opacity': 0.95,
            'line-width': [
              'case',
              ['boolean', ['get', 'selected'], false],
              4,
              1.25,
            ],
          },
        });
        map.on('click', fillLayerId, selectRenderedCell);
        map.on('click', clearSelectedCell);
        map.on('mouseenter', fillLayerId, showCellCursor);
        map.on('mouseleave', fillLayerId, clearCellCursor);

        const bounds = new LngLatBounds();
        for (const { cell } of initialHexes.current) {
          for (const [lat, lng] of cellToBoundary(cell)) {
            bounds.extend([lng, lat]);
          }
        }
        map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
        scheduleOverlayInspectionRef.current = scheduleOverlayInspection;
        scheduleOverlayInspection();
      } catch {
        setOverlayDiagnostics({
          status: 'failed',
          renderedCellCount: 0,
          renderedInfectedCellCount: 0,
          detail: 'MapLibre rejected the H3 source or layer configuration.',
        });
      } finally {
        setMapReady(true);
      }
    };

    map.on('sourcedata', inspectLoadedH3Source);
    map.on('render', inspectAfterRender);
    map.on('style.load', initializeOverlay);

    return () => {
      scheduleOverlayInspectionRef.current = null;
      map.off('style.load', initializeOverlay);
      map.off('sourcedata', inspectLoadedH3Source);
      map.off('render', inspectAfterRender);
      map.off('click', fillLayerId, selectRenderedCell);
      map.off('click', clearSelectedCell);
      map.off('mouseenter', fillLayerId, showCellCursor);
      map.off('mouseleave', fillLayerId, clearCellCursor);
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude]);

  useEffect(() => {
    const source = mapRef.current?.getSource(sourceId) as
      GeoJSONSource | undefined;
    if (!source) return;
    source.setData(asGeoJson(hexes, agents, alliances, selectedCell));
    const signature = hexes.map(({ cell }) => cell).join(',');
    if (signature !== fittedWorldRef.current && mapRef.current) {
      fittedWorldRef.current = signature;
      const bounds = new LngLatBounds();
      for (const { cell } of hexes)
        for (const [lat, lng] of cellToBoundary(cell))
          bounds.extend([lng, lat]);
      mapRef.current.fitBounds(bounds, {
        padding: 56,
        maxZoom: 14,
        duration: 0,
      });
    }
    scheduleOverlayInspectionRef.current?.();
  }, [agents, alliances, hexes, selectedCell]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    const grouped = new globalThis.Map<H3Cell, AgentProfile[]>();
    for (const agent of agents) {
      grouped.set(agent.currentCell, [
        ...(grouped.get(agent.currentCell) ?? []),
        agent,
      ]);
    }
    for (const agent of agents) {
      const cellmates = grouped
        .get(agent.currentCell)!
        .toSorted((a, b) => a.id.localeCompare(b.id));
      const position = cellmates.findIndex(({ id }) => id === agent.id);
      const angle = (position / Math.max(cellmates.length, 1)) * Math.PI * 2;
      const distance = cellmates.length > 1 ? 15 : 0;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `agent-marker${agent.id === selectedAgentId ? ' selected' : ''}${agent.id === patientZeroAgentId ? ' patient-zero' : ''}`;
      element.dataset.agentId = agent.id;
      element.setAttribute(
        'aria-label',
        `Select agent ${agent.name}${agent.id === patientZeroAgentId ? ', Patient Zero' : ''}`,
      );
      element.title = `${agent.name}${agent.id === patientZeroAgentId ? ' · Patient Zero' : ''} · ${agent.currentCell}`;
      const effectiveColor = resolveAgentColor(
        { world: { agents, alliances } } as unknown as Pick<
          SimulationSnapshot,
          'world'
        >,
        agent.id,
      );
      element.style.setProperty('--agent-color', effectiveColor);
      element.dataset.baseColor = agent.color;
      element.dataset.effectiveColor = effectiveColor;
      element.textContent = agent.name.slice(0, 1);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectAgentRef.current(agent.id);
      });
      const [lat, lng] = cellToLatLng(agent.currentCell);
      const marker = new Marker({
        element,
        offset: [Math.cos(angle) * distance, Math.sin(angle) * distance],
      })
        .setLngLat([lng, lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
    if (simulatedPlayer) {
      const element = document.createElement('div');
      element.className = 'simulated-player-marker';
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', 'Casual cleaner simulated player');
      element.title = `Casual cleaner · ${simulatedPlayer.currentCell}`;
      element.textContent = 'P';
      const [lat, lng] = cellToLatLng(simulatedPlayer.currentCell);
      markersRef.current.push(
        new Marker({ element, offset: [0, 20] })
          .setLngLat([lng, lat])
          .addTo(map),
      );
    }
  }, [
    agents,
    alliances,
    mapReady,
    patientZeroAgentId,
    selectedAgentId,
    simulatedPlayer,
  ]);

  const overlayReady = overlayDiagnostics.status === 'ready';
  const overlayLabel = overlayReady
    ? 'ready'
    : overlayDiagnostics.status === 'initializing'
      ? 'initializing'
      : overlayDiagnostics.status;

  return (
    <div className="map-stage">
      <div
        className="world-map"
        data-overlay-status={overlayDiagnostics.status}
        data-rendered-h3-cell-count={overlayDiagnostics.renderedCellCount}
        data-rendered-infected-cell-count={
          overlayDiagnostics.renderedInfectedCellCount
        }
        data-controller-colors={hexes
          .flatMap((hex) => {
            if (hex.state === 'open') return [];
            const effectiveColor = resolveAgentColor(
              { world: { agents, alliances } } as unknown as Pick<
                SimulationSnapshot,
                'world'
              >,
              hex.controllerAgentId,
            );
            return [`${hex.cell}:${effectiveColor ?? 'unknown'}`];
          })
          .join(',')}
        data-testid="world-map"
        ref={containerRef}
      />
      <p className="map-ready" role="status" title={overlayDiagnostics.detail}>
        H3 overlay {overlayLabel} · {overlayDiagnostics.renderedCellCount}/
        {hexes.length} rendered cells · {agents.length} agents ·{' '}
        <span data-testid="infected-count">
          {overlayDiagnostics.renderedInfectedCellCount} rendered infected
        </span>
        {simulatedPlayer && (
          <span data-testid="simulated-player-activity">
            {' '}
            · Cleaner {simulatedPlayer.metrics.movements} moved ·{' '}
            {simulatedPlayer.metrics.cellsDisinfected} cleaned ·{' '}
            {simulatedPlayer.metrics.blockedDisinfections} blocked
          </span>
        )}
      </p>
    </div>
  );
}
