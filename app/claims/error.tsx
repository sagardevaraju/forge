'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-2">Claims Pre-Brief</h1>
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <div className="font-semibold mb-1">Failed to load pre-flagged claims.</div>
        <div className="font-mono text-xs whitespace-pre-wrap">
          {error.message}
          {error.digest ? `  (digest ${error.digest})` : ''}
        </div>
        <button
          onClick={reset}
          className="mt-3 inline-block bg-red-700 text-white px-3 py-1 rounded text-xs"
        >
          Retry
        </button>
      </div>
    </main>
  );
}
