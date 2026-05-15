/**
 * Task 21 — Event Console loading state.
 *
 * Server data prep for `/events` calls live NHC + FIRMS feeds (with mock
 * fallback). On a cold fetch the round-trip can take a couple of seconds, so
 * we surface a minimal skeleton instead of a blank screen.
 */
export default function EventsLoading() {
  return (
    <main className="min-h-screen p-6">
      <h1 className="text-2xl font-bold mb-4">Event Console</h1>
      <div className="grid grid-cols-[1fr_360px] gap-4 h-[80vh]">
        <div className="border rounded animate-pulse bg-zinc-100" />
        <div className="flex flex-col gap-4">
          <div className="border rounded h-[40vh] animate-pulse bg-zinc-100" />
          <div className="border rounded h-[40vh] animate-pulse bg-zinc-100" />
        </div>
      </div>
    </main>
  );
}
