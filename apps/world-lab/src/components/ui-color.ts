import {
  NEUTRAL_AGENT_COLOR,
  type AgentId,
  type SimulationSnapshot,
} from '@hexzero/shared';

export const neutralAgentColor = NEUTRAL_AGENT_COLOR;

export function resolveAgentColor(
  snapshot: Pick<SimulationSnapshot, 'world'>,
  agentId: AgentId,
): string {
  const agent = snapshot.world.agents.find(({ id }) => id === agentId);
  return agent?.color ?? neutralAgentColor;
}
