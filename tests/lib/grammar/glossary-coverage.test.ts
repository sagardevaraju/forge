// Sweeps every `term="..."` literal in app/** and components/** and asserts
// the key exists in the glossary. The point: catch typos at test time, not
// when a user hovers a chip and gets no popup.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLOSSARY } from '@/lib/grammar/glossary';

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = ['app', 'components'];
const EXTS = ['.tsx', '.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

const TERM_RE = /\bterm=(?:"([a-z0-9-]+)"|\{['"]([a-z0-9-]+)['"]\})/g;

describe('glossary coverage', () => {
  test('every term="..." in app/** and components/** maps to a glossary entry', () => {
    const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
    const missing: { file: string; key: string }[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      TERM_RE.lastIndex = 0;
      while ((m = TERM_RE.exec(src)) !== null) {
        const key = m[1] ?? m[2];
        if (!(key in GLOSSARY)) missing.push({ file: f.replace(ROOT + '/', ''), key });
      }
    }
    if (missing.length > 0) {
      const report = missing.map((m) => `  ${m.file}: term="${m.key}"`).join('\n');
      throw new Error(`Missing glossary entries:\n${report}`);
    }
  });
});
