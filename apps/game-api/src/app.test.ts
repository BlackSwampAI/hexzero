import { describe, expect, it } from 'vitest';
import {
  DeterministicReflexProvider,
  DeterministicSwarmPlanner,
} from '@hexzero/agent-runtime';
import {
  defaultWorldSetupResponseSchema,
  healthResponseSchema,
  simulationSnapshotSchema,
  singleTickResponseSchema,
} from '@hexzero/shared';
import { createApp, swarmProvidersFromEnvironment } from './app';

describe('game API swarm boundary', () => {
  it('uses repeatable swarm-native providers for scripted environments', () => {
    const providers = swarmProvidersFromEnvironment({
      HEXZERO_PROVIDER: 'scripted',
    });
    expect(providers.swarmPlanner).toBeInstanceOf(DeterministicSwarmPlanner);
    expect(providers.reflexProvider).toBeInstanceOf(
      DeterministicReflexProvider,
    );
  });

  it('serves health and the swarm setup contract', async () => {
    const app = createApp({
      swarmPlanner: new DeterministicSwarmPlanner(),
      reflexProvider: new DeterministicReflexProvider(),
    });
    expect(
      healthResponseSchema.parse(await (await app.request('/health')).json()),
    ).toMatchObject({ status: 'ok' });
    const setup = defaultWorldSetupResponseSchema.parse(
      await (
        await app.request('/api/simulation/experiment/setup/default')
      ).json(),
    );
    expect(setup.request.swarmArchitectureVersion).toBe('zero-swarm-v1');
  });

  it('commits an atomic swarm tick through the public endpoint', async () => {
    const app = createApp({
      swarmPlanner: new DeterministicSwarmPlanner(),
      reflexProvider: new DeterministicReflexProvider(),
    });
    const response = await app.request('/api/simulation/tick', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(singleTickResponseSchema.parse(body).tickNumber).toBe(1);
    expect(body).not.toHaveProperty('records');
    expect(
      simulationSnapshotSchema.parse(
        await (await app.request('/api/simulation')).json(),
      ).swarmTicks,
    ).toHaveLength(1);
  });

  it('does not expose legacy sequential-turn execution routes', async () => {
    const app = createApp({
      swarmPlanner: new DeterministicSwarmPlanner(),
      reflexProvider: new DeterministicReflexProvider(),
    });
    for (const route of [
      '/api/simulation/turn',
      '/api/simulation/turn/retry',
      '/api/simulation/turn/skip',
      '/api/simulation/turn/unattended-retry',
      '/api/simulation/turn/unattended-skip',
    ])
      expect((await app.request(route, { method: 'POST' })).status, route).toBe(
        404,
      );
  });
});
