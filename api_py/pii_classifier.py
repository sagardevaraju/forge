"""Task P3.28a — Presidio-backed PII classifier (optional Python dep).

Wraps Microsoft Presidio (https://microsoft.github.io/presidio/) for
value-level PII detection on uploaded CSV columns. Gracefully falls
back to a name-only check (parity with the TypeScript classifier in
lib/book/pii_classifier.ts) when Presidio isn't installed — the ~100MB
spaCy model + presidio-analyzer install is opt-in for ingestion teams
that want value-level detection.

Install (optional):

    pip install presidio-analyzer
    python -m spacy download en_core_web_lg

The Next.js route at app/api/book/check-pii/route.ts spawns this module
via the same stdin/stdout shim used by the other api_py utilities.

Request shape::

    {
        "values": [str, ...],     # sample column values to scan
        "name": str                # column name (always classified)
    }

Response shape::

    {
        "name_is_pii": bool,           # name-level classification
        "value_pii_detected": bool,    # any value contains PII (Presidio only)
        "value_entities": [str, ...],  # Presidio entity types (e.g. ['PERSON', 'EMAIL_ADDRESS'])
        "backend": "presidio" | "name_only",
        "sample_size": int
    }

When Presidio isn't installed, ``value_pii_detected`` is always False
and ``value_entities`` is empty; ``backend == "name_only"`` signals
the degraded mode.
"""

from __future__ import annotations

from typing import Any

# Hard-coded name-only deny list — mirrors the TypeScript classifier
# in lib/book/pii_classifier.ts at a coarser grain (full-word regex
# rather than the dictionary + allow-list pattern). The full
# tokenisation lives in TS; here we only check name as a safety net
# when Presidio isn't available.
import re

# Custom word boundary that treats `_`, `-`, `.`, and case-transitions
# as separators, mirroring the TS tokenizer (which splits camelCase too).
# We sidestep \b (which treats `_` as a word character) by tokenising
# on the same boundaries the TS classifier uses.

_PII_KEYWORDS: set[str] = {
    # name (excluded: `state`/`zip`/`city`/`country` — see TS classifier)
    "ssn", "sin", "tin", "ein", "itin",
    "name", "firstname", "lastname", "surname", "fname", "lname",
    "fullname", "mn", "fn", "ln", "nm",
    # address
    "address", "addr", "addrs", "street",
    "postal", "postcode",
    "apt", "unit", "suite", "addressline",
    "mailing", "billing", "shipping",
    # contact
    "phone", "phn", "tel", "telephone", "mobile", "cell",
    "cellphone", "fax", "email", "em", "mail", "emailaddress",
    # id
    "passport", "license", "nationalid", "governmentid", "govid",
    "driverslicense", "driverlicense",
    # financial
    "creditcard", "credit", "cc", "ccnum", "ccnumber", "cardnumber",
    "bankaccount", "iban", "swift", "routingnumber",
    # age / dob
    "dob", "birth", "birthdate", "birthday", "dateofbirth",
    # medical
    "medical", "health", "diagnosis", "hipaa",
}

_ALLOW_KEYWORDS: set[str] = {
    "business", "company", "organization", "org", "entity",
    "product", "policy", "plan", "role", "job", "title",
    "department", "team", "group", "category", "type", "class",
    "event", "incident", "claim", "station", "storm", "peril",
    "tag", "code", "segment", "cluster", "cohort", "risk", "rate",
}


def _tokenize(name: str) -> list[str]:
    """Mirror of lib/book/pii_classifier.ts::tokenize.

    Splits on _ - . / whitespace and camelCase boundaries; strips
    trailing digits on generic tokens. Lowercases everything.
    """
    if not name:
        return []
    # camelCase boundary insertion
    s = re.sub(r"([a-z])([A-Z])", r"\1_\2", name)
    parts = [p for p in re.split(r"[\s_\-./]+", s.lower()) if p]
    out: list[str] = []
    for t in parts:
        if re.match(r"^(st|addressline|address)\d$", t):
            out.append(t)
        else:
            stripped = re.sub(r"\d+$", "", t)
            if stripped:
                out.append(stripped)
    return out


def _name_is_pii(name: str) -> bool:
    tokens = _tokenize(name)
    if not tokens:
        return False
    has_pii = any(t in _PII_KEYWORDS for t in tokens)
    if not has_pii:
        return False
    # Allow-list suppresses the PII flag.
    return not any(t in _ALLOW_KEYWORDS for t in tokens)


def _load_presidio():
    """Try to load presidio-analyzer + spaCy. Returns the configured
    analyzer or None when not installed. Cached at module level on
    first successful load.
    """
    global _PRESIDIO_ANALYZER
    try:
        return _PRESIDIO_ANALYZER  # type: ignore[name-defined]
    except NameError:
        pass
    try:
        from presidio_analyzer import AnalyzerEngine  # type: ignore[import-untyped]
    except Exception:
        _PRESIDIO_ANALYZER = None  # type: ignore[assignment]
        return None
    try:
        _PRESIDIO_ANALYZER = AnalyzerEngine()  # type: ignore[assignment]
        return _PRESIDIO_ANALYZER
    except Exception:
        # Presidio installed but spaCy model missing — degrade
        # gracefully.
        _PRESIDIO_ANALYZER = None  # type: ignore[assignment]
        return None


def classify(name: str, values: list[str] | None = None) -> dict[str, Any]:
    """Classify a CSV column by name + (optional) values.

    Always runs the name-only check. When Presidio is installed AND
    `values` is non-empty, additionally runs Presidio over the first
    100 values and reports any detected entity types.
    """
    name_pii = _name_is_pii(name)

    analyzer = _load_presidio()
    if analyzer is None or not values:
        return {
            "name_is_pii": name_pii,
            "value_pii_detected": False,
            "value_entities": [],
            "backend": "name_only" if analyzer is None else "presidio",
            "sample_size": len(values) if values else 0,
        }

    # Run Presidio on a bounded sample so the route stays fast.
    sample = values[:100]
    detected_entities: set[str] = set()
    for v in sample:
        if not v:
            continue
        try:
            results = analyzer.analyze(text=str(v), language="en")
        except Exception:
            continue
        for r in results:
            # Presidio returns a list of RecognizerResult objects with
            # .entity_type, .score, .start, .end. We surface the type
            # names only; the actual matched substrings stay on the
            # server (PII by definition — never log).
            if r.score >= 0.5:
                detected_entities.add(r.entity_type)

    return {
        "name_is_pii": name_pii,
        "value_pii_detected": len(detected_entities) > 0,
        "value_entities": sorted(detected_entities),
        "backend": "presidio",
        "sample_size": len(sample),
    }


__all__ = ["classify"]
