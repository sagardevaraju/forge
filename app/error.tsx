'use client';

/**
 * Root route-error boundary. Catches errors thrown while rendering any page
 * segment that doesn't ship its own `error.tsx`. Matches the red error
 * palette of the existing per-route boundaries (e.g. app/portfolio/error.tsx)
 * so a thrown error reads consistently regardless of which view failed.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-2xl mt-[8vh]">
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <div className="font-semibold mb-1">Something went wrong.</div>
          <div className="text-red-800/90 mb-3">
            This view failed to load. The error is logged below.
          </div>
          <div className="font-mono text-xs whitespace-pre-wrap break-words">
            {error.message}
            {error.digest ? `  (digest ${error.digest})` : ''}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={reset}
              className="inline-block bg-red-700 text-white px-3 py-1 rounded text-xs hover:bg-red-800"
            >
              Retry
            </button>
            <a
              href="/"
              className="inline-block px-3 py-1 rounded text-xs text-red-900 hover:bg-red-100"
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
