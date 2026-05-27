"""Tool dispatch — given (tool_name, args, handler), route to the
right veda_tools function and wrap the return through the handler.
"""

import json
from agent_cost_bench.eie.dispatch import dispatch_tool_call
from agent_cost_bench.eie.handlers import StatusOnlyHandler, KeyFieldsHandler, FreeformHandler


def test_dispatch_parse_datetime_status_mode():
    h = StatusOnlyHandler()
    out = dispatch_tool_call("parse_datetime", {"value": "2020-06-01 to 2020-11-01"}, h, "tc_001")
    parsed = json.loads(out)
    assert parsed["ok"] is True
    assert "2020-06-01" in parsed["summary"]
    assert "2020-11-01" in parsed["summary"]


def test_dispatch_geocode_key_fields_mode():
    h = KeyFieldsHandler()
    out = dispatch_tool_call("geocode", {"query": "Mendocino County", "level": "county"}, h, "tc_002")
    parsed = json.loads(out)
    assert parsed["admin_name"] == "Mendocino County"
    assert "bbox" in parsed
