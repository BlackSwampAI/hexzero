export type RealProviderSmokeScenario = 'initial' | 'stateful';

export interface RealProviderSmokeArguments {
  model: string;
  scenario: RealProviderSmokeScenario;
}

export function parseRealProviderSmokeArguments(
  argv: readonly string[],
): RealProviderSmokeArguments {
  const forwardedArguments = argv[0] === '--' ? argv.slice(1) : argv;
  const model = forwardedArguments[0]?.trim();
  if (!model)
    throw new Error(
      'Pass an explicit compatible model slug to smoke:openrouter.',
    );

  const scenario = forwardedArguments[1]?.trim() || 'initial';
  if (scenario !== 'initial' && scenario !== 'stateful')
    throw new Error('Smoke scenario must be either initial or stateful.');
  if (forwardedArguments.length > 2)
    throw new Error('Smoke accepts only a model slug and optional scenario.');

  return { model, scenario };
}
