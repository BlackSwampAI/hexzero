import {
  cellArea,
  cellToLatLng,
  greatCircleDistance,
  gridDisk,
  gridDistance,
  latLngToCell,
  UNITS,
} from 'h3-js';
import {
  SWARM_PLANNER_CONTRACT_VERSION,
  DEVELOPMENT_WORLD_CONFIG,
  DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES,
  DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES,
  DEFAULT_PROVIDER_ATTEMPT_LIMIT,
  OBJECTIVE_PROMPT_VERSION,
  WORLD_SCENARIO_LIMITS,
  agentIdSchema,
  h3CellSchema,
  worldActionSchema,
  type ActionResult,
  type Agent,
  type AgentId,
  type CaptureEligibility,
  type H3Cell,
  type PhysicalWorldEvent,
  type WorldEvent,
  type WorldAction,
  type WorldActionResult,
  type WorldSnapshot,
  type AppliedScenario,
  type ScenarioRosterEntry,
  type WorldSetupPreviewResponse,
  type WorldSetupRequest,
  type SimulatedPlayerEvent,
  type SimulatedPlayerState,
} from '@hexzero/shared';

export interface WorldState {
  readonly hexes: ReadonlyMap<H3Cell, HexControl>;
  readonly agents: ReadonlyMap<AgentId, Agent>;
  readonly events: readonly WorldEvent[];
  readonly simulatedPlayer?: SimulatedPlayerState | null;
}

export interface AdvancedSimulatedPlayer {
  state: WorldState;
  events: SimulatedPlayerEvent[];
}

/**
 * Advance the optional D1 casual cleaner for one virtual interval.
 * It observes infection only, moves at most one adjacent cell toward the
 * nearest infected cell, then attempts at most one disinfection. Agent
 * positions are consulted only for authoritative co-located blocking.
 */
export function advanceCasualCleaner(
  state: WorldState,
  seed: string,
  tickNumber: number,
  context: Pick<EngineContext, 'createEventId' | 'now'>,
): AdvancedSimulatedPlayer {
  const player = state.simulatedPlayer;
  if (!player) return { state, events: [] };
  let currentCell = player.currentCell;
  const infected = [...state.hexes]
    .filter(
      (entry): entry is [H3Cell, Extract<HexControl, { state: 'infected' }>] =>
        entry[1].state === 'infected',
    )
    .map(([cell]) => cell);
  if (!infected.length) return { state, events: [] };
  const events: SimulatedPlayerEvent[] = [];
  const eventBase = () => ({
    id: context.createEventId() as SimulatedPlayerEvent['id'],
    occurredAt: context.now(),
    profile: 'casual-cleaner' as const,
    originatingTick: tickNumber,
  });
  if (state.hexes.get(currentCell)?.state !== 'infected') {
    const rankedTargets = infected
      .map((cell) => ({
        cell,
        distance:
          safeGridDistance(currentCell, cell) ?? Number.MAX_SAFE_INTEGER,
        rank: seededNumber(`${seed}:target:${tickNumber}:${cell}`)(),
      }))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.rank - b.rank ||
          a.cell.localeCompare(b.cell),
      );
    const target = rankedTargets[0]?.cell;
    if (target) {
      const next = gridDisk(currentCell, 1)
        .filter(
          (cell) => cell !== currentCell && state.hexes.has(cell as H3Cell),
        )
        .map((cell) => ({
          cell: h3CellSchema.parse(cell),
          distance:
            safeGridDistance(h3CellSchema.parse(cell), target) ??
            Number.MAX_SAFE_INTEGER,
          rank: seededNumber(`${seed}:step:${tickNumber}:${cell}`)(),
        }))
        .sort(
          (a, b) =>
            a.distance - b.distance ||
            a.rank - b.rank ||
            a.cell.localeCompare(b.cell),
        )[0];
      if (
        next &&
        next.distance <
          (safeGridDistance(currentCell, target) ?? Number.MAX_SAFE_INTEGER)
      ) {
        events.push({
          ...eventBase(),
          type: 'simulated-player-moved',
          fromCell: currentCell,
          toCell: next.cell,
        });
        currentCell = next.cell;
      }
    }
  }
  let hexes = state.hexes;
  let metrics = {
    ...player.metrics,
    movements:
      player.metrics.movements +
      events.filter(({ type }) => type === 'simulated-player-moved').length,
  };
  const current = state.hexes.get(currentCell);
  if (current?.state === 'infected') {
    const blocker = [...state.agents.values()].find(
      ({ currentCell: agentCell }) => agentCell === currentCell,
    );
    if (blocker) {
      events.push({
        ...eventBase(),
        type: 'simulated-player-clean-blocked',
        cell: currentCell,
        blockingAgentId: blocker.id,
      });
      metrics = {
        ...metrics,
        blockedDisinfections: metrics.blockedDisinfections + 1,
      };
    } else {
      events.push({
        ...eventBase(),
        type: 'hex-disinfected',
        cell: currentCell,
        previousControllerAgentId: current.controllerAgentId,
      });
      hexes = new Map(state.hexes);
      (hexes as Map<H3Cell, HexControl>).set(currentCell, {
        state: 'open',
        controllerAgentId: null,
      });
      metrics = {
        ...metrics,
        cellsDisinfected: metrics.cellsDisinfected + 1,
      };
    }
  }
  const nextState: WorldState = {
    ...state,
    hexes,
    simulatedPlayer: { ...player, currentCell, metrics },
    events: [...state.events, ...events],
  };
  return { state: nextState, events };
}

