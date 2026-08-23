import { describe, expect, it, vi } from 'vitest';
import {
  AgentProviderError,
  BrowserTestAgentProvider,
  OpenRouterAgentProvider,
  ScriptedAgentProvider,
  type AgentProvider,
  type ProviderDecision,
} from '@hexzero/agent-runtime';
import {
  ArchivePersistenceError,
  ExperimentImportError,
} from '@hexzero/experiment-archive';
import {
  cancelledTurnResponseSchema,
  archiveExperimentExportResponseSchema,
  apiErrorSchema,
  defaultWorldSetupResponseSchema,
  h3CellSchema,
  experimentExportPreviewSchema,
  experimentExportResponseSchema,
  healthResponseSchema,
  modelCatalogResponseSchema,
  resetSimulationResponseSchema,
  restoreDefaultPersonalitiesResponseSchema,
  simulationSnapshotSchema,
  singleTurnResponseSchema,
  singleTickResponseSchema,
  updateAgentPersonalityResponseSchema,
  updateExperimentModelsResponseSchema,
  verifyModelResponseSchema,
  type ExperimentExportDocument,
} from '@hexzero/shared';
import {
  createApp,
  providerFromEnvironment,
  resolveProviderModeFromEnvironment,
} from './app';

describe('provider environment compatibility', () => {
  it('uses the canonical provider variable without a warning', () => {
    const warn = vi.fn();
    expect(
      providerFromEnvironment({ HEXZERO_PROVIDER: 'scripted' }, warn),
    ).toBeInstanceOf(BrowserTestAgentProvider);
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers the canonical provider variable over the legacy alias', () => {
    const warn = vi.fn();
    expect(
      resolveProviderModeFromEnvironment(
        {
          HEXZERO_PROVIDER: 'openrouter',
          AGENTBORNE_PROVIDER: 'scripted',
        },
        warn,
      ),
    ).toBe('openrouter');
    expect(warn).not.toHaveBeenCalled();
  });

  it('supports the legacy provider alias with a value-free warning', () => {
    const warn = vi.fn();
    expect(
      providerFromEnvironment({ AGENTBORNE_PROVIDER: 'scripted' }, warn),
    ).toBeInstanceOf(BrowserTestAgentProvider);
    expect(warn).toHaveBeenCalledWith(
      'AGENTBORNE_PROVIDER is deprecated; use HEXZERO_PROVIDER. Continuing with the legacy setting.',
    );
  });
});

