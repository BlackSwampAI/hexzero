/**
 * Deterministic compiler for semantic strategic options offered to Agent Zero.
 *
 * Each call produces a bounded, worker-relative set of options (≤8 per worker)
 * that Agent Zero selects from by opaque optionId. The authoritative map
 * optionId → (mission, targetCell) stays server-side; the model never sees raw
 * H3 cell IDs or agent IDs.
 */
import { gridDisk, gridDistance } from 'h3-js';
import {
  type AgentId,
  type H3Cell,
  type StrategicOption,
  type SwarmDirective,
} from '@hexzero/shared';
import { type WorldState } from '@hexzero/world-engine';
import {
  geographicDirectionBetweenCells,
  type GeographicDirection,
} from './geographic-direction';
import {
  localPressureFromCells,
  type LocalPressureContext,
} from './swarm-pressure';
import { swarmDirectiveIssue } from './swarm-directives';

/** Territory relation of a candidate target cell from a specific worker's perspective. */
type TerritoryRelation =
  | 'extends-own-territory'
  | 'open-frontier'
  | 'isolated-open'
  | 'own-territory'
  | 'other-swarm-territory'
  | 'abandoned-territory';

type TargetState = 'open' | 'infected' | 'abandoned';

const DIRECTION_ORDER: GeographicDirection[] = [
  'N',
  'NE',
  'SE',
  'S',
  'SW',
  'NW',
];

