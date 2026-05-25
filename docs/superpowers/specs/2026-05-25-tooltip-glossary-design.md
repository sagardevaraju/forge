# Tooltip + Glossary system — design

**Date:** 2026-05-25
**Author:** Sagar Devaraju (with Claude Code)
**Status:** Approved (brainstorm complete, plan pending)

## Goal

A homeowner who has never bought commercial insurance should be able to hover any jargon term anywhere in the FORGE UI and read a plain-English explanation in under five seconds. Today the same person sees "Tail exposure $96.7M of $93.9M capital budget · binding" and has nowhere to learn what any of that means without leaving the page.

## Non-goals

- Not building a full glossary page. The methodology page already carries long-form prose; tooltips deep-link there.
- Not rewriting any KPI label or column header to be self-explanatory in prose. The dashboard stays dense; the tooltips are the relief valve.
- Not introducing a new icon library, popover library, or tooltip dependency. Tailwind tokens + inline SVG only.
- Not building per-user preference persistence in this pass (no "I've seen this term, don't show it again" memory).

## Visual design — Variant D

Selected during the 2026-05-25 brainstorm session. An outlined info-circle SVG icon (Lucide-style: 14 px circle, 2 px stroke, dot + vertical line inside) sits adjacent to the term, in muted zinc by default and accent-green on hover/focus. The icon is small, monochrome, doesn't fight the trust-tier chip for attention, and works in three contexts:

1. **KPI labels** — `Tail exposure ⓘ` above the `$96.7M` figure on Portfolio header, ExecCards, etc.
2. **Table column headers** — `Tail ⓘ` in claims / drill-down tables.
3. **Chips and badges** — `[Tail] ⓘ` next to a status-style pill.

The popup that opens on hover/focus/click is 280 px wide, lives in a white surface with the standard FORGE hairline border + soft shadow, and contains:

- **Term label** (uppercase accent-green, 11 px) — the canonical name in case the trigger truncated it
- **Definition** (12 px, 1.45 line-height) — the elevator pitch
- **Example** (optional, italic zinc-500, hairline-divided) — a concrete number or scenario that anchors the concept
- **Methodology link** (optional, accent-green) — `→ See methodology` deep-link

Positioning defaults to `top: calc(100% + 6px); left: 0;` (below the trigger, aligned to its left edge). When the trigger sits in the right half of the viewport, the popup flips to `right: 0;` instead so it never clips. No floating-ui library; one `useEffect` measures the trigger's bounding rect against `window.innerWidth` after mount.

## Architecture — three layers

### Layer 1 — `lib/grammar/glossary.ts`

Strictly-typed lookup keyed by stable kebab-case slugs (`tvar-99`, `pareto-frontier`, `flood-zone-ve`). One entry per term:

```ts
export interface GlossaryEntry {
  label: string;       // Title Case display name
  definition: string;  // 1–3 plain-English sentences
  example?: string;    // Optional anchor example
  source?: string;     // Optional /methodology#{slug} deep-link
}
```

The lookup helper `lookupTerm(key)` returns `undefined` for unknown keys — a missing entry never crashes a render. The full `GLOSSARY` record is exported for the methodology page's eventual glossary index and for tests. Initial seed covers ~150 terms catalogued from every UI surface during the 2026-05-25 audit.

### Layer 2 — `components/grammar/InfoTooltip.tsx`

Three named exports composing the same internal popup primitive:

- **`<InfoIcon term="..." />`** — bare info-SVG. Used inline next to a label that doesn't need rewriting. Most common usage.
- **`<Term term="..." children?>` ** — wraps a phrase; renders `children` (or `entry.label` if absent) followed by the icon. Used when the visible text and the glossary key need to be different.
- **`<InfoTooltip term="..." />`** — low-level access to the popup primitive for cases that need custom triggers (the trust-tier badge wraps its own pill with this).

Shared internal state machine (one `useState<'closed' | 'open' | 'pinned'>`):

| Trigger event | State transition |
|---|---|
| `pointerenter` on trigger | `closed → open` |
| `pointerleave` on trigger+popup (after 100 ms grace) | `open → closed` (does not close `pinned`) |
| `focus` on trigger | `closed → open` |
| `blur` on trigger (no other focus inside popup) | `open → closed` |
| `click` on trigger | `open ↔ pinned` |
| `Escape` keypress | `(open\|pinned) → closed` |
| outside-click (document-level listener) | `pinned → closed` |

The 100 ms grace period on `pointerleave` is the standard "let the cursor cross the gap from trigger to popup" buffer; without it the popup snaps shut as soon as the mouse moves toward it.

### Layer 3 — application surfaces

Every page and component listed in the audit gets the appropriate `InfoIcon` / `Term` calls wired into its rendered JSX. The full inventory is in the "Application surface inventory" section below.

## Component API

