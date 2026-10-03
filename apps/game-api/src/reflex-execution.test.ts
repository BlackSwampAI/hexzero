import { describe, expect, it, vi } from 'vitest';
import { gridDisk } from 'h3-js';
import {
  DeterministicReflexProvider,
  DeterministicSwarmPlanner,
  ScriptedReflexProvider,
  TypeSafeJevReflexProvider,
  type ReflexProvider,
} from '@hexzero/agent-runtime';
import {
  simulatedPlayerEventSchema,
  type SimulatedPlayerEvent,
  type SwarmDirective,
} from '@hexzero/shared';
import {
  applyWorldAction,
  createDevelopmentWorld,
  enumerateLegalWorldActions,
  toWorldState,
} from '@hexzero/world-engine';
import { isSwarmDirectiveComplete } from './swarm-directives';
import { AttemptAccounting } from './attempt-accounting';
import { SimulationService } from './simulation-service';
import {
  chooseReflexWorldAction,
  chooseReflexWorldActions,
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
  it('executes swarm scenarios through the planner and reflex seams', async () => {
    const service = new SimulationService({
      swarmPlanner: new DeterministicSwarmPlanner(),
      reflexProvider: new DeterministicReflexProvider(),
    });
    const setup = service.getDefaultWorldSetup();
    const snapshot = service.applyWorldSetup({
      ...setup,
    });
    expect(snapshot.scenario.swarmArchitectureVersion).toBe('zero-swarm-v1');
    await service.executeNextTick();
    expect(service.getSnapshot().tickNumber).toBe(1);
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

  it('reports at-target after a worker reaches its directive target', () => {
    const { state, agent, directive, targetCell } = fixture();
    const moved = applyWorldAction(state, agent.id, {
      type: 'move',
      targetCell,
    });
    expect(moved.result.accepted).toBe(true);

    const compiled = compileReflexObservation(moved.state, directive, {
      previousCell: agent.currentCell,
    });

    expect(compiled.observation.currentSituation.directiveProgress).toBe(
      'at-target',
    );
  });

  it('preserves engine-legal candidates and directive priority/risk across missions', () => {
    const { state, directive } = fixture();
    const missions = [
      'expand',
      'hold',
      'relocate',
      'reinforce',
      'evade',
    ] as const;
    const observations = missions.map(
      (mission) =>
        compileReflexObservation(state, {
          ...directive,
          mission,
          targetCell: mission === 'hold' ? null : directive.targetCell,
          priority: 'low',
          riskTolerance: 'high',
        }).observation,
    );
    const expand = observations[0]!;
    const expectedIds = enumerateLegalWorldActions(
      state,
      directive.agentId,
    ).map((_, index) => `action_${index}`);
    expect(expand.candidates.map(({ id }) => id)).toEqual(expectedIds);
    expect(expand.directive).toMatchObject({
      mission: 'expand',
      priority: 'low',
      riskTolerance: 'high',
    });
    for (const observation of observations.slice(1)) {
      expect(observation.candidates.map(({ id }) => id)).toEqual(expectedIds);
      expect(observation.directive).toMatchObject({
        priority: 'low',
        riskTolerance: 'high',
      });
    }
  });

  it('explains infection only when standing on the assigned expand target', () => {
    const { state, agent, directive, targetCell } = fixture();
    const openCurrentState = {
      ...state,
      hexes: new Map(state.hexes).set(agent.currentCell, {
        state: 'open' as const,
        controllerAgentId: null,
      }),
    };
    const atTarget = compileReflexObservation(openCurrentState, {
      ...directive,
      mission: 'expand',
      targetCell: agent.currentCell,
    });
    const infectCandidate = atTarget.observation.candidates.find(
      ({ id }) => atTarget.actions.get(id)?.type === 'infect',
    );
    expect(infectCandidate?.description).toContain(
      'infecting it establishes this worker’s control and fulfills the directive',
    );
    expect(infectCandidate?.description).toContain(
      'Arriving here or waiting does not fulfill it.',
    );

    const offTarget = compileReflexObservation(openCurrentState, {
      ...directive,
      mission: 'expand',
      targetCell,
    });
    const genericInfect = offTarget.observation.candidates.find(
      ({ id }) => offTarget.actions.get(id)?.type === 'infect',
    );
    expect(genericInfect?.description).toBe(
      'Infect the current open cell and establish local territory.',
    );
    const sameCellOtherMission = compileReflexObservation(openCurrentState, {
      ...directive,
      mission: 'relocate',
      targetCell: agent.currentCell,
    });
    const otherMissionInfect = sameCellOtherMission.observation.candidates.find(
      ({ id }) => sameCellOtherMission.actions.get(id)?.type === 'infect',
    );
    expect(otherMissionInfect?.description).toBe(
      'Infect the current open cell and establish local territory.',
    );
  });

  it('accepts a legal wait for an open at-target expand directive with low risk and pressure', async () => {
    const { state, agent, directive } = fixture();
    const openCurrentState = {
      ...state,
      hexes: new Map(state.hexes).set(agent.currentCell, {
        state: 'open' as const,
        controllerAgentId: null,
      }),
    };
    const lowDirective = {
      ...directive,
      mission: 'expand' as const,
      targetCell: agent.currentCell,
      priority: 'low' as const,
      riskTolerance: 'low' as const,
    };
    const compiled = compileReflexObservation(openCurrentState, lowDirective);
    const engineChoices = enumerateLegalWorldActions(
      openCurrentState,
      directive.agentId,
    );
    const legalIds = engineChoices.map((_, index) => `action_${index}`);
    expect(compiled.observation.currentSituation.nearbyPressure).toBe('low');
    expect(compiled.observation.candidates.map(({ id }) => id)).toEqual(
      legalIds,
    );
    expect([...compiled.actions.values()]).toEqual(engineChoices);
    expect(compiled.observation.currentSituation.directiveProgress).toBe(
      'at-target',
    );
    expect(
      compiled.observation.candidates.find(
        ({ id }) => compiled.actions.get(id)?.type === 'infect',
      )?.description,
    ).toContain('fulfills the directive');
    const waitId = compiled.observation.candidates.find(
      ({ id }) => compiled.actions.get(id)?.type === 'wait',
    )!.id;
    const probabilities = Object.fromEntries(
      legalIds.map((id) => [id, id === waitId ? 1 : 0]),
    );
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            choose_action: {
              type: 'choice',
              choice: waitId,
              probabilities,
              confidence: 1,
            },
            request_replan: { type: 'noul', noul: 0 },
          },
          usage: { input_tokens: 12, output_tokens: 0 },
        }),
      ),
    );
    const selected = await chooseReflexWorldAction(
      openCurrentState,
      lowDirective,
      new TypeSafeJevReflexProvider({
        apiKey: 'test-only',
        fetchImplementation,
      }),
    );
    expect(selected.cognitionSource).toBe('jev-reflex');
    expect(selected.action).toEqual({ type: 'wait' });
    const request = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(request.state.directive).toMatchObject({
      mission: 'expand',
      priority: 'low',
      riskTolerance: 'low',
      fulfillmentCondition: expect.stringContaining(
        'Arriving at an open target or waiting there does not fulfill it.',
      ),
    });

    const [batchedSelection] = await chooseReflexWorldActions(
      [{ compiled, intendedTurnNumber: 1 }],
      new ScriptedReflexProvider([{ chosenCandidateId: waitId }]),
    );
    expect(batchedSelection?.cognitionSource).toBe('jev-reflex');
    expect(batchedSelection?.action).toEqual({ type: 'wait' });

    const scripted = new ScriptedReflexProvider([
      { chosenCandidateId: waitId },
    ]);
    const nativeProvider: ReflexProvider = {
      ...scripted,
      decide: scripted.decide.bind(scripted),
      decideBatch: async (observations) =>
        Promise.all(
          observations.map(async (observation) => ({
            agentId: observation.agentId,
            status: 'completed' as const,
            decision: await scripted.decide(observation),
          })),
        ),
    };
    const [nativeSelection] = await chooseReflexWorldActions(
      [{ compiled, intendedTurnNumber: 1 }],
      nativeProvider,
    );
    expect(nativeSelection?.decision?.chosenCandidateId).toBe(waitId);
    expect(nativeSelection?.action).toEqual({ type: 'wait' });
  });

  it('completes expand only after infection gives this worker control', () => {
    const { state, agent, directive } = fixture();
    const targetCell = [...state.hexes.entries()].find(
      ([cell, hex]) =>
        hex.state === 'open' &&
        cell !== agent.currentCell &&
        gridDisk(agent.currentCell, 1).includes(cell),
    )![0];
    const expandDirective = {
      ...directive,
      mission: 'expand' as const,
      targetCell,
    };
    const moved = applyWorldAction(state, agent.id, {
      type: 'move',
      targetCell,
    });
    expect(moved.result.accepted).toBe(true);
    expect(isSwarmDirectiveComplete(moved.state, expandDirective)).toBe(false);
    expect(
      compileReflexObservation(moved.state, expandDirective).observation
        .currentSituation.directiveProgress,
    ).toBe('at-target');
    const waited = applyWorldAction(moved.state, agent.id, { type: 'wait' });
    expect(waited.result.accepted).toBe(true);
    expect(isSwarmDirectiveComplete(waited.state, expandDirective)).toBe(false);

    const infected = applyWorldAction(waited.state, agent.id, {
      type: 'infect',
    });
    expect(infected.result.accepted).toBe(true);
    expect(isSwarmDirectiveComplete(infected.state, expandDirective)).toBe(
      true,
    );
    const otherAgentId = [...state.agents.keys()].find(
      (candidateId) => candidateId !== agent.id,
    )!;
    const wrongControllerHexes = new Map(infected.state.hexes).set(targetCell, {
      state: 'infected' as const,
      controllerAgentId: otherAgentId,
    });
    expect(
      isSwarmDirectiveComplete(
        { ...infected.state, hexes: wrongControllerHexes },
        expandDirective,
      ),
    ).toBe(false);
  });

  it('retains only the four most recent authoritative capture alerts', () => {
    const { state, directive } = fixture();
    const capturedAgentId = [...state.agents.keys()][0]!;
    const compiled = compileReflexObservation(state, directive, {
      captureAlerts: Array.from({ length: 5 }, (_, index) => ({
        capturedAgentId,
        cell: directive.targetCell!,
        originatingTick: index,
        abandonedCellCount: index,
      })),
    });
    expect(compiled.observation.captureAlerts).toHaveLength(4);
    expect(
      compiled.observation.captureAlerts?.map(
        ({ abandonedCellCount }) => abandonedCellCount,
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(compiled.observation).not.toHaveProperty('simulatedPlayer');
  });

  it('uses a current public disinfection for immediate pressure without exposing player state', () => {
    const { state, directive, targetCell } = fixture();
    const event = simulatedPlayerEventSchema.parse({
      id: '00000000-0000-4000-8000-000000000020',
      occurredAt: '2026-08-13T12:00:00.000Z',
      profile: 'trail-hunter-v1',
      originatingTick: 1,
      type: 'hex-disinfected',
      cell: targetCell,
      previousControllerAgentId: null,
    }) as Extract<SimulatedPlayerEvent, { type: 'hex-disinfected' }>;
    const compiled = compileReflexObservation(state, directive, {
      pressureEvents: [event],
    });
    expect(compiled.observation.currentSituation.nearbyPressure).toBe('high');
    expect(compiled.observation).not.toHaveProperty('simulatedPlayer');
    expect(compiled.observation).not.toHaveProperty('pressureEvents');
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
