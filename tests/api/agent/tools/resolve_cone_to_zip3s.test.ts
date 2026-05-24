// @vitest-environment node
/**
 * Tests for the AUDIT.5 `resolve_cone_to_zip3s` agent tool.
 *
 * The tool composes three layers: `fetch_nhc_cone` (HTTP) + `zip3Centroids`
 * (DB) + `resolveConeToZip3s` (pure). We mock the first two and let the
 * pure resolver actually run end-to-end.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the centroids loader BEFORE importing the tool — the tool reads
// from this module at handler invocation time.
const centroidsMock = vi.fn();
vi.mock('@/lib/db/zip3_centroids', () => ({
  zip3Centroids: (...args: unknown[]) => centroidsMock(...args),
}));

// Mock the fetcher tool the same way.
const fetchConeMock = vi.fn();
vi.mock('@/app/api/agent/tools/fetch_nhc_cone', () => ({
  fetchNhcCone: {
    handler: (...args: unknown[]) => fetchConeMock(...args),
  },
}));

import { resolveConeToZip3sTool } from '@/app/api/agent/tools/resolve_cone_to_zip3s';

beforeEach(() => {
  centroidsMock.mockReset();
  fetchConeMock.mockReset();
});

function unitSquareCone() {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ],
    ],
  };
}

describe('resolve_cone_to_zip3s', () => {
  test('end-to-end: fetches cone, loads centroids, returns zip3 list', async () => {
    fetchConeMock.mockResolvedValue({
      cone: unitSquareCone(),
      source: 'live',
    });
    centroidsMock.mockResolvedValue({
      a: [0, 0],
      b: [5, 5],
      c: [-0.5, 0.5],
    });

    const result = await resolveConeToZip3sTool.handler({ storm_id: 'AL092024' });

    expect(fetchConeMock).toHaveBeenCalledWith({ storm_id: 'AL092024' });
    expect(result.zip3_list).toEqual(['a', 'c']);
    expect(result.count).toBe(2);
    expect(result.centroids_count).toBe(3);
    expect(result.source).toBe('live');
    expect(result.storm_id).toBe('AL092024');
  });

  test('mock-cone path: source flows through to the tool result', async () => {
    fetchConeMock.mockResolvedValue({
      cone: unitSquareCone(),
      source: 'mock',
    });
    centroidsMock.mockResolvedValue({ a: [0, 0] });

    const result = await resolveConeToZip3sTool.handler({ storm_id: 'AL092024' });
    expect(result.source).toBe('mock');
  });

  test('null cone fetch yields empty zip3 list with source=mock', async () => {
    fetchConeMock.mockResolvedValue(null);
    centroidsMock.mockResolvedValue({ a: [0, 0] });

    const result = await resolveConeToZip3sTool.handler({ storm_id: 'AL092024' });
    expect(result.zip3_list).toEqual([]);
    expect(result.source).toBe('mock');
    // centroids_count is 0 here because the early return skips the loader.
    expect(result.centroids_count).toBe(0);
  });

  test('explicit cone arg bypasses the fetch entirely', async () => {
    centroidsMock.mockResolvedValue({ a: [0, 0] });
    const result = await resolveConeToZip3sTool.handler({
      storm_id: 'AL092024',
      cone: unitSquareCone(),
    });
    expect(fetchConeMock).not.toHaveBeenCalled();
    expect(result.zip3_list).toEqual(['a']);
    // Explicit-cone callers get source='live' since they're presumed
    // to have validated provenance themselves.
    expect(result.source).toBe('live');
  });

  test('tool metadata: name, description, required params', () => {
    expect(resolveConeToZip3sTool.name).toBe('resolve_cone_to_zip3s');
    expect(resolveConeToZip3sTool.description.length).toBeGreaterThan(20);
    expect(resolveConeToZip3sTool.parameters.required).toEqual(['storm_id']);
  });
});