function safeGridDistance(a: H3Cell, b: H3Cell): number {
  try {
    return gridDistance(a, b);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function directionSectorIndex(dir: GeographicDirection | null): number {
  if (!dir) return 0;
  return DIRECTION_ORDER.indexOf(dir);
}

function tryDirection(from: H3Cell, to: H3Cell): GeographicDirection | null {
  if (from === to) return null;
  try {
    return geographicDirectionBetweenCells(from, to);
  } catch {
    return null;
  }
}

function cellTargetState(state: WorldState, cell: H3Cell): TargetState | null {
  const hex = state.hexes.get(cell);
  if (!hex) return null;
  if (hex.state === 'open') return 'open';
  if (hex.controllerAgentId === null) return 'abandoned';
  return 'infected';
}

function territoryRelation(
  state: WorldState,
  workerAgentId: AgentId,
  target: H3Cell,
): TerritoryRelation | null {
  const hex = state.hexes.get(target);
  if (!hex) return null;
  if (hex.state === 'open') {
    // Check if adjacent to this worker's own infected cells.
    const adjacentCells: H3Cell[] = [];
    try {
      const disk1 = gridDisk(target, 1) as H3Cell[];
      for (const c of disk1) {
        if (c !== target) adjacentCells.push(c);
      }
    } catch {
      // ignore
    }
    const adjacentToOwn = adjacentCells.some((c) => {
      const h = state.hexes.get(c);
      return h?.state === 'infected' && h.controllerAgentId === workerAgentId;
    });
    if (adjacentToOwn) return 'extends-own-territory';
    const adjacentToAny = adjacentCells.some((c) => {
      const h = state.hexes.get(c);
      return h?.state === 'infected';
    });
    if (adjacentToAny) return 'open-frontier';
    return 'isolated-open';
  }
  // infected
  if (hex.controllerAgentId === null) return 'abandoned-territory';
  if (hex.controllerAgentId === workerAgentId) return 'own-territory';
  return 'other-swarm-territory';
}

function minDistanceToPressure(
  cell: H3Cell,
  pressureCells: readonly H3Cell[],
): number {
  if (pressureCells.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...pressureCells.map((pc) => safeGridDistance(cell, pc)));
}

function pressureEffect(
  workerCell: H3Cell,
  targetCell: H3Cell,
  pressureCells: readonly H3Cell[],
): StrategicOption['pressureEffect'] {
  if (pressureCells.length === 0) return 'none';
  const currentMin = minDistanceToPressure(workerCell, pressureCells);
  const targetMin = minDistanceToPressure(targetCell, pressureCells);
  if (targetMin > currentMin) return 'increases-separation';
  if (targetMin === currentMin) return 'preserves-separation';
  return 'reduces-separation';
}

function crowdingAtCell(
  state: WorldState,
  workerAgentId: AgentId,
  targetCell: H3Cell,
  retainedDirectiveByAgent: Map<AgentId, SwarmDirective>,
): number {
  let count = 0;
  const nearby: Set<H3Cell> = new Set();
  try {
    const disk1 = gridDisk(targetCell, 1) as H3Cell[];
    for (const c of disk1) nearby.add(c);
  } catch {
    nearby.add(targetCell);
  }
  for (const [agentId, agent] of state.agents.entries()) {
    if (agentId === workerAgentId) continue;
    if (nearby.has(agent.currentCell)) {
      count += 1;
      continue;
    }
    const dir = retainedDirectiveByAgent.get(agentId);
    if (dir?.targetCell && nearby.has(dir.targetCell)) count += 1;
  }
  return count;
}

function buildHoldOption(
  workerIndex: number,
  workerCell: H3Cell,
  pressureCells: readonly H3Cell[],
  retainedDirective: SwarmDirective | null,
  optionIndex: number,
): StrategicOption {
  const localPressure = localPressureFromCells(workerCell, pressureCells);
  return {
    optionId: `w${workerIndex}_o${optionIndex}`,
    mission: 'hold',
    targetCell: null,
    direction: null,
    distance: 0,
    targetState: null,
    territoryRelation: null,
    pressureAtTarget: localPressure.localPressure,
    pressureEffect: 'none',
    crowding: 0,
    continuesActiveDirective:
      retainedDirective?.mission === 'hold' &&
      retainedDirective.targetCell === null,
    description: 'Hold the current cell.',
  };
}

interface WorkerContext {
  agentId: AgentId;
  workerIndex: number;
  currentCell: H3Cell;
  retainedDirective: SwarmDirective | null;
  pressureContext: LocalPressureContext;
  pressureCells: readonly H3Cell[];
  retainedDirectiveByAgent: Map<AgentId, SwarmDirective>;
}

function expandOptionScore(
  distance: number,
  rel: TerritoryRelation | null,
  pressureAtTarget: 'low' | 'rising' | 'high',
  crowding: number,
  isClaimed: boolean,
): number {
  let score = distance;
  if (rel === 'extends-own-territory') score -= 3;
  if (rel === 'open-frontier') score -= 1;
  if (pressureAtTarget === 'low') score -= 1;
  if (crowding > 0) score += 3;
  if (isClaimed) score += 2;
  return score;
}

/**
 * Compile all expand options for one worker. Returns at most 3, diversified by
 * 60-degree sector, never truncated by lexicographic H3 ordering.
 *
 * Scans within radius 4 of the worker first; widens to world-wide if no open
 * cells are found within that radius.
 */
function compileExpandOptions(
  ctx: WorkerContext,
  state: WorldState,
  claimed: Set<H3Cell>,
  workerOptions: StrategicOption[],
): StrategicOption[] {
  const { workerIndex, currentCell, pressureCells } = ctx;

  // Radius-4 scan first; widen to world-wide only if no open candidates found.
  let scanCells: H3Cell[];
  try {
    const disk4 = gridDisk(currentCell, 4) as H3Cell[];
    const local = disk4.filter((c) => state.hexes.get(c)?.state === 'open');
    scanCells = local.length > 0 ? local : [...state.hexes.keys()];
  } catch {
    scanCells = [...state.hexes.keys()];
  }

  // Gather open candidates and score them.
  interface Candidate {
    cell: H3Cell;
    distance: number;
    direction: GeographicDirection | null;
    rel: TerritoryRelation | null;
    pressureAtTarget: 'low' | 'rising' | 'high';
    crowding: number;
    isClaimed: boolean;
    score: number;
  }
  const candidates: Candidate[] = [];
  for (const cell of scanCells) {
    const hex = state.hexes.get(cell);
    if (!hex || hex.state !== 'open') continue;
    const distance = safeGridDistance(currentCell, cell);
    if (distance === Number.MAX_SAFE_INTEGER) continue;
    const dir = tryDirection(currentCell, cell);
    const rel = territoryRelation(state, ctx.agentId, cell);
    const pt = localPressureFromCells(cell, pressureCells);
    const cr = crowdingAtCell(
      state,
      ctx.agentId,
      cell,
      ctx.retainedDirectiveByAgent,
    );
    const isClaimed =
      claimed.has(cell) ||
      [...claimed].some((c) => safeGridDistance(c, cell) <= 1);
    const score = expandOptionScore(
      distance,
      rel,
      pt.localPressure,
      cr,
      isClaimed,
    );
    candidates.push({
      cell,
      distance,
      direction: dir,
      rel,
      pressureAtTarget: pt.localPressure,
      crowding: cr,
      isClaimed,
      score,
    });
  }

  // Sort by score, then distance, then direction sector, then cell string.
  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      a.distance - b.distance ||
      directionSectorIndex(a.direction) - directionSectorIndex(b.direction) ||
      a.cell.localeCompare(b.cell),
  );

  // Diversify: at most one expand option per 60-degree sector (direction).
  const usedSectors = new Set<GeographicDirection | null>();
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= 3) break;
    const sectorKey = c.direction;
    if (usedSectors.has(sectorKey) && sectorKey !== null) continue;
    usedSectors.add(sectorKey);
    picked.push(c);
  }

  const startIndex = workerOptions.length;
  return picked.map((c, i): StrategicOption => {
    const continuesActive =
      ctx.retainedDirective?.mission === 'expand' &&
      ctx.retainedDirective.targetCell === c.cell;
    let desc = `Expand ${c.direction ?? 'nearby'} to an open cell`;
    if (c.rel === 'extends-own-territory') desc += ' adjacent to own territory';
    else if (c.rel === 'open-frontier') desc += ' on the open frontier';
    if (c.crowding > 0) desc += ` (${c.crowding} other worker(s) nearby)`;
    desc = desc.slice(0, 160);
    return {
      optionId: `w${workerIndex}_o${startIndex + i}`,
      mission: 'expand',
      targetCell: c.cell,
      direction: c.direction,
      distance: c.distance,
      targetState: 'open',
      territoryRelation: c.rel,
      pressureAtTarget: c.pressureAtTarget,
      pressureEffect: pressureEffect(currentCell, c.cell, pressureCells),
      crowding: c.crowding,
      continuesActiveDirective: continuesActive,
      description: desc,
    };
  });
}

