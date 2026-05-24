"""Task P3.13 — HurricanePeril wraps the existing scenario generator.

The Phase-2 Monte-Carlo flow lives in :func:`ml.scenarios.generate.generate_scenarios`
(perturbed Cat-4 demo track + optional GEFS ensemble resampling). This
module exposes that flow through the :class:`ml.perils.base.Peril` ABC so
the precompute pipeline can treat hurricane, SCS (P3.14), wildfire
(P3.15), EQ (P3.16), and freeze (P3.17) uniformly.

The wrapped function is unchanged — every existing test continues to
exercise :func:`ml.scenarios.generate.generate_scenarios` directly. This
wrapper just dispatches and tags ``kind = "hurricane"`` on the output.
"""

from __future__ import annotations

from typing import Any

from ml.perils.base import Peril, register_peril
from ml.scenarios.generate import generate_scenarios as _legacy_generate


class HurricanePeril(Peril):
    """Hurricane peril — wraps :mod:`ml.scenarios.generate`.

    Forwarded kwargs:

    - ``seed_track``: optional 21-point custom track.
    - ``regime``: optional AMO/ENSO regime metadata (P2.3 plumbing).
    - ``ensemble``: optional GEFS member list to resample from (P2.38).
    - ``correlation``: optional ``{"beta", "sigma"}`` metadata (P2.4).
    - ``importance_buckets``: optional stratified IS draws (P2.5).
    - ``hurdat2_path``: optional HURDAT2 parquet cache (P2.10).
    """

    peril_id = "hurricane"

    def generate_scenarios(
        self,
        scenario_id: str,
        n: int = 1000,
        **kwargs: Any,
    ) -> list[dict]:
        # Legacy function takes ``storm_id`` as its first positional;
        # accept the ABC's ``scenario_id`` name and forward.
        scs = _legacy_generate(storm_id=scenario_id, n=n, **kwargs)
        # ``generate_scenarios`` already sets ``kind = "hurricane"``, but
        # belt-and-braces — a future refactor of the legacy fn shouldn't
        # silently break the ABC contract.
        for s in scs:
            s.setdefault("kind", self.peril_id)
        return scs


# Register on import so ``import ml.perils`` populates the registry.
register_peril(HurricanePeril())


__all__ = ["HurricanePeril"]
