/**
 * Sortable sim identifier: <unix_ms_13>_<8 random hex>.
 * Lexicographic order = chronological order for sims drawn at distinct ms.
 * Not v7 UUID (avoids a dependency); has enough entropy + monotonicity for
 * a single-operator console. Format is stable: validators downstream pin
 * to the exact regex.
 */
const SIM_ID_RE = /^\d{13}_[0-9a-f]{8}$/;

export function newSimId(): string {
  const ts = Date.now().toString().padStart(13, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${ts}_${rand}`;
}

export function isValidSimId(s: string): boolean {
  return SIM_ID_RE.test(s);
}
