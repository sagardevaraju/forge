import { describe, test, expect } from 'vitest';
import { GLOSSARY, lookupTerm } from '@/lib/grammar/glossary';

describe('glossary contract', () => {
  test('every entry has non-empty label + definition', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label, `${key} label`).toBeTruthy();
      expect(entry.label.length, `${key} label length`).toBeGreaterThan(0);
      expect(entry.definition, `${key} definition`).toBeTruthy();
      expect(entry.definition.length, `${key} definition length`).toBeGreaterThan(10);
    }
  });

  test('lookupTerm returns undefined for unknown keys', () => {
    expect(lookupTerm('not-a-real-key')).toBeUndefined();
  });

  test('lookupTerm returns the entry for a known key', () => {
    const entry = lookupTerm('tvar-99');
    expect(entry).toBeDefined();
    expect(entry?.label).toMatch(/TVaR/i);
  });

  test('entry keys are kebab-case (no underscores, no spaces, no capitals)', () => {
    for (const key of Object.keys(GLOSSARY)) {
      expect(key, `key ${key}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test('seeded coverage includes the core risk-measure terms', () => {
    for (const k of ['tvar-99', 'p99', 'var', 'tail-exposure', 'capital-budget']) {
      expect(lookupTerm(k), `${k} should exist`).toBeDefined();
    }
  });
});
