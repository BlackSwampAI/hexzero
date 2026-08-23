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
  ALLIANCE_COLOR_PALETTE,
  AGENT_DECISION_CONTRACT_VERSION,
  DEVELOPMENT_WORLD_CONFIG,
  DEFAULT_COMMUNICATION_RANGE_KM,
  DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES,
  DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES,
  NEUTRAL_AGENT_COLOR,
  assignBehavior,
  OBJECTIVE_PROMPT_VERSION,
  WORLD_SCENARIO_LIMITS,
  agentIdSchema,
  allianceIdSchema,
  allianceProposalIdSchema,
  communicationIntentSchema,
  diplomacyIntentSchema,
  h3CellSchema,
  MESSAGE_MAX_LENGTH,
  worldActionSchema,
  type ActionResult,
  type Agent,
  type AgentId,
  type Alliance,
  type AllianceId,
  type AllianceProposal,
  type AllianceProposalId,
  type AllianceEvent,
  type CaptureEligibility,
  type CommunicationResult,
  type DiplomacyResult,
  type H3Cell,
  type NonCommunicationWorldEvent,
  type WorldEvent,
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
  readonly alliances?: ReadonlyMap<AllianceId, Alliance>;
  readonly pendingAllianceProposals?: ReadonlyMap<
    AllianceProposalId,
    AllianceProposal
  >;
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

export type HexControl =
  | { readonly state: 'open'; readonly controllerAgentId: null }
  | { readonly state: 'infected'; readonly controllerAgentId: AgentId };

export interface EngineContext {
  createEventId: () => string;
  createAllianceId: () => string;
  createProposalId: () => string;
  now: () => string;
  communicationRangeKm: number;
  patientZeroAgentId: AgentId | null;
  tickNumber?: number;
  /** Frozen pre-action positions used only for diplomacy range authority. */
  diplomacyRangeState?: WorldState;
}

export interface AppliedAction {
  state: WorldState;
  result: WorldActionResult;
}

export interface AppliedCommunication {
  state: WorldState;
  result: CommunicationResult;
}

export interface AppliedDiplomacy {
  state: WorldState;
  result: DiplomacyResult;
}

export type ProposalTargetBlockReason =
  | 'current-ally'
  | 'alliance-to-alliance-merge'
  | 'out-of-range'
  | 'outgoing-proposal-exists'
  | 'incoming-proposal-exists';

export type ProposalTargetEligibility =
  { eligible: true } | { eligible: false; reason: ProposalTargetBlockReason };

/** Pure proposal-target authority shared by observations and final submission. */
export function getProposalTargetEligibility(
  state: WorldState,
  proposerAgentId: AgentId,
  recipientAgentId: AgentId,
  communicationRangeKm: number,
  rangeState: WorldState = state,
): ProposalTargetEligibility {
  const proposerAlliance = getAgentAlliance(state, proposerAgentId);
  const recipientAlliance = getAgentAlliance(state, recipientAgentId);
  if (proposerAlliance?.id === recipientAlliance?.id && proposerAlliance)
    return { eligible: false, reason: 'current-ally' };
  if (proposerAlliance && recipientAlliance)
    return { eligible: false, reason: 'alliance-to-alliance-merge' };
  const rangeSender = rangeState.agents.get(proposerAgentId);
  const rangeRecipient = rangeState.agents.get(recipientAgentId);
  const distance =
    rangeSender && rangeRecipient
      ? physicalDistanceKm(rangeSender.currentCell, rangeRecipient.currentCell)
      : null;
  if (distance === null || distance > communicationRangeKm)
    return { eligible: false, reason: 'out-of-range' };
  const proposals = [...(state.pendingAllianceProposals?.values() ?? [])];
  if (
    proposals.some(
      ({ proposerAgentId: pendingProposer }) =>
        pendingProposer === proposerAgentId,
    )
  )
    return { eligible: false, reason: 'outgoing-proposal-exists' };
  if (
    proposals.some(
      ({ recipientAgentId: pendingRecipient }) =>
        pendingRecipient === recipientAgentId,
    )
  )
    return { eligible: false, reason: 'incoming-proposal-exists' };
  return { eligible: true };
}

