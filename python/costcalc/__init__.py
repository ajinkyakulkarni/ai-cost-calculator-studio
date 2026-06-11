"""costcalc — Python port of the AI Cost Calculator engine.

Usage:
    from costcalc import compute
    result = compute(workload_dict, opts_dict)
"""
from .engine import compute

__version__ = "1.0.0"
__all__ = ["compute", "__version__"]
