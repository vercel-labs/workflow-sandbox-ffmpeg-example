'use client';

import { useRef, useState } from 'react';

const OUTPUT_FORMATS = [
  { value: 'mp3', label: 'MP3 (audio)' },
  { value: 'wav', label: 'WAV (audio)' },
  { value: 'ogg', label: 'OGG (audio)' },
  { value: 'mp4', label: 'MP4 (video)' },
  { value: 'webm', label: 'WebM (video)' },
  { value: 'gif', label: 'GIF (animated)' },
];

interface LogEntry {
  ts: number;
  message: string;
  level?: string;
}

interface ConversionResult {
  outputFormat: string;
  input: {
    duration: string;
    size: string;
    format_name: string;
  };
  output: {
    duration: string;
    size: string;
    format_name: string;
  };
}

export default function Home() {
  const [inputUrl, setInputUrl] = useState('');
  const [outputFormat, setOutputFormat] = useState('mp3');
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle'
  );
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  function appendLog(entry: LogEntry) {
    setLogs((prev) => [...prev, entry]);
    // Auto-scroll to bottom
    setTimeout(
      () => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
      50
    );
  }

  async function readLogStream(runId: string) {
    try {
      const res = await fetch(`/api/convert/stream?runId=${runId}`);
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // The stream sends newline-delimited JSON chunks
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.message) {
              appendLog(entry);
            }
          } catch {
            // Not valid JSON — might be a partial chunk
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const entry = JSON.parse(buffer.trim());
          if (entry.message) appendLog(entry);
        } catch {
          // ignore
        }
      }
    } catch {
      // Stream connection failed or was closed — not critical
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inputUrl.trim()) return;

    setStatus('running');
    setResult(null);
    setError('');
    setLogs([]);

    try {
      const res = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputUrl, outputFormat }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start conversion');
      }

      const { runId } = await res.json();

      // Start reading the log stream (non-blocking)
      readLogStream(runId);

      // Poll for completion
      const poll = async () => {
        const pollRes = await fetch(`/api/convert?runId=${runId}`);
        const data = await pollRes.json();

        if (data.status === 'completed') {
          setResult(data.output);
          setStatus('done');
        } else if (data.status === 'failed') {
          setError(data.error ?? 'Conversion failed');
          setStatus('error');
        } else {
          setTimeout(poll, 1500);
        }
      };

      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }

  function formatBytes(bytes: string | number) {
    const b = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(seconds: string | number) {
    const s = typeof seconds === 'string' ? parseFloat(seconds) : seconds;
    if (isNaN(s)) return 'N/A';
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  return (
    <div className="flex min-h-screen items-center justify-center font-sans">
      <main className="flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            FFmpeg Sandbox Converter
          </h1>
          <p className="text-sm text-zinc-400">
            Convert media files using ffmpeg inside a Vercel Sandbox. The
            workflow suspends while the Sandbox does the work, then resumes via
            webhook when complete.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="url"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="URL to a media file (e.g. https://example.com/video.mp4)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-600"
            required
          />
          <div className="flex gap-3">
            <select
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
            >
              {OUTPUT_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={status === 'running' || !inputUrl.trim()}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === 'running' ? 'Converting...' : 'Convert'}
            </button>
          </div>
        </form>

        {logs.length > 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <h2 className="mb-2 text-xs font-medium text-zinc-500 uppercase">
              Sandbox Logs
            </h2>
            <div className="max-h-64 overflow-y-auto font-mono text-xs leading-relaxed">
              {logs.map((entry, i) => (
                <div
                  key={i}
                  className={
                    entry.level === 'stderr'
                      ? 'text-yellow-400'
                      : entry.message.startsWith('$')
                        ? 'text-blue-400'
                        : 'text-zinc-400'
                  }
                >
                  {entry.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-3 text-sm font-medium text-zinc-300">
                Conversion Complete
              </h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <h3 className="mb-1 text-xs font-medium text-zinc-500 uppercase">
                    Input
                  </h3>
                  <p className="text-zinc-300">
                    Format: {result.input?.format_name ?? 'unknown'}
                  </p>
                  <p className="text-zinc-300">
                    Size:{' '}
                    {result.input?.size
                      ? formatBytes(result.input.size)
                      : 'N/A'}
                  </p>
                  <p className="text-zinc-300">
                    Duration:{' '}
                    {result.input?.duration
                      ? formatDuration(result.input.duration)
                      : 'N/A'}
                  </p>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-medium text-zinc-500 uppercase">
                    Output ({result.outputFormat})
                  </h3>
                  <p className="text-zinc-300">
                    Format: {result.output?.format_name ?? 'unknown'}
                  </p>
                  <p className="text-zinc-300">
                    Size:{' '}
                    {result.output?.size
                      ? formatBytes(result.output.size)
                      : 'N/A'}
                  </p>
                  <p className="text-zinc-300">
                    Duration:{' '}
                    {result.output?.duration
                      ? formatDuration(result.output.duration)
                      : 'N/A'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
