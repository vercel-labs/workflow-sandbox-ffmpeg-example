import { Sandbox } from '@vercel/sandbox';
import { createWebhook, FatalError, getWritable, sleep } from 'workflow';

/**
 * Writes a log entry to the "logs" stream, which clients can
 * read in real-time via getReadable({ namespace: "logs" }).
 */
async function log(message: string) {
  'use step';
  const writable = getWritable({ namespace: 'logs' });
  const writer = writable.getWriter();
  await writer.write({ ts: Date.now(), message });
  writer.releaseLock();
}

/**
 * Closes the "logs" stream. Must be called when the workflow
 * is done writing logs so the client stream terminates.
 */
async function closeLogs() {
  'use step';
  const writable = getWritable({ namespace: 'logs' });
  await writable.close();
}

/**
 * Runs a command in the Sandbox, streams stdout/stderr to the
 * logs stream, and throws on failure.
 */
async function run(sandbox: Sandbox, cmd: string, args: string[]) {
  'use step';
  const label = `${cmd} ${args.join(' ')}`;

  // Write to the logs stream
  const writable = getWritable({ namespace: 'logs' });
  const writer = writable.getWriter();
  await writer.write({ ts: Date.now(), message: `$ ${label}` });

  const result = await sandbox.runCommand(cmd, args);
  const stdout = await result.stdout();
  const stderr = await result.stderr();

  if (stdout) {
    await writer.write({
      ts: Date.now(),
      message: stdout.trim(),
    });
  }
  if (stderr) {
    await writer.write({
      ts: Date.now(),
      message: stderr.trim(),
      level: 'stderr',
    });
  }

  writer.releaseLock();

  if (result.exitCode !== 0) {
    throw new FatalError(
      `Command failed (exit ${result.exitCode}): ${label}\n${stderr || stdout}`
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
 *
 * All sandbox output is piped to a "logs" stream that clients can read
 * in real-time via getReadable({ namespace: "logs" }).
 */
export async function convertMedia(
  baseUrl: string,
  inputUrl: string,
  outputFormat: string
) {
  'use workflow';

  await log(`Starting conversion: ${inputUrl} → ${outputFormat}`);

  // Create a Sandbox VM — this is a durable step. The returned
  // Sandbox instance is serialized via WORKFLOW_SERIALIZE when it
  // crosses step boundaries.
  const sandbox = await Sandbox.create({
    timeout: 5 * 60 * 1000,
  });

  try {
    // Step 1: Install xz (needed to decompress the ffmpeg tarball).
    // The Sandbox is Amazon Linux 2023 with dnf + sudo available.
    await log('Installing xz...');
    await run(sandbox, 'sudo', ['dnf', 'install', '-y', 'xz']);

    // Step 2: Download and extract a static ffmpeg build to /tmp
    // (writable by the sandbox user — /usr/local requires root).
    await log('Downloading ffmpeg...');
    await run(sandbox, 'bash', [
      '-c',
      "mkdir -p /tmp/ffmpeg && curl -sfL 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz' | tar xJf - --strip-components=1 -C /tmp/ffmpeg",
    ]);

    // Step 3: Download the input media file
    await log('Downloading input file...');
    await run(sandbox, 'bash', ['-c', `curl -sfL -o /tmp/input '${inputUrl}'`]);

    // Step 4: Collect input file metadata (so we can return it later)
    await log('Analyzing input with ffprobe...');
    const { stdout: inputMetaJson } = await run(sandbox, 'bash', [
      '-c',
      '/tmp/ffmpeg/ffprobe -v error -show_entries format=duration,size,format_name -of json /tmp/input',
    ]);

    // Step 5: Create the webhook and kick off ffmpeg in the background.
    // When ffmpeg finishes, the script curls the webhook URL to resume
    // the workflow. The workflow suspends (zero compute) while it runs.
    await log(`Converting to ${outputFormat} (suspending workflow)...`);
    const webhook = createWebhook();
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

    await log('Conversion complete.');
    await closeLogs();

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
