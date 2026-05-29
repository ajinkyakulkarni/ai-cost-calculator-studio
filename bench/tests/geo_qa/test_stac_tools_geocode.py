"""geocode — county-bbox lookup, no API."""

import pytest
from agent_cost_bench.geo_qa.stac_tools import geocode
from agent_cost_bench.geo_qa.schemas import GeocodeReturn


def test_geocode_known_county():
    r = geocode("Mendocino County", "county")
    assert isinstance(r, GeocodeReturn)
    assert r.admin_name == "Mendocino County"
    assert r.admin_level == "county"
    assert -125 < r.bbox[0] < -120  # western longitude reasonable for CA
    assert 38 < r.bbox[1] < 41


def test_geocode_case_insensitive():
    r = geocode("mendocino county", "county")
    assert r.admin_name.lower().startswith("mendocino")


def test_geocode_unknown_county_raises():
    with pytest.raises(KeyError):
        geocode("Atlantis County", "county")


def test_geocode_accepts_full_state_name():
    r = geocode("Mendocino County, California", "county")
    assert r.admin_name == "Mendocino County"
    assert -125 < r.bbox[0] < -120


def test_geocode_accepts_two_letter_state_code():
    r = geocode("Mendocino County, CA", "county")
    assert r.admin_name == "Mendocino County"


def test_geocode_accepts_bare_county_name():
    r = geocode("Sonoma", "county")
    assert r.admin_name == "Sonoma County"


def test_geocode_strips_country_suffix():
    r = geocode("Mendocino County, California, USA", "county")
    assert r.admin_name == "Mendocino County"


def test_geocode_strips_periods_in_country_abbrev():
    r = geocode("Mendocino, U.S.A.", "county")
    assert r.admin_name == "Mendocino County"
