import { getRun, start } from 'workflow/api';
import { convertMedia } from '@/workflows/convert';

export async function POST(request: Request) {
  const { inputUrl, outputFormat } = await request.json();

  if (!inputUrl || !outputFormat) {
    return Response.json(
      { error: 'Missing inputUrl or outputFormat' },
      { status: 400 }
    );
  }

  const run = await start(convertMedia, [request.url, inputUrl, outputFormat]);

  return Response.json({ runId: run.runId });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId');

  if (!runId) {
    return Response.json({ error: 'Missing runId' }, { status: 400 });
  }

  const run = getRun(runId);
  const status = await run.status;

  if (status === 'completed' || status === 'failed') {
    try {
      const output = await run.returnValue;
      return Response.json({ status: 'completed', output });
    } catch (err) {
      return Response.json({
        status: 'failed',
        error: err instanceof Error ? err.message : 'Conversion failed',
      });
    }
  }

  return Response.json({ status });
}
