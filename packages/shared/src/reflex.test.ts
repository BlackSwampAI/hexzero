import { describe, expect, it } from 'vitest';
import {
  agentIdSchema,
  h3CellSchema,
  reflexDecisionSchema,
  reflexObservationSchema,
  swarmDirectiveSchema,
} from '.';

const agentId = agentIdSchema.parse('ca0e2b4d-d88f-4c9e-a401-a7b740c6e5af');
const targetCell = h3CellSchema.parse('8928308280fffff');

const directive = {
  id: 'directive-1',
  agentId,
  mission: 'expand' as const,
  targetCell,
  priority: 'high' as const,
  riskTolerance: 'medium' as const,
  issuedAtTick: 4,
  expiresAtTick: 7,
};

describe('zero-swarm reflex contracts', () => {
  it('accepts a compact, opaque worker observation', () => {
    const observation = reflexObservationSchema.parse({
      agentId,
      directive,
      currentSituation: {
        cellStatus: 'open',
        directiveProgress: 'advancing',
        nearbyPressure: 'low',
        recentTerritoryTrend: 'growing',
        recentActionOutcome: 'success',
      },
      relevantRecentFacts: ['The assigned direction remains accessible.'],
      candidates: [
        { id: 'action_0', description: 'Move toward the assigned target.' },
        { id: 'action_1', description: 'Infect the current open territory.' },
      ],
    });

    expect(observation.candidates[0]).toEqual({
      id: 'action_0',
      description: 'Move toward the assigned target.',
    });
    expect('action' in observation.candidates[0]!).toBe(false);
  });

  it('rejects mismatched directives and malformed choice telemetry', () => {
    expect(
      reflexObservationSchema.safeParse({
        agentId,
        directive: {
          ...directive,
          agentId: agentIdSchema.parse('2507bb46-7ae4-45ca-8dda-644c4f85ca14'),
        },
        currentSituation: {
          cellStatus: 'open',
          directiveProgress: 'advancing',
          nearbyPressure: 'low',
          recentTerritoryTrend: 'growing',
          recentActionOutcome: 'success',
        },
        relevantRecentFacts: [],
        candidates: [{ id: 'action_0', description: 'Wait.' }],
      }).success,
    ).toBe(false);
    expect(
      reflexDecisionSchema.safeParse({
        chosenCandidateId: 'invented-cell',
        confidence: 0.8,
        probabilities: { action_0: 0.8 },
        model: 'jev-1.13.0',
        latencyMs: 12,
        inputTokens: 6,
        outputTokens: 1,
        directiveId: directive.id,
        cognitionSource: 'jev-reflex',
      }).success,
    ).toBe(false);
    expect(
      swarmDirectiveSchema.safeParse({ ...directive, expiresAtTick: 3 })
        .success,
    ).toBe(false);
  });
});
