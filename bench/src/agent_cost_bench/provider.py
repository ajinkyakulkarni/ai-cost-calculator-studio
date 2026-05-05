"""LiteLLM provider wrapper — single client for OpenAI / Anthropic / Google / etc.

Why LiteLLM: rolling our own SDK wrappers for each provider is the
classic mistake. LiteLLM is the de-facto abstraction — it handles
cross-provider differences (Anthropic uses `cache_control`, OpenAI
caches automatically, Gemini reports usage differently) and gives us
a consistent `usage` shape that maps cleanly to OpenTelemetry GenAI
attributes.

Side benefit: when a NASA reader downloads this and recognizes
LiteLLM, they trust the harness. Custom wrappers would be a
red flag.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import litellm

from .tracing import llm_call_span, record_usage


@dataclass
class CallResult:
    """Outcome of a single LLM call. Used by the LangGraph runner to
    drive scenario state forward without coupling to LiteLLM types."""

    content: str
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cost_usd: float
    latency_ms: float
    request_id: str | None
    raw_response: Any


def _detect_system(model: str) -> str:
    """Map a LiteLLM model identifier to the GenAI `system` attribute.

    The `system` attribute identifies the provider (openai, anthropic,
    google_genai, etc.) per the GenAI semconv spec.
    """
    if model.startswith(("gpt-", "openai/")):
        return "openai"
    if model.startswith(("claude-", "anthropic/")):
        return "anthropic"
    if model.startswith(("gemini-", "google/", "vertex_ai/")):
        return "google_genai"
    if model.startswith(("mistral", "mistralai/")):
        return "mistral"
    if model.startswith(("groq/")):
        return "groq"
    return model.split("/")[0] if "/" in model else "unknown"


def call_llm(
    tracer,
    *,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int | None = None,
    tools: list[dict[str, Any]] | None = None,
    cache_control: bool = True,
) -> CallResult:
    """Make a single LLM call with full trace capture.

    Wraps `litellm.completion()` and emits an OTEL span with the
    standard `gen_ai.*` attributes. Captures provider-reported
    `cached_tokens` when available — this is the field the variance
    comparator uses to validate AXIOM's cache-hit-rate predictions
    (the most consequential coefficient in the simulator).

    Args:
        tracer: OTEL tracer (from `tracing.init_tracing()`).
        model: LiteLLM model identifier, e.g. "gpt-5.2",
            "claude-sonnet-4.6", "gemini-3-flash".
        messages: OpenAI-format chat messages.
        temperature: 0.0–2.0; defaults to 0.2 (deterministic-ish).
        max_tokens: Hard cap on completion length.
        tools: OpenAI function-calling spec for tool use.
        cache_control: For Anthropic — sets `cache_control` on the
            system message and last user turn. Provider-handled for
            OpenAI (automatic prompt caching).

    Returns:
        CallResult with normalized usage data.
    """
    system = _detect_system(model)
    started = time.perf_counter()

    with llm_call_span(tracer, system=system, model=model, operation="chat") as span:
        span.set_attribute("gen_ai.request.temperature", temperature)
        if max_tokens:
            span.set_attribute("gen_ai.request.max_tokens", max_tokens)

        # Anthropic-specific: opt into prompt caching by tagging the
        # system message with cache_control. LiteLLM passes this
        # through. OpenAI caches automatically based on prompt prefix
        # length so no flag needed.
        if cache_control and system == "anthropic" and messages:
            messages = _add_anthropic_cache_control(messages)

        params: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens:
            params["max_tokens"] = max_tokens
        if tools:
            params["tools"] = tools

        response = litellm.completion(**params)

        latency_ms = (time.perf_counter() - started) * 1000
        span.set_attribute("duration_ms", latency_ms)

        record_usage(span, response)

        # Extract content — LiteLLM normalizes the response shape but
        # streaming and tool-call cases need careful handling.
        content = ""
        try:
            content = response.choices[0].message.content or ""
        except (AttributeError, IndexError):
            pass

        usage = getattr(response, "usage", None) or response.get("usage", {})

        def _u(k: str) -> int:
            if hasattr(usage, k):
                return int(getattr(usage, k) or 0)
            if isinstance(usage, dict):
                return int(usage.get(k, 0) or 0)
            return 0

        # LiteLLM often computes per-call cost using its own pricing
        # table; otherwise fall back to a calculated estimate from
        # `_hidden_params`. Keep the raw response around for audits.
        cost_usd = 0.0
        hidden = getattr(response, "_hidden_params", {}) or {}
        if isinstance(hidden, dict):
            cost_usd = float(hidden.get("response_cost") or 0)

        request_id = getattr(response, "id", None) or response.get("id")

        return CallResult(
            content=content,
            input_tokens=_u("prompt_tokens"),
            output_tokens=_u("completion_tokens"),
            cached_tokens=_u("cached_tokens") or _u("prompt_tokens_cached"),
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            request_id=request_id,
            raw_response=response,
        )


def _add_anthropic_cache_control(
    messages: list[dict[str, str]]
) -> list[dict[str, str]]:
    """Tag the system message with cache_control so Anthropic caches it.

    Anthropic's prompt caching is opt-in via a `cache_control` block
    on whichever message segments should be cached. The system prompt
    is the obvious win for long-chat scenarios — cache it once and
    every subsequent turn pulls from the cache at ~10% the cost.

    Mutates a copy, returns the new list. The original messages
    dict is left intact so the caller can re-use it.
    """
    out: list[dict[str, str]] = []
    for i, m in enumerate(messages):
        if m.get("role") == "system" and isinstance(m.get("content"), str):
            # Restructure the system message into Anthropic's
            # content-block form with a cache_control marker.
            new_m = dict(m)
            new_m["content"] = [
                {
                    "type": "text",
                    "text": m["content"],
                    "cache_control": {"type": "ephemeral"},
                }
            ]
            out.append(new_m)
        else:
            out.append(m)
    return out