```tsx
// Bare icon — no visible label change.
<InfoIcon term="tvar-99" />

// Wrap a phrase and append the icon.
<Term term="tail-exposure" />              // renders entry.label + icon
<Term term="tail-exposure">Tail</Term>     // renders "Tail" + icon

// Custom-trigger advanced form (used by TrustTierBadge).
<InfoTooltip term="live-feed">
  <span className="…trust-badge classes…">Live</span>
</InfoTooltip>
```

All three accept an optional `placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'` override (default: auto-detected based on viewport). All three accept `iconSize?: 'sm' | 'md'` — `sm` is 12 px (table headers, dense chips), `md` is 14 px (default; KPI labels).

When `lookupTerm(term)` returns `undefined` we render the children + icon but with a `data-testid="glossary-missing"` attribute and zero popup. Tests assert no missing keys ship.

## Accessibility behaviors

- The trigger is a `<button type="button" aria-describedby={popupId}>`. Keyboard users land on it via Tab; Enter/Space pins; Esc dismisses.
- The icon SVG carries `aria-hidden="true"`. The button's `aria-label` is `"Definition of {entry.label}"`.
- The popup container carries `role="tooltip"` and a stable id matched by `aria-describedby` so screen readers announce it when the trigger receives focus.
- When `pinned`, the popup additionally claims `role="dialog"` and traps Tab focus into the first link inside it (for the methodology deep-link). Esc exits and returns focus to the trigger.
- Native browser `title=` is **not** set on the trigger — the custom tooltip would race the OS tooltip.

## Visual specification (locked to FORGE tokens)

| Element | Token | Value |
|---|---|---|
| Icon idle stroke | zinc-500 | `#71717a` |
| Icon hover stroke | accent | `var(--accent)` `#047857` |
| Popup background | surface | `var(--surface)` `#ffffff` |
| Popup border | hairline-strong | `var(--hairline-strong)` `rgba(24,24,27,0.14)` |
| Popup shadow | — | `0 6px 20px rgba(24,24,27,0.12), 0 1px 3px rgba(24,24,27,0.08)` |
| Term label (in popup) | accent | `#047857`, 11 px, uppercase, `0.06em` tracking |
| Definition body | ink | `#18181b`, 12 px / 1.45 |
| Example body | ink-muted | `#52525b`, 11 px, italic |
| Methodology link | accent | `#047857`, 10.5 px |
| Popup width | — | 280 px |
| Popup padding | — | 10 px / 12 px |
| Popup gap from trigger | — | 6 px |
| z-index | — | 50 (above table headers, below modals) |

Icon SVG (the Lucide info-circle, inlined — no `lucide-react` dependency):

```svg
<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
     stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10"/>
  <path d="M12 16v-4"/>
  <path d="M12 8h.01"/>
</svg>
```

## TrustTierBadge integration

`TrustTierBadge` currently uses native HTML `title=`. We retrofit it to wrap its existing pill in `<InfoTooltip term="live-feed" | "model-output" | …>` so every Live/Model/Demo chip on the dashboard gets the same rich popup pattern. The badge's existing className + tier colors do not change — only the hover affordance is upgraded. The 8 glossary keys for trust tiers (`live-feed`, `model-output`, `synthetic-scaffold`, `recommendation`, `manual-override`) are already in the glossary seed.

## Application surface inventory

Pulled from the 2026-05-25 audit. Each row identifies the surface, the terms it surfaces, and where the tooltip mounts.

