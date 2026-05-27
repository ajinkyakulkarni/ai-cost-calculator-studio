"""Thin shim — wraps LiteLLM in a uniform shape for the bench's needs.

Production code paths in this bench use `call_llm` so tests can patch
this single module without monkey-patching litellm internals.
"""

from __future__ import annotations

from typing import Any


def _to_openai_dicts(messages: list[Any]) -> list[dict[str, Any]]:
    """Convert a list that may contain LangChain BaseMessage objects to plain
    OpenAI-format dicts.  Messages that are already dicts pass through
    unchanged so stub-based tests continue to work without modification.

    LiteLLM's validate_and_fix_openai_messages calls ``message.get("role")``
    which raises AttributeError on LangChain Pydantic message objects.  This
    helper normalises the list before it reaches LiteLLM.
    """
    from langchain_core.messages import (
        BaseMessage,
        SystemMessage,
        HumanMessage,
        AIMessage,
        ToolMessage,
    )

    result: list[dict[str, Any]] = []
    for msg in messages:
        if isinstance(msg, dict):
            result.append(msg)
            continue
        if not isinstance(msg, BaseMessage):
            # Unexpected type — best-effort, pass through and let LiteLLM
            # surface a meaningful error if it can't handle it.
            result.append(msg)  # type: ignore[arg-type]
            continue

        if isinstance(msg, SystemMessage):
            result.append({"role": "system", "content": msg.content})
        elif isinstance(msg, HumanMessage):
            result.append({"role": "user", "content": msg.content})
        elif isinstance(msg, AIMessage):
            out: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
            # AIMessage.tool_calls is a list of dicts with keys
            # id / name / args / type when populated via LangGraph.
            if msg.tool_calls:
                import json

                out["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": (
                                json.dumps(tc["args"])
                                if isinstance(tc.get("args"), dict)
                                else tc.get("args", "")
                            ),
                        },
                    }
                    for tc in msg.tool_calls
                ]
            result.append(out)
        elif isinstance(msg, ToolMessage):
            result.append(
                {
                    "role": "tool",
                    "content": msg.content,
                    "tool_call_id": msg.tool_call_id,
                }
            )
        else:
            # Fallback for any other BaseMessage subtype (e.g. FunctionMessage).
            role = getattr(msg, "type", "user")
            result.append({"role": role, "content": msg.content})

    return result


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
        messages=_to_openai_dicts(messages),
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
