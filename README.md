# Workflow SDK + Sandbox FFmpeg Example

A media file converter that runs ffmpeg inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) VM, orchestrated by [Workflow SDK](https://useworkflow.dev). Demonstrates the webhook callback pattern — the workflow suspends with zero compute while the Sandbox does the work, then resumes when ffmpeg completes and curls the webhook URL.

## How It Works

1. User provides a media file URL and selects an output format
2. The workflow creates a **Sandbox VM** and a **webhook**
3. A shell script is written to the Sandbox that downloads the file, runs ffmpeg, and `curl`s the webhook URL when done
4. The script starts in the background — the workflow **suspends** (zero compute)
5. When ffmpeg finishes, the `curl` hits the webhook, **resuming** the workflow
6. The workflow collects conversion metadata and cleans up the Sandbox

```ts
export async function convertMedia(baseUrl: string, inputUrl: string, outputFormat: string) {
  "use workflow";

  // Sandbox.create() is a durable step — the instance is automatically
  // serialized across step boundaries via WORKFLOW_SERIALIZE
  const sandbox = await Sandbox.create({ timeout: 5 * 60 * 1000 });

  try {
    using webhook = createWebhook();
    const callbackUrl = new URL(webhook.url, baseUrl).href;

    // Write the conversion script and start it in the background
    await sandbox.writeFiles([{ path: "convert.sh", content: script }]);
    await sandbox.runCommand("bash", ["-c", "bash /home/user/convert.sh &"]);

    // Workflow SUSPENDS — zero compute while ffmpeg runs in the Sandbox.
    // When the script finishes, it curls the webhook URL to resume.
    const result = await Promise.race([webhook, sleep("5m")]);
    // ...
  } finally {
    await sandbox.stop();
  }
}
```

### Key Patterns

- **Webhook callback from Sandbox** — the Sandbox's shell script `curl`s the workflow webhook URL when ffmpeg completes, resuming the suspended workflow
- **`createWebhook()`** — generates a unique URL that the Sandbox can POST to
- **Sandbox in `"use workflow"`** — `Sandbox.create()` and all Sandbox methods have `"use step"` built in, so they work directly in workflow functions. The Sandbox instance is automatically serialized across step boundaries via Workflow SDK's [custom class serialization](https://useworkflow.dev/docs/foundations/serialization)
- **`Promise.race([webhook, sleep("5m")])`** — built-in timeout pattern
- **`try/finally` with `sandbox.stop()`** — ensures the Sandbox VM is cleaned up even on failure

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- A Vercel account with Sandbox access

### 1. Clone and Install

```bash
git clone https://github.com/vercel-labs/workflow-sandbox-ffmpeg-example.git
cd workflow-sandbox-ffmpeg-example
pnpm install
```

### 2. Environment Variables

Create a `.env.local` file:

```bash
VERCEL_TEAM_ID=your_vercel_team_id
VERCEL_PROJECT_ID=your_vercel_project_id
```

### 3. Development

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and provide a URL to a media file to convert.

## Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fworkflow-sandbox-ffmpeg-example)

## Resources

- [Workflow SDK Documentation](https://useworkflow.dev/docs)
- [Hooks & Webhooks](https://useworkflow.dev/docs/foundations/hooks)
- [Serialization (custom classes)](https://useworkflow.dev/docs/foundations/serialization)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