| Surface | Terms | Mount strategy |
|---|---|---|
| `ExecCard` | (term passed through by caller) | New optional `term?: GlossaryKey` prop. When set, the label gets the icon. |
| `TrustTierBadge` | `live-feed`, `model-output`, `synthetic-scaffold`, `recommendation`, `manual-override` | Wrap existing pill with `InfoTooltip`. |
| Landing (`app/page.tsx`) | `book-tiv`, `policies`, `projected-cession-spend`, `advisory` | Pass `term` prop to each ExecCard. |
| `PortfolioHeader` | `expected-margin`, `tail-exposure`, `capital-budget`, `non-renew`, `non-renew-cap`, `cession`, `cession-budget`, `rate-on-line`, `crps`, `mip-status`, `infeasible` | Inline `InfoIcon` on each KPI label + status chip. |
| `PortfolioMap` / `PortfolioChoropleth` | `cohort`, `zip3`, `tiv`, action labels (`retain`, `reprice`, `non-renew`, `cede-qs`, `cede-xs`) | Inline `InfoIcon` on legend labels and cohort tooltip. |
| `PortfolioDrillDown` | `cohort`, `tiv-quintile`, `build-type`, `flood-zone`, action labels, `expected-loss`, `p99`, `tvar-99` | Inline on table headers and chip rows. |
| `PortfolioPareto` | `pareto-frontier`, `pareto-sweep`, `infeasible-relaxed`, `capital-budget`, `cession-budget` | Inline on axis labels + cell badges. |
| `WhatIfControl` | `capital-budget`, `cession-budget`, `non-renew-cap` (current/baseline/proposed) | Inline next to slider title. |
| `TreatyLadder` | `treaty`, `quota-share`, `excess-of-loss`, `attachment`, `exhaustion`, `rate-on-line`, `reinstatement`, `fronting`, `fronting-fee`, `captive`, `ils`, `upr` | Inline on every column header and layer-row label. |
| `ClaimsTable` | `claims-pre-brief`, `cohort`, `tiv-quintile`, `flood-zone-ae`, `flood-zone-ve`, `notice-days`, `expected-loss`, `expected-claims`, `adjuster-load` | Inline on column headers. |
| `CalibrationView` | `pit`, `crps`, `reliability-diagram`, `quantile-head` | Inline on chart titles. |
| `EventConsole` | `nhc-cone`, `gefs`, `firms`, `nws`, `sitrep`, `advisory`, `cone-exposure`, `stochastic-exposure` | Inline on legend labels + section headers. |
| `ThreatBanner` | `advisory`, `peak-wind`, `storm-surge` | Inline on banner sub-labels. |
| `ConeExposureBars` | `cone-exposure`, `stochastic-exposure` | Inline on bar legends. |
| `SimWorkspace` + `PerilPicker` + `SeverityStrip` | `peril`, `severity`, `intensity`, `footprint`, `ef-scale`, `mw-magnitude`, `mmi`, `dnbr`, `wssi`, `hazus` | Inline on peril option labels and severity tier chips. |
| `SimulationBanner` | `tvar-99`, `k-1000`, `unresolved-simulation` | Inline in the explanation prose. |
| `AuditLedger` | `audit-ledger`, `append-only`, `worm` | Inline on column headers. |
| `LoadWizard` | (no glossary terms — already prose-heavy) | Skip. |
| `MethodologyView` | All terms render anchors so deep-links from tooltips land at the right section. | Anchors only, no tooltips on this page itself. |

## Testing plan

### Unit (Vitest)

- `tests/lib/grammar/glossary.test.ts` — every entry has a non-empty `label` and `definition`; examples and source slugs are well-formed; `lookupTerm` returns `undefined` for unknown keys and the typed entry for known ones.
- `tests/components/grammar/InfoTooltip.test.tsx` — hover opens, blur closes, click pins, Esc dismisses pin, outside-click dismisses pin. `aria-describedby` wiring is exercised. `term="unknown-key"` does not crash.
- `tests/components/grammar/TrustTierBadge.test.tsx` — verifies the upgraded badge still renders the tier label + color and the new popup carries the tier's definition.

### Integration (Vitest)

- Snapshot or text-assertion test on the Landing page that the four ExecCard labels each render exactly one `InfoIcon` button.
- `PortfolioHeader` test that the KPI labels carry the correct glossary keys.
- `ClaimsTable` test that table-header tooltips render and contain the expected definition substring.

### Playwright (manual, after wiring)

Walk the four high-jargon-density pages (`/`, `/portfolio`, `/treaty`, `/claims`) and confirm:
- Every visible KPI label / column header / chip has the icon.
- Hovering reveals the popup; tabbing through reveals the popup; the popup never clips off the right viewport edge.
- The methodology deep-link, when present, lands at the right anchor.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tooltip becomes visual clutter in dense tables (10+ icons per row). | The `iconSize="sm"` variant is 12 px and tucks tightly. Audit during wiring; collapse to a column-header-only icon if a row icon doesn't help anyone. |
| Popup clips off right edge of viewport. | Auto-flip to `right: 0;` when trigger sits in right 30 % of viewport (measured on mount + resize). |
| Glossary entries drift from reality as the spec evolves. | One entry per term, lookup by key, the methodology page links into the same anchors — when methodology changes, the deep-link still works. Vitest test asserts no orphan source slugs. |
| Adding a new term in JSX without adding a glossary entry crashes the build. | `lookupTerm()` returns `undefined` and the component renders the children with no popup; a Vitest sweep walks every `term=` literal in `app/**` and `components/**` and fails if any is missing from the glossary. |
| The audit must touch ~20 files in one PR. | Order by surface tier: (1) shared primitives + ExecCard + TrustTierBadge ship first; (2) one-page wirings stack as subsequent commits or get folded into the same PR with reviewer-friendly per-file diffs. |

## Out of scope

- Internationalization (English-only glossary; can extend the schema later with `definitionByLocale`).
- User-controllable "I've seen this term, don't show me the icon again" memory.
- Search inside the popup (the methodology page handles deep search).
- Voice-over screen reader audit beyond `aria-describedby` and `role="tooltip"`; we'll fix screen-reader issues if they surface but won't do a JAWS/NVDA conformance pass in this PR.

## Open questions

None — all clarifying questions resolved during the brainstorm:

1. ✅ Variant D (outlined info-SVG icon) selected over A, B, C, E, F, G.
2. ✅ Click pins the popup; Esc / outside-click dismisses.
3. ✅ TrustTierBadge migrates to the new primitive in the same PR.
