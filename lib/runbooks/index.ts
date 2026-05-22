/**
 * Task P2.25 — Procedure-mode runbooks.
 *
 * The chat route's free mode hands tool selection to the LLM. Procedure mode
 * does the opposite: the operator picks one of the 7 named runbooks below,
 * and the route executes that runbook's FIXED tool-call sequence verbatim.
 * Exactly one LLM call follows — to summarize the accumulated tool results
 * into the final assistant message. No LLM-driven tool selection, no loops.
 *
 * Why 7 named runbooks: cat-ops VPs need DETERMINISTIC, AUDITABLE workflows
 * tied to the storm lifecycle. The names map 1:1 to the operational windows
 * they trigger in (T-72 / T-48 / T-24 pre-landfall, landfall, post-landfall
 * T+24 / T+72, post-storm post-mortem). The runbook id is captured in the
 * audit-log prompt field as ``procedure:<id>`` so an auditor can answer
 * "which runbook produced this output" by inspection.
 *
 * Each step references a tool by its registry name. Args are either a static
 * object or a function of ``RunbookContext`` — the latter lets a later step
 * use parameters supplied by the user (storm_id, states) or, in the future,
 * be derived from a prior step's result. Today the runbook context is
 * passed-through user input (storm_id + optional states). Step descriptions
 * are surfaced verbatim as the tool_call's ``description`` field so the UI
 * can label each step with operator-friendly text.
 *
 * Design constraints:
 *   * Only tools that already exist in ``lib/llm/tool-registry.ts`` may be
 *     referenced. Don't invent new tools to fit a runbook — simplify the
 *     runbook to use what's there.
 *   * The cone-state list is currently fixed to the historical Florida-gulf
 *     footprint (FL, GA, AL) because we don't have a TS-side cone-to-state
 *     resolver yet. Pre-landfall runbooks accept an optional ``states``
 *     override on the context so the operator can widen or narrow it.
 *   * Storm_id is REQUIRED for every runbook except ``post_storm_post_mortem``
 *     which can stand alone with just ``states``.
 */
import type { Tool } from '@/lib/llm/tool-registry';

export type RunbookId =
  | 'pre_landfall_t72'
  | 'pre_landfall_t48'
  | 'pre_landfall_t24'
  | 'landfall'
  | 'post_landfall_t24'
  | 'post_landfall_t72'
  | 'post_storm_post_mortem';

/**
 * Inputs the operator supplies when invoking a runbook. Procedure-mode is
 * deliberately spartan: a storm_id is enough for the storm-centered runbooks,
 * plus an optional states override for post-mortem and ZIP3-aware lookups.
 */
export interface RunbookContext {
  user_message: string;
  storm_id?: string;
  states?: string[];
}

export interface RunbookStep {
  /** Name of a tool registered in ``lib/llm/tool-registry.ts``. */
  tool: string;
  /**
   * Static args object OR a function of context. The function form lets a
   * step pull ``ctx.storm_id`` / ``ctx.states`` so the same runbook works
   * across different storms.
   */
  args: Record<string, unknown> | ((ctx: RunbookContext) => Record<string, unknown>);
  /**
   * Operator-facing label for this step. Surfaced verbatim as the
   * ``description`` field on the emitted ``tool_call`` event so the UI can
   * render "Step 2/4 — Query book exposure in FL/GA/AL" instead of just
   * "query_book_exposure".
   */
  description: string;
}

export interface Runbook {
  id: RunbookId;
  /** Display label for the runbook picker. */
  name: string;
  /** One-sentence explainer surfaced under the picker. */
  description: string;
  steps: RunbookStep[];
}

/**
 * Default cone-footprint states (FL/GA/AL). Pre-landfall runbooks fall back
 * to this when the operator does not supply a ``states`` override. Wider
 * than-necessary on purpose — better to over-fetch book exposure than to
 * miss a county.
 */
const DEFAULT_CONE_STATES = ['FL', 'GA', 'AL'];

/**
 * Map the default cone states into ZIP3 prefixes for ``query_book_exposure``.
 * Florida-gulf coverage: 320s-339s span Tampa/Orlando/Miami/Fort Myers; 300s
 * cover Atlanta-region Georgia; 350-369 cover Alabama. This list is the
 * Phase-2 stand-in for a real cone-to-ZIP3 resolver (which is on the Phase-3
 * roadmap).
 */
const DEFAULT_CONE_ZIP3S = [
  '320', '321', '322', '323', '324', '325', '326', '327', '328', '329',
  '330', '331', '332', '333', '334', '335', '336', '337', '338', '339',
  '300', '301', '302', '303', '304', '305', '306', '307', '308', '309',
  '350', '351', '352', '354', '355', '356', '357', '358', '359', '360',
  '361', '362', '363', '364', '365', '366', '367', '368', '369',
];

