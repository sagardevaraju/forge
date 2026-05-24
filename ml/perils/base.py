"""Task P3.13 — Peril plug-in ABC for multi-peril scenario generation.

Until Phase 3, every Monte-Carlo scenario in FORGE was a hurricane track
produced by :func:`ml.scenarios.generate.generate_scenarios`. Phase 3
expands the system to other peril families: severe convective storm
(P3.14), wildfire (P3.15), earthquake (P3.16), and freeze (P3.17). The
``Peril`` ABC defines the common contract so downstream consumers (the
MIP precompute, the reconciler, the agent tools) can treat every peril
uniformly instead of switching on ``kind``.

Contract
--------
- ``peril_id`` is the stable string id matching
  :pyfile:`lib/sim/severity.ts` ``PERILS`` and the DB
  ``simulations.peril`` column. ``hurricane`` is the only id with a
  real-storm track flow today; ``hail`` / ``wildfire`` / ``earthquake``
  / ``winter`` / ``flood`` / ``tornado`` are the operator-drawn
  footprint ids that get Monte-Carlo scenario draws here when invoked
  from the precompute pipeline.
- ``generate_scenarios(scenario_id, n, **kwargs) -> list[dict]`` returns
  ``n`` scenarios whose probability weights sum to 1. Every scenario
  carries ``kind``, ``id``, and ``prob`` at minimum; the rest is
  peril-specific (path/surge_grid for hurricane, swath polygons for SCS,
  burn perimeters for wildfire, …).

The ABC is data-light by design — the heavy generation machinery still
lives under ``ml/scenarios/`` and the per-peril modules
``ml/perils/{hurricane,scs,wildfire,eq,freeze}.py``. Importing the
``ml.perils`` package populates the registry.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class Peril(ABC):
    """A Monte-Carlo scenario producer for one peril family.

    Subclasses MUST set the ``peril_id`` class attribute to a stable string
    matching ``lib/sim/severity.ts`` PERILS and the DB ``simulations.peril``
    column, and MUST implement :meth:`generate_scenarios`. The ABC is
    intentionally light — peril-specific data sources, calibration
    constants, and damage-curve metadata live on the subclass.
    """

    #: Stable id matching ``lib/sim/severity.ts`` PERILS / DB ``simulations.peril``.
    peril_id: str = ""

    @abstractmethod
    def generate_scenarios(
        self,
        scenario_id: str,
        n: int = 1000,
        **kwargs: Any,
    ) -> list[dict]:
        """Produce ``n`` Monte-Carlo scenarios for this peril.

        Parameters
        ----------
        scenario_id:
            Opaque identifier (e.g. ``"AL092024"`` for hurricane,
            ``"SCS_2026_06_15"`` for SCS). Used as the RNG seed so the
            same ``scenario_id`` produces bit-identical output.
        n:
            Number of perturbed scenarios. Defaults to 1000 (the
            project-wide K used by the MIP).
        **kwargs:
            Peril-specific kwargs (e.g. ``ensemble``, ``regime``,
            ``correlation``, ``importance_buckets`` for hurricane).
            Subclasses document their own supported set.

        Returns
        -------
        list[dict]
            Each scenario dict contains at minimum:

            - ``kind``: this peril's :attr:`peril_id`
            - ``id``: a unique scenario id (typically
              ``f"{scenario_id}_{i:04d}"``)
            - ``prob``: probability weight, summing to 1 across all ``n``
              scenarios

            Subclasses add peril-specific fields (e.g. ``path``,
            ``peak_wind``, ``surge_grid`` for hurricane; ``geometry``,
            ``severity`` for SCS / wildfire / etc.).
        """
        raise NotImplementedError


# ── registry ───────────────────────────────────────────────────────────────

_PERIL_REGISTRY: dict[str, Peril] = {}


def register_peril(peril: Peril) -> Peril:
    """Register a :class:`Peril` instance so it can be looked up by id.

    Idempotent — registering the same id twice replaces the previous
    entry (useful for tests). Returns the registered instance so it can
    be used inline at module load. Refuses to register an instance whose
    ``peril_id`` is empty.
    """
    if not peril.peril_id:
        raise ValueError(
            f"Peril subclass {type(peril).__name__} must set peril_id "
            "(stable string matching lib/sim/severity.ts PERILS)."
        )
    _PERIL_REGISTRY[peril.peril_id] = peril
    return peril


def get_peril(peril_id: str) -> Peril:
    """Look up a registered :class:`Peril` by id.

    Raises
    ------
    KeyError
        If ``peril_id`` is not registered. The error message lists all
        currently-registered peril ids so the caller can fix the typo.
    """
    if peril_id not in _PERIL_REGISTRY:
        raise KeyError(
            f"Unknown peril '{peril_id}'. Registered perils: "
            f"{sorted(_PERIL_REGISTRY)}"
        )
    return _PERIL_REGISTRY[peril_id]


def registered_perils() -> list[str]:
    """List all registered peril ids in deterministic (sorted) order."""
    return sorted(_PERIL_REGISTRY)


__all__ = [
    "Peril",
    "register_peril",
    "get_peril",
    "registered_perils",
]
