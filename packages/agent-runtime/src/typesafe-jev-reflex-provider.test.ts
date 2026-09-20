import { describe, expect, it, vi } from 'vitest';
import { reflexObservationSchema } from '@hexzero/shared';
import {
  ScriptedReflexProvider,
  TypeSafeJevReflexProvider,
  TYPESAFE_JEV_MODEL,
  TYPESAFE_SYSTEM_ONE_ENDPOINT,
  buildTypeSafeJevRequest,
} from '.';

const observation = reflexObservationSchema.parse({
  agentId: '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
  directive: {
    id: 'directive-1',
    agentId: '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
    mission: 'expand',
    targetCell: null,
    priority: 'normal',
    riskTolerance: 'medium',
    issuedAtTick: 1,
    expiresAtTick: 2,
  },
  currentSituation: {
    cellStatus: 'friendly-infected',
    directiveProgress: 'advancing',
    nearbyPressure: 'low',
    recentTerritoryTrend: 'growing',
    recentActionOutcome: 'success',
  },
  candidates: [
    { id: 'action_0', description: 'Move into adjacent open territory.' },
    { id: 'action_1', description: 'Remain on the current infected cell.' },
  ],
});

function choiceResponse(choice = 'action_0', model = TYPESAFE_JEV_MODEL) {
  return new Response(
    JSON.stringify({
      model,
      future_top_level_metadata: 'ignored',
      answers: {
        choose_action: {
          type: 'choice',
          choice,
          probabilities: { action_0: 0.8, action_1: 0.2 },
          confidence: 0.7,
          future_answer_metadata: 'ignored',
        },
        request_replan: {
          type: 'noul',
          noul: 0.25,
          future_answer_metadata: 'ignored',
        },
      },
      usage: { input_tokens: 45, output_tokens: 8, future_usage_metadata: 1 },
    }),
  );
}