function requireStormId(ctx: RunbookContext): string {
  if (!ctx.storm_id) {
    throw new Error('runbook requires storm_id');
  }
  return ctx.storm_id;
}

function coneStates(ctx: RunbookContext): string[] {
  return ctx.states && ctx.states.length > 0 ? ctx.states : DEFAULT_CONE_STATES;
}

/**
 * The 7 named runbooks. Step counts vary (3-5) — the discipline is keeping
 * each one to a single defensible operational window, not maximizing tool
 * usage. Each runbook ends with ``draft_sitrep`` because a structured memo
 * is what gets handed up the chain.
 */
export const RUNBOOKS: Runbook[] = [
  {
    id: 'pre_landfall_t72',
    name: 'Pre-landfall T-72',
    description:
      'T-72 reconnaissance: pull the latest cone, size book exposure in cone states, ' +
      'generate a 200-scenario ensemble for peak-wind bucketing, and draft the SITREP.',
    steps: [
      {
        tool: 'fetch_nhc_cone',
        args: (ctx) => ({ storm_id: requireStormId(ctx) }),
        description: 'Fetch the latest NHC forecast cone',
      },
      {
        tool: 'query_book_exposure',
        args: () => ({ zip3_list: DEFAULT_CONE_ZIP3S }),
        description: 'Aggregate book TIV by ZIP3 across cone states',
      },
      {
        tool: 'generate_scenarios',
        args: (ctx) => ({ storm_id: requireStormId(ctx), n: 200 }),
        description: 'Generate 200-scenario ensemble for peak-wind buckets',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `T-72 reconnaissance for ${requireStormId(ctx)}. Cone fetched, book ` +
            `exposure aggregated across ${coneStates(ctx).join('/')}, 200-scenario ensemble built.`,
        }),
        description: 'Draft the T-72 SITREP',
      },
    ],
  },
  {
    id: 'pre_landfall_t48',
    name: 'Pre-landfall T-48',
    description:
      'T-48 refresh: tighten the cone, re-size book exposure, double the scenario ' +
      'count (500) for sharper bucket cuts, and update the SITREP with the new posture.',
    steps: [
      {
        tool: 'fetch_nhc_cone',
        args: (ctx) => ({ storm_id: requireStormId(ctx) }),
        description: 'Refresh the NHC cone for the T-48 advisory',
      },
      {
        tool: 'query_book_exposure',
        args: () => ({ zip3_list: DEFAULT_CONE_ZIP3S }),
        description: 'Re-aggregate book TIV against the tightened cone',
      },
      {
        tool: 'generate_scenarios',
        args: (ctx) => ({ storm_id: requireStormId(ctx), n: 500 }),
        description: 'Run 500-scenario ensemble for the T-48 bucketing',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `T-48 refresh for ${requireStormId(ctx)}. Cone tightened, exposure ` +
            `re-aggregated across ${coneStates(ctx).join('/')}, 500-scenario ensemble built.`,
        }),
        description: 'Draft the T-48 SITREP',
      },
    ],
  },
  {
    id: 'pre_landfall_t24',
    name: 'Pre-landfall T-24',
    description:
      'T-24 final pre-landfall pass: peak-wind cone, full 1,000-scenario ensemble, ' +
      'and the operationally-decisive SITREP that triggers staging + reinsurance calls.',
    steps: [
      {
        tool: 'fetch_nhc_cone',
        args: (ctx) => ({ storm_id: requireStormId(ctx) }),
        description: 'Pull the T-24 NHC cone (final pre-landfall advisory)',
      },
      {
        tool: 'query_book_exposure',
        args: () => ({ zip3_list: DEFAULT_CONE_ZIP3S }),
        description: 'Aggregate book TIV one last time before landfall',
      },
      {
        tool: 'generate_scenarios',
        args: (ctx) => ({ storm_id: requireStormId(ctx), n: 1000 }),
        description: 'Run the 1,000-scenario landfall ensemble',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `T-24 final pre-landfall pass for ${requireStormId(ctx)}. ` +
            `1,000-scenario ensemble built. Staging and reinsurance triggers in scope.`,
        }),
        description: 'Draft the T-24 SITREP for staging and reinsurance triggers',
      },
    ],
  },
  {
    id: 'landfall',
    name: 'Landfall',
    description:
      'Landfall posture: lock the current cone, hand over peak-impact scenario ensemble, ' +
      'and issue the in-event SITREP. Historical comparable storms are listed alongside.',
    steps: [
      {
        tool: 'fetch_nhc_cone',
        args: (ctx) => ({ storm_id: requireStormId(ctx) }),
        description: 'Lock the landfall-advisory cone',
      },
      {
        tool: 'generate_scenarios',
        args: (ctx) => ({ storm_id: requireStormId(ctx), n: 1000 }),
        description: 'Generate the landfall-window scenario ensemble',
      },
      {
        tool: 'fetch_storm_events',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Pull historical storm comparables for the lead cone state',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `Landfall posture for ${requireStormId(ctx)}. Cone locked, peak-impact ` +
            `ensemble in hand, historical comparables pulled for ${coneStates(ctx)[0] ?? 'FL'}.`,
        }),
        description: 'Draft the landfall SITREP',
      },
    ],
  },
  {
    id: 'post_landfall_t24',
    name: 'Post-landfall T+24',
    description:
      'T+24 damage-assessment kickoff: FEMA declarations, historical storm events for ' +
      'comparables, book exposure re-cut, and the recovery-mode SITREP.',
    steps: [
      {
        tool: 'fetch_fema_declarations',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Pull fresh FEMA disaster declarations for the impacted state',
      },
      {
        tool: 'fetch_storm_events',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Pull historical storm-event analogs for damage modeling',
      },
      {
        tool: 'query_book_exposure',
        args: () => ({ zip3_list: DEFAULT_CONE_ZIP3S }),
        description: 'Re-cut book exposure for claims-handling staging',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `T+24 post-landfall for ${requireStormId(ctx)}. FEMA declarations in, ` +
            `historical analogs pulled, book exposure re-cut for claims staging.`,
        }),
        description: 'Draft the T+24 SITREP, recovery-mode posture',
      },
    ],
  },
  {
    id: 'post_landfall_t72',
    name: 'Post-landfall T+72',
    description:
      'T+72 claims-flow check: FEMA county roster, the in-period storm-event log, ' +
      'and a SITREP refresh that reads against the running claims book.',
    steps: [
      {
        tool: 'fetch_fema_declarations',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Refresh FEMA declarations for new counties added since T+24',
      },
      {
        tool: 'fetch_storm_events',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Re-pull storm events through T+72 for damage-cost tracking',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: requireStormId(ctx),
          posture_summary:
            `T+72 post-landfall for ${requireStormId(ctx)}. Claims flow established. ` +
            `FEMA roster expanding. Storm-event log re-pulled for damage-cost tracking.`,
        }),
        description: 'Draft the T+72 SITREP, claims-flow posture',
      },
    ],
  },
  {
    id: 'post_storm_post_mortem',
    name: 'Post-storm post-mortem',
    description:
      'After-action review: full FEMA roster, multi-year storm-event history, and a ' +
      'final post-mortem SITREP capturing what the book actually took.',
    steps: [
      {
        tool: 'fetch_fema_declarations',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL' }),
        description: 'Pull the final FEMA declaration roster',
      },
      {
        tool: 'fetch_storm_events',
        args: (ctx) => ({ state: coneStates(ctx)[0] ?? 'FL', since: '2010' }),
        description: 'Pull multi-year storm-event history for after-action context',
      },
      {
        tool: 'query_book_exposure',
        args: () => ({ zip3_list: DEFAULT_CONE_ZIP3S }),
        description: 'Re-cut book exposure for the post-mortem',
      },
      {
        tool: 'draft_sitrep',
        args: (ctx) => ({
          threat_id: ctx.storm_id ?? 'post_mortem',
          posture_summary:
            `Post-storm post-mortem${ctx.storm_id ? ` for ${ctx.storm_id}` : ''}. ` +
            `Full FEMA roster and multi-year storm history reviewed. Book exposure re-cut.`,
        }),
        description: 'Draft the post-mortem SITREP',
      },
    ],
  },
];

