import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notFound } from 'next/navigation';
import { mapLibreWorkerFiles } from './worker-files';

async function getInstalledMapLibreVersion() {
  const packageContents = await readFile(
    join(process.cwd(), 'node_modules', 'maplibre-gl', 'package.json'),
    'utf8',
  );
  return (JSON.parse(packageContents) as { version: string }).version;
}

export async function serveMapLibreWorkerFile(
  file: string,
  requestedVersion?: string,
) {
  if (!mapLibreWorkerFiles.has(file)) notFound();

  if (requestedVersion !== undefined) {
    const installedVersion = await getInstalledMapLibreVersion();
    if (requestedVersion !== installedVersion) notFound();
  }

  const contents = await readFile(
    join(process.cwd(), 'node_modules', 'maplibre-gl', 'dist', file),
  );

  return new Response(contents, {
    headers: {
      'Cache-Control':
        requestedVersion === undefined
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
      'Content-Type': 'text/javascript; charset=utf-8',
    },
  });
}