/** Compile evade options (at most 2) when worker is under pressure. */
function compileEvadeOptions(
  ctx: WorkerContext,
  state: WorldState,
  workerOptions: StrategicOption[],
): StrategicOption[] {
  const { workerIndex, currentCell, pressureContext, pressureCells } = ctx;

  // Only emit evade options when worker faces non-low pressure or nearby pressure cell.
  const nearestPressureDist = minDistanceToPressure(currentCell, pressureCells);
  if (pressureContext.localPressure === 'low' && nearestPressureDist > 3)
    return [];

  const currentMinDist = minDistanceToPressure(currentCell, pressureCells);

  interface Candidate {
    cell: H3Cell;
    distance: number;
    direction: GeographicDirection | null;
    pressureAtTarget: 'low' | 'rising' | 'high';
    targetMinDist: number;
    effect: StrategicOption['pressureEffect'];
  }
  const candidates: Candidate[] = [];
  for (const cell of state.hexes.keys()) {
    if (cell === currentCell) continue;
    const distance = safeGridDistance(currentCell, cell);
    if (distance < 2 || distance > 3) continue;
    const targetMinDist = minDistanceToPressure(cell, pressureCells);
    // Never emit evade that reduces separation.
    if (targetMinDist < currentMinDist) continue;
    const pt = localPressureFromCells(cell, pressureCells);
    const dir = tryDirection(currentCell, cell);
    const effect: StrategicOption['pressureEffect'] =
      targetMinDist > currentMinDist
        ? 'increases-separation'
        : 'preserves-separation';
    candidates.push({
      cell,
      distance,
      direction: dir,
      pressureAtTarget: pt.localPressure,
      targetMinDist,
      effect,
    });
  }

  // Sort: prefer increases-separation, then low pressure at target, then distance, direction, cell.
  candidates.sort(
    (a, b) =>
      (a.effect === 'increases-separation' ? 0 : 1) -
        (b.effect === 'increases-separation' ? 0 : 1) ||
      (a.pressureAtTarget === 'low' ? 0 : 1) -
        (b.pressureAtTarget === 'low' ? 0 : 1) ||
      a.distance - b.distance ||
      directionSectorIndex(a.direction) - directionSectorIndex(b.direction) ||
      a.cell.localeCompare(b.cell),
  );

  // At most 2, distinct directions.
  const usedDirections = new Set<GeographicDirection | null>();
  const picked: Candidate[] = [];
  for (const c of candidates) {
    if (picked.length >= 2) break;
    if (usedDirections.has(c.direction) && c.direction !== null) continue;
    usedDirections.add(c.direction);
    picked.push(c);
  }

  const startIndex = workerOptions.length;
  return picked.map((c, i): StrategicOption => {
    const continuesActive =
      ctx.retainedDirective?.mission === 'evade' &&
      ctx.retainedDirective.targetCell === c.cell;
    return {
      optionId: `w${workerIndex}_o${startIndex + i}`,
      mission: 'evade',
      targetCell: c.cell,
      direction: c.direction,
      distance: c.distance,
      targetState: cellTargetState(state, c.cell) ?? 'open',
      territoryRelation: territoryRelation(state, ctx.agentId, c.cell),
      pressureAtTarget: c.pressureAtTarget,
      pressureEffect: c.effect,
      crowding: crowdingAtCell(
        state,
        ctx.agentId,
        c.cell,
        ctx.retainedDirectiveByAgent,
      ),
      continuesActiveDirective: continuesActive,
      description:
        `Evade ${c.direction ?? 'nearby'} to increase distance from pressure (effect: ${c.effect}).`.slice(
          0,
          160,
        ),
    };
  });
}

