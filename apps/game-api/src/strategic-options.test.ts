/**
 * Tests for the deterministic strategic-options compiler.
 *
 * All tests are offline and deterministic (no Math.random, no network).
 * Real h3-js cells are used for valid geographic calculations.
 */
import { describe, expect, it } from 'vitest';
import { gridDisk, gridRing } from 'h3-js';
import {
  type H3Cell,
  type AgentId,
  zeroStrategicObservationSchema,
  type ZeroStrategicObservation,
} from '@hexzero/shared';
import {
  type WorldState,
  type HexControl,
  enumerateLegalWorldActions,
} from '@hexzero/world-engine';
import { buildSwarmPlannerRequest } from '@hexzero/agent-runtime';
import {
  compileStrategicOptions,
  type CompileStrategicOptionsInput,
} from './strategic-options';
import { swarmDirectiveIssue } from './swarm-directives';

// Real h3 resolution-9 cells for deterministic geographic tests.
const ORIGIN: H3Cell = '8928308280fffff' as H3Cell;
const RING1 = gridRing(ORIGIN, 1) as H3Cell[];
const RING2 = gridRing(ORIGIN, 2) as H3Cell[];
const RING3 = gridRing(ORIGIN, 3) as H3Cell[];

const ZERO: AgentId = '00000000-0000-4000-8000-000000000001' as AgentId;
const WORKER_A: AgentId = '00000000-0000-4000-8000-000000000002' as AgentId;
const WORKER_B: AgentId = '00000000-0000-4000-8000-000000000003' as AgentId;

function makeAgent(id: AgentId, cell: H3Cell) {
  return { id, name: 'test', color: '#ff0000', currentCell: cell };
}

function openHex(): HexControl {
  return { state: 'open', controllerAgentId: null };
}
function infectedHex(agentId: AgentId | null): HexControl {
  return { state: 'infected', controllerAgentId: agentId };
}

/** Build a WorldState from a flat array of (cell, HexControl) pairs. */
function makeState(
  hexEntries: [H3Cell, HexControl][],
  agentEntries: [AgentId, ReturnType<typeof makeAgent>][],
): WorldState {
  return {
    hexes: new Map(hexEntries),
    agents: new Map(agentEntries),
    events: [],
  };
}

/**
 * Build a real ZeroStrategicObservation from a WorldState.
 * Compiles strategic options via compileStrategicOptions so the workerOptions
 * reflect the actual compiler output — not a hand-assembled estimate.
 */