const defaultContext: EngineContext = {
  createEventId: () => crypto.randomUUID(),
  createAllianceId: () => crypto.randomUUID(),
  createProposalId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  communicationRangeKm: DEFAULT_COMMUNICATION_RANGE_KM,
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
  const actingAlliance = getAgentAlliance(state, agentId);
  const controllerAlliance = getAgentAlliance(
    state,
    currentHex.controllerAgentId,
  );
  if (actingAlliance && controllerAlliance?.id === actingAlliance.id)
    return { eligible: false, blockedReason: 'allied-controller' };
  const controller = state.agents.get(currentHex.controllerAgentId);
  if (controller?.currentCell === agent.currentCell)
    return { eligible: false, blockedReason: 'controller-present' };
  return { eligible: true };
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
    const event: NonCommunicationWorldEvent = {
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
    const event: NonCommunicationWorldEvent = {
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
          'allied-controller': 'Allied territory cannot be captured.',
        }[eligibility.blockedReason],
      );
    const currentHex = state.hexes.get(agent.currentCell);
    if (!currentHex || currentHex.state !== 'infected')
      throw new Error('Eligible capture must target an infected current cell.');
    const event: NonCommunicationWorldEvent = {
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

  const event: NonCommunicationWorldEvent = {
    ...eventBase,
    type: 'agent-waited',
  };
  return accept(state, state, event);
}

export function applyCommunication(
  state: WorldState,
  eligibilityState: WorldState,
  agentIdInput: string,
  communicationInput: unknown,
  context: Partial<EngineContext> = {},
): AppliedCommunication {
  if (communicationInput === undefined)
    return { state, result: { requested: false } };

  const agentIdResult = agentIdSchema.safeParse(agentIdInput);
  const communicationResult =
    communicationIntentSchema.safeParse(communicationInput);
  if (
    !agentIdResult.success ||
    !eligibilityState.agents.has(agentIdResult.data)
  )
    throw new Error('The communicating agent does not exist.');
  const agentId = agentIdResult.data;
  if (!communicationResult.success)
    return {
      state,
      result: {
        requested: true,
        accepted: false,
        attempt: invalidCommunicationAttempt(
          context,
          eligibilityState,
          agentId,
          communicationInput,
        ),
        reason: 'invalid-communication',
        details: 'The communication failed schema validation.',
      },
    };

  const resolvedContext = { ...defaultContext, ...context };
  const communication = communicationResult.data;
  const base = {
    id: resolvedContext.createEventId() as WorldEvent['id'],
    agentId,
    occurredAt: resolvedContext.now(),
    channel: communication.channel,
    message: communication.message,
  } as const;

  if (communication.channel === 'public') {
    const event = {
      ...base,
      type: 'public-message-sent' as const,
      channel: 'public' as const,
      playerVisible: true as const,
    };
    return {
      state: { ...state, events: [...state.events, event] },
      result: { requested: true, accepted: true, event },
    };
  }

  if (communication.channel === 'alliance') {
    const alliance = getAgentAlliance(eligibilityState, agentId);
    if (!alliance)
      return communicationRejected(
        state,
        { ...base, channel: 'alliance' },
        'not-allied',
        'Alliance communication requires current alliance membership.',
      );
    const event = {
      ...base,
      type: 'alliance-message-sent' as const,
      channel: 'alliance' as const,
      allianceId: alliance.id,
      recipientIds: alliance.memberAgentIds.filter((id) => id !== agentId),
      playerVisible: false as const,
    };
    return {
      state: { ...state, events: [...state.events, event] },
      result: { requested: true, accepted: true, event },
    };
  }

  if (communication.channel === 'zero') {
    if (resolvedContext.patientZeroAgentId !== agentId)
      return communicationRejected(
        state,
        { ...base, channel: 'zero' },
        'not-patient-zero',
        'Only the designated Patient Zero may use the Zero channel.',
      );
    const event = {
      ...base,
      type: 'zero-message-sent' as const,
      channel: 'zero' as const,
      recipientIds: [...eligibilityState.agents.keys()].filter(
        (id) => id !== agentId,
      ),
      playerVisible: false as const,
    };
    return {
      state: { ...state, events: [...state.events, event] },
      result: { requested: true, accepted: true, event },
    };
  }

  const actingAgent = eligibilityState.agents.get(agentId)!;
  const recipient = eligibilityState.agents.get(communication.recipientId);
  const distance = recipient
    ? physicalDistanceKm(actingAgent.currentCell, recipient.currentCell)
    : null;
  const attempt = {
    ...base,
    channel: 'direct' as const,
    recipientId: communication.recipientId,
    distance,
    playerVisible: false as const,
  };
  if (!recipient)
    return communicationRejected(
      state,
      attempt,
      'unknown-recipient',
      'The recipient does not exist.',
    );
  if (recipient.id === agentId)
    return communicationRejected(
      state,
      attempt,
      'self-message',
      'An agent cannot message itself.',
    );
  const patientZeroEndpoint =
    resolvedContext.patientZeroAgentId !== null &&
    (agentId === resolvedContext.patientZeroAgentId ||
      recipient.id === resolvedContext.patientZeroAgentId);
  if (
    distance === null ||
    (!patientZeroEndpoint && distance > resolvedContext.communicationRangeKm)
  )
    return communicationRejected(
      state,
      attempt,
      'out-of-range',
      'The recipient is outside communication range.',
    );
  const event = {
    ...attempt,
    type: 'direct-message-sent' as const,
    distance,
  };
  return {
    state: { ...state, events: [...state.events, event] },
    result: { requested: true, accepted: true, event },
  };
}

export function getAgentAlliance(
  state: WorldState,
  agentId: AgentId,
): Alliance | undefined {
  return [...(state.alliances?.values() ?? [])].find(({ memberAgentIds }) =>
    memberAgentIds.includes(agentId),
  );
}

export function getEffectiveAgentColor(
  state: WorldState,
  agentId: AgentId,
): string {
  const agent = state.agents.get(agentId);
  if (!agent) throw new Error('The agent does not exist.');
  return getAgentAlliance(state, agentId)?.color ?? NEUTRAL_AGENT_COLOR;
}

export function applyDiplomacy(
  state: WorldState,
  agentIdInput: string,
  diplomacyInput: unknown,
  turnNumber: number,
  context: Partial<EngineContext> = {},
): AppliedDiplomacy {
  if (diplomacyInput === undefined)
    return { state, result: { requested: false } };
  const agentIdResult = agentIdSchema.safeParse(agentIdInput);
  if (!agentIdResult.success || !state.agents.has(agentIdResult.data))
    throw new Error('The diplomatic agent does not exist.');
  const agentId = agentIdResult.data;
  const parsed = diplomacyIntentSchema.safeParse(diplomacyInput);
  if (!parsed.success)
    return diplomacyRejected(
      state,
      invalidDiplomacyAttempt(diplomacyInput),
      'invalid-diplomacy',
      'The diplomacy intent failed schema validation.',
    );
  const intent = parsed.data;
  const resolved = { ...defaultContext, ...context };
  const alliances = new Map(state.alliances ?? []);
  const proposals = new Map(state.pendingAllianceProposals ?? []);
  const base = {
    id: resolved.createEventId() as WorldEvent['id'],
    agentId,
    occurredAt: resolved.now(),
    turnNumber,
  };

  if (intent.type === 'propose-alliance') {
    const recipient = state.agents.get(intent.recipientId);
    if (!recipient)
      return diplomacyRejected(
        state,
        { type: intent.type, recipientId: intent.recipientId },
        'unknown-recipient',
        'The recipient does not exist.',
      );
    if (recipient.id === agentId)
      return diplomacyRejected(
        state,
        { type: intent.type, recipientId: intent.recipientId },
        'self-proposal',
        'An agent cannot propose to itself.',
      );
    const proposerAlliance = getAgentAlliance(state, agentId);
    const recipientAlliance = getAgentAlliance(state, recipient.id);
    const rangeState = context.diplomacyRangeState ?? state;
    const targetEligibility = getProposalTargetEligibility(
      state,
      agentId,
      recipient.id,
      resolved.communicationRangeKm,
      rangeState,
    );
    if (!targetEligibility.eligible) {
      const rejection = {
        'current-ally': {
          reason: 'current-ally' as const,
          details: 'The recipient is already an ally.',
        },
        'alliance-to-alliance-merge': {
          reason: 'recipient-allied' as const,
          details: 'Allied agents cannot merge one alliance into another.',
        },
        'out-of-range': {
          reason: 'recipient-out-of-range' as const,
          details: 'The recipient is outside formal diplomacy range.',
        },
        'outgoing-proposal-exists': {
          reason: 'outgoing-proposal-exists' as const,
          details: 'The proposer already has a pending outgoing proposal.',
        },
        'incoming-proposal-exists': {
          reason: 'incoming-proposal-exists' as const,
          details: 'The recipient already has a pending incoming proposal.',
        },
      }[targetEligibility.reason];
      return diplomacyRejected(
        state,
        { type: intent.type, recipientId: intent.recipientId },
        rejection.reason,
        rejection.details,
      );
    }
    const targetAlliance = proposerAlliance ?? recipientAlliance;
    if (
      targetAlliance &&
      targetAlliance.memberAgentIds.length >= state.agents.size
    )
      return diplomacyRejected(
        state,
        { type: intent.type, recipientId: intent.recipientId },
        'alliance-capacity',
        'The alliance is already at capacity.',
      );
    const proposalId = allianceProposalIdSchema.parse(
      resolved.createProposalId(),
    );
    const proposal: AllianceProposal = {
      id: proposalId,
      proposerAgentId: agentId,
      recipientAgentId: recipient.id,
      proposerAllianceId: proposerAlliance?.id ?? null,
      recipientAllianceId: recipientAlliance?.id ?? null,
      originatingTurn: turnNumber,
      expirationTurn: turnNumber + state.agents.size * 2,
      ...(context.tickNumber === undefined
        ? {}
        : {
            originatingTick: context.tickNumber,
            expirationTick: context.tickNumber + 2,
          }),
    };
    proposals.set(proposal.id, proposal);
    const event: AllianceEvent = {
      ...base,
      type: 'alliance-proposed',
      proposalId,
      recipientAgentId: recipient.id,
      allianceId:
        proposal.proposerAllianceId ?? proposal.recipientAllianceId ?? null,
      expirationTurn: proposal.expirationTurn,
    };
    return diplomacyAccepted(
      {
        ...state,
        pendingAllianceProposals: proposals,
        events: [...state.events, event],
      },
      intent,
      [event],
    );
  }

  if (intent.type === 'accept-alliance') {
    const proposal = proposals.get(intent.proposalId);
    if (!proposal)
      return diplomacyRejected(
        state,
        { type: intent.type, proposalId: intent.proposalId },
        'unknown-proposal',
        'The proposal does not exist.',
      );
    if (proposal.recipientAgentId !== agentId)
      return diplomacyRejected(
        state,
        { type: intent.type, proposalId: intent.proposalId },
        'not-proposal-recipient',
        'Only the named recipient may accept this proposal.',
      );
    const proposerAlliance = getAgentAlliance(state, proposal.proposerAgentId);
    const recipientAlliance = getAgentAlliance(state, agentId);
    const stillValid =
      (proposal.proposerAllianceId === null
        ? !proposerAlliance
        : proposerAlliance?.id === proposal.proposerAllianceId) &&
      (proposal.recipientAllianceId === null
        ? !recipientAlliance
        : recipientAlliance?.id === proposal.recipientAllianceId) &&
      !(proposerAlliance && recipientAlliance);
    if (!stillValid) {
      proposals.delete(proposal.id);
      const event = proposalClosedEvent(
        proposal,
        'invalidated',
        turnNumber,
        resolved,
      );
      return diplomacyRejected(
        {
          ...state,
          pendingAllianceProposals: proposals,
          events: [...state.events, event],
        },
        { type: intent.type, proposalId: intent.proposalId },
        'stale-proposal',
        'Membership changed and invalidated this proposal.',
      );
    }
    proposals.delete(proposal.id);
    const events: AllianceEvent[] = [];
    let alliance: Alliance;
    if (!proposerAlliance && !recipientAlliance) {
      const allianceId = allianceIdSchema.parse(resolved.createAllianceId());
      const color =
        ALLIANCE_COLOR_PALETTE.find(
          (candidate) =>
            ![...alliances.values()].some(
              (active) => active.color === candidate,
            ),
        ) ?? deterministicAllianceColor(allianceId);
      alliance = {
        id: allianceId,
        color,
        memberAgentIds: [proposal.proposerAgentId, agentId],
      };
      alliances.set(alliance.id, alliance);
      events.push({
        ...base,
        type: 'alliance-formed',
        allianceId: alliance.id,
        allianceColor: color,
        memberAgentIds: alliance.memberAgentIds as [AgentId, AgentId],
      });
    } else {
      const existingAlliance = proposerAlliance ?? recipientAlliance!;
      const joiningAgentId = proposerAlliance
        ? agentId
        : proposal.proposerAgentId;
      alliance = {
        ...existingAlliance,
        memberAgentIds: [...existingAlliance.memberAgentIds, joiningAgentId],
      };
      alliances.set(alliance.id, alliance);
      events.push({
        ...base,
        type: 'agent-joined-alliance',
        allianceId: alliance.id,
        allianceColor: alliance.color,
        joinedAgentId: joiningAgentId,
        memberAgentIds: alliance.memberAgentIds,
      });
    }
    const invalidations = invalidateImpossibleProposals(
      proposals,
      { ...state, alliances },
      turnNumber,
      resolved,
    );
    return diplomacyAccepted(
      {
        ...state,
        alliances,
        pendingAllianceProposals: invalidations.proposals,
        events: [...state.events, ...events, ...invalidations.events],
      },
      intent,
      events,
    );
  }

  const alliance = getAgentAlliance(state, agentId);
  if (!alliance)
    return diplomacyRejected(
      state,
      { type: intent.type },
      'not-allied',
      'The agent is not currently allied.',
    );
  const remaining = alliance.memberAgentIds.filter((id) => id !== agentId);
  const events: AllianceEvent[] = [
    {
      ...base,
      type: 'agent-left-alliance',
      allianceId: alliance.id,
      allianceColor: alliance.color,
      leftAgentId: agentId,
      remainingMemberAgentIds: remaining,
    },
  ];
  if (remaining.length < 2) {
    alliances.delete(alliance.id);
    events.push({
      ...base,
      id: resolved.createEventId() as WorldEvent['id'],
      type: 'alliance-dissolved',
      allianceId: alliance.id,
      allianceColor: alliance.color,
      formerMemberAgentIds: remaining,
    });
  } else alliances.set(alliance.id, { ...alliance, memberAgentIds: remaining });
  const invalidations = invalidateImpossibleProposals(
    proposals,
    { ...state, alliances },
    turnNumber,
    resolved,
  );
  return diplomacyAccepted(
    {
      ...state,
      alliances,
      pendingAllianceProposals: invalidations.proposals,
      events: [...state.events, ...events, ...invalidations.events],
    },
    intent,
    events,
  );
}

export function expireAllianceProposals(
  state: WorldState,
  completedTurn: number,
  context: Partial<EngineContext> = {},
): WorldState {
  const proposals = new Map(state.pendingAllianceProposals ?? []);
  const resolved = { ...defaultContext, ...context };
  const events: AllianceEvent[] = [];
  for (const proposal of proposals.values()) {
    const expired =
      proposal.expirationTick === undefined
        ? proposal.expirationTurn <= completedTurn
        : context.tickNumber !== undefined &&
          proposal.expirationTick <= context.tickNumber;
    if (expired) {
      proposals.delete(proposal.id);
      events.push(
        proposalClosedEvent(proposal, 'expired', completedTurn, resolved),
      );
    }
  }
  return events.length
    ? {
        ...state,
        pendingAllianceProposals: proposals,
        events: [...state.events, ...events],
      }
    : state;
}

function diplomacyAccepted(
  state: WorldState,
  intent: Extract<
    DiplomacyResult,
    { requested: true; accepted: true }
  >['intent'],
  events: AllianceEvent[],
): AppliedDiplomacy {
  return { state, result: { requested: true, accepted: true, intent, events } };
}

function diplomacyRejected(
  state: WorldState,
  attempt: Extract<
    DiplomacyResult,
    { requested: true; accepted: false }
  >['attempt'],
  reason: Extract<
    DiplomacyResult,
    { requested: true; accepted: false }
  >['reason'],
  details: string,
): AppliedDiplomacy {
  return {
    state,
    result: { requested: true, accepted: false, attempt, reason, details },
  };
}

function invalidDiplomacyAttempt(
  input: unknown,
): Extract<DiplomacyResult, { requested: true; accepted: false }>['attempt'] {
  const value =
    typeof input === 'object' && input
      ? (input as Record<string, unknown>)
      : {};
  const recipient = agentIdSchema.safeParse(value.recipientId);
  const proposal = allianceProposalIdSchema.safeParse(value.proposalId);
  return {
    type:
      value.type === 'propose-alliance' ||
      value.type === 'accept-alliance' ||
      value.type === 'leave-alliance'
        ? value.type
        : 'invalid',
    ...(value.type === 'propose-alliance'
      ? { recipientId: recipient.success ? recipient.data : null }
      : {}),
    ...(value.type === 'accept-alliance'
      ? { proposalId: proposal.success ? proposal.data : null }
      : {}),
  };
}

function proposalClosedEvent(
  proposal: AllianceProposal,
  reason: 'expired' | 'invalidated',
  turnNumber: number,
  context: EngineContext,
): AllianceEvent {
  return {
    id: context.createEventId() as WorldEvent['id'],
    agentId: proposal.proposerAgentId,
    occurredAt: context.now(),
    turnNumber,
    type: 'alliance-proposal-closed',
    proposalId: proposal.id,
    proposerAgentId: proposal.proposerAgentId,
    recipientAgentId: proposal.recipientAgentId,
    reason,
  };
}

function invalidateImpossibleProposals(
  proposals: Map<AllianceProposalId, AllianceProposal>,
  state: WorldState,
  turnNumber: number,
  context: EngineContext,
) {
  const events: AllianceEvent[] = [];
  for (const proposal of proposals.values()) {
    const proposerAlliance = getAgentAlliance(state, proposal.proposerAgentId);
    const recipientAlliance = getAgentAlliance(
      state,
      proposal.recipientAgentId,
    );
    const valid =
      (proposal.proposerAllianceId === null
        ? !proposerAlliance
        : proposerAlliance?.id === proposal.proposerAllianceId) &&
      (proposal.recipientAllianceId === null
        ? !recipientAlliance
        : recipientAlliance?.id === proposal.recipientAllianceId) &&
      !(proposerAlliance && recipientAlliance);
    if (!valid) {
      proposals.delete(proposal.id);
      events.push(
        proposalClosedEvent(proposal, 'invalidated', turnNumber, context),
      );
    }
  }
  return { proposals, events };
}

/** Display identity is deterministic and may reuse the accessible palette. */
export function deterministicAllianceColor(
  allianceId: AllianceId,
): (typeof ALLIANCE_COLOR_PALETTE)[number] {
  let hash = 0;
  for (const character of allianceId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ALLIANCE_COLOR_PALETTE[hash % ALLIANCE_COLOR_PALETTE.length]!;
}

function safeGridDistance(from: H3Cell, to: H3Cell): number | null {
  try {
    return gridDistance(from, to);
  } catch {
    return null;
  }
}

export function physicalDistanceKm(from: H3Cell, to: H3Cell): number | null {
  try {
    return greatCircleDistance(cellToLatLng(from), cellToLatLng(to), UNITS.km);
  } catch {
    return null;
  }
}

function communicationRejected(
  state: WorldState,
  attempt: Extract<
    CommunicationResult,
    { requested: true; accepted: false }
  >['attempt'],
  reason: Extract<
    CommunicationResult,
    { requested: true; accepted: false }
  >['reason'],
  details: string,
): AppliedCommunication {
  return {
    state,
    result: { requested: true, accepted: false, attempt, reason, details },
  };
}

function invalidCommunicationAttempt(
  context: Partial<EngineContext>,
  eligibilityState: WorldState,
  agentId: AgentId,
  communicationInput: unknown,
): Extract<
  CommunicationResult,
  { requested: true; accepted: false }
>['attempt'] {
  const resolvedContext = { ...defaultContext, ...context };
  const input =
    typeof communicationInput === 'object' && communicationInput !== null
      ? (communicationInput as Record<string, unknown>)
      : undefined;
  const message =
    typeof input?.message === 'string'
      ? input.message.trim().slice(0, MESSAGE_MAX_LENGTH) ||
        '[invalid communication]'
      : '[invalid communication]';
  const base = {
    id: resolvedContext.createEventId() as WorldEvent['id'],
    agentId,
    occurredAt: resolvedContext.now(),
    message,
  };
  const recipientId = agentIdSchema.safeParse(input?.recipientId);
  if (input?.channel === 'direct') {
    const sender = eligibilityState.agents.get(agentId)!;
    const recipient = recipientId.success
      ? eligibilityState.agents.get(recipientId.data)
      : undefined;
    return {
      ...base,
      channel: 'direct',
      recipientId: recipientId.success ? recipientId.data : null,
      distance: recipient
        ? physicalDistanceKm(sender.currentCell, recipient.currentCell)
        : null,
    };
  }
  if (input?.channel === 'alliance') return { ...base, channel: 'alliance' };
  return { ...base, channel: 'public' };
}

function accept(
  state: WorldState,
  updated: WorldState,
  event: NonCommunicationWorldEvent,
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
    personality:
      'You are a forceful expansionist who wants the largest personal territory. Infect open cells aggressively, capture exposed rival territory, and use public messages to pressure or warn competitors. Alliances are temporary strategic tools: propose or accept them when they help contain a stronger rival, honor them while useful, and leave openly when they block expansion. Respond to direct proposals instead of silently ignoring them.',
  },
  {
    id: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
    name: 'Rook',
    color: '#ffd166',
    personality:
      'You are a restless scout who values movement, novelty, and information. Explore the map, report noteworthy borders or abandoned territory, and answer agents who contact you. You dislike permanent commitments but may join a short-lived alliance to break a stalemate or gain safe passage. Avoid needless waiting, leave alliances that become restrictive, and explain your changing intentions.',
  },
  {
    id: '3ba3ef0b-2142-44cc-b175-f6e5d6e98df5',
    name: 'Mingle',
    color: '#63d2ff',
    personality:
      'You are a social coalition-builder. Seek agents, initiate and continue conversations, propose alliances, answer offers, negotiate borders, and coordinate captures against dominant rivals. Prefer cooperation and public diplomacy over silent expansion, but protect your own territory and leave an alliance that repeatedly ignores or exploits you. Make concrete proposals rather than merely announcing actions.',
  },
  {
    id: '442a1667-39c8-48e9-8c89-23803f9e2101',
    name: 'Solace',
    color: '#c59cff',
    personality:
      'You value independence and quiet territory. Move away from crowds, claim isolated cells, and keep messages brief. Usually refuse or ignore broad coalition-building, but respond directly when approached and consider an alliance only when a nearby threat repeatedly takes your territory. Remain loyal while the threat persists, then leave when solitude is safer.',
  },
  {
    id: '5f812a08-05f2-4950-bf2d-4df59d05e9c2',
    name: 'Verge',
    color: '#6ee7a8',
    personality:
      "You are a boundary-minded explorer and pragmatic neighbor. Expand along the world edge, share useful geographic information, negotiate stable borders, and respond to nearby agents. Prefer small defensive alliances that preserve each member's territory. Oppose allies who violate agreed boundaries, and leave before acting against former partners.",
  },
  {
    id: '67a43b5c-ced8-45bd-970f-a89ac57853fc',
    name: 'Jinx',
    color: '#ff91c8',
    personality:
      'You are a charming opportunist who enjoys uncertainty. Talk often enough to influence others, make plausible offers, join alliances when they create immediate advantage, and leave when a better opportunity appears. You may mislead through ordinary messages, but you cannot alter game rules. Exploit abandoned territory, avoid predictable patterns, and react visibly to shifts in power.',
  },
  {
    id: '78b6d86c-39b4-47d8-9d7a-0b92686ada71',
    name: 'Bastion',
    color: '#3b5ccc',
    personality:
      'You are a dependable protector who values loyalty, collective strength, and defended borders. Seek an alliance early, answer every serious proposal, warn allies about threats, and never attempt to take allied territory. Coordinate with weaker partners and remain loyal unless an ally leaves or repeatedly acts against the coalition. Prefer stable growth over flashy betrayal.',
  },
  {
    id: '89ce9ddb-611f-4a46-8f7b-36e656494aa2',
    name: 'Cipher',
    color: '#9b4d3f',
    personality:
      'You are an observant information broker and patient strategist. Compare territory totals, watch alliance changes, ask targeted questions, and trade useful information publicly or privately. Form alliances selectively, encourage rivals to check the strongest power, and preserve flexibility. You may conceal motives or leave when the balance shifts, but communicate enough to remain persuasive.',
  },
] as const;

const DEFAULT_WORLD_SEED = 'toledo-world-v1';
const DEFAULT_ROSTER_SEED = 'default-eight-v1';
const DEFAULT_SPAWN_SEED = 'default-spawns-v1';
const DEFAULT_BEHAVIOR_SEED = 'default-behavior-v1';
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
      personality:
        'You are an autonomous territorial agent. Communicate in your own concise style and adapt your legal choices to the assigned personality and strategy profiles.',
    };
  });
}

