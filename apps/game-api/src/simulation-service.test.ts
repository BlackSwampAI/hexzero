import { describe, expect, it } from 'vitest';
import {
  DeterministicReflexProvider,
  DeterministicSwarmPlanner,
} from '@hexzero/agent-runtime';
import type { CompatibleModel } from '@hexzero/shared';
import { SimulationService } from './simulation-service';

const model: CompatibleModel = {
  id: 'test/zero',
  name: 'Test Zero',
  author: 'test',
  contextLength: 4096,
  inputPricePerToken: '0',
  outputPricePerToken: '0',
  supportedParameters: [],
  isFree: true,
  reasoning: { mandatory: false, supportedEfforts: ['low'] },
};

function service() {
  const simulation = new SimulationService({
    swarmPlanner: new DeterministicSwarmPlanner(),
    reflexProvider: new DeterministicReflexProvider(),
    now: () => '2026-08-13T12:00:00.000Z',
  });
  simulation.setCompatibleModels([model]);
  simulation.applyWorldSetup({
    ...simulation.getDefaultWorldSetup(),
    modelConfiguration: {
      globalModelId: model.id,
      globalReasoningProfile: 'low',
      overrides: [],
      locked: false,
    },
  });
  return simulation;
}

describe('SimulationService swarm execution', () => {
  it('commits Zero directives and worker reflex actions in one tick', async () => {
    const simulation = service();
    const tick = await simulation.executeNextTick();
    expect(tick?.planSource).toBe('zero-llm');
    expect(tick?.workers.length).toBeGreaterThan(0);
    expect(simulation.getSnapshot().tickNumber).toBe(1);
  });

  it('resets committed swarm state without retaining ticks', async () => {
    const simulation = service();
    await simulation.executeNextTick();
    const reset = simulation.reset();
    expect(reset.tickNumber).toBe(0);
    expect(reset.swarmTicks).toEqual([]);
  });
});
