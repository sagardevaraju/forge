"""Task P3.13 — multi-peril plug-in package.

Importing :mod:`ml.perils` populates the global registry with every
peril subclass shipped in the package. Today that is just
:class:`HurricanePeril` (the ABC wrapper around the Phase-2 Monte-Carlo
hurricane generator); P3.14-P3.17 add SCS / wildfire / EQ / freeze.

Lookup pattern::

    from ml.perils import get_peril

    scs = get_peril("hurricane").generate_scenarios("AL092024", n=1000)
"""

from ml.perils.base import (
    Peril,
    get_peril,
    register_peril,
    registered_perils,
)
from ml.perils.eq import EQPeril
from ml.perils.freeze import FreezePeril
from ml.perils.hurricane import HurricanePeril
from ml.perils.scs import SCSPeril
from ml.perils.wildfire import WildfirePeril

__all__ = [
    "Peril",
    "register_peril",
    "get_peril",
    "registered_perils",
    "HurricanePeril",
    "SCSPeril",
    "WildfirePeril",
    "EQPeril",
    "FreezePeril",
]
