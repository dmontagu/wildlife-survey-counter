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

from wildlife_counter.counting_agent import PROMPT, Census, Point, PossiblePoint, census_preview, owns


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
    executable = shutil.which('codex')
    if not executable:
        raise RuntimeError('Install Codex CLI and sign in with ChatGPT to use subscription counting.')
    (census.work_dir / 'source.json').write_text(
        json.dumps(
            {
                'image_path': str(census.image_path),
                'width': census.width,
                'height': census.height,
            }
        )
    )
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
        run['model'].split(':')[-1],
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'approval_policy="never"',
        '-c',
        'model_reasoning_effort="high"',
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
    prompt = (
        PROMPT + '\nUse the census MCP tools. Do not use other applications, search the web, read '
        'reference labels, or modify the repository. The MCP server owns the image and ledger. '
        'Call get_ledger first; finish_census when done. Your final text should briefly report the count.'
    )
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
                    elif item.get('type') == 'agent_message':
                        run['last_update'] = item.get('text', '')[:1000]
                    if event.get('type') == 'turn.completed':
                        u = event['usage']
                        run['usage'] = dict(
                            input_tokens=u.get('input_tokens', 0),
                            cache_read_tokens=u.get('cached_input_tokens', 0),
                            output_tokens=u.get('output_tokens', 0),
                        )
                        # Long-context/service-tier details are not exposed here: don't invent an invoice.
                        if run['model'].split(':')[-1] == 'gpt-6-astra':
                            fresh = max(0, u.get('input_tokens', 0) - u.get('cached_input_tokens', 0))
                            run['estimated_cost_usd'] = round(
                                (fresh * 10 + u.get('cached_input_tokens', 0) + u.get('output_tokens', 0) * 50)
                                / 1_000_000,
                                6,
                            )
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