/** Compile relocate options (at most 2) when crowded or no open cells nearby. */
function compileRelocateOptions(
  ctx: WorkerContext,
  state: WorldState,
  expandOptions: StrategicOption[],
  workerOptions: StrategicOption[],
): StrategicOption[] {
  const { workerIndex, currentCell, pressureCells } = ctx;

  // Emit relocate when no open cell within radius 2, or crowding at position >= 1.
  const openWithin2 = [...state.hexes.entries()].some(
    ([cell, hex]) =>
      hex.state === 'open' &&
      cell !== currentCell &&
      safeGridDistance(currentCell, cell) <= 2,
  );
  const positionCrowding = crowdingAtCell(
    state,
    ctx.agentId,
    currentCell,
    ctx.retainedDirectiveByAgent,
  );
  if (openWithin2 && positionCrowding < 1) return [];

  // Find the expand option directions already used (don't duplicate).
  const usedDirections = new Set<GeographicDirection | null>(
    expandOptions.map((o) => o.direction),
  );

  interface Candidate {
    cell: H3Cell;
    distance: number;
    direction: GeographicDirection | null;
    pressureAtTarget: 'low' | 'rising' | 'high';
    openNearby: number;
  }
  const candidates: Candidate[] = [];
  for (const [cell, hex] of state.hexes.entries()) {
    if (cell === currentCell) continue;
    if (hex.state !== 'open') continue;
    const distance = safeGridDistance(currentCell, cell);
    if (distance < 3 || distance > 8) continue;
    const dir = tryDirection(currentCell, cell);
    if (usedDirections.has(dir) && dir !== null) continue;
    const pt = localPressureFromCells(cell, pressureCells);
    // Count open cells within radius 1 of this candidate (richness).
    let openNearby = 0;
    try {
      for (const n of gridDisk(cell, 1) as H3Cell[]) {
        if (n !== cell && state.hexes.get(n)?.state === 'open') openNearby++;
      }
    } catch {
      // ignore
    }
    candidates.push({
      cell,
      distance,
      direction: dir,
      pressureAtTarget: pt.localPressure,
      openNearby,
    });
  }

  // Sort: prefer low pressure, more open nearby cells, shorter distance.
  candidates.sort(
    (a, b) =>
      (a.pressureAtTarget === 'low' ? 0 : 1) -
        (b.pressureAtTarget === 'low' ? 0 : 1) ||
      b.openNearby - a.openNearby ||
      a.distance - b.distance ||
      directionSectorIndex(a.direction) - directionSectorIndex(b.direction) ||
      a.cell.localeCompare(b.cell),
  );

  const picked = candidates.slice(0, 2);
  const startIndex = workerOptions.length;
  return picked.map((c, i): StrategicOption => {
    const continuesActive =
      ctx.retainedDirective?.mission === 'relocate' &&
      ctx.retainedDirective.targetCell === c.cell;
    return {
      optionId: `w${workerIndex}_o${startIndex + i}`,
      mission: 'relocate',
      targetCell: c.cell,
      direction: c.direction,
      distance: c.distance,
      targetState: 'open',
      territoryRelation: territoryRelation(state, ctx.agentId, c.cell),
      pressureAtTarget: c.pressureAtTarget,
      pressureEffect: pressureEffect(currentCell, c.cell, pressureCells),
      crowding: crowdingAtCell(
        state,
        ctx.agentId,
        c.cell,
        ctx.retainedDirectiveByAgent,
      ),
      continuesActiveDirective: continuesActive,
      description:
        `Relocate ${c.direction ?? 'far'} to an open-rich anchor cell (${c.openNearby} open neighbours).`.slice(
          0,
          160,
        ),
    };
  });
}

