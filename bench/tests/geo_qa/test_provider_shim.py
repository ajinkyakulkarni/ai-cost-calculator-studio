"""Tests for provider_shim.py — specifically the LangChain→dict message conversion.

The live bug: LiteLLM's validate_and_fix_openai_messages calls message.get("role")
which fails on LangChain Pydantic message objects. The shim must normalise them
to plain dicts before forwarding to litellm.completion.
"""

from __future__ import annotations

from langchain_core.messages import (
    SystemMessage,
    HumanMessage,
    AIMessage,
    ToolMessage,
)

from agent_cost_bench.geo_qa.provider_shim import _to_openai_dicts


# ---------------------------------------------------------------------------
# _to_openai_dicts
# ---------------------------------------------------------------------------

def test_passthrough_plain_dicts():
    """Dicts already in OpenAI format must come through unchanged."""
    msgs = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hi"},
    ]
    result = _to_openai_dicts(msgs)
    assert result == msgs


def test_system_message_conversion():
    msg = SystemMessage(content="You are a helpful assistant.")
    (out,) = _to_openai_dicts([msg])
    assert out["role"] == "system"
    assert out["content"] == "You are a helpful assistant."


def test_human_message_conversion():
    msg = HumanMessage(content="What is the status?")
    (out,) = _to_openai_dicts([msg])
    assert out["role"] == "user"
    assert out["content"] == "What is the status?"


def test_ai_message_no_tool_calls():
    msg = AIMessage(content="Here is my answer.")
    (out,) = _to_openai_dicts([msg])
    assert out["role"] == "assistant"
    assert out["content"] == "Here is my answer."
    assert "tool_calls" not in out or not out["tool_calls"]


def test_ai_message_with_tool_calls():
    """AIMessage tool_calls must be forwarded in OpenAI tool_calls shape."""

    msg = AIMessage(content="", tool_calls=[
        {"id": "tc-abc", "name": "geocode", "args": {"query": "CA"}, "type": "tool_call"}
    ])
    (out,) = _to_openai_dicts([msg])
    assert out["role"] == "assistant"
    assert isinstance(out.get("tool_calls"), list)
    assert len(out["tool_calls"]) == 1
    tc = out["tool_calls"][0]
    assert tc["id"] == "tc-abc"
    assert tc["function"]["name"] == "geocode"


def test_tool_message_conversion():
    msg = ToolMessage(content='{"status": "ok"}', tool_call_id="tc-abc")
    (out,) = _to_openai_dicts([msg])
    assert out["role"] == "tool"
    assert out["content"] == '{"status": "ok"}'
    assert out["tool_call_id"] == "tc-abc"


def test_mixed_list_conversion():
    """A realistic multi-turn conversation with mixed types."""

    msgs = [
        SystemMessage(content="sys"),
        HumanMessage(content="hello"),
        AIMessage(content="", tool_calls=[
            {"id": "tc-1", "name": "geocode", "args": {"query": "CA"}, "type": "tool_call"}
        ]),
        ToolMessage(content="result", tool_call_id="tc-1"),
        {"role": "assistant", "content": "final"},  # plain dict passes through
    ]
    result = _to_openai_dicts(msgs)
    assert len(result) == 5
    assert all(isinstance(m, dict) for m in result)
    assert result[0] == {"role": "system", "content": "sys"}
    assert result[1] == {"role": "user", "content": "hello"}
    assert result[2]["role"] == "assistant"
    assert result[2]["tool_calls"][0]["id"] == "tc-1"
    assert result[3]["role"] == "tool"
    assert result[3]["tool_call_id"] == "tc-1"
    assert result[4] == {"role": "assistant", "content": "final"}
