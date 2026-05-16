/**
 * /load — upload a carrier book CSV. Replaces the policies table, kicks off
 * the Portfolio MIP precompute, then redirects the user to /portfolio with
 * the new book in place.
 */
import { BookUpload } from '@/components/BookUpload';

export default function LoadPage() {
  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Load policy book</h1>
      <p className="text-sm text-zinc-600 mb-6">
        Upload a CSV of policies to replace the current book. After ingestion,
        FORGE re-runs the Portfolio MIP so the map and recommendations reflect
        your data. Demo cap: 200,000 rows, 25 MB.
      </p>
      <BookUpload />
    </main>
  );
}
