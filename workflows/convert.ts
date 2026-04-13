import { Sandbox } from '@vercel/sandbox';
import { createWebhook, FatalError, sleep } from 'workflow';

// Static ffmpeg build — no apt-get needed in the Sandbox.
const FFMPEG_URL =
  'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

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

    // Build the conversion script. The script ALWAYS calls the
    // webhook — on success it sends metadata, on failure it sends
    // the error. This ensures the workflow never hangs.
    const script = `#!/bin/bash

CALLBACK_URL='${callbackUrl}'

# Error handler — POST the error to the webhook so the workflow resumes
report_error() {
  local msg="$1"
  echo "ERROR: $msg" >&2
  curl -sf -X POST "$CALLBACK_URL" \\
    -H 'Content-Type: application/json' \\
    -d "{\\"error\\": \\"$msg\\"}" || true
  exit 1
}

echo "==> Downloading static ffmpeg build..."
curl -sfL '${FFMPEG_URL}' -o /tmp/ffmpeg.tar.xz \\
  || report_error "Failed to download ffmpeg"

echo "==> Extracting ffmpeg..."
mkdir -p /tmp/ffmpeg-bin
tar xf /tmp/ffmpeg.tar.xz --strip-components=1 -C /tmp/ffmpeg-bin \\
  || report_error "Failed to extract ffmpeg"

export PATH="/tmp/ffmpeg-bin:$PATH"

echo "==> Downloading input file..."
curl -sfL -o /tmp/input '${inputUrl}' \\
  || report_error "Failed to download input file"

echo "==> Collecting input metadata..."
INPUT_META=$(ffprobe -v error -show_entries format=duration,size,format_name -of json /tmp/input 2>&1) \\
  || report_error "ffprobe failed on input: $INPUT_META"

echo "==> Converting to ${outputFormat}..."
FFMPEG_OUTPUT=$(ffmpeg -i /tmp/input -y '/tmp/output.${outputFormat}' 2>&1) \\
  || report_error "ffmpeg conversion failed: $FFMPEG_OUTPUT"

echo "==> Collecting output metadata..."
OUTPUT_META=$(ffprobe -v error -show_entries format=duration,size,format_name -of json '/tmp/output.${outputFormat}' 2>&1) \\
  || report_error "ffprobe failed on output: $OUTPUT_META"

echo "==> Conversion complete, resuming workflow..."
curl -sf -X POST "$CALLBACK_URL" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"input\\": $INPUT_META, \\"output\\": $OUTPUT_META}" \\
  || report_error "Failed to POST to webhook"

echo "==> Done."
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
      throw new FatalError('Conversion timed out after 5 minutes');
    }

    // Parse the metadata that the script POSTed to the webhook.
    // Request#json() executes as a step in the workflow context.
    const metadata = await result.json();

    // If the script reported an error, surface it
    if (metadata.error) {
      throw new FatalError(`Sandbox script failed: ${metadata.error}`);
    }

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