/**
 * Advance the stronger deterministic pressure profile for one virtual
 * interval. The hunter routes only from visible infected cells, which are the
 * observable infection trail. It deliberately never ranks or routes toward
 * agent positions. Agent positions are consulted only once the player shares
 * a cell, where the engine authoritatively resolves a capture.
 */
export function advanceTrailHunter(
  state: WorldState,
  seed: string,
  tickNumber: number,
  context: Pick<EngineContext, 'createEventId' | 'now'>,
): AdvancedSimulatedPlayer {
  const player = state.simulatedPlayer;
  if (!player) return { state, events: [] };

  let currentCell = player.currentCell;
  const infected = [...state.hexes]
    .filter(
      (entry): entry is [H3Cell, Extract<HexControl, { state: 'infected' }>] =>
        entry[1].state === 'infected',
    )
    .map(([cell]) => cell);
  const events: SimulatedPlayerEvent[] = [];
  const eventBase = () => ({
    id: context.createEventId() as SimulatedPlayerEvent['id'],
    occurredAt: context.now(),
    profile: 'trail-hunter-v1' as const,
    originatingTick: tickNumber,
  });

  if (infected.length && state.hexes.get(currentCell)?.state !== 'infected') {
    const target = infected
      .map((cell) => ({
        cell,
        distance:
          safeGridDistance(currentCell, cell) ?? Number.MAX_SAFE_INTEGER,
        rank: seededNumber(
          `${seed}:trail-hunter:target:${tickNumber}:${cell}`,
        )(),
      }))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          a.rank - b.rank ||
          a.cell.localeCompare(b.cell),
      )[0]?.cell;
    if (target) {
      const currentDistance =
        safeGridDistance(currentCell, target) ?? Number.MAX_SAFE_INTEGER;
      const next = gridDisk(currentCell, 1)
        .filter(
          (cell) => cell !== currentCell && state.hexes.has(cell as H3Cell),
        )
        .map((cell) => ({
          cell: h3CellSchema.parse(cell),
          distance:
            safeGridDistance(h3CellSchema.parse(cell), target) ??
            Number.MAX_SAFE_INTEGER,
          rank: seededNumber(
            `${seed}:trail-hunter:step:${tickNumber}:${cell}`,
          )(),
        }))
        .sort(
          (a, b) =>
            a.distance - b.distance ||
            a.rank - b.rank ||
            a.cell.localeCompare(b.cell),
        )[0];
      if (next && next.distance < currentDistance) {
        events.push({
          ...eventBase(),
          type: 'simulated-player-moved',
          fromCell: currentCell,
          toCell: next.cell,
        });
        currentCell = next.cell;
      }
    }
  }

  let hexes = state.hexes;
  let agents = state.agents;
  let metrics = {
    ...player.metrics,
    movements:
      player.metrics.movements +
      events.filter(({ type }) => type === 'simulated-player-moved').length,
  };
  const captured = [...state.agents.values()]
    .filter(({ currentCell: agentCell }) => agentCell === currentCell)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (captured) {
    agents = new Map(state.agents);
    (agents as Map<AgentId, Agent>).delete(captured.id);
    const abandonedCells = [...state.hexes].filter(
      ([, hex]) =>
        hex.state === 'infected' && hex.controllerAgentId === captured.id,
    );
    if (abandonedCells.length) {
      hexes = new Map(state.hexes);
      for (const [cell, hex] of abandonedCells)
        (hexes as Map<H3Cell, HexControl>).set(cell, {
          ...hex,
          controllerAgentId: null,
        });
    }
    events.push({
      ...eventBase(),
      type: 'simulated-player-agent-captured',
      cell: currentCell,
      capturedAgentId: captured.id,
      abandonedCellCount: abandonedCells.length,
    });
  } else {
    const current = state.hexes.get(currentCell);
    if (current?.state === 'infected') {
      events.push({
        ...eventBase(),
        type: 'hex-disinfected',
        cell: currentCell,
        previousControllerAgentId: current.controllerAgentId,
      });
      hexes = new Map(state.hexes);
      (hexes as Map<H3Cell, HexControl>).set(currentCell, {
        state: 'open',
        controllerAgentId: null,
      });
      metrics = {
        ...metrics,
        cellsDisinfected: metrics.cellsDisinfected + 1,
      };
    }
  }

  const nextState: WorldState = {
    ...state,
    hexes,
    agents,
    simulatedPlayer: { ...player, currentCell, metrics },
    events: [...state.events, ...events],
  };
  return { state: nextState, events };
}

