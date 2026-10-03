import { serveMapLibreWorkerFile } from '../../../serve-worker-file';

export async function GET(
  _request: Request,
  context: { params: Promise<{ version: string; file: string }> },
) {
  const { file, version } = await context.params;
  return serveMapLibreWorkerFile(file, version);
}
