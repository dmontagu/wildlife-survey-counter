"""Run an elk classification pass on a subscription CLI (Codex for OpenAI models, Claude Code for claude-*)."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Awaitable, Callable
from typing import Any

import logfire
import numpy as np

from wildlife_counter.classify import Classification, prompt_for
from wildlife_counter.counting_claude import claude_exec, claude_turn
from wildlife_counter.counting_codex import codex_exec


def estimate_animal_px(points: list[dict]) -> float:
    """Typical elk size from marker spacing alone (no detector): ~1.3x the 25th-percentile neighbor distance.

    Checked on the 29 reference photos: usually within 2x of the reference size, which is enough
    for choosing crop magnification. Clamped so sparse or degenerate inputs stay sensible.
    """
    if len(points) < 3:
        return 80.0
    xy = np.array([[p['x'], p['y']] for p in points], dtype=float)
    dist = np.linalg.norm(xy[:, None] - xy[None, :], axis=2)
    np.fill_diagonal(dist, np.inf)
    return float(np.clip(1.32 * np.percentile(dist.min(axis=1), 25), 8.0, 400.0))


async def run_classification(
    c: Classification,
    run: dict[str, Any],
    model: str,
    effort: str,
    on_event: Callable[[dict], Awaitable[None]] | None = None,
) -> bool:
    """Classify every point in `c`; records usage/cost/errors on `run`. Returns whether it completed."""

    async def noop(_: dict):
        pass

    c.write_source()
    attrs: dict[str, Any] = {
        'model': model,
        'effort': effort,
        'animals': len(c.points),
        'gen_ai.system': 'anthropic' if model.startswith('claude') else 'openai',
        'gen_ai.request.model': model,
    }
    with logfire.span('classify {animals} elk with {model} ({effort})', **attrs) as span:
        try:
            if model.startswith('claude'):
                # Claude runs on the subscription one at a time, machine-wide.
                fd = await claude_turn()
                try:
                    code = await claude_exec(
                        run,
                        c.work_dir,
                        prompt_for(c.zoom),
                        'Classify every elk with the classify tools: get_batches first, finish when done.',
                        model,
                        effort,
                        'wildlife_counter.classify_mcp',
                        'classify',
                        on_event or noop,
                    )
                finally:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)
            else:
                code = await codex_exec(
                    run,
                    c.work_dir,
                    prompt_for(c.zoom),
                    model,
                    effort,
                    'wildlife_counter.classify_mcp',
                    'classify',
                    on_event or noop,
                )
            if code and not run.get('error'):
                run['error'] = f'Classifier exited with code {code}'
        except Exception as exc:
            run['error'] = str(exc)
        c.load()
        usage = run.get('usage') or {}
        span.set_attributes(
            {
                'gen_ai.usage.input_tokens': usage.get('input_tokens', 0),
                'gen_ai.usage.output_tokens': usage.get('output_tokens', 0),
                'completed': c.submitted,
                'tool_calls': run.get('tool_calls', 0),
            }
        )
        if run.get('estimated_cost_usd') is not None:
            span.set_attribute('operation.cost', run['estimated_cost_usd'])
        if not c.submitted:
            span.set_level('error')
    return c.submitted
