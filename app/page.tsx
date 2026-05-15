import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">FORGE</h1>
      <p className="text-sm text-zinc-600">Forecast-driven Operational Risk Governance Engine</p>
      <nav className="flex gap-4">
        <Link href="/portfolio" className="underline">Portfolio Map</Link>
        <Link href="/events" className="underline">Event Console</Link>
        <Link href="/claims" className="underline">Claims Pre-Brief</Link>
      </nav>
    </main>
  );
}
