import { gridDisk } from 'h3-js';
import { describe, expect, it } from 'vitest';
import { type H3Cell, type SwarmDirective } from '@hexzero/shared';
import { createDevelopmentWorld, toWorldState } from '@hexzero/world-engine';
import {
  isSwarmDirectiveComplete,
  swarmDirectiveIssue,
} from './swarm-directives';

function fixture() {
  const state = toWorldState(createDevelopmentWorld());
  const worker = [...state.agents.values()][1]!;
  const neighbor = gridDisk(worker.currentCell, 1).find(
    (cell) => cell !== worker.currentCell && state.hexes.has(cell as H3Cell),
  ) as H3Cell;
  const farOpen = [...state.hexes.entries()].find(
    ([cell, hex]) =>
      hex.state === 'open' &&
      cell !== worker.currentCell &&
      !gridDisk(cell, 1).some((nearby) => nearby === worker.currentCell),
  )![0];
  const directive = (
    mission: SwarmDirective['mission'],
    targetCell: H3Cell | null = neighbor,
  ): SwarmDirective => ({
    id: `directive-${mission}`,
    agentId: worker.id,
    mission,
    targetCell,
    priority: 'normal',
    riskTolerance: 'medium',
    issuedAtTick: 1,
    expiresAtTick: 4,
  });
  return { state, worker, neighbor, farOpen, directive };
}

describe('swarm directive semantics', () => {
  it('completes expand only after the target is infected and worker-controlled', () => {
    const { state, worker, neighbor, directive } = fixture();
    expect(isSwarmDirectiveComplete(state, directive('expand'))).toBe(false);
    const hexes = new Map(state.hexes);
    hexes.set(neighbor, { state: 'infected', controllerAgentId: worker.id });
    expect(
      isSwarmDirectiveComplete({ ...state, hexes }, directive('expand')),
    ).toBe(true);
  });

  it('completes relocate and reinforce once the worker reaches the target', () => {
    const { state, worker, neighbor, directive } = fixture();
    const agents = new Map(state.agents);
    agents.set(worker.id, { ...worker, currentCell: neighbor });
    const arrived = { ...state, agents };
    expect(isSwarmDirectiveComplete(arrived, directive('relocate'))).toBe(true);
    expect(isSwarmDirectiveComplete(arrived, directive('reinforce'))).toBe(
      true,
    );
  });

  it('completes evade on arrival or after exiting prior high pressure', () => {
    const { state, worker, neighbor, farOpen, directive } = fixture();
    expect(isSwarmDirectiveComplete(state, directive('evade'))).toBe(false);
    const agents = new Map(state.agents);
    agents.set(worker.id, { ...worker, currentCell: neighbor });
    expect(
      isSwarmDirectiveComplete({ ...state, agents }, directive('evade')),
    ).toBe(true);
    expect(
      isSwarmDirectiveComplete(state, directive('evade', farOpen), {
        priorNearbyPressure: 'high',
        recentCleanedCells: [farOpen],
      }),
    ).toBe(true);
    expect(
      isSwarmDirectiveComplete(state, directive('evade', farOpen), {
        priorNearbyPressure: 'high',
        recentCleanedCells: [worker.currentCell],
      }),
    ).toBe(false);
    expect(
      isSwarmDirectiveComplete(state, directive('evade', farOpen), {
        priorNearbyPressure: 'high',
      }),
    ).toBe(false);
  });

  it('does not complete hold or directives without targets automatically', () => {
    const { state, directive } = fixture();
    expect(isSwarmDirectiveComplete(state, directive('hold'))).toBe(false);
    expect(isSwarmDirectiveComplete(state, directive('relocate', null))).toBe(
      false,
    );
  });

  it('rejects missing, already-satisfied, and incoherent targets on issue', () => {
    const { state, worker, neighbor, farOpen, directive } = fixture();
    expect(swarmDirectiveIssue(state, directive('expand', null))).toBeTruthy();
    expect(
      swarmDirectiveIssue(state, directive('relocate', worker.currentCell)),
    ).toBeTruthy();
    const hexes = new Map(state.hexes);
    hexes.set(neighbor, { state: 'infected', controllerAgentId: worker.id });
    expect(
      swarmDirectiveIssue({ ...state, hexes }, directive('expand')),
    ).toBeTruthy();
    expect(
      swarmDirectiveIssue({ ...state, hexes }, directive('reinforce')),
    ).toBeNull();
    const frontierHexes = new Map(state.hexes);
    frontierHexes.set(worker.currentCell, {
      state: 'infected',
      controllerAgentId: worker.id,
    });
    expect(
      swarmDirectiveIssue(
        { ...state, hexes: frontierHexes },
        directive('reinforce'),
      ),
    ).toBeNull();
    expect(
      swarmDirectiveIssue(state, directive('reinforce', farOpen)),
    ).toContain('Reinforce');
  });
});