/** Dispatches the configured deterministic simulated-player profile. */
export function advanceSimulatedPlayer(
  state: WorldState,
  seed: string,
  tickNumber: number,
  context: Pick<EngineContext, 'createEventId' | 'now'>,
): AdvancedSimulatedPlayer {
  if (state.simulatedPlayer?.profile === 'trail-hunter-v1')
    return advanceTrailHunter(state, seed, tickNumber, context);
  return advanceCasualCleaner(state, seed, tickNumber, context);
}

export type HexControl =
  | { readonly state: 'open'; readonly controllerAgentId: null }
  | { readonly state: 'infected'; readonly controllerAgentId: AgentId | null };

export interface EngineContext {
  createEventId: () => string;
  now: () => string;
  patientZeroAgentId: AgentId | null;
  tickNumber?: number;
}

export interface AppliedAction {
  state: WorldState;
  result: WorldActionResult;
}

const defaultContext: EngineContext = {
  createEventId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  patientZeroAgentId: null,
};

function rejected(
  state: WorldState,
  reason: Extract<ActionResult, { accepted: false }>['reason'],
  details: string,
): AppliedAction {
  return { state, result: { accepted: false, reason, details } };
}

export function areAdjacent(from: H3Cell, to: H3Cell): boolean {
  try {
    return gridDistance(from, to) === 1;
  } catch {
    return false;
  }
}

