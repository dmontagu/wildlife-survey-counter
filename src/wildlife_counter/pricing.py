"""Standard (short-context) OpenAI API rates, used for API-equivalent cost estimates.

Rates checked 2026-09-09 at https://developers.openai.com/api/docs/pricing.
Unknown model prices remain unknown, never silently become zero.
"""

from __future__ import annotations

# USD per million tokens: (fresh input, cached input, cache write, output). Output includes reasoning.
API_RATES: dict[str, tuple[float, float, float, float]] = {
    'gpt-6-astra': (10, 1, 12.5, 50),
    'gpt-5.6-sol': (4, 0.4, 5, 20),
    'gpt-5.6-terra': (2, 0.2, 2.5, 12),
    'gpt-5.6-luna': (0.2, 0.02, 0.25, 1.2),
}


def api_equivalent_cost(model: str, input_tokens: int, cached_tokens: int, output_tokens: int) -> float | None:
    """Short-context API equivalent for aggregate usage; long-context premiums are not measured."""
    rate = API_RATES.get(model.split(':')[-1])
    if rate is None:
        return None
    fresh = max(0, input_tokens - cached_tokens)
    return round((fresh * rate[0] + cached_tokens * rate[1] + output_tokens * rate[3]) / 1_000_000, 6)
