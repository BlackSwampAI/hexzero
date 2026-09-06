import {
  RECENT_ALLIANCE_EVENT_LIMIT,
  RECENT_CONTROL_CHANGE_LIMIT,
  RECENT_DIRECT_MESSAGE_LIMIT,
  RECENT_PUBLIC_MESSAGE_LIMIT,
  RECENT_ZERO_MESSAGE_LIMIT,
  RECENT_ZERO_STRATEGIC_EVENT_LIMIT,
  type AgentId,
  type AllianceEvent,
  type WorldEvent,
} from '@hexzero/shared';

type EventOf<T extends WorldEvent['type']> = Extract<WorldEvent, { type: T }>;
type ActionEvent = EventOf<
  'agent-moved' | 'hex-infected' | 'hex-captured' | 'agent-waited'
>;

const RECENT_MOVEMENT_LIMIT = 6;
const RECENT_ACTION_LIMIT = 8;

/**
 * Commit-owned factual history for agent observations. This is deliberately
 * independent from WorldState.events, whose 120-event retention serves the
 * operator display rather than the observation contract.
 */
export class ObservationHistory {
  #movements = new Map<AgentId, EventOf<'agent-moved'>[]>();
  #actions: ActionEvent[] = [];
  #publicMessages: EventOf<'public-message-sent'>[] = [];
  #directMessages = new Map<AgentId, EventOf<'direct-message-sent'>[]>();
  #allianceMessages = new Map<AgentId, EventOf<'alliance-message-sent'>[]>();
  #zeroMessages = new Map<AgentId, EventOf<'zero-message-sent'>[]>();
  #controlChanges = new Map<AgentId, EventOf<'hex-captured'>[]>();
  #allianceEvents: AllianceEvent[] = [];
  #captures: EventOf<'hex-captured'>[] = [];

  constructor(initialEvents: readonly WorldEvent[] = []) {
    this.ingest(initialEvents);
  }

  ingest(events: readonly WorldEvent[]): void {
    // Engine event IDs are authoritative and unique. The batch set protects
    // initialization/call-site mistakes, while #contains scans only bounded
    // retained facts and therefore cannot become a lifetime event registry.
    const batchEventIds = new Set<string>();
    for (const event of events) {
      if (batchEventIds.has(event.id) || this.#contains(event.id)) continue;
      batchEventIds.add(event.id);
      switch (event.type) {
        case 'agent-moved':
          appendFor(
            this.#movements,
            event.agentId,
            event,
            RECENT_MOVEMENT_LIMIT,
          );
          this.#actions = append(this.#actions, event, RECENT_ACTION_LIMIT);
          break;
        case 'hex-infected':
        case 'agent-waited':
          this.#actions = append(this.#actions, event, RECENT_ACTION_LIMIT);
          break;
        case 'hex-captured':
          this.#actions = append(this.#actions, event, RECENT_ACTION_LIMIT);
          this.#captures = append(
            this.#captures,
            event,
            RECENT_CONTROL_CHANGE_LIMIT,
          );
          appendFor(
            this.#controlChanges,
            event.controllerAgentId,
            event,
            RECENT_CONTROL_CHANGE_LIMIT,
          );
          appendFor(
            this.#controlChanges,
            event.previousControllerAgentId,
            event,
            RECENT_CONTROL_CHANGE_LIMIT,
          );
          break;
        case 'public-message-sent':
          this.#publicMessages = append(
            this.#publicMessages,
            event,
            RECENT_PUBLIC_MESSAGE_LIMIT,
          );
          break;
        case 'direct-message-sent':
          for (const participant of [event.agentId, event.recipientId])
            appendFor(
              this.#directMessages,
              participant,
              event,
              RECENT_DIRECT_MESSAGE_LIMIT,
            );
          break;
        case 'alliance-message-sent':
          for (const participant of new Set([
            event.agentId,
            ...event.recipientIds,
          ]))
            appendFor(
              this.#allianceMessages,
              participant,
              event,
              RECENT_DIRECT_MESSAGE_LIMIT,
            );
          break;
        case 'zero-message-sent':
          for (const participant of new Set([
            event.agentId,
            ...event.recipientIds,
          ]))
            appendFor(
              this.#zeroMessages,
              participant,
              event,
              RECENT_ZERO_MESSAGE_LIMIT,
            );
          break;
        case 'alliance-proposed':
        case 'alliance-proposal-closed':
        case 'alliance-formed':
        case 'agent-joined-alliance':
        case 'agent-left-alliance':
        case 'alliance-dissolved':
          this.#allianceEvents = append(
            this.#allianceEvents,
            event,
            RECENT_ZERO_STRATEGIC_EVENT_LIMIT,
          );
          break;
        case 'simulated-player-moved':
        case 'hex-disinfected':
        case 'simulated-player-clean-blocked':
          break;
      }
    }
  }

  movements(agentId: AgentId) {
    return structuredClone(this.#movements.get(agentId) ?? []);
  }
  actions() {
    return structuredClone(this.#actions);
  }
  publicMessages() {
    return structuredClone(this.#publicMessages);
  }
  directMessages(agentId: AgentId) {
    return structuredClone(this.#directMessages.get(agentId) ?? []);
  }
  allianceMessages(agentId: AgentId) {
    return structuredClone(this.#allianceMessages.get(agentId) ?? []);
  }
  zeroMessages(agentId: AgentId) {
    return structuredClone(this.#zeroMessages.get(agentId) ?? []);
  }
  controlChanges(agentId: AgentId) {
    return structuredClone(this.#controlChanges.get(agentId) ?? []);
  }
  allianceEvents(limit: number = RECENT_ALLIANCE_EVENT_LIMIT) {
    return structuredClone(this.#allianceEvents.slice(-limit));
  }
  captures() {
    return structuredClone(this.#captures);
  }

  #contains(eventId: string): boolean {
    return [
      ...this.#movements.values(),
      this.#actions,
      this.#publicMessages,
      ...this.#directMessages.values(),
      ...this.#allianceMessages.values(),
      ...this.#zeroMessages.values(),
      ...this.#controlChanges.values(),
      this.#allianceEvents,
      this.#captures,
    ].some((events) => events.some(({ id }) => id === eventId));
  }
}

function append<T>(items: readonly T[], item: T, limit: number): T[] {
  return [...items, structuredClone(item)].slice(-limit);
}

function appendFor<T>(
  map: Map<AgentId, T[]>,
  agentId: AgentId,
  item: T,
  limit: number,
): void {
  map.set(agentId, append(map.get(agentId) ?? [], item, limit));
}
