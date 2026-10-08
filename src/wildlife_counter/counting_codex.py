"""Run local census tools with Codex's ChatGPT subscription, never an API key fallback."""

from __future__ import annotations

import asyncio
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

from wildlife_counter.counting_agent import Census, Point, PossiblePoint, census_preview, owns, prompt_for
from wildlife_counter.pricing import api_equivalent_cost

# Tool calls run inside the Codex subprocess; we rebuild them as spans from its event stream.
# Raw OTel spans take explicit start/end times without becoming the current context, so parallel
# tool calls can overlap under the run span.
_tracer = trace.get_tracer('wildlife_counter.counting_codex')


def write_source(census: Census):
    """Everything the stdio MCP server needs to rebuild the same Census in its own process."""
    (census.work_dir / 'source.json').write_text(
        json.dumps(
            {
                'image_path': str(census.image_path),
                'width': census.width,
                'height': census.height,
                'region_size': census.region_size,
                'final_review': census.final_review,
                'species': census.species,
            }
        )
    )


def cli_instructions(census: Census) -> str:
    text = (
        'Use the census MCP tools. Do not use other applications, search the web, read '
        'reference labels, or modify the repository. The MCP server owns the image and ledger. '
        'Call get_ledger first; finish_census when done. Your final text should briefly report the count.'
    )
    if not census.final_review:
        text += ' Final neighborhood reconciliation (step 6) is disabled for this run; skip it.'
    return text


def restore_ledger(census: Census):
    data = json.loads((census.work_dir / 'ledger.json').read_text())
    regions = data['regions']
    boxes = list(regions.values())
    area = 0
    for i, box in enumerate(boxes):
        left, top, right, bottom = box
        if not (0 <= left < right <= census.width and 0 <= top < bottom <= census.height):
            raise ValueError('Invalid region bounds in returned ledger')
        area += (right - left) * (bottom - top)
        for other in boxes[i + 1 :]:
            if max(left, other[0]) < min(right, other[2]) and max(top, other[1]) < min(bottom, other[3]):
                raise ValueError('Overlapping regions in returned ledger')
    if area != census.width * census.height:
        raise ValueError('Returned ledger does not cover the entire source image')
    for rid, record in data['records'].items():
        if rid not in regions:
            raise ValueError('Unknown recorded region')
        points = [Point.model_validate(p) for p in record['points']]
        points += [PossiblePoint.model_validate(p) for p in record['uncertain']]
        if any(not owns(regions[rid], p.x, p.y) for p in points):
            raise ValueError('Point outside its region in returned ledger')
        if len({(p.x, p.y) for p in points}) != len(points):
            raise ValueError('Duplicate coordinates in returned ledger')
    census.regions, census.records = regions, data['records']
    census.seen, census.checked = set(data['seen']), set(data['checked'])
    census.reconciled = set(data.get('reconciled', []))
    census.summary = data['summary']
    census.focus = data.get('focus')
    census.submitted = bool(data['submitted'])
    # Recheck completion in host code, independently of the model's final message.
    if any(
        rid not in census.seen
        or rid not in census.records
        or ((census.records[rid]['points'] or census.records[rid]['uncertain']) and rid not in census.checked)
        for rid in census.regions
    ):
        census.submitted = False
    if set(census.neighborhoods()) - census.reconciled:
        census.submitted = False


async def run_codex(run: dict, census: Census, persist: Callable[[dict], Awaitable[None]]):
    model = run['model'].split(':')[-1]
    effort = run.setdefault('reasoning_effort', 'high')
    with logfire.span(
        'codex census {model} ({effort}) on {image}',
        model=model,
        effort=effort,
        image=run.get('image_filename', census.image_path.name),
        run_id=run.get('id'),
        **{'gen_ai.system': 'openai', 'gen_ai.request.model': model},
    ) as span:
        try:
            await _run_codex(run, census, persist, model, effort)
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


