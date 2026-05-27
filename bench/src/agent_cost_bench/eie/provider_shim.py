"""Thin shim — wraps LiteLLM in a uniform shape for the bench's needs.

Production code paths in this bench use `call_llm` so tests can patch
this single module without monkey-patching litellm internals.
"""

from __future__ import annotations

from typing import Any


def call_llm(
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    temperature: float = 0.0,
) -> dict[str, Any]:
    """Issue one LLM call with tool schemas; return the assistant message dict."""
    import litellm  # late import keeps test isolation tighter

    response = litellm.completion(
        model=model,
        messages=messages,
        tools=tools,
        temperature=temperature,
    )
    choice = response.choices[0]
    msg = choice.message
    out: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
    if msg.tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in msg.tool_calls
        ]
    out["_usage"] = (
        response.usage.model_dump()
        if hasattr(response, "usage") and response.usage
        else {}
    )
    return out