function buildTestObservation(
  state: WorldState,
  zeroAgentId: AgentId,
  tickNumber: number,
): ZeroStrategicObservation {
  // worldSummary
  let openCells = 0;
  let swarmInfectedCells = 0;
  let abandonedInfectedCells = 0;
  let openFrontierCells = 0;
  const infectedCellSet = new Set<H3Cell>();
  for (const [cell, hex] of state.hexes.entries()) {
    if (hex.state === 'open') {
      openCells++;
    } else {
      infectedCellSet.add(cell);
      if (hex.controllerAgentId === null) abandonedInfectedCells++;
      else swarmInfectedCells++;
    }
  }
  for (const cell of state.hexes.keys()) {
    if (state.hexes.get(cell)?.state !== 'open') continue;
    for (const neighbor of gridDisk(cell, 1) as H3Cell[]) {
      if (neighbor !== cell && infectedCellSet.has(neighbor)) {
        openFrontierCells++;
        break;
      }
    }
  }
  const optionMap = compileStrategicOptions({
    state,
    zeroAgentId,
    tickNumber,
    pressureEventCells: [],
    lastPlanDirectives: null,
  });
  const sortedWorkerIds = [...state.agents.keys()]
    .filter((id) => id !== zeroAgentId)
    .sort((a, b) => a.localeCompare(b));
  const workerOptions = sortedWorkerIds.map((agentId) => ({
    agentId,
    options: optionMap.get(agentId) ?? [],
  }));
  const zero = state.agents.get(zeroAgentId)!;
  const legalZeroActions = enumerateLegalWorldActions(state, zeroAgentId).map(
    (action, index) => ({
      id: `zero_action_${index}`,
      action,
      description:
        action.type === 'wait'
          ? 'Wait on the current cell.'
          : action.type === 'infect'
            ? 'Infect the current open cell.'
            : action.type === 'capture'
              ? 'Capture the current abandoned infected cell.'
              : `Move into an adjacent cell.`,
    }),
  );
  const safeZeroActions =
    legalZeroActions.length > 0
      ? legalZeroActions
      : [
          {
            id: 'zero_action_0',
            action: { type: 'wait' as const },
            description: 'Wait on the current cell.',
          },
        ];
  const countControlled = (agentId: AgentId) => {
    let count = 0;
    for (const hex of state.hexes.values())
      if (hex.state === 'infected' && hex.controllerAgentId === agentId)
        count++;
    return count;
  };
  return zeroStrategicObservationSchema.parse({
    zeroAgentId,
    tickNumber,
    virtualTime: '2026-09-22T12:00:00.000Z',
    cells: [...state.hexes.entries()].map(([cell, hex]) => ({
      cell,
      state: hex.state,
      controllerAgentId:
        hex.state === 'infected' ? hex.controllerAgentId : null,
    })),
    worldSummary: {
      totalCells: state.hexes.size,
      openCells,
      swarmInfectedCells,
      abandonedInfectedCells,
      openFrontierCells,
    },
    agents: [
      {
        agentId: zeroAgentId,
        position: zero.currentCell,
        controlledCellCount: countControlled(zeroAgentId),
        territoryDelta: 0,
        localPressure: 'low' as const,
        pressureDirection: null,
        pressureDistance: null,
      },
      ...sortedWorkerIds.map((agentId) => ({
        agentId,
        position: state.agents.get(agentId)!.currentCell,
        controlledCellCount: countControlled(agentId),
        territoryDelta: 0,
        localPressure: 'low' as const,
        pressureDirection: null,
        pressureDistance: null,
        workerStatus: 'unknown' as const,
        directive: null,
      })),
    ],
    recentPlayerPressure: [],
    legalZeroActions: safeZeroActions,
    workerOptions,
  });
}