/** Compile reinforce option (at most 1). */
function compileReinforceOption(
  ctx: WorkerContext,
  state: WorldState,
  workerOptions: StrategicOption[],
): StrategicOption[] {
  const { workerIndex, currentCell, pressureCells, pressureContext } = ctx;

  // Prefer abandoned infected cells (captured territory) first.
  const abandonedCells: H3Cell[] = [];
  for (const [cell, hex] of state.hexes.entries()) {
    if (cell === currentCell) continue;
    if (hex.state === 'infected' && hex.controllerAgentId === null)
      abandonedCells.push(cell);
  }

  let target: H3Cell | null = null;
  if (abandonedCells.length > 0) {
    // Pick nearest abandoned cell, tie-break by direction then cell string.
    abandonedCells.sort(
      (a, b) =>
        safeGridDistance(currentCell, a) - safeGridDistance(currentCell, b) ||
        directionSectorIndex(tryDirection(currentCell, a)) -
          directionSectorIndex(tryDirection(currentCell, b)) ||
        a.localeCompare(b),
    );
    target = abandonedCells[0]!;
  } else if (
    pressureContext.localPressure === 'rising' ||
    pressureContext.localPressure === 'high'
  ) {
    // Under rising/high pressure, find a swarm-infected border cell nearest pressure.
    const borderCells: { cell: H3Cell; pressureDist: number }[] = [];
    for (const [cell, hex] of state.hexes.entries()) {
      if (cell === currentCell) continue;
      if (hex.state !== 'infected' || hex.controllerAgentId === null) continue;
      const pressureDist = minDistanceToPressure(cell, pressureCells);
      borderCells.push({ cell, pressureDist });
    }
    borderCells.sort(
      (a, b) =>
        a.pressureDist - b.pressureDist ||
        safeGridDistance(currentCell, a.cell) -
          safeGridDistance(currentCell, b.cell) ||
        a.cell.localeCompare(b.cell),
    );
    target = borderCells[0]?.cell ?? null;
  }

  if (!target) return [];

  // Validate: reinforce target must be infected or adjacent to infection.
  const dummy: SwarmDirective = {
    id: 'validate-only',
    agentId: ctx.agentId,
    mission: 'reinforce',
    targetCell: target,
    priority: 'normal',
    riskTolerance: 'medium',
    issuedAtTick: 0,
    expiresAtTick: 1,
  };
  if (swarmDirectiveIssue(state, dummy) !== null) return [];

  const distance = safeGridDistance(currentCell, target);
  const dir = tryDirection(currentCell, target);
  const ts = cellTargetState(state, target);
  const rel = territoryRelation(state, ctx.agentId, target);
  const pt = localPressureFromCells(target, pressureCells);
  const continuesActive =
    ctx.retainedDirective?.mission === 'reinforce' &&
    ctx.retainedDirective.targetCell === target;
  return [
    {
      optionId: `w${workerIndex}_o${workerOptions.length}`,
      mission: 'reinforce',
      targetCell: target,
      direction: dir,
      distance,
      targetState: ts,
      territoryRelation: rel,
      pressureAtTarget: pt.localPressure,
      pressureEffect: pressureEffect(currentCell, target, pressureCells),
      crowding: crowdingAtCell(
        state,
        ctx.agentId,
        target,
        ctx.retainedDirectiveByAgent,
      ),
      continuesActiveDirective: continuesActive,
      description:
        `Reinforce ${dir ?? 'nearby'} to ${ts === 'abandoned' ? 'reclaim abandoned territory' : 'reinforce infected border'}.`.slice(
          0,
          160,
        ),
    },
  ];
}

