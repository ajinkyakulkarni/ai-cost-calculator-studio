"""costcalc — Python port of the AI Cost Calculator engine.

Usage:
    from costcalc import compute
    result = compute(workload_dict, opts_dict)
"""
from .engine import compute
from .archetype import archetype_cost

__version__ = "1.0.0"
__all__ = ["compute", "archetype_cost", "__version__"]
