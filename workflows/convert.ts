import { Sandbox } from '@vercel/sandbox';
import { createWebhook, FatalError, sleep } from 'workflow';

/**
 * Runs a command in the Sandbox and throws on failure, including
 * stdout/stderr in the error message for visibility.
 */
async function run(sandbox: Sandbox, cmd: string, args: string[]) {
  'use step';
  const result = await sandbox.runCommand(cmd, args);
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  console.log(`[sandbox] ${cmd} ${args.join(' ')}`);
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  if (result.exitCode !== 0) {
    throw new FatalError(
      `Command failed (exit ${result.exitCode}): ${cmd} ${args.join(' ')}\n${stderr || stdout}`
    );
  }
  return { stdout, stderr, exitCode: result.exitCode };
}

/**
 * Converts a media file using ffmpeg inside a Vercel Sandbox.
 *
 * The Sandbox instance is used directly in the "use workflow" function —
 * each Sandbox method (create, writeFiles, runCommand, stop) has "use step"
 * built in, and the Sandbox object is automatically serialized across step
 * boundaries via the WORKFLOW_SERIALIZE / WORKFLOW_DESERIALIZE protocol.
 *
 * Setup commands (downloading ffmpeg, downloading the input file) run
 * synchronously as durable steps so we get stdout/stderr for debugging.
 * The actual ffmpeg conversion runs as a background process — when it
 * finishes, a curl request hits the workflow's webhook URL to resume
 * execution.
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
    // Step 1: Install xz (needed to decompress the ffmpeg tarball).
    // The Sandbox is Amazon Linux 2023 with dnf + sudo available.
    // Each runCommand() is a durable step with visible stdout/stderr.
    await run(sandbox, 'sudo', ['dnf', 'install', '-y', 'xz']);

    // Step 2: Download and extract a static ffmpeg build to /tmp
    // (writable by the sandbox user — /usr/local requires root).
    await run(sandbox, 'bash', [
      '-c',
      "mkdir -p /tmp/ffmpeg && curl -sfL 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz' | tar xJf - --strip-components=1 -C /tmp/ffmpeg",
    ]);

    // Step 3: Download the input media file
    await run(sandbox, 'bash', ['-c', `curl -sfL -o /tmp/input '${inputUrl}'`]);

    // Step 4: Collect input file metadata (so we can return it later)
    const { stdout: inputMetaJson } = await run(sandbox, 'bash', [
      '-c',
      '/tmp/ffmpeg/ffprobe -v error -show_entries format=duration,size,format_name -of json /tmp/input',
    ]);

    // Step 5: Create the webhook and kick off ffmpeg in the background.
    // When ffmpeg finishes, the script curls the webhook URL to resume
    // the workflow. The workflow suspends (zero compute) while it runs.
    using webhook = createWebhook();
    const callbackUrl = new URL(webhook.url, baseUrl).href;

    const conversionScript = `#!/bin/bash

/tmp/ffmpeg/ffmpeg -i /tmp/input -y '/tmp/output.${outputFormat}' 2>/tmp/ffmpeg.log

if [ $? -eq 0 ]; then
  OUTPUT_META=$(/tmp/ffmpeg/ffprobe -v error -show_entries format=duration,size,format_name -of json '/tmp/output.${outputFormat}')
  curl -sf -X POST '${callbackUrl}' \\
    -H 'Content-Type: application/json' \\
    -d "{\\"output\\": $OUTPUT_META}"
else
  LOG=$(cat /tmp/ffmpeg.log | head -20 | tr '"' "'")
  curl -sf -X POST '${callbackUrl}' \\
    -H 'Content-Type: application/json' \\
    -d "{\\"error\\": \\"ffmpeg failed: $LOG\\"}"
fi
`;

    await sandbox.writeFiles([
      { path: 'convert.sh', content: conversionScript },
    ]);

    // Start conversion in background — runCommand returns immediately
    await run(sandbox, 'bash', ['-c', 'bash convert.sh &']);

    // Workflow SUSPENDS here — zero compute while ffmpeg runs
    // in the Sandbox. Could be seconds or minutes.
    const result = await Promise.race([webhook, sleep('5m')]);

    if (!result) {
      throw new FatalError('Conversion timed out after 5 minutes');
    }

    // Parse the metadata that the script POSTed to the webhook.
    // Request#json() executes as a step in the workflow context.
    const metadata = await result.json();

    if (metadata.error) {
      throw new FatalError(`Sandbox: ${metadata.error}`);
    }

    return {
      outputFormat,
      input: JSON.parse(inputMetaJson)?.format,
      output: metadata.output?.format,
    };
  } finally {
    // Always clean up the Sandbox VM
    await sandbox.stop();
  }
}
