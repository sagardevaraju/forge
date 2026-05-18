import { describe, test, expect } from 'vitest';
import { newSimId, isValidSimId } from '@/lib/sim/id';

describe('newSimId', () => {
  test('returns a string matching the sim id format', () => {
    const id = newSimId();
    expect(isValidSimId(id)).toBe(true);
  });
  test('IDs sort chronologically', async () => {
    const a = newSimId();
    await new Promise(r => setTimeout(r, 2));
    const b = newSimId();
    expect(a < b).toBe(true);
  });
  test('rejects malformed inputs', () => {
    expect(isValidSimId('sim_abc')).toBe(false);
    expect(isValidSimId('')).toBe(false);
    expect(isValidSimId('1234567890123_xyzxyzxyz')).toBe(false); // hex required
  });
});