/** Emit a "continue active directive" option when the retained directive is still valid. */
function compileContinueDirectiveOption(
  ctx: WorkerContext,
  state: WorldState,
  compiledOptions: StrategicOption[],
): StrategicOption | null {
  const { workerIndex, currentCell, pressureCells, retainedDirective } = ctx;
  if (!retainedDirective) return null;
  // Already included via hold/expand/etc. if the option was compiled.
  if (
    compiledOptions.some(
      (o) =>
        o.continuesActiveDirective &&
        o.mission === retainedDirective.mission &&
        o.targetCell === retainedDirective.targetCell,
    )
  )
    return null;
  // Must not be expired.
  // NOTE: tickNumber-based expiry is checked by the caller, not here.
  // Must still pass semantic validation.
  if (swarmDirectiveIssue(state, retainedDirective) !== null) return null;
  const target = retainedDirective.targetCell;
  if (target !== null) {
    if (!state.hexes.has(target)) return null;
  }
  const distance = target ? safeGridDistance(currentCell, target) : 0;
  const dir = target ? tryDirection(currentCell, target) : null;
  const ts = target ? cellTargetState(state, target) : null;
  const rel = target ? territoryRelation(state, ctx.agentId, target) : null;
  const pt = target
    ? localPressureFromCells(target, pressureCells)
    : localPressureFromCells(currentCell, pressureCells);
  const crowd = target
    ? crowdingAtCell(state, ctx.agentId, target, ctx.retainedDirectiveByAgent)
    : 0;
  return {
    optionId: `w${workerIndex}_o${compiledOptions.length}`,
    mission: retainedDirective.mission,
    targetCell: target,
    direction: dir,
    distance,
    targetState: ts,
    territoryRelation: rel,
    pressureAtTarget: pt.localPressure,
    pressureEffect: target
      ? pressureEffect(currentCell, target, pressureCells)
      : 'none',
    crowding: crowd,
    continuesActiveDirective: true,
    description:
      `Continue active ${retainedDirective.mission} directive${dir ? ` toward ${dir}` : ''}.`.slice(
        0,
        160,
      ),
  };
}

export interface CompileStrategicOptionsInput {
  state: WorldState;
  zeroAgentId: AgentId;
  tickNumber: number;
  /**
   * Cell coordinates of bounded disinfection events from `boundedPressureEvents()`.
   * Used for pressure distance calculations.
   */
  pressureEventCells: readonly H3Cell[];
  lastPlanDirectives: readonly SwarmDirective[] | null;
}

/**
 * Compiles semantic strategic options for each non-Zero worker. Workers are
 * processed in stable sorted-agentId order for deterministic greedy
 * deconfliction. Returns a Map keyed by agentId in that stable order.
 */
