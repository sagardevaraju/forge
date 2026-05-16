/**
 * GET /api/book/sample — download a sample CSV with the exact column shape
 * the upload endpoint expects. Saves seasoned operators from guessing.
 */
export const runtime = 'nodejs';

const SAMPLE = `policy_id,state,zip3,county,lat,lon,tiv,build_year,build_type,flood_zone,elevation_m,premium_annual
1001,FL,337,Hillsborough,27.95,-82.45,425000,1998,wood_frame,AE,2.4,7820
1002,FL,337,Hillsborough,27.91,-82.50,580000,2010,masonry,VE,1.1,12180
1003,FL,341,Sarasota,27.20,-82.40,310000,1985,manufactured,AE,1.8,6240
1004,TX,775,Galveston,29.30,-94.80,950000,2005,masonry,VE,0.9,22610
1005,LA,705,Jefferson,29.95,-90.10,475000,1992,wood_frame,A,1.3,9240
1006,NC,285,Onslow,34.70,-77.40,365000,2001,wood_frame,X,8.5,4080
`;

export async function GET() {
  return new Response(SAMPLE, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="forge_book_sample.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
