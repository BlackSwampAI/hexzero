import { readFileSync } from 'node:fs';
import {
  AgentProviderError,
  OpenRouterAgentProvider,
  applyProviderEnvironmentFile,
} from './index';
import { parseRealProviderSmokeArguments } from './smoke-arguments';
import { buildRealProviderSmokeObservation } from './smoke-observation';

try {
  applyProviderEnvironmentFile(
    readFileSync(new URL('../../../.env', import.meta.url), 'utf8'),
  );
} catch (error) {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    throw error;
  }
}

const { model: selectedModel, scenario } = parseRealProviderSmokeArguments(
  process.argv.slice(2),
);
const observation = buildRealProviderSmokeObservation(scenario);
const provider = new OpenRouterAgentProvider({
  apiKey: process.env.OPENROUTER_API_KEY,
});

try {
  const result = await provider.decide(observation, selectedModel);
  console.log(
    JSON.stringify(
      {
        valid: true,
        decision: result.decision,
        provider: result.metadata.provider,
        model: result.metadata.model,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!(error instanceof AgentProviderError)) throw error;
  console.error(
    JSON.stringify(
      {
        valid: false,
        failure: error.failure,
        diagnostics: error.diagnostics,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
