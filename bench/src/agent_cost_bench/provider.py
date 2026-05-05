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
    drive scenario state forward without coupling to LiteLLM types.

    Streaming-specific fields (time_to_first_token_ms, output_rate_tps)
    are populated only when stream=True. Non-streaming calls leave
    them at zero. This shape lets the variance comparator validate
    AXIOM's currently-unmodeled streaming overhead coefficient."""

    content: str
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cost_usd: float
    latency_ms: float
    request_id: str | None
    raw_response: Any
    streamed: bool = False
    time_to_first_token_ms: float = 0.0
    output_rate_tps: float = 0.0  # tokens per second (streaming only)


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
    stream: bool = False,
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
        if stream:
            params["stream"] = True
            # Ask the provider to include usage data on the final
            # streaming chunk (OpenAI behavior — Anthropic always
            # streams it). LiteLLM normalizes this where supported.
            params["stream_options"] = {"include_usage": True}

        if not stream:
            response = litellm.completion(**params)
            latency_ms = (time.perf_counter() - started) * 1000
            span.set_attribute("duration_ms", latency_ms)
            record_usage(span, response)
            content = ""
            try:
                content = response.choices[0].message.content or ""
            except (AttributeError, IndexError):
                pass
            cost_usd = _extract_cost(response)
            request_id = getattr(response, "id", None) or response.get("id")
            return CallResult(
                content=content,
                input_tokens=_usage_field(response, "prompt_tokens"),
                output_tokens=_usage_field(response, "completion_tokens"),
                cached_tokens=_usage_field(response, "cached_tokens")
                or _usage_field(response, "prompt_tokens_cached"),
                cost_usd=cost_usd,
                latency_ms=latency_ms,
                request_id=request_id,
                raw_response=response,
            )

        # ---- Streaming path ----
        # Time-to-first-token (TTFT) and output rate are the latency
        # metrics that matter in production agent UX. Capture both.
        # The provider only sends `usage` on the final chunk (when
        # stream_options.include_usage is set), so we accumulate
        # delta content + parse the last chunk's usage object.
        first_token_at: float | None = None
        last_chunk = None
        chunks: list[Any] = []
        content_parts: list[str] = []
        request_id = None

        for chunk in litellm.completion(**params):
            chunks.append(chunk)
            if first_token_at is None:
                # Some providers emit a metadata-only first chunk.
                # The TTFT we want is the moment first content arrives.
                try:
                    delta = chunk.choices[0].delta
                    if getattr(delta, "content", None):
                        first_token_at = time.perf_counter()
                        if not request_id:
                            request_id = getattr(chunk, "id", None)
                except (AttributeError, IndexError):
                    pass
            try:
                d = chunk.choices[0].delta.content
                if d:
                    content_parts.append(d)
            except (AttributeError, IndexError):
                pass
            last_chunk = chunk

        ended = time.perf_counter()
        latency_ms = (ended - started) * 1000
        ttft_ms = ((first_token_at - started) * 1000) if first_token_at else 0.0
        span.set_attribute("duration_ms", latency_ms)
        span.set_attribute("gen_ai.streaming.time_to_first_token_ms", ttft_ms)
        span.set_attribute("gen_ai.streaming.chunks", len(chunks))

        # Final usage lives on the last chunk (when include_usage was
        # honored). LiteLLM normalizes shape across providers.
        record_usage(span, last_chunk) if last_chunk else None

        out_tokens = _usage_field(last_chunk, "completion_tokens") if last_chunk else 0
        # Output rate over the streaming interval (excluding TTFT).
        stream_secs = max(0.001, (ended - (first_token_at or started)))
        output_rate_tps = out_tokens / stream_secs if out_tokens else 0.0
        span.set_attribute("gen_ai.streaming.output_rate_tps", output_rate_tps)

        return CallResult(
            content="".join(content_parts),
            input_tokens=_usage_field(last_chunk, "prompt_tokens") if last_chunk else 0,
            output_tokens=out_tokens,
            cached_tokens=(
                _usage_field(last_chunk, "cached_tokens")
                or _usage_field(last_chunk, "prompt_tokens_cached")
            )
            if last_chunk
            else 0,
            cost_usd=_extract_cost(last_chunk) if last_chunk else 0.0,
            latency_ms=latency_ms,
            request_id=request_id,
            raw_response=chunks,
            streamed=True,
            time_to_first_token_ms=ttft_ms,
            output_rate_tps=output_rate_tps,
        )


def _usage_field(response: Any, key: str) -> int:
    """Read a usage field from any LiteLLM response shape (object or dict)."""
    if response is None:
        return 0
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage", {})
    if usage is None:
        return 0
    if hasattr(usage, key):
        return int(getattr(usage, key) or 0)
    if isinstance(usage, dict):
        return int(usage.get(key, 0) or 0)
    return 0


def _extract_cost(response: Any) -> float:
    """Pull LiteLLM's computed cost from `_hidden_params.response_cost`."""
    if response is None:
        return 0.0
    hidden = getattr(response, "_hidden_params", {}) or {}
    if isinstance(hidden, dict):
        return float(hidden.get("response_cost") or 0)
    return 0.0


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
