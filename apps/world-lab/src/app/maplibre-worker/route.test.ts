import { getVersion } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { GET as getLegacyWorker } from './[file]/route';
import { GET as getVersionedWorker } from './v/[version]/[file]/route';

describe('MapLibre worker routes', () => {
  it('serves versioned allowlisted files with immutable caching', async () => {
    const response = await getVersionedWorker(new Request('http://localhost'), {
      params: Promise.resolve({
        version: getVersion(),
        file: 'maplibre-gl-worker.mjs',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(await response.text()).toContain('maplibre-gl-shared.mjs');
  });

  it('returns not found for stale versions and files outside the allowlist', async () => {
    await expect(
      getVersionedWorker(new Request('http://localhost'), {
        params: Promise.resolve({
          version: 'stale-version',
          file: 'maplibre-gl-worker.mjs',
        }),
      }),
    ).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');

    await expect(
      getVersionedWorker(new Request('http://localhost'), {
        params: Promise.resolve({
          version: getVersion(),
          file: 'unlisted.mjs',
        }),
      }),
    ).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('serves legacy URLs without allowing browsers to retain stale bundles', async () => {
    const response = await getLegacyWorker(new Request('http://localhost'), {
      params: Promise.resolve({ file: 'maplibre-gl-shared.mjs' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('maplibre-gl-shared.mjs.map');
  });
});
