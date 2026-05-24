/**
 * Central registry of tools exposed to the FORGE agent loop.
 *
 * Adding a tool: implement it under app/api/agent/tools/<name>.ts following
 * the Tool<TArgs,TResult> shape, re-export it from
 * app/api/agent/tools/index.ts, and append it to TOOLS below.
 */
import {
  fetchNhcCone,
  fetchActiveStorms,
  fetchNwsAlerts,
  fetchFirmsFires,
  fetchFemaDeclarations,
  fetchStormEvents,
  generateScenarios,
  queryBookExposure,
  draftSitrep,
  resolveConeToZip3sTool,
} from '@/app/api/agent/tools';

export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  handler: (args: TArgs) => Promise<TResult>;
}

export const TOOLS: Tool[] = [
  fetchActiveStorms,
  fetchNhcCone,
  fetchNwsAlerts,
  fetchFirmsFires,
  fetchFemaDeclarations,
  fetchStormEvents,
  generateScenarios,
  queryBookExposure,
  draftSitrep,
  resolveConeToZip3sTool,
] as unknown as Tool[];

export const TOOL_MAP: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
