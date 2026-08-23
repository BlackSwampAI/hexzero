import type { AgentId, AgentTurnRecord, H3Cell } from '@hexzero/shared';

export const BEHAVIOR_TRACE_LIMIT = 6;
const BEHAVIOR_TRACE_EVIDENCE_LIMIT = 6;

type CompletedTurn = Extract<
  AgentTurnRecord,
  { outcome: 'accepted' | 'rejected' }
>;

export interface BehaviorTraceEvidence {
  kind:
    | 'direct'
    | 'public'
    | 'alliance-message'
    | 'zero-message'
    | 'world-event'
    | 'territory'
    | 'alliance-event'
    | 'player-threat'
    | 'patient-zero-threat';
  label: string;
  cell?: H3Cell;
}

export interface BehaviorTraceEntry {
  turn: AgentTurnRecord;
  hasPreviousObservation: boolean;
  observedChanges: string[];
  evidence: BehaviorTraceEvidence[];
  evidenceTruncated: boolean;
  legalActions: string[];
  chosenAction: string;
  chosenCell?: H3Cell;
  actionPattern?: string;
  continuity: string[];
}

function isCompletedTurn(turn: AgentTurnRecord): turn is CompletedTurn {
  return turn.outcome === 'accepted' || turn.outcome === 'rejected';
}

function unseenBy<T>(
  current: readonly T[],
  previous: readonly T[] | undefined,
  idFor: (item: T) => string,
): T[] {
  const priorIds = new Set(previous?.map(idFor) ?? []);
  return current.filter((item) => !priorIds.has(idFor(item)));
}

function goalSignature(
  goal: AgentTurnRecord['observation']['currentGoal'],
): string {
  return goal
    ? [
        goal.longTermGoal,
        goal.shortTermGoal,
        goal.planSummary,
        goal.establishedAtTick,
        goal.revisedAtTick,
      ].join('\u0000')
    : '';
}

function memorySignature(
  memory: AgentTurnRecord['observation']['currentMemory'],
): string {
  return memory
    .map(
      ({ id, text, createdAtTick, revisedAtTick }) =>
        `${id}\u0000${text}\u0000${createdAtTick}\u0000${revisedAtTick}`,
    )
    .join('\u0001');
}

function ownTerritoryCount(
  turn: AgentTurnRecord,
  agentId: AgentId,
): number | undefined {
  return turn.observation.territoryScoreboard.find(
    (entry) => entry.agentId === agentId,
  )?.controlledCellCount;
}

