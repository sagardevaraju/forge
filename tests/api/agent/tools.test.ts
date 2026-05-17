// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchNhcCone } from '@/app/api/agent/tools/fetch_nhc_cone';
import { fetchFirmsFires } from '@/app/api/agent/tools/fetch_firms_fires';
import { fetchFemaDeclarations } from '@/app/api/agent/tools/fetch_fema_declarations';
import { fetchStormEvents } from '@/app/api/agent/tools/fetch_storm_events';
import { generateScenarios } from '@/app/api/agent/tools/generate_scenarios';
import { queryBookExposure } from '@/app/api/agent/tools/query_book_exposure';
import {
  draftSitrep,
  __setDraftSitrepLlmFactory,
  __resetDraftSitrepLlmFactory,
} from '@/app/api/agent/tools/draft_sitrep';

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

describe('fetch_nhc_cone', () => {
  test('returns mock when FORGE_TOOLS_MODE=mock and never calls fetch', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not run'));
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('mock');
    expect(out.peak_wind).toBeGreaterThan(0);
    expect(out.advisory_number).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  test('parses live response into the expected shape', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          features: [
            {
              properties: { ADVISNUM: '23B', MAXWIND: 130 },
              geometry: { type: 'Polygon', coordinates: [[[0, 0]]] },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('live');
    expect(out.advisory_number).toBe('23B');
    expect(out.peak_wind).toBe(130);
  });

  test('falls back to mock when fetch throws', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net dn'));
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.source).toBe('mock');
  });

  test('handler throws when storm_id missing (error path)', async () => {
    // exercise the error-handling branch (also covered later via chat route)
    await expect(
      fetchNhcCone.handler({ storm_id: '' } as { storm_id: string }),
    ).rejects.toThrow(/storm_id required/);
  });

  test('returns prior_peak_wind in mock fallback (Task 23 delta)', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const out = await fetchNhcCone.handler({ storm_id: 'AL092024' });
    expect(out.prior_peak_wind).toBe(135);
  });
});

