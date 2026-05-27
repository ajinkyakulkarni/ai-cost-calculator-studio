"""Deterministic user-actor for Pattern E (gated drill-down).

Pattern E pauses at 5 confirmation gates; this actor responds with
fixed, pre-decided answers so the conversation is fully reproducible.

Not an LLM. Just a frozen lookup table. The 'user' is a measurement
instrument here, not a participant.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class UserActor:
    """Look-up table keyed by gate-type."""

    answers: dict[str, str]

    @classmethod
    def frozen_default(cls) -> "UserActor":
        """The canonical Mendocino x LIS Global GPP x cog_default x 2020-summer-fall fixture."""
        return cls(
            answers={
                "datetime": "yes, that's correct",
                "state": "California",
                "county": "Mendocino County",
                "dataset": "LIS Global GPP",
                "variable": "cog_default",
            }
        )

    def respond(self, gate: str, agent_prompt: str) -> str:
        if gate not in self.answers:
            raise KeyError(
                f"no scripted answer for gate {gate!r}; agent asked: {agent_prompt!r}"
            )
        return self.answers[gate]