function collectEvidence(
  turn: AgentTurnRecord,
  previous: AgentTurnRecord | undefined,
  agentId: AgentId,
): BehaviorTraceEvidence[] {
  const observation = turn.observation;
  const prior = previous?.observation;
  const inboundDirect = unseenBy(
    observation.recentDirectMessages.filter(
      ({ direction }) => direction === 'inbound',
    ),
    prior?.recentDirectMessages.filter(
      ({ direction }) => direction === 'inbound',
    ),
    ({ eventId }) => eventId,
  ).map(({ senderName, message }): BehaviorTraceEvidence => ({
    kind: 'direct',
    label: `Inbound from ${senderName}: ${message}`,
  }));
  const publicMessages = unseenBy(
    observation.recentPublicMessages.filter(
      ({ senderId }) => senderId !== agentId,
    ),
    prior?.recentPublicMessages.filter(({ senderId }) => senderId !== agentId),
    ({ eventId }) => eventId,
  ).map(({ senderName, message }): BehaviorTraceEvidence => ({
    kind: 'public',
    label: `Public from ${senderName}: ${message}`,
  }));
  const allianceMessages = unseenBy(
    observation.recentAllianceMessages.filter(
      ({ senderId }) => senderId !== agentId,
    ),
    prior?.recentAllianceMessages.filter(
      ({ senderId }) => senderId !== agentId,
    ),
    ({ eventId }) => eventId,
  ).map(({ senderName, message }): BehaviorTraceEvidence => ({
    kind: 'alliance-message',
    label: `Alliance from ${senderName}: ${message}`,
  }));
  const zeroMessages = unseenBy(
    observation.recentZeroMessages.filter(
      ({ senderId }) => senderId !== agentId,
    ),
    prior?.recentZeroMessages.filter(({ senderId }) => senderId !== agentId),
    ({ eventId }) => eventId,
  ).map(({ senderName, message }): BehaviorTraceEvidence => ({
    kind: 'zero-message',
    label: `Patient Zero from ${senderName}: ${message}`,
  }));
  const territory = unseenBy(
    observation.recentControlChanges,
    prior?.recentControlChanges,
    ({ eventId }) => eventId,
  ).map(({ direction, cell, otherAgentName }): BehaviorTraceEvidence => ({
    kind: 'territory',
    label: `${direction === 'gained' ? 'Gained' : 'Lost'} ${cell} ${
      direction === 'gained' ? 'from' : 'to'
    } ${otherAgentName}`,
    cell,
  }));
  const allianceEvents = unseenBy(
    observation.recentAllianceEvents,
    prior?.recentAllianceEvents,
    ({ event }) => event.id,
  ).map(({ summary }): BehaviorTraceEvidence => ({
    kind: 'alliance-event',
    label: summary,
  }));
  const worldEvents = unseenBy(
    observation.recentEvents.filter(
      ({ agentId: actorId }) => actorId !== agentId,
    ),
    prior?.recentEvents.filter(({ agentId: actorId }) => actorId !== agentId),
    ({ type, agentId: actorId, occurredAt, summary }) =>
      `${type}:${actorId}:${occurredAt}:${summary}`,
  ).map(({ summary }): BehaviorTraceEvidence => ({
    kind: 'world-event',
    label: `World: ${summary}`,
  }));
  const localPlayerThreats = unseenBy(
    observation.playerPressure.recentThreats,
    prior?.playerPressure.recentThreats,
    ({ eventId }) => eventId,
  ).map(
    ({
      eventId,
      kind,
      cell,
      distanceCells,
    }): BehaviorTraceEvidence & {
      eventId: string;
    } => ({
      eventId,
      kind: 'player-threat',
      label:
        kind === 'territory-disinfected'
          ? `Local cleaner threat: own territory disinfected at ${cell}`
          : `Local cleaner threat: disinfection at ${cell} (${distanceCells} cells away)`,
      cell,
    }),
  );
  const localPlayerEventIds = new Set(
    localPlayerThreats.map(({ eventId }) => eventId),
  );
  const globalFeed = observation.patientZeroGlobalView?.playerThreatFeed;
  const priorGlobalFeed = prior?.patientZeroGlobalView?.playerThreatFeed;
  const globalPlayerThreats = globalFeed
    ? unseenBy(
        globalFeed.events,
        priorGlobalFeed?.events,
        ({ eventId }) => eventId,
      )
        .filter(({ eventId }) => !localPlayerEventIds.has(eventId))
        .map((event): BehaviorTraceEvidence => ({
          kind: 'patient-zero-threat',
          label:
            event.kind === 'territory-disinfected'
              ? `Patient Zero global cleaner feed: ${event.affectedAgentName}${
                  event.affectedAllianceId
                    ? ` (${event.affectedAllianceId})`
                    : ''
                } lost ${event.cell}`
              : `Patient Zero global cleaner feed: ${event.blockingAgentName}${
                  event.blockingAllianceId
                    ? ` (${event.blockingAllianceId})`
                    : ''
                } blocked a clean at ${event.cell}`,
          cell: event.cell,
        }))
    : [];
  const globalFeedSummary: BehaviorTraceEvidence[] =
    globalFeed && globalFeed.totalEventCount > 0
      ? [
          {
            kind: 'patient-zero-threat',
            label: `Patient Zero global cleaner feed: ${globalFeed.events.length}/${globalFeed.totalEventCount} displayed${globalFeed.truncated ? ' · truncated' : ''}`,
          },
        ]
      : [];
  return [
    ...globalFeedSummary,
    ...localPlayerThreats.map(({ kind, label, cell }) => ({
      kind,
      label,
      cell,
    })),
    ...globalPlayerThreats,
    ...inboundDirect,
    ...zeroMessages,
    ...allianceMessages,
    ...territory,
    ...allianceEvents,
    ...worldEvents,
    ...publicMessages,
  ];
}

function observedChanges(
  turn: AgentTurnRecord,
  previous: AgentTurnRecord | undefined,
  agentId: AgentId,
  evidence: readonly BehaviorTraceEvidence[],
): string[] {
  if (!previous) return ['First retained observation for this agent.'];
  const changes: string[] = [];
  const current = turn.observation;
  const prior = previous.observation;
  if (current.currentCell.cell !== prior.currentCell.cell)
    changes.push(
      `Observed cell changed ${prior.currentCell.cell} → ${current.currentCell.cell}.`,
    );
  if (current.currentCell.state !== prior.currentCell.state)
    changes.push(
      `Current-cell state changed ${prior.currentCell.state} → ${current.currentCell.state}.`,
    );
  const previousTerritory = ownTerritoryCount(previous, agentId);
  const currentTerritory = ownTerritoryCount(turn, agentId);
  if (
    previousTerritory !== undefined &&
    currentTerritory !== undefined &&
    previousTerritory !== currentTerritory
  )
    changes.push(
      `Controlled territory changed ${previousTerritory} → ${currentTerritory}.`,
    );
  if (current.actingAllianceId !== prior.actingAllianceId)
    changes.push(
      `Alliance changed ${prior.actingAllianceId ?? 'unaffiliated'} → ${
        current.actingAllianceId ?? 'unaffiliated'
      }.`,
    );
  if (goalSignature(current.currentGoal) !== goalSignature(prior.currentGoal))
    changes.push('Strategic goal context changed.');
  if (
    memorySignature(current.currentMemory) !==
    memorySignature(prior.currentMemory)
  )
    changes.push('Compact memory context changed.');
  if (evidence.length)
    changes.push(
      `${evidence.length} new retained evidence item${
        evidence.length === 1 ? '' : 's'
      } entered the retained observation.`,
    );
  return changes.length
    ? changes
    : ['No retained observation change detected.'];
}