export function getCaptureEligibility(
  state: WorldState,
  agentId: AgentId,
): CaptureEligibility {
  const agent = state.agents.get(agentId);
  if (!agent) throw new Error('The acting agent does not exist.');
  const currentHex = state.hexes.get(agent.currentCell);
  if (!currentHex || currentHex.state === 'open')
    return { eligible: false, blockedReason: 'capture-open-cell' };
  if (currentHex.controllerAgentId === agentId)
    return { eligible: false, blockedReason: 'already-controller' };
  const controller = currentHex.controllerAgentId
    ? state.agents.get(currentHex.controllerAgentId)
    : undefined;
  if (controller?.currentCell === agent.currentCell)
    return { eligible: false, blockedReason: 'controller-present' };
  return { eligible: true };
}

/**
 * Lists every physical action the engine currently accepts for an agent in a
 * frozen world state. This is intentionally derived by the same authority
 * that resolves actions, so callers may safely map opaque model choices back
 * to these actions without teaching a provider movement or legality rules.
 */
export function enumerateLegalWorldActions(
  state: WorldState,
  agentId: AgentId,
): readonly WorldAction[] {
  const agent = state.agents.get(agentId);
  if (!agent) return [];

  const proposed: WorldAction[] = [
    ...gridDisk(agent.currentCell, 1)
      .filter((cell) => cell !== agent.currentCell)
      .map((cell) => h3CellSchema.safeParse(cell))
      .filter((result) => result.success)
      .map((result) => ({ type: 'move' as const, targetCell: result.data }))
      .sort((left, right) => left.targetCell.localeCompare(right.targetCell)),
    { type: 'infect' },
    { type: 'capture' },
    { type: 'wait' },
  ];

  return proposed.filter(
    (action) => applyWorldAction(state, agentId, action).result.accepted,
  );
}

export function applyWorldAction(
  state: WorldState,
  agentIdInput: string,
  actionInput: unknown,
  context: Partial<EngineContext> = {},
): AppliedAction {
  const agentIdResult = agentIdSchema.safeParse(agentIdInput);
  const actionResult = worldActionSchema.safeParse(actionInput);

  if (!agentIdResult.success || !state.agents.has(agentIdResult.data)) {
    return rejected(state, 'unknown-agent', 'The acting agent does not exist.');
  }
  if (!actionResult.success) {
    return rejected(
      state,
      'invalid-action',
      'The requested action failed schema validation.',
    );
  }

  const agentId = agentIdResult.data;
  const agent = state.agents.get(agentId);
  if (!agent)
    return rejected(state, 'unknown-agent', 'The acting agent does not exist.');

  const resolvedContext = { ...defaultContext, ...context };
  const eventBase = {
    id: resolvedContext.createEventId() as WorldEvent['id'],
    agentId,
    occurredAt: resolvedContext.now(),
  };
  const action = actionResult.data;

  if (action.type === 'move') {
    if (!state.hexes.has(action.targetCell)) {
      return rejected(
        state,
        'cell-not-in-world',
        'The target cell is outside this world.',
      );
    }
    if (!areAdjacent(agent.currentCell, action.targetCell)) {
      return rejected(
        state,
        'not-adjacent',
        'Agents may move only to an adjacent H3 cell.',
      );
    }
    const event: PhysicalWorldEvent = {
      ...eventBase,
      type: 'agent-moved',
      fromCell: agent.currentCell,
      toCell: action.targetCell,
    };
    const agents = new Map(state.agents);
    agents.set(agentId, { ...agent, currentCell: action.targetCell });
    return accept(state, { ...state, agents }, event);
  }

  if (action.type === 'infect') {
    if (state.hexes.get(agent.currentCell)?.state === 'infected') {
      return rejected(
        state,
        'already-infected',
        'The current cell is already infected.',
      );
    }
    if (!state.hexes.has(agent.currentCell)) {
      return rejected(
        state,
        'cell-not-in-world',
        'The current cell is outside this world.',
      );
    }
    const event: PhysicalWorldEvent = {
      ...eventBase,
      type: 'hex-infected',
      cell: agent.currentCell,
      controllerAgentId: agentId,
    };
    const hexes = new Map(state.hexes);
    hexes.set(agent.currentCell, {
      state: 'infected',
      controllerAgentId: agentId,
    });
    return accept(state, { ...state, hexes }, event);
  }

  if (action.type === 'capture') {
    const eligibility = getCaptureEligibility(state, agentId);
    if (!eligibility.eligible)
      return rejected(
        state,
        eligibility.blockedReason,
        {
          'capture-open-cell': 'Only an infected current cell can be captured.',
          'already-controller':
            'The acting agent already controls the current cell.',
          'controller-present':
            'The current controller is present and defends this cell.',
        }[eligibility.blockedReason],
      );
    const currentHex = state.hexes.get(agent.currentCell);
    if (!currentHex || currentHex.state !== 'infected')
      throw new Error('Eligible capture must target an infected current cell.');
    const event: PhysicalWorldEvent = {
      ...eventBase,
      type: 'hex-captured',
      cell: agent.currentCell,
      controllerAgentId: agentId,
      previousControllerAgentId: currentHex.controllerAgentId,
    };
    const hexes = new Map(state.hexes);
    hexes.set(agent.currentCell, {
      state: 'infected',
      controllerAgentId: agentId,
    });
    return accept(state, { ...state, hexes }, event);
  }

  const event: PhysicalWorldEvent = {
    ...eventBase,
    type: 'agent-waited',
  };
  return accept(state, state, event);
}

