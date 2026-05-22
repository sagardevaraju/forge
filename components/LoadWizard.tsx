'use client';
/**
 * Task P2.39 — three-step /load wizard.
 *
 * Step 1: pick a CSV. The first row is the header; the rest are data rows.
 * Step 2: review FORGE-field → CSV-column mappings. The wizard auto-suggests
 *   a mapping with `suggestMapping` (lib/book/csv.ts) and shows it as the
 *   default of each select. CSV columns whose names match the PII deny-list
 *   are surfaced in red, are NOT selectable for any FORGE field, and will be
 *   recorded in every imported row's lineage as `refused_columns`.
 * Step 3: review the first 5 mapped rows + the list of refused columns,
 *   then POST `{ srcFile, rows: applyMapping(...), refusedColumns }` to
 *   /api/book/upload-wizard. On success, redirect to /portfolio once the
 *   MIP precompute reports back.
 *
 * v3 deferral (per spec): the deny-list is a regex against column NAMES
 * only. Value-level scrubbing + SOC 2 audit trail land in Task P3.28.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  parseCsv,
  FORGE_FIELDS,
  isPII,
  suggestMapping,
  applyMapping,
  type Mapping,
} from '@/lib/book/csv';

interface ParsedFile {
  name: string;
  header: string[];
  rows: Record<string, string>[];
  /**
   * 1-indexed CSV line number for each entry in `rows`. The wizard filters
   * blank lines client-side; this array preserves the original line index
   * so lineage `src_row` matches the actual CSV (header is line 1).
   */
  srcRowNumbers: number[];
}

interface WizardResult {
  accepted?: number;
  rejected?: number;
  errors?: { row: number; message: string }[];
  refused_columns?: string[];
  optimization?: 'refreshed' | 'failed' | 'skipped';
  error?: string;
}

type Step = 1 | 2 | 3;

const PREVIEW_ROWS = 5;