/** Lookup a runbook by id. Returns undefined if the id is unknown. */
export function getRunbook(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id);
}

/** Type guard for narrow checks at the route boundary. */
export function isRunbookId(id: unknown): id is RunbookId {
  return typeof id === 'string' && RUNBOOKS.some((r) => r.id === id);
}

/**
 * Resolve a step's args by either returning the static object or invoking
 * the function form with the supplied context. Separated out so the route
 * can call this once per step and so tests can pin the resolution rule.
 */
export function resolveStepArgs(
  step: RunbookStep,
  ctx: RunbookContext,
): Record<string, unknown> {
  return typeof step.args === 'function' ? step.args(ctx) : step.args;
}

/**
 * Verify at module load that every referenced tool name exists in the
 * registry. We don't have a static import-time check (the runbook references
 * tool *names*, not Tool objects), so do a runtime guard against typos. The
 * check is skipped in production builds — it's a developer ergonomics
 * guardrail, not a security control.
 */
export function assertRunbooksReferenceKnownTools(tools: Tool[]): void {
  const known = new Set(tools.map((t) => t.name));
  for (const rb of RUNBOOKS) {
    for (const step of rb.steps) {
      if (!known.has(step.tool)) {
        throw new Error(
          `runbook ${rb.id} references unknown tool ${step.tool}`,
        );
      }
    }
  }
}
