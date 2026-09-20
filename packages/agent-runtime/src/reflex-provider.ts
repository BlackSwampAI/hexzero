import {
  reflexDecisionSchema,
  reflexObservationSchema,
  type ProviderFailure,
  type ProviderMetadata,
  type ReflexDecision,
  type ReflexObservation,
} from '@hexzero/shared';

export type { ReflexDecision } from '@hexzero/shared';

/**
 * A bounded local-decision provider. Unlike AgentProvider, this provider can
 * select only a service-compiled opaque candidate identifier.
 */
export interface ReflexProvider {
  readonly mode: 'typesafe-jev' | 'scripted-reflex-test';
  readonly model?: string;
  readonly configured: boolean;
  decide(
    observation: ReflexObservation,
    options?: ReflexDecisionOptions,
  ): Promise<ReflexDecision>;
}

export interface ReflexDecisionOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
  beginAttempt?: ReflexAttemptStarter;
}

export interface ReflexAttemptCompletion {
  outcome: 'completed' | 'provider-error' | 'cancelled' | 'timeout';
  provider?: ProviderMetadata;
  failure?: ProviderFailure;
  reflexDecision?: ReflexDecision;
}

export type ReflexAttemptFinalizer = (
  completion: ReflexAttemptCompletion,
) => void;

export type ReflexAttemptStarter = (
  kind: 'initial' | 'automatic-transport-retry',
) => ReflexAttemptFinalizer | null;

export class ReflexProviderError extends Error {
  constructor(
    readonly failure: ProviderFailure,
    readonly metadata?: ProviderMetadata,
  ) {
    super(failure.message);
    this.name = 'ReflexProviderError';
  }
}

export interface ScriptedReflexChoice {
  chosenCandidateId: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  replanProbability?: number;
}

/** Deterministic offline provider for reflex-path tests. */
export class ScriptedReflexProvider implements ReflexProvider {
  readonly mode = 'scripted-reflex-test' as const;
  readonly model = 'deterministic-reflex-script';
  readonly configured = true;
  readonly #choices: ScriptedReflexChoice[];
  #cursor = 0;

  constructor(choices: ScriptedReflexChoice[]) {
    if (choices.length === 0)
      throw new Error('ScriptedReflexProvider requires at least one choice.');
    this.#choices = choices.map((choice) => ({ ...choice }));
  }

  async decide(
    observationInput: ReflexObservation,
    options: ReflexDecisionOptions = {},
  ): Promise<ReflexDecision> {
    const observation = reflexObservationSchema.parse(observationInput);
    const finalize = options.beginAttempt?.('initial');
    if (finalize === null)
      throw new ReflexProviderError({
        code: 'budget-exhausted',
        message: 'The reflex provider attempt budget is exhausted.',
        retryable: false,
      });
    try {
      const choice = this.#choices[this.#cursor];
      if (!choice)
        throw new ReflexProviderError({
          code: 'unsupported-response',
          message: 'The deterministic reflex script has no choice remaining.',
          retryable: false,
        });
      this.#cursor += 1;
      const candidateIds = observation.candidates.map(({ id }) => id);
      if (!candidateIds.includes(choice.chosenCandidateId))
        throw new ReflexProviderError({
          code: 'invalid-decision',
          message:
            'The deterministic reflex script selected an unknown candidate.',
          retryable: false,
        });
      const probabilities =
        choice.probabilities ??
        Object.fromEntries(
          candidateIds.map((id) => [
            id,
            id === choice.chosenCandidateId ? 1 : 0,
          ]),
        );
      const decision = reflexDecisionSchema.parse({
        chosenCandidateId: choice.chosenCandidateId,
        confidence: choice.confidence ?? 1,
        probabilities,
        replanProbability: choice.replanProbability ?? 0,
        model: this.model,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        directiveId: observation.directive.id,
        cognitionSource: 'jev-reflex',
      });
      finalize?.({
        outcome: 'completed',
        provider: scriptedMetadata(this.model),
        reflexDecision: decision,
      });
      return decision;
    } catch (error) {
      const providerError =
        error instanceof ReflexProviderError
          ? error
          : new ReflexProviderError({
              code: 'unsupported-response',
              message: 'The deterministic reflex script returned invalid data.',
              retryable: false,
            });
      finalize?.({
        outcome: 'provider-error',
        provider: providerError.metadata ?? scriptedMetadata(this.model),
        failure: providerError.failure,
      });
      throw providerError;
    }
  }
}

function scriptedMetadata(model: string): ProviderMetadata {
  return {
    provider: 'scripted-test',
    model,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}
