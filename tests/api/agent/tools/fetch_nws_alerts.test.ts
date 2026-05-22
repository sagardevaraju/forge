// @vitest-environment node
/**
 * fetch_nws_alerts — live NWS active-alert lookup.
 *
 * Covers:
 *   - FORGE_TOOLS_MODE=mock returns 3 FL alerts (tornado / flood / severe)
 *   - Live parse: every NWS feature shape (full props, missing fields,
 *     null geometry, MultiPolygon geometry, unknown event)
 *   - Counts mirror category buckets
 *   - URL builder applies state + event filters + status default
 *   - HTTP failure and thrown fetch both fall back to the mock
 *   - categorizeAlertEvent covers every category branch
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchNwsAlerts,
  categorizeAlertEvent,
  countAlerts,
  DEFAULT_ACUTE_EVENTS,
  type NwsAlert,
} from '@/app/api/agent/tools/fetch_nws_alerts';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

beforeEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe('categorizeAlertEvent', () => {
  test('maps each canonical event to its category', () => {
    expect(categorizeAlertEvent('Tornado Warning')).toBe('tornado');
    expect(categorizeAlertEvent('Tornado Watch')).toBe('tornado');
    expect(categorizeAlertEvent('Flash Flood Warning')).toBe('flood');
    expect(categorizeAlertEvent('Flood Warning')).toBe('flood');
    expect(categorizeAlertEvent('Severe Thunderstorm Warning')).toBe('severe_thunderstorm');
    expect(categorizeAlertEvent('Severe Thunderstorm Watch')).toBe('severe_thunderstorm');
    expect(categorizeAlertEvent('Hurricane Warning')).toBe('hurricane');
    expect(categorizeAlertEvent('Hurricane Watch')).toBe('hurricane');
    expect(categorizeAlertEvent('Tropical Storm Warning')).toBe('tropical');
    expect(categorizeAlertEvent('Tropical Depression Statement')).toBe('tropical');
    expect(categorizeAlertEvent('Storm Surge Warning')).toBe('storm_surge');
  });

  test('"Severe Thunderstorm" must match before generic storm-surge fallback', () => {
    // Regression guard: keyword ordering inside the function matters.
    expect(categorizeAlertEvent('Severe Thunderstorm Warning')).toBe('severe_thunderstorm');
  });

  test('unknown events fall through to "other"', () => {
    expect(categorizeAlertEvent('Frost Advisory')).toBe('other');
    expect(categorizeAlertEvent('Air Quality Alert')).toBe('other');
    expect(categorizeAlertEvent('Lakeshore Hazard Statement')).toBe('other');
  });
});

describe('countAlerts', () => {
  const mk = (cat: NwsAlert['category']): NwsAlert => ({
    id: `id-${cat}-${Math.random()}`,
    event: 'x',
    category: cat,
    severity: 'unknown',
    urgency: 'unknown',
    certainty: 'unknown',
    headline: null,
    area_desc: null,
    effective: null,
    onset: null,
    expires: null,
    sender: null,
    geometry: null,
  });

  test('returns zero counts on empty input', () => {
    const c = countAlerts([]);
    expect(c.total).toBe(0);
    expect(c.tornado).toBe(0);
    expect(c.flood).toBe(0);
  });

  test('counts by category and totals correctly', () => {
    const c = countAlerts([
      mk('tornado'),
      mk('tornado'),
      mk('flood'),
      mk('severe_thunderstorm'),
      mk('other'),
    ]);
    expect(c.tornado).toBe(2);
    expect(c.flood).toBe(1);
    expect(c.severe_thunderstorm).toBe(1);
    expect(c.other).toBe(1);
    expect(c.total).toBe(5);
  });
});

describe('fetch_nws_alerts — mock fallback', () => {
  test('FORGE_TOOLS_MODE=mock returns 3 FL alerts', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNwsAlerts.handler({});
    expect(out.source).toBe('mock');
    expect(out.alerts).toHaveLength(3);
    expect(out.counts.tornado).toBe(1);
    expect(out.counts.flood).toBe(1);
    expect(out.counts.severe_thunderstorm).toBe(1);
    expect(out.counts.total).toBe(3);
    // All mock alerts ship geometry — the map layer needs at least one
    // polygon to render anything.
    for (const a of out.alerts) {
      expect(a.geometry).not.toBeNull();
      expect(a.geometry!.type).toBe('Polygon');
    }
  });

  test('mock honours state override in area_desc', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNwsAlerts.handler({ state: 'tx' });
    for (const a of out.alerts) {
      expect(a.area_desc).toMatch(/, TX$/);
    }
  });
});

describe('fetch_nws_alerts — live path', () => {
  test('parses tornado / flood / severe / null-geometry / unknown features', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              id: 'urn:tornado-1',
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [[[-82, 29], [-81, 29], [-81, 30], [-82, 30], [-82, 29]]],
              },
              properties: {
                id: 'urn:tornado-1',
                event: 'Tornado Warning',
                severity: 'Extreme',
                urgency: 'Immediate',
                certainty: 'Observed',
                headline: 'Tornado Warning issued for Marion County',
                areaDesc: 'Marion, FL',
                effective: '2026-05-18T13:00:00Z',
                onset: '2026-05-18T13:00:00Z',
                expires: '2026-05-18T14:00:00Z',
                senderName: 'NWS Jacksonville FL',
              },
            },
            {
              type: 'Feature',
              geometry: {
                type: 'MultiPolygon',
                coordinates: [[[[-82, 28], [-81, 28], [-81, 29], [-82, 29], [-82, 28]]]],
              },
              properties: {
                id: 'urn:flood-1',
                event: 'Flash Flood Warning',
                severity: 'Severe',
                urgency: 'Immediate',
                certainty: 'Likely',
              },
            },
            // County-coded alert — no polygon geometry. Must be preserved
            // (with geometry: null) so it can still be counted.
            {
              type: 'Feature',
              geometry: null,
              properties: {
                id: 'urn:svr-1',
                event: 'Severe Thunderstorm Warning',
                severity: 'Severe',
              },
            },
            // Event we don't categorise specifically.
            {
              type: 'Feature',
              geometry: null,
              properties: { id: 'urn:other-1', event: 'Frost Advisory' },
            },
            // Junk feature with no event — must be dropped, not thrown.
            { type: 'Feature', geometry: null, properties: {} },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchNwsAlerts.handler({});
    expect(out.source).toBe('live');
    expect(out.alerts).toHaveLength(4); // the empty-event feature is dropped
    const byId = Object.fromEntries(out.alerts.map((a) => [a.id, a]));
    expect(byId['urn:tornado-1'].category).toBe('tornado');
    expect(byId['urn:tornado-1'].severity).toBe('extreme');
    expect(byId['urn:tornado-1'].urgency).toBe('immediate');
    expect(byId['urn:tornado-1'].certainty).toBe('observed');
    expect(byId['urn:tornado-1'].geometry?.type).toBe('Polygon');
    expect(byId['urn:flood-1'].category).toBe('flood');
    expect(byId['urn:flood-1'].geometry?.type).toBe('MultiPolygon');
    expect(byId['urn:svr-1'].category).toBe('severe_thunderstorm');
    expect(byId['urn:svr-1'].geometry).toBeNull();
    expect(byId['urn:other-1'].category).toBe('other');
    expect(out.counts.total).toBe(4);
    expect(out.counts.tornado).toBe(1);
    expect(out.counts.flood).toBe(1);
    expect(out.counts.severe_thunderstorm).toBe(1);
    expect(out.counts.other).toBe(1);
  });

  test('URL builder includes status=actual, area, and every event', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({});
    expect(capturedUrl).toContain('api.weather.gov/alerts/active');
    expect(capturedUrl).toContain('status=actual');
    expect(capturedUrl).toContain('area=FL');
    // Every default event is appended; check a couple of representatives
    // (URLSearchParams encodes spaces as `+`).
    expect(capturedUrl).toContain('event=Tornado+Warning');
    expect(capturedUrl).toContain('event=Flash+Flood+Warning');
    expect(capturedUrl).toContain('event=Storm+Surge+Warning');
  });

  test('array state joins via comma in area= param', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({ state: ['FL', 'ga', 'tx'] });
    expect(capturedUrl).toContain('area=FL%2CGA%2CTX');
  });

  test('empty array state disables the area filter', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({ state: [] });
    expect(capturedUrl).not.toContain('area=');
  });

  test('null state disables the area filter, custom events override defaults', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({ state: null, events: ['Tornado Warning'] });
    expect(capturedUrl).not.toContain('area=');
    expect(capturedUrl).toContain('event=Tornado+Warning');
    expect(capturedUrl).not.toContain('event=Hurricane');
  });

  test('empty events array disables event filter', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({ events: [] });
    expect(capturedUrl).not.toContain('event=');
  });

  test('User-Agent header is set (env override honoured)', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    process.env.NWS_USER_AGENT = 'custom-agent/9.9';
    let capturedHeaders: HeadersInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ features: [] }), { status: 200 });
    });
    await fetchNwsAlerts.handler({});
    const hdr = capturedHeaders as Record<string, string> | undefined;
    expect(hdr?.['User-Agent']).toBe('custom-agent/9.9');
  });

  test('HTTP failure falls back to mock', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('boom', { status: 500 }),
    );
    const out = await fetchNwsAlerts.handler({});
    expect(out.source).toBe('mock');
    expect(out.alerts.length).toBeGreaterThan(0);
  });

  test('thrown fetch falls back to mock', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    const out = await fetchNwsAlerts.handler({});
    expect(out.source).toBe('mock');
    expect(out.alerts.length).toBeGreaterThan(0);
  });

  test('empty live response returns [] without falling back to mock', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ features: [] }), { status: 200 }),
    );
    const out = await fetchNwsAlerts.handler({});
    expect(out.source).toBe('live');
    expect(out.alerts).toEqual([]);
    expect(out.counts.total).toBe(0);
  });
});

describe('DEFAULT_ACUTE_EVENTS', () => {
  test('covers the high-acuity property-cat perils', () => {
    expect(DEFAULT_ACUTE_EVENTS).toContain('Tornado Warning');
    expect(DEFAULT_ACUTE_EVENTS).toContain('Flash Flood Warning');
    expect(DEFAULT_ACUTE_EVENTS).toContain('Severe Thunderstorm Warning');
    expect(DEFAULT_ACUTE_EVENTS).toContain('Hurricane Warning');
    expect(DEFAULT_ACUTE_EVENTS).toContain('Storm Surge Warning');
  });
});
