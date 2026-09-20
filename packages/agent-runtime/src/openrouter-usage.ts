import { z } from 'zod';
import type { ProviderMetadata } from '@hexzero/shared';

const nonnegativeInteger = z.number().int().nonnegative();
const nonnegativeFinite = z.number().nonnegative().finite();

/** Preserves provider-reported OpenRouter accounting without price estimates. */
export function normalizeOpenRouterUsage(
  usage: unknown,
): Partial<
  Pick<
    ProviderMetadata,
    | 'promptTokens'
    | 'completionTokens'
    | 'totalTokens'
    | 'reasoningTokens'
    | 'cachedReadTokens'
    | 'cacheWriteTokens'
    | 'costCredits'
  >
> {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  const completionDetails = asRecord(record.completion_tokens_details);
  const promptDetails = asRecord(record.prompt_tokens_details);
  return {
    ...numberMetadata('promptTokens', record.prompt_tokens, nonnegativeInteger),
    ...numberMetadata(
      'completionTokens',
      record.completion_tokens,
      nonnegativeInteger,
    ),
    ...numberMetadata('totalTokens', record.total_tokens, nonnegativeInteger),
    ...numberMetadata(
      'reasoningTokens',
      completionDetails?.reasoning_tokens,
      nonnegativeInteger,
    ),
    ...numberMetadata(
      'cachedReadTokens',
      promptDetails?.cached_tokens,
      nonnegativeInteger,
    ),
    ...numberMetadata(
      'cacheWriteTokens',
      promptDetails?.cache_write_tokens,
      nonnegativeInteger,
    ),
    ...numberMetadata('costCredits', record.cost, nonnegativeFinite),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberMetadata<Key extends keyof ProviderMetadata>(
  key: Key,
  value: unknown,
  schema: z.ZodType<NonNullable<ProviderMetadata[Key]>>,
): Partial<Pick<ProviderMetadata, Key>> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ({ [key]: parsed.data } as Partial<Pick<ProviderMetadata, Key>>)
    : {};
}