function legalActions(turn: AgentTurnRecord): string[] {
  const availability = turn.observation.actionAvailability;
  if (!availability) return ['Legacy affordances unavailable'];
  const moves = availability.moveOptions.length
    ? availability.moveOptions.map(({ direction }) => `Move ${direction}`)
    : [
        `${availability.moveTargetCellIds.length} legal move target${
          availability.moveTargetCellIds.length === 1 ? '' : 's'
        }`,
      ];
  return [
    ...moves,
    ...(availability.infect.available ? ['Infect'] : []),
    ...(availability.capture.available ? ['Capture'] : []),
    'Wait',
  ];
}

function actionDescription(turn: CompletedTurn): {
  label: string;
  pattern: string;
  direction?: string;
  cell?: H3Cell;
} {
  if (turn.worldAction.type === 'move') {
    const targetCell = turn.worldAction.targetCell;
    const direction = turn.observation.actionAvailability?.moveOptions.find(
      (option) => option.targetCell === targetCell,
    )?.direction;
    return {
      label: `Move${direction ? ` ${direction}` : ''} → ${targetCell}`,
      pattern: `move${direction ? ` ${direction}` : ''}`,
      direction,
      cell: targetCell,
    };
  }
  const label =
    turn.worldAction.type[0]!.toUpperCase() + turn.worldAction.type.slice(1);
  return { label, pattern: turn.worldAction.type };
}

function actionPattern(
  turn: AgentTurnRecord,
  previousCompleted: CompletedTurn | undefined,
): string | undefined {
  if (!isCompletedTurn(turn) || !previousCompleted) return undefined;
  const current = actionDescription(turn);
  const previous = actionDescription(previousCompleted);
  if (current.pattern === previous.pattern)
    return `Repeated ${current.pattern}.`;
  if (current.direction && previous.direction)
    return `Changed direction ${previous.direction} → ${current.direction}.`;
  return `Changed ${previous.pattern} → ${current.pattern}.`;
}

function continuity(turn: AgentTurnRecord): string[] {
  if (!isCompletedTurn(turn)) return [];
  const entries: string[] = [];
  if (turn.goalRevisionResult.requested)
    entries.push(
      `Goal ${turn.goalRevisionResult.operation}: ${
        turn.goalRevisionResult.accepted
          ? 'accepted'
          : `rejected (${turn.goalRevisionResult.reason})`
      }`,
    );
  if (turn.memoryOperationResult.requested)
    entries.push(
      `Memory ${turn.memoryOperationResult.operation}: ${
        turn.memoryOperationResult.accepted
          ? 'accepted'
          : `rejected (${turn.memoryOperationResult.reason})`
      }`,
    );
  if (turn.communicationResult.requested)
    entries.push(
      `Communication ${
        turn.communicationResult.accepted
          ? turn.communicationResult.event.channel
          : turn.communicationResult.attempt.channel
      }: ${turn.communicationResult.accepted ? 'accepted' : 'rejected'}`,
    );
  if (turn.diplomacyResult.requested)
    entries.push(
      `Diplomacy ${
        turn.diplomacyResult.accepted
          ? turn.diplomacyResult.intent.type
          : turn.diplomacyResult.attempt.type
      }: ${turn.diplomacyResult.accepted ? 'accepted' : 'rejected'}`,
    );
  return entries;
}

export function deriveBehaviorTrace(
  turns: readonly AgentTurnRecord[],
  agentId: AgentId,
  limit = BEHAVIOR_TRACE_LIMIT,
): BehaviorTraceEntry[] {
  const agentTurns = turns.filter((turn) => turn.agentId === agentId);
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(BEHAVIOR_TRACE_LIMIT, Math.floor(limit)))
    : BEHAVIOR_TRACE_LIMIT;
  const start = Math.max(0, agentTurns.length - boundedLimit);
  return agentTurns
    .slice(start)
    .map((turn, visibleIndex) => {
      const sourceIndex = start + visibleIndex;
      const previous = agentTurns[sourceIndex - 1];
      const previousCompleted = agentTurns
        .slice(0, sourceIndex)
        .findLast(isCompletedTurn);
      const allEvidence = collectEvidence(turn, previous, agentId);
      const chosen: ReturnType<typeof actionDescription> = isCompletedTurn(turn)
        ? actionDescription(turn)
        : {
            label: `No completed action · ${turn.outcome}`,
            pattern: turn.outcome,
          };
      const pattern = actionPattern(turn, previousCompleted);
      return {
        turn,
        hasPreviousObservation: Boolean(previous),
        observedChanges: observedChanges(turn, previous, agentId, allEvidence),
        evidence: allEvidence.slice(0, BEHAVIOR_TRACE_EVIDENCE_LIMIT),
        evidenceTruncated: allEvidence.length > BEHAVIOR_TRACE_EVIDENCE_LIMIT,
        legalActions: legalActions(turn),
        chosenAction: chosen.label,
        ...(chosen.cell ? { chosenCell: chosen.cell } : {}),
        ...(pattern ? { actionPattern: pattern } : {}),
        continuity: continuity(turn),
      };
    })
    .reverse();
}
