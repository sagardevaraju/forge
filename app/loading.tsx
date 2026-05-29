/**
 * Root-level loading skeleton. Next.js falls back to this for any route
 * segment that doesn't ship its own `loading.tsx` — covering the home
 * dashboard plus /calibration, /treaty, /methodology, /audit, and /load,
 * all of which read the DB or a tracked artifact on the server and
 * previously showed nothing during that fetch. The four data-heavy routes
 * (/portfolio, /events, /simulate, /claims) keep their tailored skeletons.
 *
 * Title-agnostic on purpose: it stands in for many routes, so it shows a
 * neutral shimmer rather than a wrong page heading.
 */
export default function Loading() {
  return (
    <main className="min-h-screen p-6" aria-busy="true" aria-live="polite">
      <div className="mx-auto max-w-[1400px]">
        <div className="h-7 w-48 bg-zinc-200 rounded animate-pulse mb-3" />
        <div className="h-4 w-72 bg-zinc-200 rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 bg-white ring-1 ring-zinc-200/70 rounded-md animate-pulse"
            />
          ))}
        </div>
        <div className="h-[40vh] bg-zinc-100 rounded-md animate-pulse" />
      </div>
    </main>
  );
}
