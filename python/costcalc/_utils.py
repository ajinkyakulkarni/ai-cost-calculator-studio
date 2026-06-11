"""_utils.py — tiny shared helpers for the costcalc package."""
import math
from typing import Any


def to_float(x: Any, default: float = 0.0) -> float:
    """Coerce x to a finite float; absent/None/non-numeric/non-finite -> default.

    NOTE: an explicit 0 passes through (Python None-semantics). Where the JS
    source uses `Number(x) || d` (0 is falsy there), call sites must write
    `to_float(x, 0.0) or d` to match — see agents.py fewshot handling.
    """
    if x is None:
        return default
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default