describe('fetch_firms_fires', () => {
  test('mocks when no NASA_FIRMS_KEY', async () => {
    delete process.env.NASA_FIRMS_KEY;
    delete process.env.FORGE_TOOLS_MODE;
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = await fetchFirmsFires.handler({ bbox: [-125, 32, -114, 42], hours: 24 });
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  test('parses CSV from live FIRMS', async () => {
    process.env.NASA_FIRMS_KEY = 'test-key';
    delete process.env.FORGE_TOOLS_MODE;
    const csv = [
      'latitude,longitude,bright_ti4,acq_date,acq_time,confidence',
      '38.5,-121.5,330.1,2026-05-15,1820,h',
      '37.4,-122.0,310.0,2026-05-15,1750,n',
    ].join('\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(csv, { status: 200 }));
    const out = await fetchFirmsFires.handler({ bbox: [-125, 32, -114, 42], hours: 24 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ lat: 38.5, lon: -121.5, brightness: 330.1, confidence: 'h' });
  });
});

describe('fetch_fema_declarations', () => {
  test('parses live OpenFEMA response, dedupes counties by disaster id', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          DisasterDeclarationsSummaries: [
            {
              disasterNumber: 4781,
              declarationDate: '2025-09-30T00:00:00.000Z',
              incidentType: 'Hurricane',
              designatedArea: 'Pinellas (County)',
            },
            {
              disasterNumber: 4781,
              declarationDate: '2025-09-30T00:00:00.000Z',
              incidentType: 'Hurricane',
              designatedArea: 'Hillsborough (County)',
            },
            {
              disasterNumber: 4760,
              declarationDate: '2025-07-12T00:00:00.000Z',
              incidentType: 'Severe Storms',
              designatedArea: 'Orange (County)',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await fetchFemaDeclarations.handler({ state: 'FL', since: '2024-01-01' });
    expect(out).toHaveLength(2);
    const dr4781 = out.find((d) => d.disaster_id === 'DR-4781')!;
    expect(dr4781.counties.sort()).toEqual(['Hillsborough', 'Pinellas']);
    expect(dr4781.declared_date).toBe('2025-09-30');
  });

  test('mocks when FORGE_TOOLS_MODE=mock', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = await fetchFemaDeclarations.handler({ state: 'FL' });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].disaster_id).toContain('FL');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetch_storm_events (real DB)', () => {
  test('returns rows for FL with sensible aggregate counts', async () => {
    const out = await fetchStormEvents.handler({ state: 'FL' });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.state).toBe('FL');
      expect(Number.isFinite(r.year)).toBe(true);
    }
  });

  test('respects since year filter', async () => {
    const all = await fetchStormEvents.handler({ state: 'FL' });
    const since2020 = await fetchStormEvents.handler({ state: 'FL', since: '2020-01-01' });
    expect(since2020.length).toBeLessThanOrEqual(all.length);
    for (const r of since2020) expect(r.year).toBeGreaterThanOrEqual(2020);
  });
});

describe('query_book_exposure (real DB)', () => {
  test('FL ZIP3 330 has > $1M TIV and >0 policies', async () => {
    const out = await queryBookExposure.handler({ zip3_list: ['330'] });
    expect(out.total_tiv).toBeGreaterThan(1_000_000);
    expect(out.policies).toBeGreaterThan(0);
    expect(out.by_zip3['330']).toBeDefined();
    expect(out.by_zip3['330'].tiv).toBeGreaterThan(1_000_000);
  });

  test('multiple zip3s sum correctly', async () => {
    const one = await queryBookExposure.handler({ zip3_list: ['330'] });
    const two = await queryBookExposure.handler({ zip3_list: ['331'] });
    const both = await queryBookExposure.handler({ zip3_list: ['330', '331'] });
    expect(both.total_tiv).toBeCloseTo(one.total_tiv + two.total_tiv, 5);
    expect(both.policies).toBe(one.policies + two.policies);
  });

  test('empty list returns zero aggregate', async () => {
    const out = await queryBookExposure.handler({ zip3_list: [] });
    expect(out).toEqual({ total_tiv: 0, policies: 0, by_zip3: {} });
  });
});

describe('generate_scenarios', () => {
  test('returns mock when FORGE_TOOLS_MODE=mock', async () => {
    process.env.FORGE_TOOLS_MODE = 'mock';
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 5 });
    expect(out).toHaveLength(5);
    expect(out[0].peak_wind).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  test('proxies to /api/scenarios and returns its JSON', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    const payload = [{ id: 0, path: {}, peak_wind: 100, surge_grid: {}, prob: 0.5 }];
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 1 });
    expect(out).toEqual(payload);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('storm_id=AL092024');
  });

  test('falls back to mock when upstream fails', async () => {
    delete process.env.FORGE_TOOLS_MODE;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const out = await generateScenarios.handler({ storm_id: 'AL092024', n: 3 });
    expect(out).toHaveLength(3);
  });
});

