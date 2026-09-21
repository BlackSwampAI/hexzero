import { gridDisk } from 'h3-js';
import { describe, expect, it } from 'vitest';
import {
  simulatedPlayerEventSchema,
  type SimulatedPlayerEvent,
  type H3Cell,
} from '@hexzero/shared';
import { createDevelopmentWorld, toWorldState } from '@hexzero/world-engine';
import { boundedPressureEvents, localPressureAtCell } from './swarm-pressure';

const timestamp = '2026-08-13T12:00:00.000Z';

function disinfection(cell: H3Cell, id: string, tick = 1) {
  return simulatedPlayerEventSchema.parse({
    id,
    occurredAt: timestamp,
    profile: 'trail-hunter-v1',
    originatingTick: tick,
    type: 'hex-disinfected',
    cell,
    previousControllerAgentId: null,
  }) as Extract<SimulatedPlayerEvent, { type: 'hex-disinfected' }>;
}

describe('swarm pressure', () => {
  const state = toWorldState(createDevelopmentWorld());
  const cell = [...state.agents.values()][1]!.currentCell;
  const ring = gridDisk(cell, 3) as H3Cell[];
  const adjacent = ring.find((candidate) => candidate !== cell)!;
  const nearby = ring.find(
    (candidate) => !gridDisk(cell, 1).includes(candidate),
  )!;
  const distant = ring.find(
    (candidate) => !gridDisk(cell, 2).includes(candidate),
  )!;

  it('classifies one-cell, two-cell, and distant public disinfections', () => {
    expect(
      localPressureAtCell(cell, [
        disinfection(adjacent, '00000000-0000-4000-8000-000000000001'),
      ]).localPressure,
    ).toBe('high');
    expect(
      localPressureAtCell(cell, [
        disinfection(nearby, '00000000-0000-4000-8000-000000000002'),
      ]).localPressure,
    ).toBe('rising');
    expect(
      localPressureAtCell(cell, [
        disinfection(distant, '00000000-0000-4000-8000-000000000003'),
      ]),
    ).toEqual({
      localPressure: 'low',
      pressureDirection: null,
      pressureDistance: null,
    });
  });

  it('bounds retained plus current public events without duplication', () => {
    const events = Array.from({ length: 7 }, (_, index) =>
      disinfection(
        index % 2 === 0 ? adjacent : nearby,
        `00000000-0000-4000-8000-0000000000${10 + index}`,
        index + 1,
      ),
    );
    const combined = boundedPressureEvents(events, [events[1]!, ...events]);
    expect(combined.map(({ id }) => id)).toEqual(
      events.slice(-6).map(({ id }) => id),
    );
    expect(combined).toHaveLength(6);
  });
});
