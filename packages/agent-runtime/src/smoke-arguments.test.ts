import { describe, expect, it } from 'vitest';
import { agentObservationSchema } from '@hexzero/shared';
import { parseRealProviderSmokeArguments } from './smoke-arguments';
import { buildRealProviderSmokeObservation } from './smoke-observation';

describe('parseRealProviderSmokeArguments', () => {
  it.each([
    ['pnpm-forwarded arguments', ['--', 'google/gemini-3.7-flash', 'stateful']],
    ['direct arguments', ['google/gemini-3.7-flash', 'stateful']],
  ])('accepts %s', (_label, argv) => {
    expect(parseRealProviderSmokeArguments(argv)).toEqual({
      model: 'google/gemini-3.7-flash',
      scenario: 'stateful',
    });
  });

  it('defaults a pnpm-forwarded invocation to the initial scenario', () => {
    expect(
      parseRealProviderSmokeArguments(['--', 'google/gemini-3.7-flash']),
    ).toEqual({
      model: 'google/gemini-3.7-flash',
      scenario: 'initial',
    });
  });

  it.each([
    [[], 'Pass an explicit compatible model slug'],
    [['--'], 'Pass an explicit compatible model slug'],
    [
      ['google/gemini-3.7-flash', 'unknown'],
      'Smoke scenario must be either initial or stateful',
    ],
  ])('rejects invalid arguments %#', (argv, message) => {
    expect(() => parseRealProviderSmokeArguments(argv)).toThrow(message);
  });
});

describe('buildRealProviderSmokeObservation', () => {
  it('constructs a current production-schema initial observation', () => {
    const observation = buildRealProviderSmokeObservation('initial');

    expect(agentObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.currentGoal).toBeNull();
    expect(observation.goalAvailability).toEqual({
      active: false,
      availableOperations: ['establish'],
    });
    expect(observation.currentMemory).toEqual([]);
    expect(observation.memoryAvailability).toEqual({
      remember: true,
      revisableMemoryIds: [],
      forgettableMemoryIds: [],
    });
  });

  it('constructs a current production-schema stateful observation', () => {
    const observation = buildRealProviderSmokeObservation('stateful');

    expect(agentObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.currentGoal).toMatchObject({
      longTermGoal: 'Build durable influence in this region.',
      establishedAtTick: 1,
      revisedAtTick: 1,
    });
    expect(observation.goalAvailability).toEqual({
      active: true,
      availableOperations: ['keep', 'revise', 'complete', 'abandon'],
    });
    expect(observation.currentMemory).toHaveLength(1);
    expect(observation.memoryAvailability).toEqual({
      remember: true,
      revisableMemoryIds: [observation.currentMemory[0]!.id],
      forgettableMemoryIds: [observation.currentMemory[0]!.id],
    });
  });
});
