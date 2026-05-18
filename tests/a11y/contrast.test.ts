// @vitest-environment node
/**
 * Task 26 — WCAG-AA contrast pass for the trust-tier palette.
 *
 * The five `TRUST_TIER_META` entries are the canonical badge palette that
 * decorates every numbered surface in FORGE. This suite programmatically
 * verifies that each tier's foreground/background combination clears the
 * WCAG-AA contrast threshold of 4.5:1 for normal-size text. The test pins
 * the contract — if anyone later swaps `text-green-800` for a lighter
 * shade we want the build to break, not the screen-reader user.
 */
import { describe, test, expect } from 'vitest';
import { TRUST_TIER_META } from '@/lib/grammar/trust-tiers';

// Tailwind color tokens for the 100/300/400/800 shades used by trust tiers.
// Values from Tailwind v3 default palette (stable across v3.x → v4.x).
const TAILWIND_COLORS: Record<string, string> = {
  'green-100': '#dcfce7', 'green-300': '#86efac', 'green-800': '#166534',
  'blue-100': '#dbeafe',  'blue-300': '#93c5fd',  'blue-800': '#1e40af',
  'amber-100': '#fef3c7', 'amber-300': '#fcd34d', 'amber-800': '#92400e',
  'violet-100': '#ede9fe','violet-300': '#c4b5fd','violet-800': '#5b21b6',
  'red-100': '#fee2e2',   'red-400': '#f87171',   'red-800': '#991b1b',
};

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// Extract fg/bg class names from a className string like
// "bg-green-100 text-green-800 border-green-300".
function extractFgBg(className: string): { fg: string; bg: string } | null {
  const bgMatch = className.match(/bg-([a-z]+-\d+)/);
  const textMatch = className.match(/text-([a-z]+-\d+)/);
  if (!bgMatch || !textMatch) return null;
  const bg = TAILWIND_COLORS[bgMatch[1]];
  const fg = TAILWIND_COLORS[textMatch[1]];
  if (!bg || !fg) return null;
  return { bg, fg };
}

describe('TrustTier color contrast (WCAG AA, 4.5:1 for normal text)', () => {
  for (const [tier, meta] of Object.entries(TRUST_TIER_META)) {
    test(`${tier} meets WCAG AA`, () => {
      const colors = extractFgBg(meta.className);
      expect(colors).not.toBeNull();
      const ratio = contrastRatio(colors!.fg, colors!.bg);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});
