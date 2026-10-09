"""Run local census tools with the Claude Code CLI on a Claude subscription, never an API key."""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import shutil
import signal
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import time_ns

import logfire
from opentelemetry import trace

from wildlife_counter.config import settings
from wildlife_counter.counting_agent import Census, census_preview, prompt_for
from wildlife_counter.counting_codex import cli_instructions, event_lines, restore_ledger, write_source

_tracer = trace.get_tracer('wildlife_counter.counting_claude')


async def _claude_turn() -> int:
    """Machine-wide lock: at most one Claude subscription run at a time, across every process."""
    path = settings.sandbox_work_dir / 'claude-subscription.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            await asyncio.sleep(5)


async def run_claude(run: dict, census: Census, persist: Callable[[dict], Awaitable[None]]):
    fd = await _claude_turn()
    try:
        await _run_claude_span(run, census, persist)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


async def _run_claude_span(run: dict, census: Census, persist: Callable[[dict], Awaitable[None]]):
    model = run['model'].split(':')[-1]
    effort = run.setdefault('reasoning_effort', 'high')
    with logfire.span(
        'claude census {model} ({effort}) on {image}',
        model=model,
        effort=effort,
        image=run.get('image_filename', census.image_path.name),
        run_id=run.get('id'),
        **{'gen_ai.system': 'anthropic', 'gen_ai.request.model': model},
    ) as span:
        try:
            await _run_claude(run, census, persist, model, effort)
        finally:
            usage = run.get('usage') or {}
            span.set_attributes(
                {
                    'gen_ai.response.model': model,
                    'gen_ai.usage.input_tokens': usage.get('input_tokens', 0),
                    'gen_ai.usage.cache_read_tokens': usage.get('cache_read_tokens', 0),
                    'gen_ai.usage.output_tokens': usage.get('output_tokens', 0),
                    'tool_calls': run.get('tool_calls', 0),
                    'submitted': census.submitted,
                }
            )
            if run.get('estimated_cost_usd') is not None:
                span.set_attribute('operation.cost', run['estimated_cost_usd'])
            if run.get('error'):
                span.set_level('error')


async def _run_claude(run: dict, census: Census, persist: Callable[[dict], Awaitable[None]], model: str, effort: str):
    executable = shutil.which('claude')
    if not executable:
        raise RuntimeError('Install the Claude Code CLI and sign in with a Claude subscription.')
    write_source(census)
    package_root = str(Path(__file__).resolve().parent.parent)
    mcp_config = census.work_dir / 'mcp.json'
    mcp_config.write_text(
        json.dumps(
            {
                'mcpServers': {
                    'census': {
                        'command': sys.executable,
                        'args': ['-m', 'wildlife_counter.counting_mcp', str(census.work_dir)],
                        'env': {'PYTHONPATH': package_root},
                    }
                }
            }
        )
    )
    environment = dict(os.environ)
    for key in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'):
        environment.pop(key, None)
    environment['MCP_TOOL_TIMEOUT'] = '300000'
    args = [
        executable,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--model',
        model,
        '--effort',
        effort,
        '--strict-mcp-config',
        '--mcp-config',
        str(mcp_config),
        '--setting-sources',
        '',
        '--tools',
        '',
        '--allowedTools',
        'mcp__census__*',
        '--system-prompt',
        prompt_for(census.species),
    ]
    run['billing'] = 'Claude subscription; API equivalent is informational, not an API charge.'
    with (census.work_dir / 'claude-stderr.log').open('wb') as stderr:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(census.work_dir),
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            limit=64 * 1024 * 1024,
            start_new_session=os.name == 'posix',
        )
        try:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(cli_instructions(census).encode())
            await proc.stdin.drain()
            proc.stdin.close()
            tool_spans: dict[str, trace.Span] = {}
            with (census.work_dir / 'claude-events.jsonl').open('wb') as events:
                async for line in event_lines(proc.stdout):
                    events.write(line)
                    events.flush()
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    kind = event.get('type')
                    if (
                        kind == 'system'
                        and event.get('subtype') == 'init'
                        and event.get('apiKeySource')
                        not in (
                            None,
                            'none',
                        )
                    ):
                        raise RuntimeError('Claude CLI is using an API key; subscription counting refuses to bill it.')
                    for part in (event.get('message') or {}).get('content') or []:
                        if not isinstance(part, dict):
                            continue
                        if part.get('type') == 'tool_use':
                            tool = str(part.get('name', '')).removeprefix('mcp__census__')
                            run['progress'] = f'Reviewing image: {tool}'
                            arguments = json.dumps(part.get('input') or {})
                            tool_spans[part['id']] = _tracer.start_span(
                                f'tool {tool}',
                                start_time=time_ns(),
                                attributes={
                                    'logfire.msg': f'tool {tool} {arguments}',
                                    'gen_ai.tool.name': tool,
                                    'tool_arguments': arguments,
                                },
                            )
                        elif part.get('type') == 'tool_result' and part.get('tool_use_id') in tool_spans:
                            tool_span = tool_spans.pop(part['tool_use_id'])
                            run['tool_calls'] = run.get('tool_calls', 0) + 1
                            if part.get('is_error'):
                                tool_span.set_attribute('error', str(part.get('content'))[:2000])
                                tool_span.set_attribute('logfire.level_num', 17)
                            tool_span.end(end_time=time_ns())
                        elif part.get('type') == 'text' and kind == 'assistant' and part.get('text', '').strip():
                            run['last_update'] = part['text'][:1000]
                            logfire.info('agent message: {text}', text=part['text'])
                    if kind == 'result':
                        u = event.get('usage') or {}
                        run['usage'] = dict(
                            input_tokens=u.get('input_tokens', 0)
                            + u.get('cache_read_input_tokens', 0)
                            + u.get('cache_creation_input_tokens', 0),
                            cache_read_tokens=u.get('cache_read_input_tokens', 0),
                            output_tokens=u.get('output_tokens', 0),
                        )
                        # The CLI prices its own usage at list rates, including cache writes.
                        run['estimated_cost_usd'] = event.get('total_cost_usd')
                        run['cost_basis'] = 'Claude list-price API equivalent; subscription usage is not an API bill.'
                        if event.get('is_error'):
                            run['error'] = str(event.get('result') or event.get('subtype') or 'Claude run failed')
                    if (census.work_dir / 'ledger.json').exists():
                        try:
                            data = json.loads((census.work_dir / 'ledger.json').read_text())
                            run['regions_total'], run['regions_recorded'] = len(data['regions']), len(data['records'])
                            run['preview'] = census_preview(data)
                        except (ValueError, KeyError):
                            pass  # A tool may currently be writing the ledger.
                    await persist(run)
            code = await proc.wait()
            if code:
                raise RuntimeError(run.get('error') or f'Claude exited with code {code}; see the local run log.')
            if not (census.work_dir / 'ledger.json').exists():
                raise RuntimeError(run.get('last_update') or 'Claude did not record any image regions.')
            restore_ledger(census)
        finally:
            if proc.returncode is None:
                if os.name == 'posix':
                    os.killpg(proc.pid, signal.SIGTERM)
                else:
                    proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except TimeoutError:
                    if os.name == 'posix':
                        os.killpg(proc.pid, signal.SIGKILL)
                    else:
                        proc.kill()
                    await proc.wait()
            if (census.work_dir / 'ledger.json').exists():
                restore_ledger(census)
