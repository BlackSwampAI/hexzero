import { serveMapLibreWorkerFile } from '../serve-worker-file';

export async function GET(
  _request: Request,
  context: { params: Promise<{ file: string }> },
) {
  const { file } = await context.params;
  return serveMapLibreWorkerFile(file);
}
