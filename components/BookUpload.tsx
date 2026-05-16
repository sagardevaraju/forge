'use client';
/**
 * Book upload widget. Drag-and-drop or click to pick a CSV; POSTs it as
 * multipart/form-data to /api/book/upload; surfaces per-row errors when
 * validation fails; redirects to /portfolio on success once the MIP
 * precompute reports back.
 */
import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface UploadResult {
  accepted?: number;
  rejected?: number;
  errors?: { row: number; message: string }[];
  optimization?: 'refreshed' | 'failed' | 'skipped';
  error?: string;
}

const REQUIRED_COLS = [
  'policy_id',
  'state',
  'zip3',
  'lat',
  'lon',
  'tiv',
  'build_type',
  'flood_zone',
];

export function BookUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [filename, setFilename] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>('');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const submitFile = useCallback(
    async (file: File) => {
      setFilename(file.name);
      setBusy(true);
      setResult(null);
      setStage('Validating + writing to database…');
      try {
        const form = new FormData();
        form.append('file', file);
        const r = await fetch('/api/book/upload', {
          method: 'POST',
          body: form,
        });
        setStage('Re-running Portfolio MIP…');
        const data = (await r.json()) as UploadResult;
        setResult(data);
        if (r.ok && data.optimization === 'refreshed') {
          setStage('Done. Redirecting to /portfolio…');
          setTimeout(() => router.push('/portfolio'), 900);
        } else {
          setStage('');
        }
      } catch (e: unknown) {
        setResult({ error: e instanceof Error ? e.message : String(e) });
        setStage('');
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) submitFile(f);
    },
    [submitFile],
  );

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded p-8 text-center transition-colors ${
          dragOver
            ? 'border-teal-500 bg-teal-50'
            : 'border-zinc-300 bg-zinc-50'
        }`}
        data-testid="book-dropzone"
      >
        <div className="text-sm text-zinc-700">
          Drag a CSV here, or
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="ml-1 underline text-teal-700 hover:text-teal-900 disabled:opacity-50"
          >
            choose a file
          </button>
          .
        </div>
        <div className="text-xs text-zinc-500 mt-2">
          Required columns: {REQUIRED_COLS.join(', ')}.
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) submitFile(f);
          }}
          data-testid="book-file-input"
          aria-label="book-file-input"
        />
        {filename && (
          <div className="text-xs text-zinc-700 mt-3 font-mono">{filename}</div>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-600">
        <a
          href="/api/book/sample"
          className="underline text-teal-700 hover:text-teal-900"
          download
        >
          Download sample CSV
        </a>
        <span>·</span>
        <span>Optional columns: county, build_year, elevation_m, premium_annual, cv_features.</span>
      </div>

      {busy && stage && (
        <div
          className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium">{stage}</span>
        </div>
      )}

      {result && (
        <div
          className={`rounded border p-3 text-sm ${
            result.error || result.optimization === 'failed'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
          data-testid="upload-result"
        >
          {result.error ? (
            <div>
              <div className="font-medium">Upload failed</div>
              <div className="font-mono text-xs">{result.error}</div>
            </div>
          ) : (
            <div className="space-y-1">
              <div>
                <span className="font-medium">{result.accepted}</span> policies
                accepted
                {(result.rejected ?? 0) > 0 && (
                  <>
                    {' · '}
                    <span className="font-medium">{result.rejected}</span>{' '}
                    rejected
                  </>
                )}
                {' · '}
                Optimization{' '}
                <span className="font-medium">{result.optimization}</span>
              </div>
              {result.errors && result.errors.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer">
                    Show first {result.errors.length} rejected rows
                  </summary>
                  <ul className="mt-1 list-disc list-inside font-mono">
                    {result.errors.map((er, i) => (
                      <li key={i}>
                        row {er.row}: {er.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
