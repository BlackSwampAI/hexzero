import { describe, expect, it, vi } from 'vitest';
import { gridDisk } from 'h3-js';
import {
  BrowserTestAgentProvider,
  ScriptedReflexProvider,
  TypeSafeJevReflexProvider,
  type ReflexProvider,
} from '@hexzero/agent-runtime';
import { type SwarmDirective } from '@hexzero/shared';
import {
  applyWorldAction,
  createDevelopmentWorld,
  toWorldState,
} from '@hexzero/world-engine';
import { AttemptAccounting } from './attempt-accounting';
import { SimulationService } from './simulation-service';
import {
  chooseReflexWorldAction,
  compileReflexObservation,
} from './reflex-execution';

function fixture() {
  const state = toWorldState(createDevelopmentWorld());
  const agent = [...state.agents.values()][1]!;
  const targetCell = gridDisk(agent.currentCell, 1).find(
    (cell) =>
      cell !== agent.currentCell &&
      state.hexes.has(cell as typeof agent.currentCell),
  ) as typeof agent.currentCell;
  const directive: SwarmDirective = {
    id: 'directive-1',
    agentId: agent.id,
    mission: 'relocate',
    targetCell,
    priority: 'normal',
    riskTolerance: 'medium',
    issuedAtTick: 0,
    expiresAtTick: 3,
  };
  return { state, agent, directive, targetCell };
}