export function LoadWizard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [result, setResult] = useState<WizardResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // ---- Step 1 -------------------------------------------------------------
  const onPickFile = useCallback(async (f: File) => {
    setParseError(null);
    setResult(null);
    try {
      const text = await f.text();
      const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const parsed = parseCsv(cleaned);
      if (parsed.length < 2) {
        setParseError('CSV needs a header row and at least one data row.');
        return;
      }
      const header = parsed[0].map((c) => c.trim());
      // Keep blank-row filtering but track each survivor's original CSV
      // line index so lineage src_row matches the actual file line. The
      // header occupies line 1, so the first data row is line 2.
      const rows: Record<string, string>[] = [];
      const srcRowNumbers: number[] = [];
      for (let i = 1; i < parsed.length; i++) {
        const cells = parsed[i];
        if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) {
          continue;
        }
        const obj: Record<string, string> = {};
        header.forEach((h, j) => {
          obj[h] = (cells[j] ?? '').trim();
        });
        rows.push(obj);
        srcRowNumbers.push(i + 1); // parsed[0] is header (line 1)
      }
      setFile({ name: f.name, header, rows, srcRowNumbers });
      // Seed the mapping with auto-suggestions.
      const suggestions = suggestMapping(header, FORGE_FIELDS);
      const m: Mapping = {};
      for (const s of suggestions) m[s.forgeField] = s.csvColumn;
      setMapping(m);
      setStep(2);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setParseError(`Could not read CSV: ${msg}`);
    }
  }, []);

  const onFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) onPickFile(f);
    },
    [onPickFile],
  );

  // ---- Step 2 -------------------------------------------------------------
  const refusedColumns = useMemo(
    () => (file ? file.header.filter(isPII) : []),
    [file],
  );

  const onChangeMapping = useCallback(
    (forgeField: string, csvCol: string) => {
      setMapping((m) => ({
        ...m,
        [forgeField]: csvCol === '' ? null : csvCol,
      }));
    },
    [],
  );

  // Required FORGE fields that still have no CSV column.
  const unmappedRequired = useMemo(() => {
    return FORGE_FIELDS.filter((f) => f.required && !mapping[f.id]).map(
      (f) => f.id,
    );
  }, [mapping]);

  // ---- Step 3 -------------------------------------------------------------
  const mappedPreview = useMemo(() => {
    if (!file) return [];
    return applyMapping(
      file.rows.slice(0, PREVIEW_ROWS),
      mapping,
      file.name,
      undefined,
      file.srcRowNumbers.slice(0, PREVIEW_ROWS),
    );
  }, [file, mapping]);

  const onImport = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setStage('Validating + writing to database…');
    setResult(null);
    try {
      const mapped = applyMapping(
        file.rows,
        mapping,
        file.name,
        undefined,
        file.srcRowNumbers,
      );
      const r = await fetch('/api/book/upload-wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          srcFile: file.name,
          rows: mapped,
          refusedColumns,
        }),
      });
      setStage('Re-running Portfolio MIP…');
      const data = (await r.json()) as WizardResult;
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
  }, [file, mapping, refusedColumns, router]);

  // ---- Render -------------------------------------------------------------
  return (
    <div className="flex flex-col gap-6" data-testid="load-wizard">
      <Stepper step={step} />

      {step === 1 && (
        <section data-testid="wizard-step-1" className="flex flex-col gap-3">
          <p className="text-sm text-zinc-600">
            Pick a carrier CSV. The wizard will suggest a column mapping in
            the next step.
          </p>
          <div className="border-2 border-dashed border-zinc-300 rounded p-8 text-center bg-zinc-50">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="px-3 py-1 rounded bg-teal-600 text-white text-sm hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              Choose CSV file
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              aria-label="csv-file"
              data-testid="wizard-file-input"
              onChange={onFileInput}
            />
          </div>
          {parseError && (
            <div
              role="alert"
              className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            >
              {parseError}
            </div>
          )}
        </section>
      )}

      {step === 2 && file && (
        <section data-testid="wizard-step-2" className="flex flex-col gap-4">
          <p className="text-sm text-zinc-600">
            Confirm how each FORGE field maps to a column in{' '}
            <span className="font-mono">{file.name}</span>. Columns whose
            names look like PII (ssn, dob, phone, email, name, address) are
            highlighted and will not be imported.
          </p>
          <ul className="flex flex-col gap-2">
            {FORGE_FIELDS.map((f) => {
              const value = mapping[f.id] ?? '';
              const selectId = `map-${f.id}`;
              return (
                <li
                  key={f.id}
                  className="grid grid-cols-[1fr_2fr] items-center gap-3"
                  data-testid={`mapping-row-${f.id}`}
                >
                  <label
                    htmlFor={selectId}
                    className="text-sm font-medium text-zinc-800"
                  >
                    {f.label}
                    {f.required && (
                      <span className="ml-1 text-red-600" aria-hidden="true">
                        *
                      </span>
                    )}
                  </label>
                  <select
                    id={selectId}
                    value={value}
                    onChange={(e) => onChangeMapping(f.id, e.target.value)}
                    className="border border-zinc-300 rounded px-2 py-1 text-sm bg-white"
                    data-testid={`select-${f.id}`}
                  >
                    <option value="">(not mapped)</option>
                    {file.header.map((h) => {
                      const pii = isPII(h);
                      return (
                        <option
                          key={h}
                          value={h}
                          disabled={pii}
                          data-pii={pii ? 'true' : undefined}
                          data-testid={
                            pii ? `option-pii-${h}` : `option-${h}`
                          }
                        >
                          {h}
                          {pii ? '  (refused, PII)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </li>
              );
            })}
          </ul>

          {refusedColumns.length > 0 && (
            <div
              role="status"
              data-testid="refused-banner"
              className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            >
              <div className="font-medium">
                Refused {refusedColumns.length} column
                {refusedColumns.length === 1 ? '' : 's'} (PII deny-list)
              </div>
              <ul className="font-mono text-xs mt-1 list-disc list-inside">
                {refusedColumns.map((c) => (
                  <li key={c} data-testid={`refused-${c}`}>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unmappedRequired.length > 0 && (
            <div
              role="status"
              className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            >
              Required field
              {unmappedRequired.length === 1 ? '' : 's'} not yet mapped:{' '}
              <span className="font-mono">{unmappedRequired.join(', ')}</span>
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-3 py-1 rounded border border-zinc-300 text-sm hover:bg-zinc-50"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={unmappedRequired.length > 0}
              data-testid="wizard-next"
              className="px-3 py-1 rounded bg-teal-600 text-white text-sm hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              Review →
            </button>
          </div>
        </section>
      )}

      {step === 3 && file && (
        <section data-testid="wizard-step-3" className="flex flex-col gap-4">
          <p className="text-sm text-zinc-600">
            Preview of the first {Math.min(PREVIEW_ROWS, file.rows.length)}{' '}
            mapped rows. Each imported policy will carry a lineage record
            tying it back to <span className="font-mono">{file.name}</span>.
          </p>
          <div className="overflow-x-auto border rounded">
            <table className="text-xs w-full" data-testid="preview-table">
              <thead className="bg-zinc-100">
                <tr>
                  <th className="px-2 py-1 text-left">src_row</th>
                  {FORGE_FIELDS.filter((f) => mapping[f.id]).map((f) => (
                    <th key={f.id} className="px-2 py-1 text-left">
                      {f.label}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-left">refused</th>
                </tr>
              </thead>
              <tbody>
                {mappedPreview.map((r, i) => {
                  const lineage = JSON.parse(r.lineage) as {
                    src_row: number;
                    refused_columns: string[];
                  };
                  return (
                    <tr
                      key={i}
                      className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50'}
                      data-testid={`preview-row-${i}`}
                    >
                      <td className="px-2 py-1 font-mono">{lineage.src_row}</td>
                      {FORGE_FIELDS.filter((f) => mapping[f.id]).map((f) => (
                        <td key={f.id} className="px-2 py-1 font-mono">
                          {r.forgeRow[f.id] ?? ''}
                        </td>
                      ))}
                      <td className="px-2 py-1 font-mono text-red-700">
                        {lineage.refused_columns.join(', ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="px-3 py-1 rounded border border-zinc-300 text-sm hover:bg-zinc-50"
              disabled={busy}
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={onImport}
              disabled={busy}
              data-testid="wizard-import"
              className="px-3 py-1 rounded bg-teal-600 text-white text-sm hover:bg-teal-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              {busy ? 'Importing…' : `Import ${file.rows.length} rows`}
            </button>
          </div>

          {busy && stage && (
            <div
              role="status"
              aria-live="polite"
              className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900"
            >
              {stage}
            </div>
          )}

          {result && (
            <div
              data-testid="wizard-result"
              className={`rounded border p-3 text-sm ${
                result.error || result.optimization === 'failed'
                  ? 'border-red-200 bg-red-50 text-red-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900'
              }`}
            >
              {result.error ? (
                <div>
                  <div className="font-medium">Upload failed</div>
                  <div className="font-mono text-xs">{result.error}</div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div>
                    <span className="font-medium">{result.accepted}</span>{' '}
                    policies accepted
                    {(result.rejected ?? 0) > 0 && (
                      <>
                        {' · '}
                        <span className="font-medium">
                          {result.rejected}
                        </span>{' '}
                        rejected
                      </>
                    )}
                    {' · '}
                    Optimization{' '}
                    <span className="font-medium">{result.optimization}</span>
                  </div>
                  {(result.refused_columns?.length ?? 0) > 0 && (
                    <div className="text-xs">
                      Refused columns:{' '}
                      <span className="font-mono">
                        {result.refused_columns?.join(', ')}
                      </span>
                    </div>
                  )}
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
        </section>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const labels: Record<Step, string> = {
    1: 'Upload',
    2: 'Map columns',
    3: 'Confirm + import',
  };
  return (
    <ol
      className="flex items-center gap-2 text-xs text-zinc-600"
      data-testid="wizard-stepper"
      aria-label="Wizard progress"
    >
      {([1, 2, 3] as Step[]).map((n) => (
        <li key={n} className="flex items-center gap-2">
          <span
            className={`inline-flex w-6 h-6 items-center justify-center rounded-full border ${
              n === step
                ? 'bg-teal-600 text-white border-teal-600'
                : n < step
                  ? 'bg-teal-100 text-teal-700 border-teal-300'
                  : 'bg-white text-zinc-400 border-zinc-300'
            }`}
            aria-current={n === step ? 'step' : undefined}
          >
            {n}
          </span>
          <span className={n === step ? 'font-medium text-zinc-800' : ''}>
            {labels[n]}
          </span>
          {n !== 3 && <span aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}
