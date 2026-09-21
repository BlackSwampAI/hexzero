import { parseEnv } from 'node:util';

const providerEnvironmentNames = [
  'OPENROUTER_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

export function applyProviderEnvironmentFile(
  contents: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  let fileEnvironment: Record<string, string | undefined>;
  try {
    fileEnvironment = parseEnv(contents);
  } catch {
    throw new Error('The repository .env file could not be parsed.');
  }

  for (const name of providerEnvironmentNames) {
    if (fileEnvironment[name] !== undefined) {
      environment[name] = fileEnvironment[name];
    }
  }
}
