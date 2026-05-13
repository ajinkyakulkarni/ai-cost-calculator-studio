"""OpenTelemetry tracing — emits GenAI semconv spans for every LLM call.

Why OTEL: every serious LLM observability tool (Langfuse, Arize Phoenix,
Datadog, Honeycomb, etc.) consumes OTEL. By emitting standard
`gen_ai.*` attributes, this bench's traces work with whatever
observability stack the consumer already has — no custom adapters.

GenAI semconv reference:
    https://opentelemetry.io/docs/specs/semconv/gen-ai/

We also keep a parallel in-memory list of completed spans for the
local trace.json artifact — this is what the variance comparator
reads. OTEL export to a remote collector is optional (set
OTEL_EXPORTER_OTLP_ENDPOINT to enable).
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)

# Captured spans accumulate here for the trace.json artifact. Populated
# by InMemorySpanCollector below.
_collected_spans: list[dict[str, Any]] = []


class InMemorySpanCollector(SpanExporter):
    """Custom OTEL span exporter that stores spans for local JSON export.

    OTEL exporters typically push to a remote collector. We keep a
    local copy too, since the variance comparator runs offline against
    the trace.json artifact. Wrapped in SimpleSpanProcessor in
    init_tracing() so the SDK calls export() on each finished span.
    """

    def export(self, spans) -> SpanExportResult:
        for span in spans:
            _collected_spans.append(_span_to_dict(span))
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def _span_to_dict(span) -> dict[str, Any]:
    """Convert a finished OTEL span into a JSON-serializable dict.

    Preserves all `gen_ai.*` attributes verbatim. Adds duration_ms
    derived from start/end timestamps.
    """
    ctx = span.get_span_context()
    attrs = dict(span.attributes or {})
    duration_ns = (span.end_time or 0) - (span.start_time or 0)
    return {
        "trace_id": format(ctx.trace_id, "032x"),
        "span_id": format(ctx.span_id, "016x"),
        "name": span.name,
        "kind": str(span.kind).split(".")[-1],
        "started_at": _ns_to_iso(span.start_time),
        "ended_at": _ns_to_iso(span.end_time),
        "duration_ms": duration_ns / 1_000_000 if duration_ns else 0,
        "status": span.status.status_code.name,
        "attributes": attrs,
    }


def _ns_to_iso(ts_ns: int | None) -> str | None:
    if not ts_ns:
        return None
    return datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc).isoformat()


def init_tracing(service_name: str = "agent-cost-bench") -> trace.Tracer:
    """Set up the global tracer provider with our collector + optional OTLP.

    Idempotent — calling twice in the same process is a no-op.
    """
    if isinstance(trace.get_tracer_provider(), TracerProvider):
        return trace.get_tracer(service_name)

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)

    # Always store spans locally for trace.json output.
    provider.add_span_processor(SimpleSpanProcessor(InMemorySpanCollector()))

    # Console exporter only when explicitly requested — too noisy by
    # default, but useful when debugging.
    if os.environ.get("AGENT_COST_BENCH_CONSOLE_TRACES") == "1":
        provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))

    # OTLP export to a remote collector (Langfuse / Arize / etc.) is
    # optional. Enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set, per
    # the standard OTEL env vars.
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))

    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)


def collected_spans() -> list[dict[str, Any]]:
    """Snapshot of every span finished since process start."""
    return list(_collected_spans)


def reset_collected_spans() -> None:
    """Clear the in-memory span buffer — call between scenario runs."""
    _collected_spans.clear()


@contextmanager
def llm_call_span(
    tracer: trace.Tracer,
    *,
    system: str,
    model: str,
    operation: str = "chat",
):
    """Wrap an LLM call in a GenAI-semconv-compliant span.

    Use this around the actual `litellm.completion(...)` invocation:

        with llm_call_span(tracer, system="openai", model="gpt-5.2") as span:
            resp = litellm.completion(...)
            record_usage(span, resp)

    The span attributes are populated post-call by `record_usage()`.
    """
    span_name = f"chat {model}" if operation == "chat" else f"{operation} {model}"
    with tracer.start_as_current_span(span_name, kind=trace.SpanKind.CLIENT) as span:
        span.set_attribute("gen_ai.system", system)
        span.set_attribute("gen_ai.request.model", model)
        span.set_attribute("gen_ai.operation.name", operation)
        yield span


def record_usage(span, response: Any) -> None:
    """Populate a span with usage data from a LiteLLM response.

    LiteLLM normalizes provider-specific usage shapes into a common
    structure. We map those to GenAI semconv attributes.

    OpenAI nests `cached_tokens` inside `usage.prompt_tokens_details`
    rather than as a top-level field, so we look there too. This is
    where the bench's cache-hit-rate signal comes from for the
    OpenAI provider — without this fallback, every span reports
    cached=0 even when caching is firing.
    """
    usage = getattr(response, "usage", None) or response.get("usage", {})
    if not usage:
        return

    def _u(key: str, default: int = 0) -> int:
        # Top-level read first (Anthropic, LiteLLM-normalized values).
        val = default
        if hasattr(usage, key):
            val = int(getattr(usage, key) or default)
        elif isinstance(usage, dict):
            val = int(usage.get(key, default) or default)
        if val:
            return val
        # OpenAI nests cache info under prompt_tokens_details.
        details = (
            getattr(usage, "prompt_tokens_details", None)
            if hasattr(usage, "prompt_tokens_details")
            else (usage.get("prompt_tokens_details") if isinstance(usage, dict) else None)
        )
        if details is None:
            return default
        nested_key = "cached_tokens" if key == "prompt_tokens_cached" else key
        if hasattr(details, nested_key):
            return int(getattr(details, nested_key) or default)
        if isinstance(details, dict):
            return int(details.get(nested_key, default) or default)
        return default

    input_tokens = _u("prompt_tokens")
    output_tokens = _u("completion_tokens")
    cached_tokens = _u("cached_tokens") or _u("prompt_tokens_cached")

    span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
    span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
    if cached_tokens:
        span.set_attribute("gen_ai.usage.cached_tokens", cached_tokens)

    # LiteLLM computes provider-billed cost in cents/USD and stuffs it
    # on `_hidden_params.response_cost`. Forward that to the span so
    # downstream tools (compare.py variance reports, paper figures)
    # have the real billed cost rather than a hardcoded $5/M rate-card
    # estimate. Without this, every variance report's
    # session_cost_usd row is silently computed from a fallback table.
    hidden = getattr(response, "_hidden_params", None)
    if isinstance(hidden, dict):
        rc = hidden.get("response_cost")
        if rc is not None:
            try:
                span.set_attribute("response_cost", float(rc))
            except (TypeError, ValueError):
                pass

    # Provider request id is invaluable for cross-referencing against
    # provider audit logs (OpenAI dashboard, Anthropic console).
    request_id = getattr(response, "id", None)
    if request_id is None and isinstance(response, dict):
        request_id = response.get("id")
    if request_id:
        span.set_attribute("gen_ai.response.id", request_id)


def write_trace_artifact(
    *,
    scenario_name: str,
    output_dir: Path,
    started_at: str,
    config_hash: str,
    user_turns: int = 0,
) -> Path:
    """Serialize all collected spans + session totals to trace.json.

    File name follows `{scenario}-{timestamp}-trace.json` so consecutive
    runs don't clobber each other.

    `user_turns` is the total user-driven turn count across all repeats
    (scenario.repeat × len(scenario.turns)). Recorded so downstream
    comparators can compute `llm_calls_per_user_turn` — a structural
    diagnostic that reveals how aggressive the agent's tool-loop is.
    """
    spans = collected_spans()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Aggregate session totals from gen_ai.usage.* attributes.
    total_in = sum(s["attributes"].get("gen_ai.usage.input_tokens", 0) for s in spans)
    total_out = sum(s["attributes"].get("gen_ai.usage.output_tokens", 0) for s in spans)
    total_cached = sum(s["attributes"].get("gen_ai.usage.cached_tokens", 0) for s in spans)

    artifact = {
        "scenario": scenario_name,
        "started_at": started_at,
        "config_hash": config_hash,
        "agent_cost_bench_version": "0.2.0",
        "calls": spans,
        "session_totals": {
            "calls": len(spans),
            "input_tokens": total_in,
            "output_tokens": total_out,
            "cached_tokens": total_cached,
            "user_turns": user_turns,
        },
    }

    ts = started_at.replace(":", "-").replace(".", "-")
    out_path = output_dir / f"{scenario_name}-{ts}-trace.json"
    out_path.write_text(json.dumps(artifact, indent=2))
    return out_path
