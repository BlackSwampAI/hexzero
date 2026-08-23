import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_MAX_LENGTH,
  OPENROUTER_MAX_OUTPUT_TOKENS,
  OPENROUTER_PROVIDER_TIMEOUT_MS,
  agentObservationSchema,
} from '@hexzero/shared';
import {
  AgentProviderError,
  OpenRouterAgentProvider,
  ScriptedAgentProvider,
  buildOpenRouterRequest,
  normalizeFlatDecision,
} from '.';
import { applyProviderEnvironmentFile } from './provider-environment';

const TEST_MODEL = 'test/compatible-model';

const observation = agentObservationSchema.parse({
  agentId: '128f3f38-6b7d-4db7-9e95-751b4ce2681e',
  agentName: 'Ember',
  personality: 'Aggressively infect open cells.',
  currentCell: {
    cell: '892a1072893ffff',
    state: 'open',
    controllerAgentId: null,
    controllerAllianceId: null,
    effectiveColor: null,
  },
  captureEligibility: {
    eligible: false,
    blockedReason: 'capture-open-cell',
  },
  actionAvailability: {
    moveTargetCellIds: ['892a1072883ffff'],
    infect: { available: true },
    capture: { available: false, reason: 'capture-open-cell' },
    wait: { available: true },
  },
  adjacentCells: [
    {
      cell: '892a1072883ffff',
      state: 'open',
      controllerAgentId: null,
      controllerAllianceId: null,
      effectiveColor: null,
    },
  ],
  nearbyAgents: [
    {
      id: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
      name: 'Rook',
      currentCell: '892a1072883ffff',
      distance: 1,
      allianceId: null,
    },
  ],
  recentEvents: [],
  recentPublicMessages: [],
  recentDirectMessages: [],
  territoryScoreboard: [
    ['128f3f38-6b7d-4db7-9e95-751b4ce2681e', 'Ember', '#ff6b57'],
    ['2507bb46-7ae4-45ca-8dda-644c4f85ca14', 'Rook', '#ffd166'],
    ['3ba3ef0b-2142-44cc-b175-f6e5d6e98df5', 'Mingle', '#63d2ff'],
    ['442a1667-39c8-48e9-8c89-23803f9e2101', 'Solace', '#c59cff'],
    ['5f812a08-05f2-4950-bf2d-4df59d05e9c2', 'Verge', '#6ee7a8'],
    ['67a43b5c-ced8-45bd-970f-a89ac57853fc', 'Jinx', '#ff91c8'],
    ['78b6d86c-39b4-47d8-9d7a-0b92686ada71', 'Bastion', '#3b5ccc'],
    ['89ce9ddb-611f-4a46-8f7b-36e656494aa2', 'Cipher', '#9b4d3f'],
  ].map(([agentId, name, color]) => ({
    agentId,
    name,
    color,
    allianceId: null,
    effectiveColor: color,
    controlledCellCount: 0,
  })),
  recentControlChanges: [],
  actingAllianceId: null,
  actingAlliance: null,
  activeAlliances: [],
  inboundAllianceProposals: [],
  outboundAllianceProposals: [],
  recentAllianceEvents: [],
});

