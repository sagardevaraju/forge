/**
 * Task 19 — MapBase fallback behavior.
 *
 * We can't fully render react-map-gl in jsdom (no WebGL), so this suite
 * focuses on the deterministic fallback path that fires when the public
 * Mapbox token is absent. That path is also the one that protects CI and
 * fresh clones from a hard crash on `/portfolio`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MapBase } from '@/components/MapBase';

describe('MapBase', () => {
  beforeEach(() => {
    delete (process.env as Record<string, string | undefined>).NEXT_PUBLIC_MAPBOX_TOKEN;
  });
  afterEach(() => {
    cleanup();
  });

  test('renders the fallback panel when NEXT_PUBLIC_MAPBOX_TOKEN is unset', () => {
    render(<MapBase />);
    expect(screen.getByText('Map unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/Set NEXT_PUBLIC_MAPBOX_TOKEN to render/i),
    ).toBeInTheDocument();
  });
});
