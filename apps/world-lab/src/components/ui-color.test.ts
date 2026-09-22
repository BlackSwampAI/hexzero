import { describe, expect, it } from 'vitest';
import type { AgentId, SimulationSnapshot } from '@hexzero/shared';
import { neutralAgentColor, resolveAgentColor } from './ui-color';

const agentId = '11111111-1111-4111-8111-111111111111' as AgentId;
const otherId = '22222222-2222-4222-8222-222222222222' as AgentId;
const state = () =>
  ({
    world: {
      agents: [{ id: agentId, color: '#123456' }],
    },
  }) as unknown as Pick<SimulationSnapshot, 'world'>;

describe('agent color resolution', () => {
  it("resolves to the agent's own color", () => {
    expect(resolveAgentColor(state(), agentId)).toBe('#123456');
  });

  it('falls back to the neutral color when the agent is unknown', () => {
    expect(resolveAgentColor(state(), otherId)).toBe(neutralAgentColor);
  });
});
