"""parse_datetime — local NLP, no API call."""

from agent_cost_bench.geo_qa.veda_tools import parse_datetime
from agent_cost_bench.geo_qa.schemas import ParseDatetimeReturn


def test_parse_explicit_range():
    r = parse_datetime("2020-06-01 to 2020-11-01")
    assert isinstance(r, ParseDatetimeReturn)
    assert r.start == "2020-06-01"
    assert r.end == "2020-11-01"


def test_parse_natural_year():
    r = parse_datetime("June 2020 through November 2020")
    # Allow some leeway: must be 2020 and span June-November.
    assert r.start.startswith("2020-06")
    assert r.end.startswith("2020-11")


def test_parse_single_date_returns_same_start_end():
    r = parse_datetime("2020-06-01")
    assert r.start == "2020-06-01"
    assert r.end == "2020-06-01"


def test_parse_iso_interval_slash_separated():
    r = parse_datetime("2020-08-01/2020-10-31")
    assert r.start == "2020-08-01"
    assert r.end == "2020-10-31"
