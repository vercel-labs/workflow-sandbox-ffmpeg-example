import { Sandbox } from '@vercel/sandbox';
import { createWebhook, sleep } from 'workflow';

/**
 * Converts a media file using ffmpeg inside a Vercel Sandbox.
 *
 * The Sandbox instance is used directly in the "use workflow" function —
 * each Sandbox method (create, writeFiles, runCommand, stop) has "use step"
 * built in, and the Sandbox object is automatically serialized across step
 * boundaries via the WORKFLOW_SERIALIZE / WORKFLOW_DESERIALIZE protocol.
 *
 * The conversion runs as a background process inside the Sandbox. When
 * ffmpeg finishes, a curl request hits the workflow's webhook URL to
 * resume execution. The workflow is fully suspended (zero compute) while
 * the Sandbox does the work.
 */
export async function convertMedia(
  baseUrl: string,
  inputUrl: string,
  outputFormat: string
) {
  'use workflow';

  // Create a Sandbox VM — this is a durable step. The returned
  // Sandbox instance is serialized via WORKFLOW_SERIALIZE when it
  // crosses step boundaries.
  const sandbox = await Sandbox.create({
    timeout: 5 * 60 * 1000,
  });

  try {
    // Create a webhook — the Sandbox will curl this URL when
    // ffmpeg finishes, resuming the workflow.
    using webhook = createWebhook();
    const callbackUrl = new URL(webhook.url, baseUrl).href;

    // Build the conversion script. When ffmpeg completes, it
    // collects metadata with ffprobe and POSTs it to the webhook.
    const script = `#!/bin/bash
set -euo pipefail

# Install ffmpeg
apt-get update -qq > /dev/null 2>&1
apt-get install -y -qq ffmpeg > /dev/null 2>&1

# Download the input file
curl -sfL -o /tmp/input '${inputUrl}'

# Collect input file metadata
INPUT_META=$(ffprobe -v error -show_entries format=duration,size,format_name -of json /tmp/input)

# Convert with ffmpeg
ffmpeg -i /tmp/input -y '/tmp/output.${outputFormat}' 2>/dev/null

# Collect output file metadata
OUTPUT_META=$(ffprobe -v error -show_entries format=duration,size,format_name -of json '/tmp/output.${outputFormat}')

# Resume the workflow by POSTing metadata to the webhook
curl -sf -X POST '${callbackUrl}' \\
  -H 'Content-Type: application/json' \\
  -d "{\\"input\\": $INPUT_META, \\"output\\": $OUTPUT_META}"
`;

    // Write the script to the Sandbox filesystem
    await sandbox.writeFiles([{ path: 'convert.sh', content: script }]);

    // Start the conversion in the background. The outer shell
    // starts the inner script and exits immediately, so
    // runCommand() returns without waiting for ffmpeg to finish.
    await sandbox.runCommand('bash', ['-c', 'bash /home/user/convert.sh &']);

    // Workflow SUSPENDS here — zero compute while ffmpeg runs
    // in the Sandbox. Could be seconds or minutes.
    const result = await Promise.race([webhook, sleep('5m')]);

    if (!result) {
      throw new Error('Conversion timed out after 5 minutes');
    }

    // Parse the metadata that the script POSTed to the webhook
    const metadata = await parseWebhookBody(result);

    return {
      outputFormat,
      input: metadata.input?.format,
      output: metadata.output?.format,
    };
  } finally {
    // Always clean up the Sandbox VM
    await sandbox.stop();
  }
}

/**
 * Parse the webhook request body. This needs to be a step because
 * Request.json() is async and cannot run in the workflow sandbox.
 */
async function parseWebhookBody(request: Request) {
  'use step';
  return await request.json();
}