describe('TypeSafeJevReflexProvider', () => {
  it('sends the pinned model and opaque candidate choice criteria', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(choiceResponse());
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });

    const decision = await provider.decide(observation);

    expect(decision).toMatchObject({
      chosenCandidateId: 'action_0',
      model: TYPESAFE_JEV_MODEL,
      inputTokens: 45,
      outputTokens: 8,
      directiveId: 'directive-1',
      cognitionSource: 'jev-reflex',
      replanProbability: 0.25,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      TYPESAFE_SYSTEM_ONE_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const request = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(request).toEqual(buildTypeSafeJevRequest(observation));
    expect(request.model).toBe(TYPESAFE_JEV_MODEL);
    expect(request.questions.choose_action.criteria).toEqual({
      action_0: 'Move into adjacent open territory.',
      action_1: 'Remain on the current infected cell.',
    });
    expect(request.questions.request_replan).toEqual({
      type: 'noul',
      instructions:
        'Do currently observed local conditions materially undermine or prevent successful execution of the assigned directive?',
      criteria: {
        false:
          'Observed local conditions leave the assigned directive materially achievable with one of the currently legal actions.',
        true: 'Observed local conditions materially undermine or prevent the assigned directive, such as when its target, route, required local state, or expected progress is unavailable or contradicted.',
      },
    });
    expect(JSON.stringify(request.state)).not.toContain('targetCell');
    expect(JSON.stringify(request.state)).not.toContain('issuedAtTick');
    expect(JSON.stringify(request.state)).not.toContain('expiresAtTick');
  });

  it('projects bounded capture pressure into the outbound Jev request without location or hunter data', async () => {
    const observationWithCaptures = reflexObservationSchema.parse({
      ...observation,
      captureAlerts: [
        {
          capturedAgentId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
          cell: '8928308280fffff',
          originatingTick: 99,
          abandonedCellCount: 3,
        },
      ],
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(choiceResponse());
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await provider.decide(observationWithCaptures);

    const request = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(request.state).toMatchObject({
      capturePressure: {
        recentCaptureCount: 1,
        recentCaptures: [{ abandonedCellCount: 3 }],
      },
    });
    expect(JSON.stringify(request.state)).not.toContain('capturedAgentId');
    expect(JSON.stringify(request.state)).not.toContain('originatingTick');
    expect(JSON.stringify(request.state)).not.toContain('8928308280fffff');
    expect(JSON.stringify(request.state)).not.toContain('hunter');
    expect(JSON.stringify(request.state)).not.toContain('player');
  });

  it('omits capture pressure when no captures were observed', () => {
    expect(buildTypeSafeJevRequest(observation).state).not.toHaveProperty(
      'capturePressure',
    );
  });

  it('rejects malformed responses and selections outside its candidates', async () => {
    const malformed = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{')),
    });
    await expect(malformed.decide(observation)).rejects.toMatchObject({
      failure: { code: 'malformed-response' },
    });

    const unknown = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(choiceResponse('action_99')),
    });
    await expect(unknown.decide(observation)).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message:
          'TypeSafe Jev selected a candidate outside the supplied choices.',
      },
      metadata: { promptTokens: 45, completionTokens: 8, totalTokens: 53 },
    });

    const inconsistentProbabilities = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: TYPESAFE_JEV_MODEL,
            answers: {
              choose_action: {
                type: 'choice',
                choice: 'action_0',
                probabilities: { action_0: 1 },
                confidence: 0.7,
              },
              request_replan: { type: 'noul', noul: 0.25 },
            },
            usage: { input_tokens: 45, output_tokens: 8 },
          }),
        ),
      ),
    });
    await expect(
      inconsistentProbabilities.decide(observation),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        message:
          'TypeSafe Jev returned an incomplete or inconsistent probability distribution.',
      },
      metadata: { promptTokens: 45, completionTokens: 8, totalTokens: 53 },
    });

    const wrongModel = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(choiceResponse('action_0', 'jev-latest')),
    });
    await expect(wrongModel.decide(observation)).rejects.toMatchObject({
      failure: { code: 'unsupported-response' },
    });
  });

  it('rejects a missing or malformed Noul answer without a second request', async () => {
    const missingFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: TYPESAFE_JEV_MODEL,
          answers: {
            choose_action: {
              type: 'choice',
              choice: 'action_0',
              probabilities: { action_0: 0.8, action_1: 0.2 },
              confidence: 0.7,
            },
          },
          usage: { input_tokens: 45, output_tokens: 8 },
        }),
      ),
    );
    const missingNoul = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: missingFetch,
    });
    await expect(missingNoul.decide(observation)).rejects.toMatchObject({
      failure: { code: 'unsupported-response' },
    });
    expect(missingFetch).toHaveBeenCalledTimes(1);

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: TYPESAFE_JEV_MODEL,
          answers: {
            choose_action: {
              type: 'choice',
              choice: 'action_0',
              probabilities: { action_0: 0.8, action_1: 0.2 },
              confidence: 0.7,
            },
            request_replan: { type: 'noul', noul: 2 },
          },
          usage: { input_tokens: 45, output_tokens: 8 },
        }),
      ),
    );
    const malformedNoul = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation: malformedFetch,
    });
    await expect(malformedNoul.decide(observation)).rejects.toMatchObject({
      failure: { code: 'unsupported-response' },
    });
    expect(malformedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 529])('retries one %s response and no more', async (status) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(choiceResponse());
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });
    await expect(provider.decide(observation)).resolves.toMatchObject({
      chosenCandidateId: 'action_0',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('accounts for every dispatched HTTP attempt independently', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(choiceResponse());
    const completions: Array<{ kind: string; outcome?: string }> = [];
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });
    await provider.decide(observation, {
      beginAttempt: (kind) => (completion) => {
        completions.push({ kind, outcome: completion.outcome });
      },
    });
    expect(completions).toEqual([
      { kind: 'initial', outcome: 'provider-error' },
      { kind: 'automatic-transport-retry', outcome: 'completed' },
    ]);
  });

  it('does not call TypeSafe after its operation deadline has elapsed', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });
    await expect(
      provider.decide(observation, { deadlineAtMs: Date.now() - 1 }),
    ).rejects.toMatchObject({ failure: { code: 'timeout' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('stops before dispatch when attempt accounting denies the budget', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });
    await expect(
      provider.decide(observation, { beginAttempt: () => null }),
    ).rejects.toMatchObject({ failure: { code: 'budget-exhausted' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects invalid timeout configuration', () => {
    expect(() => new TypeSafeJevReflexProvider({ timeoutMs: 0 })).toThrow(
      RangeError,
    );
  });

  it('propagates cancellation to the transport', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-key',
      fetchImplementation,
    });
    const pending = provider.decide(observation, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      failure: { code: 'cancelled' },
    });
  });
});

describe('ScriptedReflexProvider', () => {
  it('returns a deterministic opaque candidate selection', async () => {
    const provider = new ScriptedReflexProvider([
      {
        chosenCandidateId: 'action_1',
        confidence: 1,
        replanProbability: 0.6,
      },
    ]);
    await expect(provider.decide(observation)).resolves.toMatchObject({
      chosenCandidateId: 'action_1',
      probabilities: { action_0: 0, action_1: 1 },
      cognitionSource: 'jev-reflex',
      replanProbability: 0.6,
    });
  });

  it('defaults scripted replan probability to zero', async () => {
    const provider = new ScriptedReflexProvider([
      { chosenCandidateId: 'action_1', confidence: 1 },
    ]);
    await expect(provider.decide(observation)).resolves.toMatchObject({
      replanProbability: 0,
    });
  });

  it('does not include its API key in the System One request body', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(choiceResponse());
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'private-test-key',
      fetchImplementation,
    });

    await provider.decide(observation);

    expect(String(fetchImplementation.mock.calls[0]?.[1]?.body)).not.toContain(
      'private-test-key',
    );
  });
});