export function compileStrategicOptions(
  input: CompileStrategicOptionsInput,
): Map<AgentId, StrategicOption[]> {
  const {
    state,
    zeroAgentId,
    tickNumber,
    pressureEventCells,
    lastPlanDirectives,
  } = input;

  // Sorted worker list (stable, deterministic).
  const workers = [...state.agents.values()]
    .filter((a) => a.id !== zeroAgentId)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Build retained-directive lookup (by agentId, not-expired).
  const retainedDirectiveByAgent = new Map<AgentId, SwarmDirective>();
  if (lastPlanDirectives) {
    for (const d of lastPlanDirectives) {
      if (d.expiresAtTick >= tickNumber)
        retainedDirectiveByAgent.set(d.agentId, d);
    }
  }

  // Claimed set for greedy deconfliction of expand top targets.
  const claimed = new Set<H3Cell>();

  const result = new Map<AgentId, StrategicOption[]>();

  for (const [workerIndex, worker] of workers.entries()) {
    const { id: agentId, currentCell } = worker;
    const retainedDirective = retainedDirectiveByAgent.get(agentId) ?? null;
    const pressureContext = localPressureFromCells(
      currentCell,
      pressureEventCells,
    );

    const ctx: WorkerContext = {
      agentId,
      workerIndex,
      currentCell,
      retainedDirective,
      pressureContext,
      pressureCells: pressureEventCells,
      retainedDirectiveByAgent,
    };

    const options: StrategicOption[] = [];

    // 1. Hold (always first, always present, targetCell = null).
    const holdOption = buildHoldOption(
      workerIndex,
      currentCell,
      pressureEventCells,
      retainedDirective,
      options.length,
    );
    options.push(holdOption);

    // 2. Continue active directive (if valid and not yet covered).
    if (
      retainedDirective &&
      retainedDirective.expiresAtTick >= tickNumber &&
      retainedDirective.mission !== 'hold'
    ) {
      const contOpt = compileContinueDirectiveOption(ctx, state, options);
      if (contOpt) options.push(contOpt);
    }

    // 3. Expand options (≤3, diversified by sector).
    const expandOpts = compileExpandOptions(ctx, state, claimed, options);
    options.push(...expandOpts);

    // Register the top expand target (if any) in the claimed set.
    const topExpand = expandOpts.find((o) => o.mission === 'expand');
    if (topExpand?.targetCell) claimed.add(topExpand.targetCell);

    // 4. Evade options (≤2, only under pressure).
    const evadeOpts = compileEvadeOptions(ctx, state, options);
    options.push(...evadeOpts);

    // 5. Relocate options (≤2, when needed).
    const relocateOpts = compileRelocateOptions(
      ctx,
      state,
      expandOpts,
      options,
    );
    options.push(...relocateOpts);

    // 6. Reinforce option (≤1).
    const reinforceOpts = compileReinforceOption(ctx, state, options);
    options.push(...reinforceOpts);

    // Priority-aware bounding: never exceed 8.
    // Hold (index 0) and continue-active options are always kept.
    // Under pressure: evade > reinforce > expand > relocate.
    // Without pressure: expand > reinforce > relocate.
    // Cap relocate at 1.
    const underPressure = pressureContext.localPressure !== 'low';
    const alwaysKeep = options.filter(
      (o) => o.mission === 'hold' || o.continuesActiveDirective,
    );
    const remaining = options.filter((o) => !alwaysKeep.includes(o));
    const missionOrder = underPressure
      ? (['evade', 'reinforce', 'expand', 'relocate'] as const)
      : (['expand', 'reinforce', 'relocate'] as const);
    const bounded: StrategicOption[] = [...alwaysKeep];
    let relocateCount = 0;
    for (const mission of missionOrder) {
      if (bounded.length >= 8) break;
      for (const opt of remaining.filter((o) => o.mission === mission)) {
        if (bounded.length >= 8) break;
        if (opt.mission === 'relocate') {
          if (relocateCount >= 1) continue;
          relocateCount++;
        }
        bounded.push(opt);
      }
    }

    // Final validation: run every non-hold option through swarmDirectiveIssue so
    // that an offered option can never cause #assertSwarmPlan to reject the plan.
    const validated = bounded.filter((o) => {
      if (o.mission === 'hold') return true;
      const dummy: SwarmDirective = {
        id: 'validate-only',
        agentId,
        mission: o.mission,
        targetCell: o.targetCell,
        priority: 'normal',
        riskTolerance: 'medium',
        issuedAtTick: tickNumber,
        expiresAtTick: tickNumber + 10,
      };
      return swarmDirectiveIssue(state, dummy) === null;
    });

    result.set(agentId, validated);
  }

  return result;
}
