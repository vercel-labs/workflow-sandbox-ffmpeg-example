import { getRun } from 'workflow/api';

/**
 * GET /api/convert/stream?runId=xxx
 *
 * Streams sandbox logs to the client in real-time. The workflow
 * writes log entries to a "logs" stream via getWritable(), and
 * this endpoint exposes that stream via getReadable().
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId');

  if (!runId) {
    return Response.json({ error: 'Missing runId' }, { status: 400 });
  }

  const run = getRun(runId);
  const readable = run.getReadable({ namespace: 'logs' });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Workflow-Run-Id': runId,
    },
  });
}