describe('game API simulation boundary', () => {
  it('requires a known Patient Zero through the public setup boundary', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    const defaultsResponse = await app.request(
      '/api/simulation/experiment/setup/default',
    );
    expect(defaultsResponse.status).toBe(200);
    const defaults = defaultWorldSetupResponseSchema.parse(
      await defaultsResponse.json(),
    ).request;
    expect(defaults.patientZeroAgentId).toBe(defaults.roster[0]!.id);

    const invalidRequests: unknown[] = [
      { ...defaults, patientZeroAgentId: undefined },
      { ...defaults, patientZeroAgentId: null },
      {
        ...defaults,
        patientZeroAgentId: '00000000-0000-4000-8000-000000000999',
      },
    ];
    for (const request of invalidRequests) {
      const response = await app.request('/api/simulation/experiment/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json())).toMatchObject({
        error: { code: 'invalid_request' },
      });
    }
  });

  it('coalesces repeated delivery of the same tick mutation ID', async () => {
    let calls = 0;
    const app = createApp({
      provider: {
        mode: 'scripted-test',
        configured: true,
        async decide(): Promise<ProviderDecision> {
          calls += 1;
          await Promise.resolve();
          return {
            decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
            metadata: {
              provider: 'scripted-test',
              model: 'tick-idempotency',
              latencyMs: 0,
              costCredits: 0,
            },
          };
        },
      },
    });
    const request = () =>
      app.request('/api/simulation/tick?mutationId=tick_same_001', {
        method: 'POST',
      });
    const [first, second] = await Promise.all([request(), request()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toBe(8);
    expect(
      simulationSnapshotSchema.parse(
        await (await app.request('/api/simulation')).json(),
      ).tickNumber,
    ).toBe(1);
  });

  it('replays the original complete tick envelope after later ticks commit', async () => {
    let calls = 0;
    const app = createApp({
      provider: {
        mode: 'scripted-test',
        configured: true,
        async decide(): Promise<ProviderDecision> {
          calls += 1;
          return {
            decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
            metadata: {
              provider: 'scripted-test',
              model: 'tick-replay',
              latencyMs: 0,
              costCredits: 0,
            },
          };
        },
      },
    });
    const first = singleTickResponseSchema.parse(
      await (
        await app.request('/api/simulation/tick?mutationId=tick_replay_A', {
          method: 'POST',
        })
      ).json(),
    );
    const second = singleTickResponseSchema.parse(
      await (
        await app.request('/api/simulation/tick?mutationId=tick_replay_B', {
          method: 'POST',
        })
      ).json(),
    );
    const replay = singleTickResponseSchema.parse(
      await (
        await app.request('/api/simulation/tick?mutationId=tick_replay_A', {
          method: 'POST',
        })
      ).json(),
    );
    expect(first).toMatchObject({ tickNumber: 1, snapshot: { tickNumber: 1 } });
    expect(second).toMatchObject({
      tickNumber: 2,
      snapshot: { tickNumber: 2 },
    });
    expect(replay).toEqual(first);
    expect(calls).toBe(16);
    expect(
      simulationSnapshotSchema.parse(
        await (await app.request('/api/simulation')).json(),
      ).tickNumber,
    ).toBe(2);
  });

  it('returns one complete simultaneous tick group', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider(
        Array.from({ length: 8 }, () => ({
          worldAction: { type: 'wait' as const },
          summary: 'Wait.',
        })),
      ),
    });
    const response = await app.request('/api/simulation/tick', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(singleTickResponseSchema.parse(await response.json())).toMatchObject(
      {
        tickNumber: 1,
        snapshot: { tickNumber: 1, turnNumber: 8 },
      },
    );
  });

  it('coalesces repeated delivery of the same turn mutation ID', async () => {
    let calls = 0;
    const app = createApp({
      provider: {
        mode: 'scripted-test',
        configured: true,
        async decide(): Promise<ProviderDecision> {
          calls += 1;
          await Promise.resolve();
          return {
            decision: { worldAction: { type: 'wait' }, summary: 'Wait once.' },
            metadata: {
              provider: 'scripted-test',
              model: 'mutation-test',
              latencyMs: 0,
              costCredits: 0,
            },
          };
        },
      },
    });
    const request = () =>
      app.request('/api/simulation/turn', {
        method: 'POST',
        headers: { 'X-Hexzero-Mutation-Id': 'mutation_same_001' },
      });
    const [first, duplicate] = await Promise.all([request(), request()]);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(calls).toBe(1);
    expect(
      simulationSnapshotSchema.parse(
        await (await app.request('/api/simulation')).json(),
      ).turnNumber,
    ).toBe(1);
  });

  it('reports health and serves a schema-valid snapshot', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(healthResponseSchema.parse(await health.json()).status).toBe('ok');
    const response = await app.request('/api/simulation');
    expect(response.status).toBe(200);
    const payload = simulationSnapshotSchema.parse(await response.json());
    expect(payload.world.agents).toHaveLength(8);
    expect(
      payload.world.hexes.every(
        (hex) => hex.state === 'open' && hex.controllerAgentId === null,
      ),
    ).toBe(true);
    expect(payload.experiment.currentTerritory).toHaveLength(8);
  });

  it('returns a non-tick-consuming cancellation response from the tick route', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'cancel-test',
      configured: true,
      async decide(_observation, _model, options) {
        requestStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        throw new AgentProviderError({
          code: 'cancelled',
          message: 'The model request was cancelled by the operator.',
          retryable: false,
        });
      },
    };
    const app = createApp({ provider });
    const pendingTurn = app.request('/api/simulation/tick', { method: 'POST' });
    await started;
    expect(
      (await app.request('/api/simulation/tick/cancel', { method: 'POST' }))
        .status,
    ).toBe(200);
    const response = await pendingTurn;
    expect(response.status).toBe(200);
    expect(
      cancelledTurnResponseSchema.parse(await response.json()),
    ).toMatchObject({
      cancelled: true,
      snapshot: {
        status: 'paused',
        turnNumber: 0,
        tickNumber: 0,
        turns: [],
        experiment: { totalCompletedTurns: 0 },
      },
    });
  });

  it('serves and refreshes sanitized catalogs without exposing the server key', async () => {
    const secret = 'server-only-secret-marker';
    const forced: boolean[] = [];
    const catalogResponse = modelCatalogResponseSchema.parse({
      models: [
        {
          id: 'example/compatible-model',
          name: 'Compatible model',
          author: 'example',
          contextLength: 32_768,
          inputPricePerToken: '0.000001',
          outputPricePerToken: '0.000002',
          supportedParameters: ['max_tokens'],
          isFree: false,
        },
      ],
      filteredOutCount: 4,
      stale: false,
      requirements: {
        input: 'text',
        output: 'text',
        endpoint: 'chat-completions',
        requiredParameters: ['max_tokens'],
        minimumContextLength: 16_384,
        streaming: false,
      },
    });
    const app = createApp({
      provider: new OpenRouterAgentProvider({ apiKey: secret }),
      catalog: {
        async getCatalog(force = false) {
          forced.push(force);
          return catalogResponse;
        },
      },
    });
    const catalog = await (await app.request('/api/simulation/models')).json();
    expect(modelCatalogResponseSchema.parse(catalog).models).toHaveLength(1);
    const assigned = updateExperimentModelsResponseSchema.parse(
      await (
        await app.request('/api/simulation/experiment/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            globalModelId: 'example/compatible-model',
            overrides: [],
          }),
        })
      ).json(),
    );
    expect(
      assigned.snapshot.resolvedModels.every(({ available }) => available),
    ).toBe(true);
    const refreshed = await (
      await app.request('/api/simulation/models/refresh', { method: 'POST' })
    ).json();
    expect(forced).toEqual([false, false, true]);
    expect(JSON.stringify({ catalog, assigned, refreshed })).not.toContain(
      secret,
    );
  });

  it('caches an explicit model probe without advancing the world', async () => {
    let calls = 0;
    const profiles: string[] = [];
    const provider: AgentProvider = {
      mode: 'openrouter',
      configured: true,
      async decide(_observation, model, options) {
        calls += 1;
        expect(options?.reasoningProfile).toBeDefined();
        profiles.push(options?.reasoningProfile ?? 'provider-default');
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Probe.' },
          metadata: { provider: 'openrouter', model, latencyMs: 1 },
        };
      },
    };
    const catalogResponse = modelCatalogResponseSchema.parse({
      models: [
        {
          id: 'example/probe-model',
          name: 'Probe model',
          author: 'example',
          contextLength: 16_384,
          inputPricePerToken: '0',
          outputPricePerToken: '0',
          supportedParameters: ['max_tokens'],
          isFree: true,
          reasoning: {
            mandatory: false,
            supportedEfforts: ['low', 'medium', 'xhigh'],
          },
        },
      ],
      filteredOutCount: 0,
      stale: false,
      requirements: {
        input: 'text',
        output: 'text',
        endpoint: 'chat-completions',
        requiredParameters: ['max_tokens'],
        minimumContextLength: 16_384,
        streaming: false,
      },
    });
    const app = createApp({
      provider,
      catalog: {
        async getCatalog() {
          return catalogResponse;
        },
      },
    });
    const before = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    for (let index = 0; index < 2; index += 1) {
      const response = await app.request('/api/simulation/models/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: 'example/probe-model',
          reasoningProfile: 'low',
        }),
      });
      expect(
        verifyModelResponseSchema.parse(await response.json()).verification
          .status,
      ).toBe('verified');
    }
    const differentProfile = await app.request(
      '/api/simulation/models/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: 'example/probe-model',
          reasoningProfile: 'medium',
        }),
      },
    );
    expect(
      verifyModelResponseSchema.parse(await differentProfile.json())
        .verification.reasoningProfile,
    ).toBe('medium');
    const after = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    expect(calls).toBe(2);
    expect(profiles).toEqual(['low', 'medium']);
    expect(after.world).toEqual(before.world);
    expect(after.turnNumber).toBe(0);
  });

  it('returns accepted and rejected single-turn records with valid response shapes', async () => {
    const acceptedApp = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    });
    const accepted = singleTurnResponseSchema.parse(
      await (
        await acceptedApp.request('/api/simulation/turn', { method: 'POST' })
      ).json(),
    );
    expect(accepted.turn.outcome).toBe('accepted');
    if (accepted.turn.outcome !== 'accepted')
      throw new Error('Expected accepted infection fixture.');
    expect(accepted.turn).toMatchObject({
      worldActionResult: {
        event: {
          type: 'hex-infected',
          controllerAgentId: accepted.turn.agentId,
        },
      },
    });
    expect(
      accepted.snapshot.world.hexes.find(
        ({ cell }) => cell === accepted.turn.observation.currentCell.cell,
      ),
    ).toMatchObject({
      state: 'infected',
      controllerAgentId: accepted.turn.agentId,
    });

    const rejectedApp = createApp({
      provider: new ScriptedAgentProvider([
        {
          worldAction: {
            type: 'move',
            targetCell: h3CellSchema.parse('8928308280fffff'),
          },
          summary: 'Move far away.',
        },
      ]),
    });
    const rejected = singleTurnResponseSchema.parse(
      await (
        await rejectedApp.request('/api/simulation/turn', { method: 'POST' })
      ).json(),
    );
    expect(rejected.turn.outcome).toBe('rejected');
  });

  it('returns independently typed world-action and communication responses', async () => {
    const bootstrap = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'placeholder' },
      ]),
    });
    const snapshot = simulationSnapshotSchema.parse(
      await (await bootstrap.request('/api/simulation')).json(),
    );
    const [sender, recipient] = snapshot.world.agents;
    const acceptedApp = createApp({
      provider: new ScriptedAgentProvider([
        {
          worldAction: { type: 'wait' },
          communication: {
            channel: 'direct',
            recipientId: recipient!.id,
            message: 'Nearby API message.',
          },
          summary: 'Send.',
        },
      ]),
    });
    const accepted = singleTurnResponseSchema.parse(
      await (
        await acceptedApp.request('/api/simulation/turn', { method: 'POST' })
      ).json(),
    );
    expect(accepted.turn).toMatchObject({
      outcome: 'accepted',
      communicationResult: {
        accepted: true,
        event: {
          type: 'direct-message-sent',
          agentId: sender!.id,
          recipientId: recipient!.id,
          message: 'Nearby API message.',
        },
      },
    });

    const rejectedApp = createApp({
      provider: new ScriptedAgentProvider([
        {
          worldAction: { type: 'wait' },
          communication: {
            channel: 'direct',
            recipientId: sender!.id,
            message: 'Self message.',
          },
          summary: 'Try.',
        },
      ]),
    });
    const rejected = singleTurnResponseSchema.parse(
      await (
        await rejectedApp.request('/api/simulation/turn', { method: 'POST' })
      ).json(),
    );
    expect(rejected.turn).toMatchObject({
      outcome: 'accepted',
      communicationResult: { accepted: false, reason: 'self-message' },
    });
    expect(rejected.snapshot.world.events).toHaveLength(1);
  });

  it('returns provider failures and missing configuration safely', async () => {
    const failureProvider: AgentProvider = {
      mode: 'scripted-test',
      model: 'failure-test',
      configured: true,
      async decide() {
        throw new AgentProviderError(
          {
            code: 'network',
            message: 'The model provider could not be reached.',
            retryable: true,
          },
          undefined,
          {
            httpStatus: 400,
            providerMessage: 'internal-diagnostic-marker',
            model: 'example/compatible-model',
          },
        );
      },
    };
    const failed = singleTurnResponseSchema.parse(
      await (
        await createApp({ provider: failureProvider }).request(
          '/api/simulation/turn',
          { method: 'POST' },
        )
      ).json(),
    );
    expect(failed.turn.outcome).toBe('provider-error');
    expect(JSON.stringify(failed)).not.toContain('internal-diagnostic-marker');

    const missing = createApp({ provider: new OpenRouterAgentProvider() });
    const snapshot = simulationSnapshotSchema.parse(
      await (await missing.request('/api/simulation')).json(),
    );
    expect(snapshot).toMatchObject({
      status: 'configuration-error',
      providerConfigured: false,
    });
  });

  it('exposes explicit retry and skip operations for one pending logical turn', async () => {
    let calls = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'manual-control-test',
      configured: true,
      async decide() {
        calls += 1;
        throw new AgentProviderError({
          code: 'timeout',
          message: 'Timed out.',
          retryable: true,
        });
      },
    };
    const app = createApp({ provider });
    const failed = singleTurnResponseSchema.parse(
      await (
        await app.request('/api/simulation/turn', { method: 'POST' })
      ).json(),
    );
    expect(failed.snapshot).toMatchObject({
      turnNumber: 0,
      pendingFailedTurn: { turnNumber: 1 },
    });
    const retried = singleTurnResponseSchema.parse(
      await (
        await app.request('/api/simulation/turn/retry', { method: 'POST' })
      ).json(),
    );
    expect(calls).toBe(3);
    expect(retried.snapshot.pendingFailedTurn?.attempts).toHaveLength(3);
    const skipped = singleTurnResponseSchema.parse(
      await (
        await app.request('/api/simulation/turn/skip', { method: 'POST' })
      ).json(),
    );
    expect(skipped.turn).toMatchObject({
      turnNumber: 1,
      outcome: 'operator-skipped',
    });
    expect(skipped.snapshot).toMatchObject({
      turnNumber: 1,
      status: 'paused',
      pendingFailedTurn: null,
    });
  });

  it('returns recoverable post-provider validation failures without advancing', async () => {
    let calls = 0;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'invalid-metadata-test',
      configured: true,
      async decide(): Promise<ProviderDecision> {
        calls += 1;
        return {
          decision: { worldAction: { type: 'wait' }, summary: 'Wait.' },
          metadata: {
            provider: 'scripted-test',
            model: calls === 1 ? '' : 'invalid-metadata-test',
            latencyMs: 0,
          },
        } as ProviderDecision;
      },
    };
    const app = createApp({ provider });
    const initial = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );

    const failed = await app.request('/api/simulation/turn', {
      method: 'POST',
    });
    expect(failed.status).toBe(200);
    const failedTurn = singleTurnResponseSchema.parse(await failed.json());
    expect(failedTurn.turn).toMatchObject({
      outcome: 'provider-error',
      failure: { code: 'simulation-validation' },
    });

    const afterFailure = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    expect(afterFailure).toMatchObject({
      turnNumber: 0,
      turns: [],
      nextAgentId: initial.nextAgentId,
      activeAgentId: null,
      status: 'provider-error',
      pendingFailedTurn: { turnNumber: 1 },
    });
    expect(afterFailure.world).toEqual(initial.world);

    const recovered = singleTurnResponseSchema.parse(
      await (
        await app.request('/api/simulation/turn/retry', { method: 'POST' })
      ).json(),
    );
    expect(recovered.turn).toMatchObject({
      turnNumber: 1,
      agentId: initial.nextAgentId,
      outcome: 'accepted',
    });
  });

  it('resets world progress while preserving personality configuration', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    });
    const initial = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    await app.request(
      `/api/simulation/agents/${initial.world.agents[0]!.id}/personality`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personality: 'Preserved through reset.' }),
      },
    );
    await app.request('/api/simulation/turn', { method: 'POST' });
    const response = await app.request('/api/simulation/reset', {
      method: 'POST',
    });
    const reset = resetSimulationResponseSchema.parse(await response.json());
    expect(reset.snapshot.turnNumber).toBe(0);
    expect(reset.snapshot.world.events).toEqual([]);
    expect(reset.snapshot.world.agents[0]!.personality).toBe(
      'Preserved through reset.',
    );
  });

  it('updates one agent personality through a runtime-validated safe response', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    const initial = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    const agent = initial.world.agents[0]!;
    const response = await app.request(
      `/api/simulation/agents/${agent.id}/personality`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personality: '  Explore open edges.  ' }),
      },
    );
    expect(response.status).toBe(200);
    const payload = updateAgentPersonalityResponseSchema.parse(
      await response.json(),
    );
    expect(payload.agent.personality).toBe('Explore open edges.');
    expect(payload.snapshot.world.agents[0]!.personality).toBe(
      'Explore open edges.',
    );
    expect(JSON.stringify(payload)).not.toMatch(/api[_-]?key|secret|prompt/i);
  });

  it.each([
    JSON.stringify({ personality: '' }),
    JSON.stringify({ personality: 42 }),
    '{malformed',
  ])('rejects invalid personality request bodies safely', async (body) => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    const response = await app.request(
      '/api/simulation/agents/128f3f38-6b7d-4db7-9e95-751b4ce2681e/personality',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_personality',
        message: 'Personality must contain 1 to 600 characters.',
      },
    });
  });

  it('returns typed invalid and unknown agent errors without internal details', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    for (const [agentId, status, code] of [
      ['not-a-uuid', 400, 'invalid_agent_id'],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 404, 'unknown_agent'],
    ] as const) {
      const response = await app.request(
        `/api/simulation/agents/${agentId}/personality`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personality: 'Valid request.' }),
        },
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code } });
      expect(JSON.stringify(body)).not.toMatch(
        /stack|provider|openrouter|secret/i,
      );
    }
  });

  it('restores all default personalities without resetting progress', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'infect' }, summary: 'Infect.' },
      ]),
    });
    const initial = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    );
    const agent = initial.world.agents[0]!;
    await app.request(`/api/simulation/agents/${agent.id}/personality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personality: 'Custom.' }),
    });
    await app.request('/api/simulation/turn', { method: 'POST' });

    const response = await app.request(
      '/api/simulation/personalities/restore-defaults',
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const restored = restoreDefaultPersonalitiesResponseSchema.parse(
      await response.json(),
    );
    expect(restored.snapshot.turnNumber).toBe(1);
    expect(restored.snapshot.world.events).toHaveLength(1);
    expect(restored.snapshot.world.agents[0]!.personality).toBe(
      agent.personality,
    );
    expect(
      restored.snapshot.world.agents.find(({ name }) => name === 'Mingle')
        ?.personality,
    ).toBe(
      'You are a social coalition-builder. Seek agents, initiate and continue conversations, propose alliances, answer offers, negotiate borders, and coordinate captures against dominant rivals. Prefer cooperation and public diplomacy over silent expansion, but protect your own territory and leave an alliance that repeatedly ignores or exploits you. Make concrete proposals rather than merely announcing actions.',
    );
  });

  it('returns typed conflicts for an overlapping turn and reset', async () => {
    let release!: (result: ProviderDecision) => void;
    const provider: AgentProvider = {
      mode: 'scripted-test',
      model: 'deferred-test',
      configured: true,
      decide: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const app = createApp({ provider });
    const pending = app.request('/api/simulation/turn', { method: 'POST' });
    expect(
      (await app.request('/api/simulation/turn', { method: 'POST' })).status,
    ).toBe(409);
    expect(
      (await app.request('/api/simulation/reset', { method: 'POST' })).status,
    ).toBe(409);
    const agentId = simulationSnapshotSchema.parse(
      await (await app.request('/api/simulation')).json(),
    ).world.agents[0]!.id;
    const editConflict = await app.request(
      `/api/simulation/agents/${agentId}/personality`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personality: 'Blocked.' }),
      },
    );
    expect(editConflict.status).toBe(409);
    await expect(editConflict.json()).resolves.toMatchObject({
      error: { code: 'personality_conflict' },
    });
    const restoreConflict = await app.request(
      '/api/simulation/personalities/restore-defaults',
      { method: 'POST' },
    );
    expect(restoreConflict.status).toBe(409);
    await expect(restoreConflict.json()).resolves.toMatchObject({
      error: { code: 'personality_conflict' },
    });
    const exportConflict = await app.request(
      '/api/simulation/experiment/export/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agents: { mode: 'all' },
          turns: { mode: 'entire-retained' },
          outcomes: ['accepted'],
          actions: ['wait'],
          level: 'minimal',
        }),
      },
    );
    expect(exportConflict.status).toBe(409);
    await expect(exportConflict.json()).resolves.toMatchObject({
      error: { code: 'export_conflict' },
    });
    release({
      decision: { worldAction: { type: 'wait' }, summary: 'Done.' },
      metadata: {
        provider: 'scripted-test',
        model: 'deferred-test',
        latencyMs: 0,
      },
    });
    expect((await pending).status).toBe(200);
  });

  it('uses a predictable error envelope', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    const response = await app.request('/missing');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: 'The requested route does not exist.',
      },
    });
  });

  it('previews and generates schema-valid retained exports through narrow endpoints', async () => {
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
    });
    await app.request('/api/simulation/turn', { method: 'POST' });
    const request = {
      agents: { mode: 'all' },
      turns: { mode: 'entire-retained' },
      outcomes: ['accepted', 'rejected', 'provider-error'],
      actions: ['move', 'infect', 'capture', 'wait'],
      level: 'minimal',
    };
    const previewResponse = await app.request(
      '/api/simulation/experiment/export/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    expect(previewResponse.status).toBe(200);
    const preview = experimentExportPreviewSchema.parse(
      await previewResponse.json(),
    );
    expect(preview).toMatchObject({
      matchingTurnCount: 1,
      knownCostCredits: 0,
      attemptsWithUnknownCost: 0,
      turnsWithUnknownCost: 0,
    });
    const generatedResponse = await app.request(
      '/api/simulation/experiment/export',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const generated = experimentExportResponseSchema.parse(
      await generatedResponse.json(),
    );
    expect(
      generated.document.turns.map(({ turnNumber }) => turnNumber),
    ).toEqual([1]);
    expect(JSON.stringify(generated)).not.toMatch(
      /authorization|api[_-]?key|rawPrompt|rawBody|chainOfThought|privateReasoning/i,
    );
  });

  it('archives the exact supplied generated artifact through an injected writer', async () => {
    const archiveExperimentExport = vi.fn(
      (document: ExperimentExportDocument) => ({
        experimentId: document.experiment.id,
        inserted: 3,
        existing: 0,
        skipped: 1,
        rejected: 0,
        idempotent: false,
      }),
    );
    const app = createApp({
      provider: new ScriptedAgentProvider([
        { worldAction: { type: 'wait' }, summary: 'Wait.' },
      ]),
      archiveExperimentExport,
    });
    const request = {
      agents: { mode: 'all' as const },
      turns: { mode: 'entire-retained' as const },
      outcomes: ['accepted' as const],
      actions: ['wait' as const],
      level: 'minimal' as const,
    };
    const generatedResponse = await app.request(
      '/api/simulation/experiment/export',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const generated = experimentExportResponseSchema.parse(
      await generatedResponse.json(),
    );
    const response = await app.request(
      '/api/simulation/experiment/export/archive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(generated),
      },
    );
    expect(response.status).toBe(200);
    expect(archiveExperimentExport).toHaveBeenCalledWith(generated.document);
    expect(
      archiveExperimentExportResponseSchema.parse(await response.json()),
    ).toMatchObject({ inserted: 3, idempotent: false });
  });

  it('rejects invalid archive artifacts before invoking persistence', async () => {
    const archiveExperimentExport = vi.fn();
    const app = createApp({ archiveExperimentExport });
    const response = await app.request(
      '/api/simulation/experiment/export/archive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: { schemaVersion: 10 } }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_artifact' },
    });
    expect(archiveExperimentExport).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new ExperimentImportError('unsafe internal rejection detail'),
      status: 422,
      code: 'archive_rejected',
      message: 'The experiment archive rejected the export safely.',
    },
    {
      error: new ArchivePersistenceError('private filesystem detail'),
      status: 500,
      code: 'archive_persistence_failed',
      message: 'The local experiment archive could not be updated.',
    },
    {
      error: new ExperimentImportError(
        'wrapped private persistence detail',
        new ArchivePersistenceError('private database detail'),
      ),
      status: 500,
      code: 'archive_persistence_failed',
      message: 'The local experiment archive could not be updated.',
    },
  ])(
    'maps archive failures to safe API errors',
    async ({ error, status, code, message }) => {
      const sourceApp = createApp();
      const generatedResponse = await sourceApp.request(
        '/api/simulation/experiment/export',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agents: { mode: 'all' },
            turns: { mode: 'entire-retained' },
            outcomes: ['accepted'],
            actions: ['wait'],
            level: 'minimal',
          }),
        },
      );
      const generated = experimentExportResponseSchema.parse(
        await generatedResponse.json(),
      );
      const app = createApp({
        archiveExperimentExport: () => {
          throw error;
        },
      });
      const response = await app.request(
        '/api/simulation/experiment/export/archive',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generated),
        },
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toEqual({ error: { code, message } });
      expect(JSON.stringify(body)).not.toMatch(/private|filesystem|database/);
    },
  );

  it.each([
    [{}, 400, 'invalid_export'],
    [
      {
        agents: { mode: 'selected', agentIds: [] },
        turns: { mode: 'entire-retained' },
        outcomes: ['accepted'],
        actions: ['wait'],
        level: 'minimal',
      },
      400,
      'invalid_export',
    ],
    [
      {
        agents: {
          mode: 'selected',
          agentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        },
        turns: { mode: 'entire-retained' },
        outcomes: ['accepted'],
        actions: ['wait'],
        level: 'minimal',
      },
      404,
      'unknown_agent',
    ],
  ])(
    'returns typed safe export validation failures',
    async (body, status, code) => {
      const app = createApp({
        provider: new ScriptedAgentProvider([
          { worldAction: { type: 'wait' }, summary: 'Wait.' },
        ]),
      });
      const response = await app.request('/api/simulation/experiment/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    },
  );
});
