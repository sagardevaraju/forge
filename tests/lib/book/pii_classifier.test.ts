// @vitest-environment node
/**
 * Task P3.28a — Enhanced PII classifier tests.
 *
 * Pins the dictionary + allow-list classifier so the regex's known
 * failure modes stay fixed:
 *   - false positive on `business_name` (P2.39 regex flagged it)
 *   - false negative on `cust_ssn_hash` (P2.39 regex missed it)
 */
import { describe, test, expect } from 'vitest';
import {
  classifyPII,
  isPIIColumnName,
  tokenize,
} from '@/lib/book/pii_classifier';
import { isPII, PII_DENY_REGEX } from '@/lib/book/csv';

describe('tokenize', () => {
  test('splits snake_case', () => {
    expect(tokenize('cust_ssn_hash')).toEqual(['cust', 'ssn', 'hash']);
  });

  test('splits camelCase on lower-Upper boundaries', () => {
    expect(tokenize('customerSsnHash')).toEqual(['customer', 'ssn', 'hash']);
    // Consecutive uppercase doesn't break — captures the SSN acronym
    // contiguous with the next word; the actual classifier matches
    // 'ssnhash' against the embedded 'ssn' via the token dictionary.
    expect(tokenize('customerSSNHash')).toEqual(['customer', 'ssnhash']);
  });

  test('splits kebab-case', () => {
    expect(tokenize('first-name-encrypted')).toEqual(['first', 'name', 'encrypted']);
  });

  test('preserves st1 / st2 / addressline1 as PII-relevant tokens', () => {
    expect(tokenize('addressline1')).toEqual(['addressline1']);
    expect(tokenize('st1')).toEqual(['st1']);
  });

  test('strips trailing digits on generic tokens', () => {
    expect(tokenize('zip5')).toEqual(['zip']);
    expect(tokenize('claim_id_123')).toEqual(['claim', 'id']);
  });

  test('empty / null input returns empty list', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('classifyPII — base PII detection', () => {
  test('detects ssn', () => {
    const r = classifyPII('ssn');
    expect(r.isPii).toBe(true);
    expect(r.matchedToken).toBe('ssn');
    expect(r.category).toBe('id');
  });

  test('detects dob', () => {
    const r = classifyPII('dob');
    expect(r.isPii).toBe(true);
    expect(r.matchedToken).toBe('dob');
    expect(r.category).toBe('age_dob');
  });

  test('detects email', () => {
    expect(classifyPII('email').isPii).toBe(true);
    expect(classifyPII('em_addr').isPii).toBe(true);
    expect(classifyPII('emailAddress').isPii).toBe(true);
  });

  test('detects phone variants', () => {
    expect(classifyPII('phone').isPii).toBe(true);
    expect(classifyPII('mobile').isPii).toBe(true);
    expect(classifyPII('cellphone').isPii).toBe(true);
    expect(classifyPII('caller_phn').isPii).toBe(true);
  });

  test('detects address variants', () => {
    expect(classifyPII('address').isPii).toBe(true);
    expect(classifyPII('addr').isPii).toBe(true);
    expect(classifyPII('mailing_addr').isPii).toBe(true);
    expect(classifyPII('addressline1').isPii).toBe(true);
  });

  test('detects medical PHI', () => {
    expect(classifyPII('diagnosis').isPii).toBe(true);
    expect(classifyPII('hipaa').isPii).toBe(true);
  });
});

describe('classifyPII — P2.39 regex false positives fixed', () => {
  test('business_name is NOT PII (allow-list wins)', () => {
    const r = classifyPII('business_name');
    expect(r.isPii).toBe(false);
    expect(r.allowedBy).toBe('business');
    // But the original regex would refuse it
    expect(PII_DENY_REGEX.test('business_name')).toBe(true);
  });

  test('company_name is NOT PII', () => {
    expect(classifyPII('company_name').isPii).toBe(false);
  });

  test('product_name is NOT PII', () => {
    expect(classifyPII('product_name').isPii).toBe(false);
  });

  test('peril_name is NOT PII', () => {
    expect(classifyPII('peril_name').isPii).toBe(false);
  });

  test('event_name is NOT PII', () => {
    expect(classifyPII('event_name').isPii).toBe(false);
  });
});

describe('classifyPII — P2.39 regex false negatives fixed', () => {
  test('cust_ssn_hash IS PII', () => {
    const r = classifyPII('cust_ssn_hash');
    expect(r.isPii).toBe(true);
    expect(r.matchedToken).toBe('ssn');
  });

  test('dt_birth IS PII', () => {
    expect(classifyPII('dt_birth').isPii).toBe(true);
  });

  test('caller_id_phn IS PII', () => {
    const r = classifyPII('caller_id_phn');
    expect(r.isPii).toBe(true);
    // matches `phn` from the contact dictionary
    expect(r.matchedToken).toBe('phn');
  });

  test('passport_no IS PII', () => {
    expect(classifyPII('passport_no').isPii).toBe(true);
  });

  test('credit_card IS PII', () => {
    expect(classifyPII('credit_card').isPii).toBe(true);
  });
});

describe('classifyPII — benign columns', () => {
  test('common book columns are NOT PII', () => {
    // FORGE-specific: state / zip3 / city / country are NOT in the
    // PII dictionary because they describe the POLICY's location, not
    // a customer's mailing address. The classifier accepts them as
    // standard book columns.
    for (const col of [
      'policy_id',
      'tiv',
      'lat',
      'lon',
      'build_type',
      'zip3',
      'state',
      'city',
      'country',
      'premium_annual',
      'flood_zone',
      'elevation_m',
      'cohort_id',
      'effective_date',
    ]) {
      const r = classifyPII(col);
      expect(r.isPii).toBe(false);
    }
  });
});

describe('isPII (backward compat with csv.ts)', () => {
  test('isPII delegates to the new classifier', () => {
    expect(isPII('ssn')).toBe(true);
    expect(isPII('business_name')).toBe(false);     // newly fixed
    expect(isPII('cust_ssn_hash')).toBe(true);      // newly fixed
  });

  test('isPIIColumnName returns the same answer as isPII', () => {
    for (const col of ['ssn', 'business_name', 'cust_ssn_hash', 'policy_id']) {
      expect(isPIIColumnName(col)).toBe(isPII(col));
    }
  });

  test('PII_DENY_REGEX is still exported for backward compat', () => {
    expect(PII_DENY_REGEX).toBeInstanceOf(RegExp);
  });
});

describe('classifyPII — rationale surfaced for audit', () => {
  test('matchedToken + category surfaced for PII columns', () => {
    const r = classifyPII('cust_ssn_hash');
    expect(r.matchedToken).toBe('ssn');
    expect(r.category).toBe('id');
    expect(r.tokens).toEqual(['cust', 'ssn', 'hash']);
  });

  test('allowedBy surfaced for allow-listed columns', () => {
    const r = classifyPII('business_name');
    expect(r.matchedToken).toBe('name');
    expect(r.category).toBe('name');
    expect(r.allowedBy).toBe('business');
  });

  test('non-PII columns get all-null rationale fields', () => {
    const r = classifyPII('tiv');
    expect(r.matchedToken).toBeNull();
    expect(r.category).toBeNull();
    expect(r.allowedBy).toBeNull();
  });
});