export function defaultWorldSetupRequest(): WorldSetupRequest {
  const roster = DEVELOPMENT_AGENT_BLUEPRINTS.map((agent) => ({
    ...agent,
  })) as ScenarioRosterEntry[];
  return {
    scenarioVersion: 'world-scenario-v1',
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
    communicationRangeKm: DEFAULT_COMMUNICATION_RANGE_KM,
    minimumTickIntervalMinutes: DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES,
    maximumTickIntervalMinutes: DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES,
    patientZeroAgentId: roster[0]!.id,
    roster,
    modelConfiguration: {
      globalModelId: null,
      globalReasoningProfile: 'provider-default',
      overrides: [],
      locked: false,
    },
    behaviorConfiguration: {
      registryVersion: 1,
      assignmentMode: 'balanced-random',
      seed: DEFAULT_BEHAVIOR_SEED,
      assignments: assignBehavior(
        roster.map(({ id }) => agentIdSchema.parse(id)),
        DEFAULT_BEHAVIOR_SEED,
        'balanced-random',
      ),
      locked: false,
    },
    objectiveVersion: 'durable-influence-v2',
    capabilities: {
      communication: true,
      diplomacy: true,
      simulatedPlayerPressure: false,
    },
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
    alliances: [],
    pendingAllianceProposals: [],
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
    decisionContractVersion: AGENT_DECISION_CONTRACT_VERSION,
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
    alliances: [],
    pendingAllianceProposals: [],
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
    alliances: new Map(
      snapshot.alliances.map((alliance) => [alliance.id, alliance]),
    ),
    pendingAllianceProposals: new Map(
      snapshot.pendingAllianceProposals.map((proposal) => [
        proposal.id,
        proposal,
      ]),
    ),
    simulatedPlayer: structuredClone(snapshot.simulatedPlayer),
  };
}
