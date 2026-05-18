'use client';
export default function Error({ error }: { error: Error }) {
  return <div className="p-6 text-red-400">Simulate workspace failed to load: {error.message}</div>;
}