function response(content: string, status = 200, returnedModel = TEST_MODEL) {
  return new Response(
    JSON.stringify({
      id: 'request-safe-id',
      model: returnedModel,
      choices: [
        {
          finish_reason: 'stop',
          native_finish_reason: 'stop',
          message: {
            content: toWireArguments(content),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 12 },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function textResponse(content: string | null, finishReason = 'stop') {
  return Response.json({
    id: 'request-safe-id',
    model: TEST_MODEL,
    choices: [
      {
        finish_reason: finishReason,
        native_finish_reason: finishReason,
        message: { content },
      },
    ],
  });
}

function toWireArguments(content: string): string {
  let decision: {
    worldAction?: { type?: unknown; targetCell?: unknown };
    communication?: {
      channel?: unknown;
      recipientId?: unknown;
      message?: unknown;
    };
    diplomacy?: { type?: unknown; recipientId?: unknown; proposalId?: unknown };
    summary?: unknown;
  };
  try {
    decision = JSON.parse(content) as typeof decision;
  } catch {
    return content;
  }
  if (!decision.worldAction) return content;
  return JSON.stringify({
    worldActionType: decision.worldAction.type,
    targetCell: decision.worldAction.targetCell ?? '',
    communicationType: decision.communication?.channel ?? 'none',
    communicationRecipientId: decision.communication?.recipientId ?? '',
    communicationMessage: decision.communication?.message ?? '',
    diplomacyType: decision.diplomacy?.type ?? 'none',
    diplomacyRecipientId: decision.diplomacy?.recipientId ?? '',
    diplomacyProposalId: decision.diplomacy?.proposalId ?? '',
    goalOperation: 'establish',
    goalLongTerm: 'Build durable influence.',
    goalShortTerm: 'Secure the nearby cells.',
    goalPlanSummary: 'Expand methodically from the current position.',
    goalRevisionReason: 'No active strategic goal exists.',
    summary: decision.summary,
  });
}

function errorResponse({
  status,
  code,
  message,
  requestId = 'safe-request-id',
  retryAfter,
}: {
  status: number;
  code?: string | number;
  message?: string;
  requestId?: string;
  retryAfter?: string;
}) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    },
  });
}

describe('OpenRouterAgentProvider', () => {
  it('constructs a universal text request for one flat JSON object', () => {
    const request = buildOpenRouterRequest(observation, TEST_MODEL);
    expect(request.model).toBe(TEST_MODEL);
    expect(request).not.toHaveProperty('response_format');
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
    expect(request).not.toHaveProperty('provider');
    expect(request.stream).toBe(false);
    expect(request.max_tokens).toBe(OPENROUTER_MAX_OUTPUT_TOKENS);
    expect(OPENROUTER_PROVIDER_TIMEOUT_MS).toBe(75_000);
    expect(request).not.toHaveProperty('max_completion_tokens');
    expect(request).not.toHaveProperty('include_reasoning');
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(request).not.toHaveProperty('reasoning');
    expect(request.messages[1]!.content).toContain(observation.personality);
    expect(request.messages[0]!.content).toContain(
      'All decisions are independently validated',
    );
    expect(request.messages[0]!.content).toContain(
      'actionAvailability.capture.available is true',
    );
    expect(request.messages[0]!.content).toContain(
      'move there this turn and infect it on a later turn',
    );
    expect(request.messages[0]!.content).toContain(
      'Infect affects only the current cell',
    );
    expect(request.messages[0]!.content).toContain(
      'Return exactly one plain JSON object',
    );
    expect(request.messages[0]!.content).toContain('untrusted claim');
    expect(request.messages[0]!.content).toContain('durable-influence-v2');
    expect(request.messages[0]!.content).toContain(
      'maximizing your own durable influence',
    );
    expect(request.messages[0]!.content).toContain(
      'actionAvailability and observation.diplomacyAvailability as authoritative',
    );
    expect(request.messages[0]!.content).toContain(
      'diplomacyAvailability.propose.eligibleRecipientAgentIds',
    );
    expect(request.messages[0]!.content).toContain(
      'Never infer range, membership, or proposal legality from prose',
    );
    expect(request.messages[0]!.content).toContain(
      'do not repeat an unavailable unchanged diplomacy plan',
    );
    expect(request.messages[0]!.content).toContain(
      'no provider tool call is needed',
    );
    expect(request.messages[0]!.content).toContain(
      'recommendations may name only IDs in diplomacySummary.displayedEligiblePairs',
    );
    expect(request.messages[0]!.content).toContain('subordinate preferences');
    expect(request.messages[0]!.content).not.toMatch(
      /nearby player|player threat|capturing player|player gps/i,
    );
    expect(request.messages[0]!.content).not.toContain(observation.personality);
    expect(JSON.parse(request.messages[1]!.content)).toMatchObject({
      observation: {
        captureEligibility: {
          eligible: false,
          blockedReason: 'capture-open-cell',
        },
      },
    });

    expect(request.messages[0]!.content).toContain('worldActionType');
    expect(request.messages[0]!.content).toContain('communicationType');
    expect(request.messages[0]!.content).toContain('diplomacyType');
  });

  it('guides Patient Zero to broadcast selectively with a specific target, action, and authoritative reason', () => {
    const patientZeroObservation = agentObservationSchema.parse({
      ...observation,
      patientZero: {
        agentId: observation.agentId,
        agentName: observation.agentName,
        isPatientZero: true,
        directRangeBypass: true,
      },
    });
    const guidance = buildOpenRouterRequest(patientZeroObservation, TEST_MODEL)
      .messages[0]!.content;

    expect(guidance).toContain(
      'broadcast only when it reveals one specific, high-value coordination opportunity',
    );
    expect(guidance).toContain('otherwise choose communicationType "none"');
    expect(guidance).toContain('TARGET: <named agent(s)>');
    expect(guidance).toContain('ACTION: <specific recommendation>');
    expect(guidance).toContain(
      'REASON: <brief authoritative map or alliance fact>',
    );
    expect(guidance).toContain(
      'prioritize the highest-value coordination problem',
    );
    expect(guidance).toContain(
      'Never use Zero merely to narrate your own action',
    );
    expect(guidance).toContain('Never send motivational filler');
    expect(guidance).toContain('keep expanding');
    expect(guidance).toContain('great work');
    expect(guidance).toContain('spread outward');
    expect(guidance).toContain('build coalitions');
    expect(guidance).toContain('Use only facts in this observation');
    expect(guidance).toContain(
      'Never invent player activity, danger, threats, captures, losses',
    );
    expect(guidance).toContain('Field agents retain autonomy');
  });

  it('makes selective communication the universal default without changing wire fields', () => {
    const guidance = buildOpenRouterRequest(observation, TEST_MODEL)
      .messages[0]!.content;
    expect(guidance).toContain('DECISION CONTRACT (text-flat-json-v7)');
    expect(guidance).toContain('GOAL CONTINUITY');
    expect(guidance).toContain(
      'communicationType "none" is the normal/default choice',
    );
    expect(guidance).toContain('concrete request or reply');
    expect(guidance).toContain('warning grounded in observed facts');
    expect(guidance).toContain('materially changed plan');
    expect(guidance).toContain('border or conflict coordination');
    expect(guidance).toContain('coordinated target or route');
    expect(guidance).toContain(
      'Do not narrate a routine move, infect, capture, or wait action',
    );
    expect(guidance).toContain('send motivational filler');
    expect(guidance).toContain('restate the observation or decision summary');
    expect(guidance).toContain('repeat an unchanged plan');
    expect(guidance).toContain('must add terms or useful context');
    expect(guidance).toContain('assigned personality and style');
    expect(guidance).toContain(
      'communicationType (none|public|direct|alliance|zero)',
    );
  });

  it('guides addressed field agents toward useful private replies without blind or illegal compliance', () => {
    const fieldObservation = agentObservationSchema.parse({
      ...observation,
      patientZero: {
        agentId: '2507bb46-7ae4-45ca-8dda-644c4f85ca14',
        agentName: 'Rook',
        isPatientZero: false,
        directRangeBypass: true,
      },
    });
    const guidance = buildOpenRouterRequest(fieldObservation, TEST_MODEL)
      .messages[0]!.content;

    expect(guidance).toContain(
      'Evaluate each directive against current legal actions',
    );
    expect(guidance).toContain('never follow it blindly');
    expect(guidance).toContain(
      'never follow it blindly or claim compliance when its recommendation is unavailable',
    );
    expect(guidance).toContain(
      'If a directive addresses you, prefer a private direct reply to Patient Zero',
    );
    expect(guidance).toContain('accepting, declining, counter-proposing');
    expect(guidance).toContain('Do not reply merely to say thanks');
    expect(guidance).toContain('do not repeat the directive publicly');
    expect(guidance).toContain(
      'If you are not addressed, you may ignore the directive',
    );
    expect(guidance).toContain('regardless of distance');
  });

  it('adds only bounded validation codes to a fresh corrective request', () => {
    const request = buildOpenRouterRequest(
      observation,
      TEST_MODEL,
      'provider-default',
      ['contradictory-fields', 'invalid-recipient-sentinel'],
    );
    const user = JSON.parse(request.messages[1]!.content);
    expect(user.correction).toEqual({
      instruction:
        'Correct only the flat JSON format or decision-contract problem and return one replacement object.',
      validationCodes: ['contradictory-fields', 'invalid-recipient-sentinel'],
    });
    expect(request.messages[1]!.content).not.toContain('raw invalid');
  });

  it('retains a specific diplomacy detail code with the broad category', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        textResponse(
          JSON.stringify({
            worldActionType: 'wait',
            targetCell: '',
            communicationType: 'none',
            communicationRecipientId: '',
            communicationMessage: '',
            diplomacyType: 'accept-alliance',
            diplomacyRecipientId: observation.nearbyAgents[0]!.id,
            diplomacyProposalId: '',
            goalOperation: 'establish',
            goalLongTerm: 'Build durable influence.',
            goalShortTerm: 'Secure this area.',
            goalPlanSummary: 'Expand one cell at a time.',
            goalRevisionReason: 'No goal is active.',
            summary: 'Accept the invitation.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: {
        validationCodes: [
          'invalid-action-fields',
          'unexpected-alliance-recipient',
          'contradictory-diplomacy-fields',
        ],
      },
    });
  });

  it('returns safe repair feedback for contradictory v7 goal sentinels', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        textResponse(
          JSON.stringify({
            worldActionType: 'wait',
            targetCell: '',
            communicationType: 'none',
            communicationRecipientId: '',
            communicationMessage: '',
            diplomacyType: 'none',
            diplomacyRecipientId: '',
            diplomacyProposalId: '',
            goalOperation: 'keep',
            goalLongTerm: 'Contradictory retained text.',
            goalShortTerm: '',
            goalPlanSummary: '',
            goalRevisionReason: '',
            summary: 'Keep the goal.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: {
        code: 'invalid-decision',
        retryable: true,
        validationCodes: ['invalid-action-fields', 'contradictory-fields'],
      },
    });
  });

  it('preserves an explicit model override', () => {
    expect(
      buildOpenRouterRequest(observation, 'custom/provider-model').model,
    ).toBe('custom/provider-model');
  });

  it('omits reasoning for the provider-default profile', () => {
    const request = buildOpenRouterRequest(observation, TEST_MODEL);
    expect(request).not.toHaveProperty('reasoning');
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(request).not.toHaveProperty('include_reasoning');
  });

  it('constructs only the selected normalized reasoning control', () => {
    expect(
      buildOpenRouterRequest(observation, TEST_MODEL, 'off'),
    ).toHaveProperty('reasoning', { enabled: false, exclude: true });
    expect(
      buildOpenRouterRequest(observation, TEST_MODEL, 'xhigh'),
    ).toHaveProperty('reasoning', {
      enabled: true,
      effort: 'xhigh',
      exclude: true,
    });
    expect(OPENROUTER_PROVIDER_TIMEOUT_MS).toBe(75_000);
  });

  it('rejects missing text output', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () => textResponse(null)),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({ failure: { code: 'missing-text-output' } });
  });

  it.each([
    [
      '```json\n{"worldActionType":"wait","targetCell":"","communicationType":"none","communicationRecipientId":"","communicationMessage":"","diplomacyType":"none","diplomacyRecipientId":"","diplomacyProposalId":"","goalOperation":"keep","goalLongTerm":"","goalShortTerm":"","goalPlanSummary":"","goalRevisionReason":"","summary":"Wait."}\n```',
      'Wait.',
    ],
    [
      'Decision: {"worldActionType":"wait","targetCell":"","communicationType":"none","communicationRecipientId":"","communicationMessage":"","diplomacyType":"none","diplomacyRecipientId":"","diplomacyProposalId":"","goalOperation":"keep","goalLongTerm":"","goalShortTerm":"","goalPlanSummary":"","goalRevisionReason":"","summary":"Extracted.",}',
      'Extracted.',
    ],
  ])(
    'extracts and conservatively repairs flat JSON text',
    async (content, summary) => {
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        fetchImplementation: vi.fn(async () => textResponse(content)),
      });
      await expect(
        provider.decide(observation, TEST_MODEL),
      ).resolves.toMatchObject({
        decision: { worldAction: { type: 'wait' }, summary },
      });
    },
  );

  it('requires and normalizes the flat v7 goal revision fields', () => {
    expect(
      normalizeFlatDecision({
        worldActionType: 'wait',
        targetCell: '',
        communicationType: 'none',
        communicationRecipientId: '',
        communicationMessage: '',
        diplomacyType: 'none',
        diplomacyRecipientId: '',
        diplomacyProposalId: '',
        goalOperation: 'establish',
        goalLongTerm: 'Build durable influence.',
        goalShortTerm: 'Secure this area.',
        goalPlanSummary: 'Expand one cell at a time.',
        goalRevisionReason: 'No goal is active.',
        summary: 'Wait.',
      }),
    ).toMatchObject({
      success: true,
      data: {
        worldAction: { type: 'wait' },
        goalRevision: { operation: 'establish' },
        summary: 'Wait.',
      },
    });
    expect(
      normalizeFlatDecision({
        worldActionType: 'wait',
        targetCell: '',
        communicationType: 'none',
        communicationRecipientId: '',
        communicationMessage: '',
        diplomacyType: 'none',
        diplomacyRecipientId: '',
        diplomacyProposalId: '',
        goalOperation: 'keep',
        goalLongTerm: 'contradiction',
        goalShortTerm: '',
        goalPlanSummary: '',
        goalRevisionReason: '',
        summary: 'Wait.',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['1.5', 1_500],
    ['not-a-delay', undefined],
  ])('normalizes Retry-After %s safely', async (retryAfter, expectedMs) => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        errorResponse({
          status: 429,
          code: 'rate_limited',
          message: 'Try later.',
          retryAfter,
        }),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: {
        code: 'provider-http',
        httpStatus: 429,
        ...(expectedMs === undefined ? {} : { retryAfterMs: expectedMs }),
      },
    });
  });

  it.each([
    JSON.stringify({ worldAction: { type: 'wait' }, summary: 'Nested.' }),
    '{"worldActionType":"wait"} {"worldActionType":"wait"}',
  ])('rejects non-flat or ambiguous JSON output', async (content) => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () => textResponse(content)),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: { code: expect.stringMatching(/invalid-(?:json|decision)/) },
    });
  });

  it('accepts standardized text content parts', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: [
                  {
                    type: 'text',
                    text: toWireArguments(
                      JSON.stringify({
                        worldAction: { type: 'wait' },
                        summary: 'Text part.',
                      }),
                    ),
                  },
                ],
              },
            },
          ],
        }),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({ decision: { summary: 'Text part.' } });
  });

  it('classifies output exhaustion before JSON parsing', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () => textResponse(null, 'length')),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: { code: 'output-length', finishReason: 'length' },
      metadata: { finishReason: 'length', nativeFinishReason: 'length' },
    });
  });

  it.each([
    'gemini/mock',
    'qwen/mock',
    'deepseek/mock',
    'glm/mock',
    'tencent/mock',
  ])('uses the same flat JSON text path for %s', async (model) => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({ worldAction: { type: 'wait' }, summary: 'Wait.' }),
          200,
          model,
        ),
      ),
    });
    await expect(provider.decide(observation, model)).resolves.toMatchObject({
      decision: { worldAction: { type: 'wait' } },
      metadata: { model, selectedModel: model, resolvedModel: model },
    });
  });

  it('parses and runtime-validates a structured decision', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return response(
          JSON.stringify({
            worldAction: { type: 'infect' },
            summary: 'Claiming this cell.',
          }),
        );
      },
    );
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation,
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: { worldAction: { type: 'infect' } },
      metadata: { provider: 'openrouter' },
    });
    const request = JSON.parse(String(capturedInit?.body));
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
    expect(request).not.toHaveProperty('provider');
    expect(request).not.toHaveProperty('reasoning');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('parses a structured nearby message from a mocked provider response', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({
            worldAction: { type: 'infect' },
            communication: {
              channel: 'direct',
              recipientId: observation.nearbyAgents[0]!.id,
              message: 'Coordinate at the center.',
            },
            summary: 'Sending a nearby message.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: {
        worldAction: { type: 'infect' },
        communication: {
          channel: 'direct',
          recipientId: observation.nearbyAgents[0]!.id,
          message: 'Coordinate at the center.',
        },
      },
    });
  });

  it('parses a first-class capture from a mocked provider response', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({
            worldAction: { type: 'capture' },
            summary: 'Taking control of this contested hex.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: { worldAction: { type: 'capture' } },
      metadata: { promptTokens: 20, completionTokens: 12 },
    });
  });

  it('keeps structured move decisions compatible', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({
            worldAction: {
              type: 'move',
              targetCell: observation.adjacentCells[0]!.cell,
            },
            summary: 'Moving one adjacent hex.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: {
        worldAction: {
          type: 'move',
          targetCell: observation.adjacentCells[0]!.cell,
        },
      },
    });
  });

  it('parses a valid decision envelope so communication can be validated independently', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({
            worldAction: { type: 'infect' },
            communication: {
              channel: 'public',
              message: 'x'.repeat(MESSAGE_MAX_LENGTH + 1),
            },
            summary: 'The engine must reject only the message.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: {
        worldAction: { type: 'infect' },
        communication: { channel: 'public' },
      },
    });
  });

  it('preserves malformed diplomacy for independent sanitized engine rejection', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        response(
          JSON.stringify({
            worldAction: { type: 'wait' },
            communication: {
              channel: 'public',
              message: 'The valid message remains.',
            },
            diplomacy: {
              type: 'propose-alliance',
              recipientId: 'malformed-id',
            },
            summary: 'Validate components independently.',
          }),
        ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: {
        worldAction: { type: 'wait' },
        communication: { channel: 'public' },
        diplomacy: { type: 'propose-alliance', recipientId: 'malformed-id' },
      },
    });
  });

  it('normalizes complete OpenRouter usage accounting without rounding tiny cost', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'safe-id',
              model: 'safe/model',
              choices: [
                {
                  message: {
                    content: toWireArguments(
                      JSON.stringify({
                        worldAction: { type: 'wait' },
                        summary: 'Wait.',
                      }),
                    ),
                  },
                },
              ],
              usage: {
                prompt_tokens: 101,
                completion_tokens: 23,
                total_tokens: 124,
                cost: 0.00000017,
                completion_tokens_details: { reasoning_tokens: 7 },
                prompt_tokens_details: {
                  cached_tokens: 80,
                  cache_write_tokens: 4,
                },
              },
            }),
          ),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      metadata: {
        promptTokens: 101,
        completionTokens: 23,
        totalTokens: 124,
        reasoningTokens: 7,
        cachedReadTokens: 80,
        cacheWriteTokens: 4,
        costCredits: 0.00000017,
      },
    });
  });

  it('supports a successful response with usage omitted', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: toWireArguments(
                      JSON.stringify({
                        worldAction: { type: 'wait' },
                        summary: 'Wait.',
                      }),
                    ),
                  },
                },
              ],
            }),
          ),
      ),
    });
    const result = await provider.decide(observation, TEST_MODEL);
    expect(result.metadata).not.toHaveProperty('costCredits');
    expect(result.metadata).not.toHaveProperty('totalTokens');
  });

  it('never copies secrets, observations or raw provider payloads into safe metadata', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'sk-or-secret-test-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: `Bearer sk-or-secret-test-key ${observation.personality}`,
              model: JSON.stringify({
                observation,
                authorization: 'sk-or-secret-test-key',
              }),
              choices: [
                {
                  message: {
                    content: toWireArguments(
                      JSON.stringify({
                        worldAction: { type: 'wait' },
                        summary: 'Wait.',
                      }),
                    ),
                  },
                },
              ],
              usage: { cost: 0.00000001 },
            }),
          ),
      ),
    });
    const result = await provider.decide(observation, TEST_MODEL);
    const serialized = JSON.stringify(result.metadata);
    expect(serialized).not.toContain('sk-or-secret-test-key');
    expect(serialized).not.toContain(observation.personality);
    expect(serialized).not.toContain('authorization');
  });

  it.each([
    'not-json',
    JSON.stringify({ worldAction: { type: 'teleport' }, summary: 'No.' }),
    JSON.stringify({
      worldAction: {
        type: 'capture',
        targetCell: observation.currentCell.cell,
      },
      summary: 'No.',
    }),
  ])(
    'retains known safe usage when decision content is malformed or unsupported',
    async (content) => {
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        fetchImplementation: vi.fn(async () => response(content)),
      });
      await expect(
        provider.decide(observation, TEST_MODEL),
      ).rejects.toMatchObject({
        metadata: {
          promptTokens: 20,
          completionTokens: 12,
        },
      });
    },
  );

  it.each([
    ['not-json', 'invalid-json'],
    [
      JSON.stringify({ worldAction: { type: 'teleport' }, summary: 'No.' }),
      'invalid-decision',
    ],
    [
      JSON.stringify({
        worldAction: {
          type: 'capture',
          targetCell: observation.currentCell.cell,
        },
        summary: 'No.',
      }),
      'invalid-decision',
    ],
    [
      JSON.stringify({
        worldAction: { type: 'wait' },
        summary: 'x'.repeat(241),
      }),
      'invalid-decision',
    ],
  ])(
    'rejects invalid provider content without fallback',
    async (content, code) => {
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        fetchImplementation: vi.fn(async () => response(content)),
      });
      await expect(
        provider.decide(observation, TEST_MODEL),
      ).rejects.toMatchObject({
        failure: { code },
      });
    },
  );

  it.each([
    [
      400,
      'provider-http',
      'The model provider rejected the request configuration.',
      false,
    ],
    [
      404,
      'model-unavailable',
      'The selected model is unavailable or no endpoint supports all required parameters.',
      false,
    ],
    [
      429,
      'provider-http',
      'The model provider rate limited the request.',
      true,
    ],
    [503, 'provider-http', 'The model provider is unavailable.', true],
  ])(
    'maps HTTP %i to a clear sanitized public failure',
    async (status, code, message, retryable) => {
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        fetchImplementation: vi.fn(async () =>
          errorResponse({
            status,
            code: 'provider_error',
            message: 'Safe provider detail.',
          }),
        ),
      });
      await expect(
        provider.decide(observation, TEST_MODEL),
      ).rejects.toMatchObject({
        failure: { code, message, retryable },
        diagnostics: {
          httpStatus: status,
          providerCode: 'provider_error',
          providerMessage: 'Safe provider detail.',
          requestId: 'safe-request-id',
          model: TEST_MODEL,
        },
      });
    },
  );

  it('sanitizes HTTP diagnostics and network errors without leaking sensitive data', async () => {
    const key = 'highly-sensitive-key';
    const injectedSensitiveString = 'injected-sensitive-observation';
    const sensitiveObservation = agentObservationSchema.parse({
      ...observation,
      personality: injectedSensitiveString,
    });
    const httpProvider = new OpenRouterAgentProvider({
      apiKey: key,
      fetchImplementation: vi.fn(async () =>
        errorResponse({
          status: 400,
          code: `invalid-${key}`,
          message: `Authorization: Bearer ${key}; observation=${injectedSensitiveString}`,
          requestId: `request-${key}`,
        }),
      ),
    });
    const networkProvider = new OpenRouterAgentProvider({
      apiKey: key,
      fetchImplementation: vi.fn(async () => {
        throw new Error(`socket failed with ${key}`);
      }),
    });
    for (const provider of [httpProvider, networkProvider]) {
      const selectedModel =
        provider === httpProvider ? 'openai/gpt-5.6-luna' : TEST_MODEL;
      try {
        await provider.decide(
          provider === httpProvider ? sensitiveObservation : observation,
          selectedModel,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(AgentProviderError);
        expect(String(error)).not.toContain(key);
        expect(JSON.stringify(error)).not.toContain(key);
        expect(JSON.stringify(error)).not.toContain(injectedSensitiveString);
        if (provider === httpProvider)
          expect((error as AgentProviderError).diagnostics?.model).toBe(
            selectedModel,
          );
      }
    }
  });

  it('reads only a bounded OpenRouter error body', async () => {
    const oversizedMessage = 'safe-detail '.repeat(4_000);
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async () =>
        errorResponse({
          status: 400,
          code: 'invalid_request',
          message: oversizedMessage,
        }),
      ),
    });
    try {
      await provider.decide(observation, TEST_MODEL);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProviderError);
      expect((error as AgentProviderError).diagnostics?.providerMessage).toBe(
        undefined,
      );
    }
  });

  it('times out a bounded request', async () => {
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      timeoutMs: 1,
      fetchImplementation: vi.fn(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: { code: 'timeout' },
    });
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        timeoutMs: 10,
        fetchImplementation: vi.fn(async (_url, init) => {
          requestSignal = init?.signal;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              new Promise((_resolve, reject) => {
                requestSignal?.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError')),
                );
              }),
          } as Response;
        }),
      });
      const pending = expect(
        provider.decide(observation, TEST_MODEL),
      ).rejects.toMatchObject({ failure: { code: 'timeout' } });

      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes operator cancellation from timeout', async () => {
    const controller = new AbortController();
    const provider = new OpenRouterAgentProvider({
      apiKey: 'secret-test-key',
      fetchImplementation: vi.fn(async (_url, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
        return Response.json({});
      }),
    });
    const pending = expect(
      provider.decide(observation, TEST_MODEL, { signal: controller.signal }),
    ).rejects.toMatchObject({ failure: { code: 'cancelled' } });
    controller.abort();
    await pending;
  });

  it('clears the timeout after a successful response', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OpenRouterAgentProvider({
        apiKey: 'secret-test-key',
        fetchImplementation: vi.fn(async () =>
          response(
            JSON.stringify({
              worldAction: { type: 'wait' },
              summary: 'Done.',
            }),
          ),
        ),
      });

      await expect(
        provider.decide(observation, TEST_MODEL),
      ).resolves.toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports missing configuration instead of using a heuristic fallback', async () => {
    const provider = new OpenRouterAgentProvider();
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).rejects.toMatchObject({
      failure: { code: 'configuration' },
    });
  });
});

