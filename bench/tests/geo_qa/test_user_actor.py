"""geo_qa user_actor — deterministic gate-response actor for the gated drill-down pattern.

The bench's "user" in Pattern E is a script, not an LLM. It reads
from a fixed answer list keyed by gate-type. Re-runs are bit-for-bit
reproducible.
"""

from agent_cost_bench.geo_qa.user_actor import UserActor


def test_actor_yields_each_gate_answer_in_order():
    actor = UserActor.frozen_default()
    # Gate 1: datetime confirm
    a = actor.respond("datetime", agent_prompt="Confirm: 2020-06-01 to 2020-11-01?")
    assert a == "yes, that's correct"
    # Gate 2: state
    a = actor.respond("state", agent_prompt="What state should I analyze?")
    assert a == "California"
    # Gate 3: county
    a = actor.respond("county", agent_prompt="Which county?")
    assert a == "Mendocino County"
    # Gate 4: dataset (literal VEDA STAC collection id)
    a = actor.respond("dataset", agent_prompt="Which dataset?")
    assert a == "lis-global-da-gpp"
    # Gate 5: variable
    a = actor.respond("variable", agent_prompt="Which variable?")
    assert a == "cog_default"


def test_actor_raises_on_unknown_gate():
    actor = UserActor.frozen_default()
    try:
        actor.respond("unknown_gate", agent_prompt="x")
        assert False, "expected KeyError"
    except KeyError:
        pass
