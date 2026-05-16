export default function Loading() {
  return (
    <main className="min-h-screen p-6" aria-busy="true" aria-live="polite">
      <div className="h-7 w-48 bg-zinc-200 rounded animate-pulse mb-4" />
      <div className="h-4 w-72 bg-zinc-200 rounded animate-pulse mb-4" />
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-8 bg-zinc-100 rounded animate-pulse" />
        ))}
      </div>
    </main>
  );
}