describe('OpenRouter provider environment', () => {
  it('loads only server provider values and overrides stale exports', () => {
    const environment: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: 'exported-key',
    };
    applyProviderEnvironmentFile(
      [
        'OPENROUTER_API_KEY=file-key',
        'HEXZERO_MODEL=ignored/legacy-value',
        'NEXT_PUBLIC_GAME_API_BASE_URL=https://browser.example',
      ].join('\n'),
      environment,
    );
    expect(environment).toEqual({
      OPENROUTER_API_KEY: 'file-key',
    });
  });
});

describe('ScriptedAgentProvider', () => {
  it('returns explicitly scripted decisions in order', async () => {
    const provider = new ScriptedAgentProvider([
      { worldAction: { type: 'wait' }, summary: 'Staying still.' },
      {
        worldAction: { type: 'wait' },
        communication: {
          channel: 'direct',
          recipientId: observation.nearbyAgents[0]!.id,
          message: 'Hello, Rook.',
        },
        summary: 'Messaging.',
      },
    ]);
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: { worldAction: { type: 'wait' } },
      metadata: {
        provider: 'scripted-test',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costCredits: 0,
      },
    });
    await expect(
      provider.decide(observation, TEST_MODEL),
    ).resolves.toMatchObject({
      decision: { communication: { channel: 'direct' } },
    });
  });

  it('rejects an empty script', () => {
    expect(() => new ScriptedAgentProvider([])).toThrow(
      /at least one decision/,
    );
  });
});