describe('draft_sitrep', () => {
  // Task P2.24 — the tool now returns a StructuredSitrep (6 named fields)
  // wrapped in { data_source, sitrep }. The handler's mock-fallback path
  // (no LLM key) must still produce a valid StructuredSitrep so the UI
  // never has to handle a half-shaped payload.

  test('returns valid StructuredSitrep on happy path (mock LLM)', async () => {
    process.env.OPENROUTER_API_KEY = 'test';
    delete process.env.FORGE_TOOLS_MODE;
    const goodPayload = {
      threat_tier: 'high',
      lead_time_hours: 36,
      portfolio_recommendation:
        'Cede QS on FL ZIP3 330–339; non-renew the bottom-decile cohorts.',
      operational_recommendation:
        'Stage 12 adjusters in Tampa, 8 in Miami, 6 in Jacksonville.',
      claims_prep_recommendation:
        'Pre-flag cohorts above 35% probability; open IVR overflow.',
      escalation_criteria:
        'Re-broadcast if peak wind > 140 mph or cone shifts >25 nm east.',
    };
    const fakeLlm = {
      chat: vi
        .fn()
        .mockResolvedValue({ content: JSON.stringify(goodPayload) }),
    };
    __setDraftSitrepLlmFactory(() => fakeLlm);
    try {
      const out = await draftSitrep.handler({
        threat_id: 'AL092024',
        posture_summary: 'p',
      });
      expect(out.data_source).toBe('live');
      expect(out.sitrep.threat_tier).toBe('high');
      expect(out.sitrep.lead_time_hours).toBe(36);
      expect(out.sitrep.portfolio_recommendation).toMatch(/Cede QS/);
      expect(out.sitrep.operational_recommendation).toMatch(/adjusters/);
      expect(out.sitrep.claims_prep_recommendation).toMatch(/IVR/);
      expect(out.sitrep.escalation_criteria).toMatch(/140 mph/);
      expect(fakeLlm.chat).toHaveBeenCalledTimes(1);
    } finally {
      __resetDraftSitrepLlmFactory();
    }
  });

  test('malformed LLM output falls back to synthetic with data_source=synthetic_fallback', async () => {
    process.env.OPENROUTER_API_KEY = 'test';
    delete process.env.FORGE_TOOLS_MODE;
    // LLM returns prose, not JSON ⇒ validator rejects ⇒ stub falls in.
    __setDraftSitrepLlmFactory(() => ({
      chat: vi.fn().mockResolvedValue({
        content: 'Sure, here is a memo as freeform markdown without JSON.',
      }),
    }));
    try {
      const out = await draftSitrep.handler({
        threat_id: 'AL092024',
        posture_summary: 'p',
      });
      expect(out.data_source).toBe('synthetic_fallback');
      // The stub still satisfies the schema so the UI never crashes.
      expect(['low', 'medium', 'high', 'critical']).toContain(out.sitrep.threat_tier);
      expect(typeof out.sitrep.lead_time_hours).toBe('number');
      expect(typeof out.sitrep.portfolio_recommendation).toBe('string');
      expect(typeof out.sitrep.operational_recommendation).toBe('string');
      expect(typeof out.sitrep.claims_prep_recommendation).toBe('string');
      expect(typeof out.sitrep.escalation_criteria).toBe('string');
    } finally {
      __resetDraftSitrepLlmFactory();
    }
  });

  test('tool registry shape — JSON-schema parameters describe the 6 fields', () => {
    // The LLM uses these parameters to plan the call; the tool itself
    // uses them as a documentation contract for what the LLM-emitted
    // content should look like. We pin the names so a regression in
    // the schema is caught at unit-test time.
    expect(draftSitrep.parameters.type).toBe('object');
    const props = draftSitrep.parameters.properties as Record<string, unknown>;
    // Inputs: the tool still takes threat_id + posture_summary as args.
    expect(props.threat_id).toBeDefined();
    expect(props.posture_summary).toBeDefined();
    // The description string MUST advertise the 6-field output shape so the
    // LLM emits a JSON body with the right keys.
    const desc = draftSitrep.description.toLowerCase();
    for (const key of [
      'threat_tier',
      'lead_time_hours',
      'portfolio_recommendation',
      'operational_recommendation',
      'claims_prep_recommendation',
      'escalation_criteria',
    ]) {
      expect(desc).toContain(key);
    }
  });

  test('returns synthetic_fallback when no LLM key and no factory override', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GITHUB_MODELS_PAT;
    delete process.env.FORGE_TOOLS_MODE;
    const out = await draftSitrep.handler({
      threat_id: 'AL092024',
      posture_summary: '5 ZIP3s in-cone; TIV $400M.',
    });
    expect(out.data_source).toBe('synthetic_fallback');
    expect(out.sitrep.portfolio_recommendation).toBeTruthy();
  });

  test('synthetic_fallback when injected LLM throws', async () => {
    process.env.OPENROUTER_API_KEY = 'test';
    delete process.env.FORGE_TOOLS_MODE;
    __setDraftSitrepLlmFactory(() => ({
      chat: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    try {
      const out = await draftSitrep.handler({
        threat_id: 'AL092024',
        posture_summary: 'p',
      });
      expect(out.data_source).toBe('synthetic_fallback');
      expect(out.sitrep.threat_tier).toBeTruthy();
    } finally {
      __resetDraftSitrepLlmFactory();
    }
  });
});
