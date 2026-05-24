/**
 * Task P3.28a — Enhanced PII classifier (replaces the P2.39 regex
 * deny-list in lib/book/csv.ts).
 *
 * The original `PII_DENY_REGEX = /(ssn|dob|phone|email|name|address)/i`
 * has two failure modes documented inline in csv.ts:
 *
 *   - False POSITIVE on benign columns like `business_name` (matches
 *     `name`) — refuses legitimate metadata columns.
 *   - False NEGATIVE on cryptic ones like `cust_ssn_hash`, `dt_birth`,
 *     `em_addr`, `caller_id_phn` — silently allows PII through.
 *
 * P3.28a replaces it with a three-layer classifier:
 *
 *   1. **Normalization** — lowercases the column name and splits on
 *      common delimiters (`_`, `-`, `.`, ` `, camelCase boundaries) so
 *      `cust_ssn_hash` becomes ['cust', 'ssn', 'hash'].
 *   2. **PII keyword dictionary** — checks each token against a broad
 *      dictionary covering 80+ PII shapes (names, addresses, contact,
 *      ids, financial, biometric, age/DOB, medical).
 *   3. **Allow-list** — terms like 'business', 'company', 'policy' are
 *      flagged as legitimately-naming, so `business_name` is no longer
 *      a PII column even though it contains the `name` token.
 *
 * The classifier returns a structured `PIIClassification` so the
 * caller can surface WHY a column was refused (which token matched,
 * which category) — a substantial improvement over the regex's binary
 * yes/no for audit/regulatory traceability.
 *
 * For deeper analysis on column VALUES (not just names), the Python
 * side (`api_py/pii_classifier.py` + `/api/book/check-pii` route) wraps
 * Microsoft Presidio when installed. Installing Presidio adds ~100 MB
 * of deps (presidio-analyzer + spaCy en_core_web_lg model); ingestion
 * teams that want value-level detection can opt in. Without Presidio
 * the route falls back to this name-level classifier.
 */

// ── PII keyword dictionary (token-level) ─────────────────────────────

/**
 * Tokens that, when found inside a normalised column name, mark the
 * column as PII. Grouped by category so the classifier can return a
 * human-readable rationale.
 *
 * Entries are EXACT TOKENS — `address` matches `address`, `addr`, or
 * `addrs` only if they're separate tokens (after normalization), not
 * substrings of unrelated words.
 */
const PII_TOKENS: Record<string, ReadonlySet<string>> = {
  name: new Set([
    'name', 'firstname', 'lastname', 'middlename', 'surname',
    'givenname', 'fname', 'lname', 'mname', 'fullname',
    'fn', 'ln', 'mn', 'nm',
  ]),
  address: new Set([
    // Mailing-address tokens. NOT included: `state`, `zip`, `city`,
    // `country` — those are standard FORGE book columns (policy
    // location), not customer-mailing PII. The wizard accepts them
    // without refusal.
    'address', 'addr', 'addrs', 'street', 'st1', 'st2',
    'postal', 'postcode',
    'apt', 'unit', 'suite', 'addressline', 'addressline1',
    'addressline2', 'mailing', 'billing', 'shipping',
  ]),
  contact: new Set([
    'phone', 'phn', 'tel', 'telephone', 'mobile', 'cell',
    'cellphone', 'mob', 'fax', 'email', 'em', 'mail',
    'emailaddress', 'emailaddr',
  ]),
  id: new Set([
    'ssn', 'sin', 'nin', 'ein', 'itin', 'taxid', 'tin',
    'passport', 'passportno', 'license', 'licenseno',
    'driverslicense', 'dl', 'driverlicense',
    'nationalid', 'governmentid', 'govid',
  ]),
  financial: new Set([
    'creditcard', 'credit', 'cc', 'ccnum', 'ccnumber', 'cardnumber',
    'bankaccount', 'iban', 'swift', 'routingnumber', 'aba',
    'cvv', 'cvc', 'pin',
  ]),
  biometric: new Set([
    'fingerprint', 'biometric', 'iris', 'retina', 'facial',
    'photo', 'photograph',
  ]),
  age_dob: new Set([
    'dob', 'birth', 'birthdate', 'birthday', 'dateofbirth',
    'dtbirth', 'age',
  ]),
  medical: new Set([
    'medical', 'health', 'diagnosis', 'condition', 'medication',
    'prescription', 'hipaa',
  ]),
};

