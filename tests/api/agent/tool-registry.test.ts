// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { TOOLS, TOOL_MAP } from '@/lib/llm/tool-registry';

const EXPECTED_TOOL_NAMES = [
  'fetch_nhc_cone',
  'fetch_firms_fires',
  'fetch_fema_declarations',
  'fetch_storm_events',
  'generate_scenarios',
  'query_book_exposure',
  'draft_sitrep',
];

describe('tool-registry', () => {
  test('exposes exactly 7 tools', () => {
    expect(TOOLS).toHaveLength(7);
  });

  test('every expected tool name is present', () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test('tool names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('TOOL_MAP is keyed by name and matches TOOLS', () => {
    for (const t of TOOLS) {
      expect(TOOL_MAP[t.name]).toBe(t);
    }
    expect(Object.keys(TOOL_MAP)).toHaveLength(TOOLS.length);
  });

  test('each tool has the expected shape (name, description, parameters, handler)', () => {
    for (const t of TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters.type).toBe('object');
      expect(typeof t.parameters.properties).toBe('object');
      expect(Array.isArray(t.parameters.required)).toBe(true);
      expect(typeof t.handler).toBe('function');
    }
  });
});
