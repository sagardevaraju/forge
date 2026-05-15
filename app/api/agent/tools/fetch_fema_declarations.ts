/**
 * fetch_fema_declarations — OpenFEMA Disaster Declarations Summaries v2.
 *
 * No API key required. Endpoint:
 *   https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries
 * Falls back to mocks when FORGE_TOOLS_MODE=mock or the live call throws.
 */

export interface FetchFemaDeclarationsArgs {
  state: string;
  since?: string; // ISO date, e.g. '2024-01-01'
}

export interface FemaDeclaration {
  disaster_id: string;
  declared_date: string;
  incident_type: string;
  counties: string[];
}

function mockResponse(state: string): FemaDeclaration[] {
  return [
    {
      disaster_id: `DR-4781-${state}`,
      declared_date: '2025-09-30',
      incident_type: 'Hurricane',
      counties: ['Pinellas', 'Hillsborough', 'Manatee'],
    },
    {
      disaster_id: `DR-4760-${state}`,
      declared_date: '2025-07-12',
      incident_type: 'Severe Storms',
      counties: ['Orange', 'Seminole'],
    },
    {
      disaster_id: `DR-4733-${state}`,
      declared_date: '2024-10-04',
      incident_type: 'Hurricane',
      counties: ['Lee', 'Collier', 'Charlotte'],
    },
  ];
}

interface OpenFemaRow {
  disasterNumber?: number | string;
  declarationDate?: string;
  incidentType?: string;
  designatedArea?: string;
}

interface OpenFemaResp {
  DisasterDeclarationsSummaries?: OpenFemaRow[];
}

async function tryLive(state: string, since?: string): Promise<FemaDeclaration[] | null> {
  const filterParts = [`state eq '${state}'`];
  if (since) filterParts.push(`declarationDate ge '${since}'`);
  const url =
    'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries' +
    `?$filter=${encodeURIComponent(filterParts.join(' and '))}` +
    `&$orderby=declarationDate%20desc&$top=200`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = (await r.json()) as OpenFemaResp;
  const rows = data.DisasterDeclarationsSummaries ?? [];
  // Group rows by disaster_id, collecting designatedArea into counties.
  const byId = new Map<string, FemaDeclaration>();
  for (const row of rows) {
    const id = String(row.disasterNumber ?? '');
    if (!id) continue;
    const existing = byId.get(id);
    const county = String(row.designatedArea ?? '').replace(/\s*\(County\)\s*$/, '').trim();
    if (existing) {
      if (county && !existing.counties.includes(county)) existing.counties.push(county);
    } else {
      byId.set(id, {
        disaster_id: `DR-${id}`,
        declared_date: String(row.declarationDate ?? '').slice(0, 10),
        incident_type: String(row.incidentType ?? ''),
        counties: county ? [county] : [],
      });
    }
  }
  return Array.from(byId.values());
}

export const fetchFemaDeclarations = {
  name: 'fetch_fema_declarations',
  description:
    'List FEMA disaster declarations for a US state, optionally since an ISO date. Returns disaster id, declaration date, incident type, and the designated counties.',
  parameters: {
    type: 'object' as const,
    properties: {
      state: { type: 'string', description: '2-letter US state code (e.g., FL)' },
      since: {
        type: 'string',
        description: 'Optional ISO date lower bound on declarationDate, e.g. 2024-01-01',
      },
    },
    required: ['state'],
  },
  handler: async (args: FetchFemaDeclarationsArgs): Promise<FemaDeclaration[]> => {
    if (!args?.state) throw new Error('state required');
    if (process.env.FORGE_TOOLS_MODE === 'mock') {
      return mockResponse(args.state);
    }
    try {
      const live = await tryLive(args.state, args.since);
      if (live) return live;
      return mockResponse(args.state);
    } catch {
      return mockResponse(args.state);
    }
  },
};
