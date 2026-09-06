import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  worldEventSchema,
  type AgentId,
  type WorldEvent,
} from '@hexzero/shared';
import { ObservationHistory } from './observation-history';

const actor = agentIdSchema.parse('00000000-0000-4000-8000-000000000001');
const peer = agentIdSchema.parse('00000000-0000-4000-8000-000000000002');
const outsider = agentIdSchema.parse('00000000-0000-4000-8000-000000000003');
const cellA = '892a94d232bffff';
const cellB = '892a94d2323ffff';

describe('ObservationHistory', () => {
  it('retains independent factual streams through more than 120 unrelated events', () => {
    const history = new ObservationHistory();
    history.ingest([
      ...range(7).map((index) => movement(actor, index)),
      ...range(10).map((index) => waited(actor, index)),
      ...range(15).map((index) => publicMessage(actor, index)),
      ...range(7).map((index) => directMessage(actor, peer, index)),
      ...range(7).map((index) => allianceMessage(actor, [peer], index)),
      ...range(7).map((index) => zeroMessage(actor, [peer], index)),
      ...range(7).map((index) => capture(actor, peer, index)),
      ...range(14).map((index) => proposed(actor, peer, index)),
    ]);
    history.ingest(
      range(130).map((index) => directMessage(outsider, peer, index + 100)),
    );

    expect(ids(history.movements(actor))).toEqual(
      range(6).map((index) => eventId(index + 1)),
    );
    expect(history.actions()).toHaveLength(8);
    expect(history.publicMessages()).toHaveLength(12);
    expect(history.directMessages(actor)).toHaveLength(6);
    expect(history.directMessages(outsider)).toHaveLength(6);
    expect(history.directMessages(agent('4'))).toEqual([]);
    expect(history.allianceMessages(actor)).toHaveLength(6);
    expect(history.allianceMessages(peer)).toHaveLength(6);
    expect(history.allianceMessages(outsider)).toEqual([]);
    expect(history.zeroMessages(actor)).toHaveLength(6);
    expect(history.zeroMessages(peer)).toHaveLength(6);
    expect(history.zeroMessages(outsider)).toEqual([]);
    expect(history.controlChanges(actor)).toHaveLength(6);
    expect(history.controlChanges(peer)).toHaveLength(6);
    expect(history.captures()).toHaveLength(6);
    expect(history.allianceEvents(8)).toHaveLength(8);
    expect(history.allianceEvents(12)).toHaveLength(12);
  });

  it('initializes existing facts in order and ingests an event ID only once', () => {
    const first = directMessage(actor, peer, 1);
    const second = directMessage(peer, actor, 2);
    const history = new ObservationHistory([first]);
    history.ingest([first, second]);

    expect(ids(history.directMessages(actor))).toEqual([first.id, second.id]);
    expect(ids(history.directMessages(peer))).toEqual([first.id, second.id]);
  });
});

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function agent(last: string): AgentId {
  return agentIdSchema.parse(`00000000-0000-4000-8000-00000000000${last}`);
}

function eventId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function event(input: Record<string, unknown>, index: number): WorldEvent {
  return worldEventSchema.parse({
    id: eventId(index),
    occurredAt: `2026-08-25T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    ...input,
  });
}

function movement(agentId: AgentId, index: number): WorldEvent {
  return event(
    { type: 'agent-moved', agentId, fromCell: cellA, toCell: cellB },
    index,
  );
}

function waited(agentId: AgentId, index: number): WorldEvent {
  return event({ type: 'agent-waited', agentId }, index + 20);
}

function publicMessage(agentId: AgentId, index: number): WorldEvent {
  return event(
    {
      type: 'public-message-sent',
      channel: 'public',
      agentId,
      message: `public ${index}`,
      playerVisible: true,
    },
    index + 40,
  );
}

function directMessage(
  agentId: AgentId,
  recipientId: AgentId,
  index: number,
): WorldEvent {
  return event(
    {
      type: 'direct-message-sent',
      channel: 'direct',
      agentId,
      recipientId,
      message: `direct ${index}`,
      distance: 1,
      playerVisible: false,
    },
    index + 1000,
  );
}

function allianceMessage(
  agentId: AgentId,
  recipientIds: AgentId[],
  index: number,
): WorldEvent {
  return event(
    {
      type: 'alliance-message-sent',
      channel: 'alliance',
      agentId,
      recipientIds,
      allianceId: '20000000-0000-4000-8000-000000000001',
      message: `alliance ${index}`,
      playerVisible: false,
    },
    index + 70,
  );
}

function zeroMessage(
  agentId: AgentId,
  recipientIds: AgentId[],
  index: number,
): WorldEvent {
  return event(
    {
      type: 'zero-message-sent',
      channel: 'zero',
      agentId,
      recipientIds,
      message: `zero ${index}`,
      playerVisible: false,
    },
    index + 80,
  );
}

function capture(
  controllerAgentId: AgentId,
  previousControllerAgentId: AgentId,
  index: number,
): WorldEvent {
  return event(
    {
      type: 'hex-captured',
      agentId: controllerAgentId,
      controllerAgentId,
      previousControllerAgentId,
      cell: cellA,
    },
    index + 90,
  );
}

function proposed(
  agentId: AgentId,
  recipientAgentId: AgentId,
  index: number,
): WorldEvent {
  return event(
    {
      type: 'alliance-proposed',
      agentId,
      recipientAgentId,
      proposalId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      allianceId: null,
      turnNumber: index + 1,
      expirationTurn: index + 10,
    },
    index + 110,
  );
}

function ids(events: readonly WorldEvent[]): string[] {
  return events.map(({ id }) => id);
}