describe('zero-swarm reflex execution seam', () => {
  it('identifies zero-swarm scenarios without running the legacy tick executor', async () => {
    const service = new SimulationService({
      provider: new BrowserTestAgentProvider(),
    });
    const setup = service.getDefaultWorldSetup();
    const snapshot = service.applyWorldSetup({
      ...setup,
      cognitionMode: 'zero-swarm-v1',
    });
    expect(snapshot.scenario.cognitionMode).toBe('zero-swarm-v1');
    await expect(service.executeNextTick()).rejects.toThrow(
      'Zero-swarm execution requires a planner and reflex provider',
    );
    expect(service.getSnapshot().tickNumber).toBe(0);
  });

  it('takes a directive through legal candidate choice and the real engine', async () => {
    const { state, agent, directive, targetCell } = fixture();
    const compiled = compileReflexObservation(state, directive);
    expect(compiled.observation).not.toHaveProperty('messages');
    expect(compiled.observation).not.toHaveProperty('behavior');
    expect(compiled.observation).not.toHaveProperty('memories');
    expect(
      compiled.observation.candidates.every(({ id }) =>
        /^action_\d+$/.test(id),
      ),
    ).toBe(true);
    const chosenCandidateId = compiled.observation.candidates.find(({ id }) => {
      const action = compiled.actions.get(id);
      return action?.type === 'move' && action.targetCell === targetCell;
    })!.id;
    const provider = new ScriptedReflexProvider([{ chosenCandidateId }]);
    const selected = await chooseReflexWorldAction(state, directive, provider);
    expect(selected.cognitionSource).toBe('jev-reflex');
    expect(selected.action).toEqual({ type: 'move', targetCell });
    const applied = applyWorldAction(state, agent.id, selected.action);
    expect(applied.result.accepted).toBe(true);
    expect(applied.state.agents.get(agent.id)?.currentCell).toBe(targetCell);
  });

  it('passes bounded authoritative capture facts to Jev without player route data', () => {
    const { state, directive } = fixture();
    const compiled = compileReflexObservation(state, directive, {
      captureAlerts: [
        {
          capturedAgentId: [...state.agents.keys()][0]!,
          cell: directive.targetCell!,
          originatingTick: 4,
          abandonedCellCount: 2,
        },
      ],
    });
    expect(compiled.observation.captureAlerts).toEqual([
      {
        capturedAgentId: [...state.agents.keys()][0]!,
        cell: directive.targetCell,
        originatingTick: 4,
        abandonedCellCount: 2,
      },
    ]);
    expect(compiled.observation).not.toHaveProperty('simulatedPlayer');
  });

  it('retains a completed provider attempt even when no world state is committed', async () => {
    const { state, directive } = fixture();
    const accounting = new AttemptAccounting(10);
    const compiled = compileReflexObservation(state, directive);
    const chosenCandidateId = compiled.observation.candidates.find(
      ({ description }) => description.startsWith('Remain'),
    )!.id;
    const provider = new ScriptedReflexProvider([{ chosenCandidateId }]);
    const selected = await chooseReflexWorldAction(state, directive, provider, {
      accounting,
      intendedTickNumber: 1,
      intendedTurnNumber: 1,
      now: () => '2026-08-13T12:00:00.000Z',
    });
    expect(selected.action).toEqual({ type: 'wait' });
    expect(accounting.ledger()).toMatchObject([
      {
        outcome: 'completed',
        provider: { provider: 'scripted-test', promptTokens: 0 },
        reflexDecision: {
          directiveId: directive.id,
          chosenCandidateId: selected.decision?.chosenCandidateId,
          probabilities: selected.decision?.probabilities,
        },
      },
    ]);
    expect(state.agents.get(directive.agentId)).toBeDefined();
  });

  it('falls back to wait and records a malformed worker response', async () => {
    const { state, directive } = fixture();
    const accounting = new AttemptAccounting(10);
    const provider = new ScriptedReflexProvider([
      { chosenCandidateId: 'action_999' },
    ]);
    const selected = await chooseReflexWorldAction(state, directive, provider, {
      accounting,
      now: () => '2026-08-13T12:00:00.000Z',
    });
    expect(selected.action).toEqual({ type: 'wait' });
    expect(selected.cognitionSource).toBe('deterministic-fallback');
    expect(accounting.ledger()[0]?.outcome).toBe('provider-error');
  });

  it('rejects fabricated cognition attribution and partial probability telemetry', async () => {
    const { state, directive } = fixture();
    const compiled = compileReflexObservation(state, directive);
    const selectedId = compiled.observation.candidates[0]!.id;
    const scripted = new ScriptedReflexProvider([
      { chosenCandidateId: selectedId },
    ]);
    const valid = await scripted.decide(compiled.observation);
    const provider: ReflexProvider = {
      mode: 'scripted-reflex-test',
      model: 'test',
      configured: true,
      decide: async () => ({
        ...valid,
        cognitionSource: 'zero-llm',
        probabilities: { [selectedId]: 1 },
      }),
    };
    const selected = await chooseReflexWorldAction(state, directive, provider);
    expect(selected.action).toEqual({ type: 'wait' });
    expect(selected.cognitionSource).toBe('deterministic-fallback');
    expect(selected.failure?.code).toBe('unsupported-response');
  });

  it('records both TypeSafe HTTP attempts when a transient retry succeeds', async () => {
    const { state, directive } = fixture();
    const accounting = new AttemptAccounting(10);
    const compiled = compileReflexObservation(state, directive);
    const ids = compiled.observation.candidates.map(({ id }) => id);
    const chosenCandidateId = ids.at(-1)!;
    const probabilities = Object.fromEntries(
      ids.map((id) => [id, id === chosenCandidateId ? 1 : 0]),
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              choose_action: {
                type: 'choice',
                choice: chosenCandidateId,
                probabilities,
                confidence: 1,
              },
              request_replan: { type: 'noul', noul: 0 },
            },
            usage: { input_tokens: 24, output_tokens: 0 },
          }),
        ),
      );
    const provider = new TypeSafeJevReflexProvider({
      apiKey: 'test-only',
      fetchImplementation,
    });
    const selected = await chooseReflexWorldAction(state, directive, provider, {
      accounting,
      now: () => '2026-08-13T12:00:00.000Z',
    });
    expect(selected.cognitionSource).toBe('jev-reflex');
    expect(
      accounting.ledger().map(({ kind, outcome }) => ({ kind, outcome })),
    ).toEqual([
      { kind: 'initial', outcome: 'provider-error' },
      { kind: 'automatic-transport-retry', outcome: 'completed' },
    ]);
    expect(accounting.ledger()[1]?.reflexDecision?.probabilities).toEqual(
      probabilities,
    );
  });
});