function accept(
  state: WorldState,
  updated: WorldState,
  event: PhysicalWorldEvent,
): AppliedAction {
  return {
    state: { ...updated, events: [...state.events, event] },
    result: { accepted: true, event },
  };
}

export interface DevelopmentWorldOptions {
  latitude?: number;
  longitude?: number;
  resolution?: number;
  radius?: number;
  generatedAt?: string;
}

export const DEVELOPMENT_AGENT_BLUEPRINTS = [
  {
    id: '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
    name: 'Ember',
    color: '#ff6b57',
  },
  {
    id: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
    name: 'Rook',
    color: '#ffd166',
  },
  {
    id: '3ba3ef0b-2142-44cc-b175-f6e5d6e98df5',
    name: 'Mingle',
    color: '#63d2ff',
  },
  {
    id: '442a1667-39c8-48e9-8c89-23803f9e2101',
    name: 'Solace',
    color: '#c59cff',
  },
  {
    id: '5f812a08-05f2-4950-bf2d-4df59d05e9c2',
    name: 'Verge',
    color: '#6ee7a8',
  },
  {
    id: '67a43b5c-ced8-45bd-970f-a89ac57853fc',
    name: 'Jinx',
    color: '#ff91c8',
  },
  {
    id: '78b6d86c-39b4-47d8-9d7a-0b92686ada71',
    name: 'Bastion',
    color: '#3b5ccc',
  },
  {
    id: '89ce9ddb-611f-4a46-8f7b-36e656494aa2',
    name: 'Cipher',
    color: '#9b4d3f',
  },
] as const;

const DEFAULT_WORLD_SEED = 'toledo-world-v1';
const DEFAULT_ROSTER_SEED = 'default-eight-v1';
const DEFAULT_SPAWN_SEED = 'default-spawns-v1';
const DEFAULT_STARTING_INDEXES = [91, 94, 97, 100, 103, 106, 109, 112] as const;

