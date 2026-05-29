/**
 * 404 boundary. The console previously had no not-found handler, so an
 * unknown path fell through to Next's unstyled default. This keeps the
 * brand surface intact and routes the operator back to a real view.
 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-2xl mt-[12vh]">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint mb-2">
          404
        </div>
        <h1 className="text-2xl font-semibold text-ink mb-2">
          Page not found
        </h1>
        <p className="text-sm text-ink-muted mb-5">
          The view you requested doesn&apos;t exist. It may have moved, or the
          link may be stale.
        </p>
        <Link
          href="/"
          className="inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
