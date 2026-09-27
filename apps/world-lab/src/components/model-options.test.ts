import { describe, expect, it } from 'vitest';
import type { CompatibleModel } from '@hexzero/shared';
import { buildModelOptions, formatModelOption } from './model-options';

const model = (id: string, name: string, price = '0'): CompatibleModel => ({
  id,
  name,
  author: id.split('/')[0]!,
  contextLength: 32_768,
  inputPricePerToken: price,
  outputPricePerToken: price,
  supportedParameters: ['max_tokens'],
  isFree: price === '0',
});

describe('shared model options', () => {
  it('deduplicates and orders model options consistently', () => {
    const catalog = [
      model('zeta/model', 'Alpha'),
      model('Acme/model-2', 'Zulu', '0.000001'),
      model('acme/model-1', 'Beta'),
      model('zeta/model', 'Duplicate ignored'),
    ];
    const options = buildModelOptions(catalog);

    expect(options.map(({ value }) => value)).toEqual([
      'acme/model-1',
      'Acme/model-2',
      'zeta/model',
    ]);
  });

  it('places the identifier before the friendly name and preserves price metadata', () => {
    expect(formatModelOption(model('sample/free', 'Friendly'))).toBe(
      'sample/free — Friendly · free in / free out',
    );
    expect(formatModelOption(model('sample/paid', 'Paid', '0.000001'))).toBe(
      'sample/paid — Paid · $1.00 in / $1.00 out',
    );
  });
});