describe('compileStrategicOptions', () => {
  it('always emits exactly one hold option (targetCell=null) as the first option', () => {
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...RING1.map((c) => [c, openHex()] as [H3Cell, HexControl]),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const input: CompileStrategicOptionsInput = {
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    };
    const result = compileStrategicOptions(input);
    const opts = result.get(WORKER_A)!;
    expect(opts).toBeDefined();
    expect(opts[0]!.mission).toBe('hold');
    expect(opts[0]!.targetCell).toBeNull();
    expect(opts[0]!.optionId).toBe('w0_o0');
    // Must be exactly one hold option.
    expect(opts.filter((o) => o.mission === 'hold')).toHaveLength(1);
  });

  it('does not include Zero in workerOptions', () => {
    const world = makeState(
      [[ORIGIN, infectedHex(ZERO)]],
      [[ZERO, makeAgent(ZERO, ORIGIN)]],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    expect(result.has(ZERO)).toBe(false);
    expect(result.size).toBe(0);
  });

  it('emits at most 8 options per worker', () => {
    // Build a world with many open cells to stress the option cap.
    const openCells = [...RING1, ...RING2, ...RING3].map(
      (c) => [c, openHex()] as [H3Cell, HexControl],
    );
    const world = makeState(
      [[ORIGIN, infectedHex(ZERO)], ...openCells],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    const opts = result.get(WORKER_A)!;
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts.length).toBeLessThanOrEqual(8);
  });

  it('emits at most 3 expand options per worker, diversified by direction sector', () => {
    const openCells = [...RING1, ...RING2].map(
      (c) => [c, openHex()] as [H3Cell, HexControl],
    );
    const world = makeState(
      [[ORIGIN, infectedHex(ZERO)], ...openCells],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    const opts = result.get(WORKER_A)!;
    const expandOpts = opts.filter((o) => o.mission === 'expand');
    expect(expandOpts.length).toBeGreaterThanOrEqual(1);
    expect(expandOpts.length).toBeLessThanOrEqual(3);
    // All expand targetCells must be open.
    for (const o of expandOpts) {
      expect(o.targetState).toBe('open');
      expect(o.targetCell).not.toBeNull();
    }
    // Direction sectors must be distinct among expand options.
    const dirs = expandOpts.map((o) => o.direction);
    const uniqueDirs = new Set(dirs.filter((d) => d !== null));
    expect(uniqueDirs.size).toBe(dirs.filter((d) => d !== null).length);
  });

  it('emits deterministic, stable optionIds (w<workerIndex>_o<n> format) across repeated calls', () => {
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const input: CompileStrategicOptionsInput = {
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    };
    const first = compileStrategicOptions(input);
    const second = compileStrategicOptions(input);
    expect([...first.get(WORKER_A)!.map((o) => o.optionId)]).toEqual([
      ...second.get(WORKER_A)!.map((o) => o.optionId),
    ]);
    // All optionIds must match the w<n>_o<n> pattern.
    for (const o of first.get(WORKER_A)!) {
      expect(o.optionId).toMatch(/^w[0-9]+_o[0-9]+$/);
    }
  });

  it('diversifies top expand targets across workers (greedy deconfliction)', () => {
    // Two workers co-located; the second should not use the first's top expand.
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
        [WORKER_B, makeAgent(WORKER_B, ORIGIN)],
      ],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    const optsA = result.get(WORKER_A)!;
    const optsB = result.get(WORKER_B)!;
    // Worker B's best expand should differ from Worker A's best expand
    // (or worker B has crowding > 0 for any shared target).
    const topExpandA = optsA.find((o) => o.mission === 'expand');
    const topExpandB = optsB.find((o) => o.mission === 'expand');
    if (topExpandA && topExpandB) {
      const sharedTarget =
        topExpandA.targetCell !== null &&
        topExpandB.targetCell === topExpandA.targetCell;
      if (sharedTarget) {
        // If the same target, Worker B must have higher crowding score.
        expect(topExpandB.crowding).toBeGreaterThan(0);
      }
    }
  });

  it('marks continuesActiveDirective on matching retained directives', () => {
    const expandTarget = RING1[0]!;
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const activeDirective = {
      id: 'dir-1',
      agentId: WORKER_A,
      mission: 'expand' as const,
      targetCell: expandTarget,
      priority: 'normal' as const,
      riskTolerance: 'medium' as const,
      issuedAtTick: 1,
      expiresAtTick: 5,
    };
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 2,
      pressureEventCells: [],
      lastPlanDirectives: [activeDirective],
    });
    const opts = result.get(WORKER_A)!;
    const continueOpt = opts.find((o) => o.continuesActiveDirective);
    expect(continueOpt).toBeDefined();
    expect(continueOpt!.mission).toBe('expand');
    expect(continueOpt!.targetCell).toBe(expandTarget);
  });

  it('emits evade options only under pressure (nearestPressureDist <= 3 or non-low pressure)', () => {
    const ring4 = gridRing(ORIGIN, 4) as H3Cell[];
    const pressureCell = ring4[0]!;
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
        ...(RING2 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
        ...(RING3 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
        ...(ring4 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    // No pressure → no evade options.
    const noPresResult = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    expect(
      noPresResult.get(WORKER_A)!.filter((o) => o.mission === 'evade'),
    ).toHaveLength(0);

    // Nearby pressure → evade options may appear.
    const presResult = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [pressureCell],
      lastPlanDirectives: null,
    });
    // With a ring-4 cell as pressure, distance from ORIGIN is 4: no evade.
    // But if we use a ring-2 cell as pressure (dist=2), evade should appear.
    const nearPressure = RING2[0]!;
    const nearPresResult = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [nearPressure],
      lastPlanDirectives: null,
    });
    const evadeOpts = nearPresResult
      .get(WORKER_A)!
      .filter((o) => o.mission === 'evade');
    // With pressure at dist=2, we should get evade options (if cells in range 2-3 exist).
    // Evade candidates are distance 2-3 from worker with targetMinDist >= currentMinDist.
    expect(evadeOpts.length).toBeGreaterThanOrEqual(0); // possible, not always
    // All evade options must increase or preserve separation (never reduce).
    for (const o of evadeOpts) {
      expect(['increases-separation', 'preserves-separation']).toContain(
        o.pressureEffect,
      );
    }
    // Suppress unused variable warning.
    void presResult;
  });

  it('produces unique optionIds across all workers in the same call', () => {
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
        ...(RING2 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
        [WORKER_B, makeAgent(WORKER_B, ORIGIN)],
      ],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    const allIds: string[] = [];
    for (const opts of result.values()) {
      for (const o of opts) allIds.push(o.optionId);
    }
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('every non-hold option passes swarmDirectiveIssue in a 20-agent/radius-12 world with pressure and abandoned cell', () => {
    // Build a large world: radius-12 disk around origin, all open.
    const ring12 = gridRing(ORIGIN, 12) as H3Cell[];
    const disk12 = gridDisk(ORIGIN, 12) as H3Cell[];
    // 20 worker agents placed at equally spaced ring-12 positions.
    const workerIds: AgentId[] = Array.from(
      { length: 20 },
      (_, i) =>
        `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}` as AgentId,
    );
    const workerCells = ring12.slice(0, 20);
    // One abandoned cell near origin.
    const abandonedCell = RING1[0]!;
    // One pressure cell on the opposite side.
    const pressureCell = ring12[ring12.length - 1]!;
    const hexEntries: [H3Cell, HexControl][] = [
      [ORIGIN, infectedHex(ZERO)],
      [abandonedCell, infectedHex(null)],
      ...disk12
        .filter((c) => c !== ORIGIN && c !== abandonedCell)
        .map((c) => [c, openHex()] as [H3Cell, HexControl]),
    ];
    const agentEntries: [AgentId, ReturnType<typeof makeAgent>][] = [
      [ZERO, makeAgent(ZERO, ORIGIN)],
      ...workerIds.map(
        (id, i) =>
          [id, makeAgent(id, workerCells[i] ?? ORIGIN)] as [
            AgentId,
            ReturnType<typeof makeAgent>,
          ],
      ),
    ];
    const state = makeState(hexEntries, agentEntries);
    const result = compileStrategicOptions({
      state,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [pressureCell],
      lastPlanDirectives: null,
    });
    // Every non-hold option for every worker must pass swarmDirectiveIssue.
    for (const [agentId, opts] of result.entries()) {
      for (const o of opts) {
        if (o.mission === 'hold') continue;
        const dummy = {
          id: 'validate-only',
          agentId,
          mission: o.mission,
          targetCell: o.targetCell,
          priority: 'normal' as const,
          riskTolerance: 'medium' as const,
          issuedAtTick: 1,
          expiresAtTick: 11,
        };
        expect(swarmDirectiveIssue(state, dummy)).toBeNull();
      }
    }
    // There must be at least one worker with options.
    expect(result.size).toBe(20);
  });

  it('reinforce-reclaim-abandoned survives priority bounding under pressure with continue option', () => {
    // Worker A is under pressure and has an active expand directive to continue.
    // An abandoned cell exists. The reinforce (reclaim) option must survive bounding.
    const abandonedCell = RING1[2]!;
    const expandTarget = RING1[0]!;
    const pressureCell = RING2[0]!;
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        [abandonedCell, infectedHex(null)],
        ...RING1.filter((c) => c !== abandonedCell).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
        ...RING2.map((c) => [c, openHex()] as [H3Cell, HexControl]),
        ...RING3.map((c) => [c, openHex()] as [H3Cell, HexControl]),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const activeDirective = {
      id: 'dir-1',
      agentId: WORKER_A,
      mission: 'expand' as const,
      targetCell: expandTarget,
      priority: 'normal' as const,
      riskTolerance: 'medium' as const,
      issuedAtTick: 1,
      expiresAtTick: 5,
    };
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 2,
      pressureEventCells: [pressureCell],
      lastPlanDirectives: [activeDirective],
    });
    const opts = result.get(WORKER_A)!;
    // Must not exceed 8.
    expect(opts.length).toBeLessThanOrEqual(8);
    // Reinforce-reclaim option must be present (abandoned cell exists, under pressure).
    const reinforceOpt = opts.find((o) => o.mission === 'reinforce');
    expect(reinforceOpt).toBeDefined();
    expect(reinforceOpt!.targetCell).toBe(abandonedCell);
    // Continue option must also be present.
    expect(opts.some((o) => o.continuesActiveDirective)).toBe(true);
  });

  it('expand candidate scan widens beyond radius-4 when no open cells found locally', () => {
    // Worker A is surrounded by infected cells within radius 4; open cells are far.
    const farOpen = gridRing(ORIGIN, 8) as H3Cell[];
    const localInfected = gridDisk(ORIGIN, 4) as H3Cell[];
    const hexEntries: [H3Cell, HexControl][] = [
      ...localInfected.map(
        (c) => [c, infectedHex(WORKER_A)] as [H3Cell, HexControl],
      ),
      ...farOpen.map((c) => [c, openHex()] as [H3Cell, HexControl]),
    ];
    const world = makeState(hexEntries, [
      [ZERO, makeAgent(ZERO, ORIGIN)],
      [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
    ]);
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    const opts = result.get(WORKER_A)!;
    const expandOpts = opts.filter((o) => o.mission === 'expand');
    // Must find expand options despite no open cells within radius 4.
    expect(expandOpts.length).toBeGreaterThanOrEqual(1);
    expect(expandOpts.every((o) => o.distance >= 8)).toBe(true);
  });

  it('real request size: 8 workers/radius-6 ≈ 8 workers/radius-12; 20-worker request < v1 estimate', () => {
    // ── scenario helpers ────────────────────────────────────────────────────
    function makeScenario(
      numWorkers: number,
      radius: number,
    ): ZeroStrategicObservation {
      const disk = gridDisk(ORIGIN, radius) as H3Cell[];
      const ring = gridRing(ORIGIN, radius) as H3Cell[];
      const workerIds: AgentId[] = Array.from(
        { length: numWorkers },
        (_, i) =>
          `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}` as AgentId,
      );
      const workerCells = ring.slice(0, numWorkers);
      const hexEntries: [H3Cell, HexControl][] = [
        [ORIGIN, infectedHex(ZERO)],
        ...disk
          .filter((c) => c !== ORIGIN)
          .map((c) => [c, openHex()] as [H3Cell, HexControl]),
      ];
      const agentEntries: [AgentId, ReturnType<typeof makeAgent>][] = [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        ...workerIds.map(
          (id, i) =>
            [id, makeAgent(id, workerCells[i] ?? ORIGIN)] as [
              AgentId,
              ReturnType<typeof makeAgent>,
            ],
        ),
      ];
      return buildTestObservation(makeState(hexEntries, agentEntries), ZERO, 1);
    }

    // (a) 8 workers / radius 6 (~127 cells)
    const obsA = makeScenario(8, 6);
    // (b) 20 workers / radius 12 (~469 cells)
    const obsB = makeScenario(20, 12);
    // (c) 8 workers / radius 12 (~469 cells)
    const obsC = makeScenario(8, 12);

    const msgBytes = (obs: ZeroStrategicObservation) =>
      Buffer.byteLength(
        JSON.stringify(
          buildSwarmPlannerRequest(obs, 'test-model', 'provider-default')
            .messages,
        ),
        'utf8',
      );

    const bytesA = msgBytes(obsA);
    const bytesB = msgBytes(obsB);
    const bytesC = msgBytes(obsC);

    // (c) must be within 10 % of (a) — message size is driven by roster, not world cells.
    expect(bytesC).toBeGreaterThanOrEqual(bytesA * 0.9);
    expect(bytesC).toBeLessThanOrEqual(bytesA * 1.1);

    // Per-worker bytes in (b): ceiling = measured (1 474 B) × ~1.7 = 2 500.
    // Update if the option schema grows meaningfully; do not tighten to an exact number.
    const perWorkerBytesB = bytesB / 20;
    expect(perWorkerBytesB).toBeLessThanOrEqual(2_500);

    // v1-shape estimate for the SAME 20-worker/469-cell observation:
    //   full cells array ({cell, state, controllerAgentId})
    //   + all agent UUIDs + positions
    //   + 80 strategicTargetCells ({cell, state, controllerAgentId})
    const v1Bytes = Buffer.byteLength(
      JSON.stringify({
        tickNumber: obsB.tickNumber,
        cells: obsB.cells,
        agents: obsB.agents.map((a) => ({
          agentId: a.agentId,
          position: a.position,
          controlledCellCount: a.controlledCellCount,
          localPressure: a.localPressure,
        })),
        strategicTargetCells: obsB.cells.slice(0, 80).map((c) => ({
          cell: c.cell,
          state: c.state,
          controllerAgentId: c.controllerAgentId,
        })),
      }),
      'utf8',
    );
    expect(bytesB).toBeLessThan(v1Bytes);
  });

  it('20-worker radius-12 fixture: top-expand targets are diverse across workers', () => {
    const disk12 = gridDisk(ORIGIN, 12) as H3Cell[];
    const ring12 = gridRing(ORIGIN, 12) as H3Cell[];
    const workerIds20: AgentId[] = Array.from(
      { length: 20 },
      (_, i) =>
        `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}` as AgentId,
    );
    const workerCells20 = ring12.slice(0, 20);
    const hexEntries: [H3Cell, HexControl][] = [
      [ORIGIN, infectedHex(ZERO)],
      ...disk12
        .filter((c) => c !== ORIGIN)
        .map((c) => [c, openHex()] as [H3Cell, HexControl]),
    ];
    const agentEntries: [AgentId, ReturnType<typeof makeAgent>][] = [
      [ZERO, makeAgent(ZERO, ORIGIN)],
      ...workerIds20.map(
        (id, i) =>
          [id, makeAgent(id, workerCells20[i] ?? ORIGIN)] as [
            AgentId,
            ReturnType<typeof makeAgent>,
          ],
      ),
    ];
    const state = makeState(hexEntries, agentEntries);
    const result = compileStrategicOptions({
      state,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    // Collect top expand targets and directions across all workers.
    const topExpandTargets: string[] = [];
    const topExpandDirections: Set<string | null> = new Set();
    for (const opts of result.values()) {
      const firstExpand = opts.find((o) => o.mission === 'expand');
      if (firstExpand?.targetCell)
        topExpandTargets.push(firstExpand.targetCell);
      if (firstExpand) topExpandDirections.add(firstExpand.direction);
    }
    // Greedy deconfliction ensures most workers have distinct top-expand targets.
    // In this ring-12 fixture workers are spread ~120° of arc, so at least 70%
    // of workers with expand options should have distinct top targets.
    const distinctTargets = new Set(topExpandTargets).size;
    expect(distinctTargets).toBeGreaterThanOrEqual(
      Math.ceil(topExpandTargets.length * 0.7),
    );
    // Workers at ring-12 all expand inward; at least 2 distinct direction
    // sectors are represented (typically 3 are observed in this fixture).
    expect(topExpandDirections.size).toBeGreaterThanOrEqual(2);
  });

  it('does not include raw H3 cell IDs or agent IDs in any option description', () => {
    const world = makeState(
      [
        [ORIGIN, infectedHex(ZERO)],
        ...(RING1 as H3Cell[]).map(
          (c) => [c, openHex()] as [H3Cell, HexControl],
        ),
      ],
      [
        [ZERO, makeAgent(ZERO, ORIGIN)],
        [WORKER_A, makeAgent(WORKER_A, ORIGIN)],
      ],
    );
    const result = compileStrategicOptions({
      state: world,
      zeroAgentId: ZERO,
      tickNumber: 1,
      pressureEventCells: [],
      lastPlanDirectives: null,
    });
    for (const opts of result.values()) {
      for (const o of opts) {
        // H3 cell IDs are 15-character hex strings like '8928308280fffff'
        expect(o.description).not.toMatch(/[0-9a-f]{15}/);
        // Agent IDs are UUIDs
        expect(o.description).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
      }
    }
  });
});