function seededNumber(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function safeGridDistance(from: H3Cell, to: H3Cell): number | null {
  try {
    return gridDistance(from, to);
  } catch {
    return null;
  }
}

/** Stable per-tick shuffle used by simulation resolution, never provider completion order. */
export function seededTickOrder<T extends string>(
  values: readonly T[],
  scenarioSeed: string,
  tickNumber: number,
): T[] {
  const random = seededNumber(`${scenarioSeed}:tick-order:${tickNumber}`);
  return values
    .map((value) => ({ value, rank: random() }))
    .sort(
      (left, right) =>
        left.rank - right.rank || left.value.localeCompare(right.value),
    )
    .map(({ value }) => value);
}

export function seededTickIntervalMinutes(
  scenarioSeed: string,
  tickNumber: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum > maximum
  )
    throw new Error('Invalid tick interval bounds.');
  const random = seededNumber(`${scenarioSeed}:tick-interval:${tickNumber}`);
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function shuffled<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  const random = seededNumber(seed);
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export function allocateDeterministicSpawns(
  cells: readonly H3Cell[],
  agentCount: number,
  minimumSeparation: number,
  seed: string,
): H3Cell[] | null {
  const selected: H3Cell[] = [];
  for (const candidate of shuffled(cells, seed)) {
    if (
      selected.every((cell) => {
        try {
          return gridDistance(cell, candidate) >= minimumSeparation;
        } catch {
          return false;
        }
      })
    )
      selected.push(candidate);
    if (selected.length === agentCount) return selected;
  }
  return null;
}

function deterministicUuid(seed: string, index: number): string {
  const bytes = Array.from({ length: 16 }, (_, byte) =>
    Math.floor(seededNumber(`${seed}:${index}:${byte}`)() * 256),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateDeterministicRoster(
  count: number,
  seed: string,
): ScenarioRosterEntry[] {
  const adjectives = [
    'Amber',
    'Bold',
    'Cobalt',
    'Distant',
    'Emerald',
    'Feral',
    'Golden',
    'Harbor',
  ];
  const nouns = [
    'Arc',
    'Beacon',
    'Cairn',
    'Drift',
    'Echo',
    'Flint',
    'Grove',
    'Haven',
  ];
  return Array.from({ length: count }, (_, index) => {
    const random = seededNumber(`${seed}:color:${index}`);
    const color = `#${Array.from({ length: 3 }, () =>
      Math.floor(48 + random() * 176)
        .toString(16)
        .padStart(2, '0'),
    ).join('')}`;
    const base = `${adjectives[index % adjectives.length]} ${nouns[Math.floor(index / adjectives.length) % nouns.length]}`;
    return {
      id: agentIdSchema.parse(deterministicUuid(seed, index)),
      name: `${base} ${index + 1}`.slice(0, 80),
      color,
    };
  });
}

export function defaultWorldSetupRequest(): WorldSetupRequest {
  const roster = DEVELOPMENT_AGENT_BLUEPRINTS.map((agent) => ({
    ...agent,
  })) as ScenarioRosterEntry[];
  return {
    scenarioVersion: 'world-scenario-v1',
    swarmArchitectureVersion: 'zero-swarm-v1',
    locationLabel: 'Toledo, Ohio',
    center: {
      latitude: DEVELOPMENT_WORLD_CONFIG.latitude,
      longitude: DEVELOPMENT_WORLD_CONFIG.longitude,
    },
    resolution: DEVELOPMENT_WORLD_CONFIG.resolution,
    radius: DEVELOPMENT_WORLD_CONFIG.radius,
    worldSeed: DEFAULT_WORLD_SEED,
    rosterSeed: DEFAULT_ROSTER_SEED,
    spawnSeed: DEFAULT_SPAWN_SEED,
    minimumSpawnSeparation: 1,
    minimumTickIntervalMinutes: DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES,
    maximumTickIntervalMinutes: DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES,
    executionLimits: {
      version: 'execution-limits-v2',
      providerAttemptLimit: DEFAULT_PROVIDER_ATTEMPT_LIMIT,
      creditLimit: null,
      reservationCreditsPerAttempt: '0.01',
    },
    patientZeroAgentId: roster[0]!.id,
    roster,
    modelConfiguration: {
      globalModelId: null,
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    },
    objectiveVersion: 'durable-influence-v2',
    capabilities: { simulatedPlayerPressure: false },
    simulatedPlayer: {
      enabled: false,
      profile: 'casual-cleaner',
      seed: 'casual-cleaner-v1',
    },
  };
}

export function previewWorldSetup(
  request: WorldSetupRequest,
  generatedAt = new Date().toISOString(),
): WorldSetupPreviewResponse {
  let cells: H3Cell[];
  try {
    const center = h3CellSchema.parse(
      latLngToCell(
        request.center.latitude,
        request.center.longitude,
        request.resolution,
      ),
    );
    cells = gridDisk(center, request.radius).map((cell) =>
      h3CellSchema.parse(cell),
    );
  } catch {
    return {
      feasible: false,
      errors: [
        {
          code: 'invalid-coordinates',
          message:
            'The coordinates could not be converted to a valid H3 world.',
        },
      ],
      warnings: [],
    };
  }
  if (cells.length > WORLD_SCENARIO_LIMITS.maximumGeneratedCells)
    return {
      feasible: false,
      errors: [
        {
          code: 'cell-limit-exceeded',
          message: `The generated world has ${cells.length} cells; the limit is ${WORLD_SCENARIO_LIMITS.maximumGeneratedCells}.`,
        },
      ],
      warnings: [],
    };
  const isDefault =
    request.center.latitude === DEVELOPMENT_WORLD_CONFIG.latitude &&
    request.center.longitude === DEVELOPMENT_WORLD_CONFIG.longitude &&
    request.resolution === DEVELOPMENT_WORLD_CONFIG.resolution &&
    request.radius === DEVELOPMENT_WORLD_CONFIG.radius &&
    request.roster.length === DEVELOPMENT_AGENT_BLUEPRINTS.length &&
    request.roster.every(
      (agent, index) => agent.id === DEVELOPMENT_AGENT_BLUEPRINTS[index]?.id,
    ) &&
    request.spawnSeed === DEFAULT_SPAWN_SEED;
  const startingCells = isDefault
    ? DEFAULT_STARTING_INDEXES.map((index) => cells[index]!).filter(Boolean)
    : allocateDeterministicSpawns(
        cells,
        request.roster.length,
        request.minimumSpawnSeparation,
        request.spawnSeed,
      );
  const separationSatisfied = startingCells?.every((cell, index) =>
    startingCells.slice(index + 1).every((other) => {
      try {
        return gridDistance(cell, other) >= request.minimumSpawnSeparation;
      } catch {
        return false;
      }
    }),
  );
  if (!startingCells || !separationSatisfied)
    return {
      feasible: false,
      errors: [
        {
          code: 'spawn-infeasible',
          message: `The ${request.roster.length}-agent roster cannot fit with minimum separation ${request.minimumSpawnSeparation}.`,
        },
      ],
      warnings: [],
    };
  const setupWarnings =
    cells.length / request.roster.length <
    WORLD_SCENARIO_LIMITS.highDensityCellsPerAgent
      ? [
          {
            code: 'high-agent-density' as const,
            message: `This setup has fewer than ${WORLD_SCENARIO_LIMITS.highDensityCellsPerAgent} cells per agent.`,
          },
        ]
      : [];
  const world: WorldSnapshot = {
    generatedAt,
    hexes: cells.map((cell) => ({
      cell,
      state: 'open',
      controllerAgentId: null,
    })),
    agents: request.roster.map((agent, index) => ({
      ...agent,
      currentCell: startingCells[index]!,
    })),
    events: [],
    simulatedPlayer: request.simulatedPlayer.enabled
      ? {
          profile: request.simulatedPlayer.profile,
          currentCell: shuffled(cells, request.simulatedPlayer.seed)[0]!,
          metrics: {
            movements: 0,
            cellsDisinfected: 0,
            blockedDisinfections: 0,
          },
        }
      : null,
  };
  const scenario: AppliedScenario = {
    ...request,
    swarmPlannerContractVersion: SWARM_PLANNER_CONTRACT_VERSION,
    exactCellCount: cells.length,
    areaSquareKilometers: cells.reduce(
      (total, cell) => total + cellArea(cell, UNITS.km2),
      0,
    ),
    startingCells,
    setupWarnings,
  };
  return { feasible: true, scenario, world };
}

export function createWorldFromScenario(
  scenario: AppliedScenario,
  generatedAt = new Date().toISOString(),
): WorldSnapshot {
  const preview = previewWorldSetup(scenario, generatedAt);
  if (!preview.feasible)
    throw new Error(preview.errors[0]?.message ?? 'Invalid scenario.');
  return preview.world;
}

export function createDevelopmentWorld({
  latitude = DEVELOPMENT_WORLD_CONFIG.latitude,
  longitude = DEVELOPMENT_WORLD_CONFIG.longitude,
  resolution = DEVELOPMENT_WORLD_CONFIG.resolution,
  radius = DEVELOPMENT_WORLD_CONFIG.radius,
  generatedAt = new Date().toISOString(),
}: DevelopmentWorldOptions = {}): WorldSnapshot {
  const center = h3CellSchema.parse(
    latLngToCell(latitude, longitude, resolution),
  );
  const cells = gridDisk(center, radius).map((cell) =>
    h3CellSchema.parse(cell),
  );
  if (
    latitude === DEVELOPMENT_WORLD_CONFIG.latitude &&
    longitude === DEVELOPMENT_WORLD_CONFIG.longitude &&
    resolution === DEVELOPMENT_WORLD_CONFIG.resolution &&
    radius === DEVELOPMENT_WORLD_CONFIG.radius &&
    cells.length !== DEVELOPMENT_WORLD_CONFIG.cellCount
  )
    throw new Error(
      `The development world must contain exactly ${DEVELOPMENT_WORLD_CONFIG.cellCount} cells.`,
    );
  const startingIndexes =
    latitude === DEVELOPMENT_WORLD_CONFIG.latitude &&
    longitude === DEVELOPMENT_WORLD_CONFIG.longitude &&
    resolution === DEVELOPMENT_WORLD_CONFIG.resolution &&
    radius === DEVELOPMENT_WORLD_CONFIG.radius
      ? [...DEFAULT_STARTING_INDEXES]
      : DEVELOPMENT_AGENT_BLUEPRINTS.map((_, index) =>
          Math.floor(
            (index * cells.length) / DEVELOPMENT_AGENT_BLUEPRINTS.length,
          ),
        );
  const startingCells = startingIndexes.map((index) => cells[index]);
  if (
    startingCells.some((cell) => !cell) ||
    new Set(startingCells).size !== DEVELOPMENT_AGENT_BLUEPRINTS.length
  )
    throw new Error('Development starting cells must be unique world cells.');
  return {
    generatedAt,
    hexes: cells.map((cell) => ({
      cell,
      state: 'open' as const,
      controllerAgentId: null,
    })),
    agents: DEVELOPMENT_AGENT_BLUEPRINTS.map((profile, index) => ({
      ...profile,
      id: agentIdSchema.parse(profile.id),
      currentCell: cells[startingIndexes[index]!]!,
    })),
    events: [],
    simulatedPlayer: null,
  };
}

export function createDefaultAppliedScenario(
  generatedAt = new Date().toISOString(),
): AppliedScenario {
  const preview = previewWorldSetup(defaultWorldSetupRequest(), generatedAt);
  if (!preview.feasible)
    throw new Error('The default World Lab scenario is invalid.');
  return preview.scenario;
}

export function toWorldState(snapshot: WorldSnapshot): WorldState {
  return {
    hexes: new Map(snapshot.hexes.map(({ cell, ...hex }) => [cell, hex])),
    agents: new Map(snapshot.agents.map((agent) => [agent.id, agent])),
    events: snapshot.events,
    simulatedPlayer: structuredClone(snapshot.simulatedPlayer),
  };
}