async def _run_codex(run: dict, census: Census, persist: Callable[[dict], Awaitable[None]], model: str, effort: str):
    executable = shutil.which('codex')
    if not executable:
        raise RuntimeError('Install Codex CLI and sign in with ChatGPT to use subscription counting.')
    write_source(census)
    environment = dict(os.environ)
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'):
        environment.pop(key, None)
    package_root = str(Path(__file__).resolve().parent.parent)
    environment['PYTHONPATH'] = package_root
    mcp_args = json.dumps(['-m', 'wildlife_counter.counting_mcp', str(census.work_dir)])
    args = [
        executable,
        'exec',
        '--ignore-user-config',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--json',
        '-C',
        str(census.work_dir),
        '-m',
        model,
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'approval_policy="never"',
        '-c',
        f'model_reasoning_effort="{effort}"',
        '-c',
        f'mcp_servers.census.command={json.dumps(sys.executable)}',
        '-c',
        f'mcp_servers.census.args={mcp_args}',
        '-c',
        'mcp_servers.census.required=true',
        '-c',
        'mcp_servers.census.default_tools_approval_mode="approve"',
        '-c',
        'mcp_servers.census.tool_timeout_sec=300',
        '-c',
        f'mcp_servers.census.env.PYTHONPATH={json.dumps(package_root)}',
        '-',
    ]
    prompt = prompt_for(census.species) + '\n' + cli_instructions(census)
    run['billing'] = 'ChatGPT/Codex subscription; API equivalent is informational, not an API charge.'
    with (census.work_dir / 'codex-stderr.log').open('wb') as stderr:
        proc = await asyncio.create_subprocess_exec(
            *args,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            limit=16 * 1024 * 1024,
            start_new_session=os.name == 'posix',
        )
        try:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(prompt.encode())
            await proc.stdin.drain()
            proc.stdin.close()
            tool_spans: dict[str, trace.Span] = {}
            with (census.work_dir / 'codex-events.jsonl').open('wb') as events:
                async for line in proc.stdout:
                    events.write(line)
                    events.flush()
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    item = event.get('item', {})
                    if item.get('type') == 'mcp_tool_call':
                        run['progress'] = f'Reviewing image: {item.get("tool", "census")}'
                        if event.get('type') == 'item.started':
                            tool_spans[item['id']] = _tracer.start_span(
                                f'tool {item.get("tool")}',
                                start_time=time_ns(),
                                attributes={
                                    'logfire.msg': f'tool {item.get("tool")} {json.dumps(item.get("arguments") or {})}',
                                    'gen_ai.tool.name': item.get('tool', ''),
                                    'tool_arguments': json.dumps(item.get('arguments') or {}),
                                },
                            )
                        elif event.get('type') == 'item.completed' and item['id'] in tool_spans:
                            tool_span = tool_spans.pop(item['id'])
                            run['tool_calls'] = run.get('tool_calls', 0) + 1
                            if item.get('error'):
                                tool_span.set_attribute('error', str(item['error'])[:2000])
                                tool_span.set_attribute('logfire.level_num', 17)
                            tool_span.end(end_time=time_ns())
                    elif item.get('type') == 'agent_message':
                        run['last_update'] = item.get('text', '')[:1000]
                        logfire.info('agent message: {text}', text=item.get('text', ''))
                    if event.get('type') == 'turn.completed':
                        u = event['usage']
                        run['usage'] = dict(
                            input_tokens=u.get('input_tokens', 0),
                            cache_read_tokens=u.get('cached_input_tokens', 0),
                            output_tokens=u.get('output_tokens', 0),
                        )
                        # Long-context/service-tier details are not exposed here: don't invent an invoice.
                        run['estimated_cost_usd'] = api_equivalent_cost(
                            model, u.get('input_tokens', 0), u.get('cached_input_tokens', 0), u.get('output_tokens', 0)
                        )
                        if run['estimated_cost_usd'] is not None:
                            run['cost_basis'] = (
                                'Standard short-context API equivalent only; subscription usage '
                                'is not an API bill. Long-context premiums are not measured here.'
                            )
                    if event.get('type') in ('turn.failed', 'error'):
                        run['error'] = str(event.get('error', event.get('message', 'Codex run failed')))
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
                raise RuntimeError(run.get('error') or f'Codex exited with code {code}; see the local run log.')
            if not (census.work_dir / 'ledger.json').exists():
                raise RuntimeError(run.get('last_update') or 'Codex did not record any image regions.')
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