/**
 * Allow-listed token contexts. When a column name contains BOTH a PII
 * token AND an allow-list token, the allow-list wins (column is NOT
 * PII). Solves the `business_name` false positive: the `business`
 * token marks the column as legitimately naming an entity rather than
 * a person.
 */
const ALLOW_CONTEXTS: ReadonlySet<string> = new Set([
  'business', 'company', 'organization', 'org', 'entity',
  'product', 'policy', 'plan', 'role', 'job', 'title',
  'department', 'team', 'group', 'category', 'type', 'class',
  'event', 'incident', 'claim', 'station', 'storm', 'peril',
  'tag', 'code', 'category', 'segment', 'cluster', 'cohort',
  'risk', 'rate',
]);

// ── normalization ──────────────────────────────────────────────────────

/**
 * Split a column name into lowercase tokens. Handles snake_case,
 * kebab-case, dot-separated, space-separated, and camelCase /
 * PascalCase. Strips digits at token boundaries (`address1` →
 * ['address']; `st1` stays as 'st1' because the digit is inside the
 * token).
 */
export function tokenize(columnName: string): string[] {
  if (!columnName) return [];
  // 1. Insert separators at camelCase / PascalCase boundaries.
  const withCamelSeps = columnName.replace(/([a-z])([A-Z])/g, '$1_$2');
  // 2. Split on common delimiters.
  const parts = withCamelSeps
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 0);
  // 3. Strip trailing digits at token end (`address1` → `address`)
  //    but leave embedded numbers in known PII-ish tokens (`st1`).
  return parts.map((t) => {
    // Keep `st1` / `st2` / `addressline1` / `addressline2` as full
    // tokens; strip plain trailing digits otherwise.
    if (/^(st|addressline|address)\d$/.test(t)) return t;
    return t.replace(/\d+$/, '');
  }).filter((t) => t.length > 0);
}

// ── classifier ─────────────────────────────────────────────────────────

export interface PIIClassification {
  /** True if the column name should be refused. */
  isPii: boolean;
  /** Token that matched the PII dictionary (or null). */
  matchedToken: string | null;
  /** Category of PII (or null). */
  category: keyof typeof PII_TOKENS | null;
  /** Allow-list token that won (when present + suppressed the PII flag). */
  allowedBy: string | null;
  /** All tokenized parts of the input name (for traceability). */
  tokens: string[];
}

/**
 * Classify a single column name. Returns a structured result so the
 * caller can surface WHY a column was refused.
 *
 * Algorithm:
 *   1. Tokenize the column name.
 *   2. Find the first token that matches any PII dictionary entry.
 *   3. If found, scan the remaining tokens for an allow-list entry —
 *      if one matches, suppress the PII flag.
 *   4. Otherwise the column is PII; report the matching token +
 *      category.
 */
export function classifyPII(columnName: string): PIIClassification {
  const tokens = tokenize(columnName);
  if (tokens.length === 0) {
    return { isPii: false, matchedToken: null, category: null,
             allowedBy: null, tokens };
  }
  let matchedToken: string | null = null;
  let category: keyof typeof PII_TOKENS | null = null;
  for (const token of tokens) {
    for (const [cat, set] of Object.entries(PII_TOKENS)) {
      if (set.has(token)) {
        matchedToken = token;
        category = cat as keyof typeof PII_TOKENS;
        break;
      }
    }
    if (matchedToken) break;
  }
  if (!matchedToken) {
    return { isPii: false, matchedToken: null, category: null,
             allowedBy: null, tokens };
  }
  // PII token matched — check for an allow-list context.
  for (const token of tokens) {
    if (ALLOW_CONTEXTS.has(token)) {
      return { isPii: false, matchedToken, category,
               allowedBy: token, tokens };
    }
  }
  return { isPii: true, matchedToken, category, allowedBy: null, tokens };
}

/**
 * Backward-compatible boolean check. Equivalent to
 * `classifyPII(name).isPii`. Use this from any call site that needs a
 * simple yes/no answer; use `classifyPII` when you want the rationale.
 */
export function isPIIColumnName(columnName: string): boolean {
  return classifyPII(columnName).isPii;
}
