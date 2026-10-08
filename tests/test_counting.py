from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from PIL import Image
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ModelResponse
from pydantic_ai.usage import RequestUsage

from wildlife_counter import counting
from wildlife_counter import counting_agent as agent
from wildlife_counter.config import settings
from wildlife_counter.counting_codex import restore_ledger, run_codex
from wildlife_counter.db import init_db


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.png'
        Image.new('RGB', (200, 150), 'white').save(self.source)
        self.census = agent.Census(self.source, self.root, 200, 150)
        self.ctx = SimpleNamespace(deps=self.census)

    def tearDown(self):
        self.temp.cleanup()

    def test_submission_requires_source_and_final_overlay_and_invalidates_after_changes(self):
        with self.assertRaises(ModelRetry):
            agent.record_region(self.ctx, 'r0c0', [], [], 'empty')
        agent.inspect_region(self.ctx, 'r0c0')
        agent.record_region(self.ctx, 'r0c0', [agent.Point(x=40, y=40)], [], 'source checked')
        with self.assertRaises(ModelRetry):
            agent.finish_census(self.ctx, 'done')
        agent.inspect_region(self.ctx, 'r0c0', 'review')
        with self.assertRaisesRegex(ModelRetry, 'cross-region'):
            agent.finish_census(self.ctx, 'done')
        for neighborhood in self.census.neighborhoods():
            agent.inspect_neighborhood(self.ctx, neighborhood)
        self.assertEqual(agent.finish_census(self.ctx, 'done')['count'], 1)
        agent.record_region(self.ctx, 'r0c0', [agent.Point(x=41, y=40)], [], 'corrected torso')
        self.assertFalse(self.census.submitted)
        self.assertFalse(self.census.reconciled)
        with self.assertRaises(ModelRetry):
            agent.finish_census(self.ctx, 'done')

    def test_preview_tracks_inspection_revision_and_subdivision_without_finalizing(self):
        def preview():
            return agent.census_preview(json.loads((self.root / 'ledger.json').read_text()))

        self.census.save()
        self.assertEqual(preview()['regions'][0]['status'], 'pending')
        self.assertEqual(preview()['points'], [])
        agent.inspect_region(self.ctx, 'r0c0')
        self.assertEqual(preview()['regions'][0]['status'], 'inspecting')
        self.assertEqual(preview()['focus'], [0, 0, 200, 150])
        agent.record_region(self.ctx, 'r0c0', [agent.Point(x=40, y=40)], [], 'first pass')
        self.assertEqual(preview()['regions'][0]['status'], 'recorded')
        self.assertEqual(preview()['points'][0]['x'], 40)
        agent.inspect_region(self.ctx, 'r0c0', 'review')
        self.assertEqual(preview()['regions'][0]['status'], 'checked')
        self.assertEqual(preview()['phase'], 'review')
        agent.inspect_neighborhood(self.ctx, next(iter(self.census.neighborhoods())))
        self.assertEqual(preview()['neighborhoods_checked'], 1)
        agent.record_region(self.ctx, 'r0c0', [agent.Point(x=50, y=40)], [], 'revised torso')
        self.assertEqual(preview()['points'][0]['x'], 50)
        self.assertEqual(len(preview()['points']), 1)
        self.assertEqual(preview()['neighborhoods_checked'], 0)
        agent.split_region(self.ctx, 'r0c0')
        self.assertEqual(len(preview()['regions']), 4)
        self.assertEqual(preview()['points'], [])
        self.assertIsNone(preview()['focus'])
        self.assertFalse(self.census.submitted)

    def test_split_covers_every_pixel_and_prevents_context_double_count(self):
        children = agent.split_region(self.ctx, 'r0c0')
        for x in range(200):
            for y in range(150):
                self.assertEqual(sum(agent.owns(b, x, y) for b in children.values()), 1)
        rid = 'r0c0.0'
        agent.inspect_region(self.ctx, rid)
        with self.assertRaises(ModelRetry):
            agent.record_region(self.ctx, rid, [agent.Point(x=100, y=50)], [], 'belongs to neighbor')
        with self.assertRaises(ModelRetry):
            agent.record_region(self.ctx, rid, [agent.Point(x=40, y=50)] * 2, [], 'duplicate')

    def test_empty_count_is_valid_but_unfinished_count_is_not(self):
        with self.assertRaises(ModelRetry):
            agent.finish_census(self.ctx, 'no animals')
        agent.inspect_region(self.ctx, 'r0c0')
        agent.record_region(self.ctx, 'r0c0', [], [], 'whole source contains no animals')
        self.assertEqual(agent.finish_census(self.ctx, 'empty')['count'], 0)
        restore_ledger(self.census)
        self.assertTrue(self.census.submitted)

    def test_subscription_ledger_rejects_gaps_and_overlaps(self):
        self.census.save()
        p = self.root / 'ledger.json'
        data = json.loads(p.read_text())
        data['regions'] = {'a': [0, 0, 100, 150]}
        p.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'cover'):
            restore_ledger(self.census)
        data['regions'] = {'a': [0, 0, 120, 150], 'b': [100, 0, 200, 150]}
        p.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            restore_ledger(self.census)

    def test_cost_distinguishes_cache_output_and_long_context(self):
        short = ModelResponse(
            parts=[],
            model_name='gpt-6-astra',
            usage=RequestUsage(input_tokens=100_000, cache_read_tokens=80_000, output_tokens=10_000),
        )
        self.assertAlmostEqual(counting.estimated_cost([short]), 0.78)
        long = ModelResponse(
            parts=[],
            model_name='gpt-6-astra',
            usage=RequestUsage(input_tokens=300_000, cache_read_tokens=200_000, output_tokens=10_000),
        )
        self.assertAlmostEqual(counting.estimated_cost([long]), 3.15)
        self.assertIsNone(counting.estimated_cost([ModelResponse(parts=[], model_name='unpriced-model')]))


class CountingAPITests(unittest.IsolatedAsyncioTestCase):
    client_token = '36632e3b-ef1a-4f28-8f53-68e1c14c8028'
    owner = counting.counting_owner(client_token)

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.multiple(
            settings,
            db_path=self.root / 'runs.db',
            sandbox_work_dir=self.root / 'work',
            counting_enabled=True,
            counting_runner='codex',
        )
        self.patch.start()
        await init_db(settings.db_path)
        await counting.initialize()
        app = FastAPI()
        app.include_router(counting.router)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url='http://test',
            headers={'X-Counting-Client': self.client_token},
        )

    async def asyncTearDown(self):
        await counting.shutdown()
        await self.client.aclose()
        self.patch.stop()
        self.temp.cleanup()

    async def test_review_is_persistent_idempotent_and_reversible(self):
        run = dict(
            id='review',
            owner_key=self.owner,
            image_sha256='hash',
            status='complete',
            annotations=[agent.annotation(1, 10, 10)],
            uncertain=[dict(id='U1', x=20, y=20, reason='overlap', decision='pending')],
        )
        await counting.save_run(run)
        url = '/api/counting/runs/review/uncertain/U1'
        for _ in range(2):
            response = await self.client.patch(url, json={'decision': 'accept'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()['annotations']), 2)
        response = await self.client.patch(url, json={'decision': 'pending'})
        self.assertEqual(len(response.json()['annotations']), 1)
        response = await self.client.patch(url, json={'decision': 'reject'})
        saved = (await self.client.get('/api/counting/runs/review')).json()
        self.assertEqual(saved['uncertain'][0]['decision'], 'reject')
        self.assertEqual(len(saved['annotations']), 1)

    async def test_disabled_counting_does_not_start_work_and_invalid_images_fail(self):
        settings.counting_enabled = False
        response = await self.client.post('/api/counting/runs', files={'file': ('test.jpg', b'invalid')})
        self.assertEqual(response.status_code, 503)
        settings.counting_enabled = True
        response = await self.client.post('/api/counting/runs', files={'file': ('test.jpg', b'invalid')})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(counting.tasks)

    async def test_restart_marks_unfinished_jobs_interrupted_without_losing_results(self):
        for status in ['running', 'queued', 'complete']:
            await counting.save_run(dict(id=status, image_sha256='same', status=status, annotations=[{'x': 1}]))
        await counting.initialize()
        self.assertEqual((await counting.load_run('running'))['status'], 'interrupted')
        self.assertEqual((await counting.load_run('queued'))['status'], 'interrupted')
        self.assertEqual((await counting.load_run('complete'))['annotations'], [{'x': 1}])

    async def test_camera_mpo_jpeg_upload_preserves_original_bytes_without_calling_model(self):
        data = io.BytesIO()
        Image.new('RGB', (80, 60), 'white').save(
            data, format='MPO', save_all=True, append_images=[Image.new('RGB', (80, 60), 'gray')]
        )
        with patch.object(counting, 'execute_run', new_callable=AsyncMock):
            response = await self.client.post('/api/counting/runs', files={'file': ('camera.JPG', data.getvalue())})
        self.assertEqual(response.status_code, 202)
        saved = await counting.load_run(response.json()['id'])
        self.assertEqual((saved['width'], saved['height']), (80, 60))
        self.assertEqual(Path(saved['source_path']).read_bytes(), data.getvalue())

    def png(self, color='white'):
        data = io.BytesIO()
        Image.new('RGB', (80, 60), color).save(data, format='PNG')
        return data.getvalue()

    async def test_concurrent_uploads_and_renames_start_only_one_count(self):
        content = self.png()
        with patch.object(counting, 'execute_run', new_callable=AsyncMock) as execute:
            responses = await asyncio.gather(
                *[
                    self.client.post('/api/counting/runs', files={'file': (f'renamed-{i}.png', content)})
                    for i in range(5)
                ]
            )
            self.assertTrue(all(response.status_code == 202 for response in responses))
            self.assertEqual(len({response.json()['id'] for response in responses}), 1)
            execute.assert_awaited_once()
            # Even an explicit reset reconnects if a count is already running.
            forced = await self.client.post('/api/counting/runs?force=true', files={'file': ('elk.png', content)})
            self.assertEqual(forced.json()['id'], responses[0].json()['id'])
            self.assertEqual(len(list(settings.sandbox_work_dir.glob('census-*'))), 1)
            # The cache key is content, not the filename.
            other = await self.client.post('/api/counting/runs', files={'file': ('renamed-0.png', self.png('black'))})
            self.assertNotEqual(other.json()['id'], responses[0].json()['id'])
            await asyncio.sleep(0)
            self.assertEqual(execute.await_count, 2)

    async def test_completed_empty_count_survives_failed_retries_restart_and_model_changes(self):
        content = self.png()
        image_hash = hashlib.sha256(content).hexdigest()
        cached = dict(
            id='saved',
            owner_key=self.owner,
            image_sha256=image_hash,
            status='complete',
            annotations=[],
            uncertain=[],
            started_at='2026-01-01',
            model='previous-model',
        )
        await counting.save_run(cached)
        for status in ['error', 'cancelled', 'interrupted']:
            await counting.save_run(dict(cached, id=status, status=status, started_at='2026-02-01'))
        await counting.initialize()
        with patch.object(counting, 'execute_run', new_callable=AsyncMock) as execute:
            response = await self.client.post('/api/counting/runs', files={'file': ('renamed.png', content)})
            self.assertEqual(response.json(), counting.public_run(cached))
            execute.assert_not_called()
            self.assertFalse(settings.sandbox_work_dir.exists())
            # A deliberate reset retains the old result and creates fresh work.
            forced = await self.client.post('/api/counting/runs?force=true', files={'file': ('elk.png', content)})
            self.assertNotEqual(forced.json()['id'], cached['id'])
            self.assertEqual(await counting.load_run('saved'), cached)
            await asyncio.sleep(0)
            execute.assert_awaited_once()

    async def test_failed_only_count_can_be_retried(self):
        content = self.png()
        await counting.save_run(
            dict(id='failed', owner_key=self.owner, image_sha256=hashlib.sha256(content).hexdigest(), status='error')
        )
        with patch.object(counting, 'execute_run', new_callable=AsyncMock) as execute:
            response = await self.client.post('/api/counting/runs', files={'file': ('elk.png', content)})
            self.assertEqual(response.json()['status'], 'queued')
            self.assertNotEqual(response.json()['id'], 'failed')
            await asyncio.sleep(0)
            execute.assert_awaited_once()

    async def test_users_cannot_share_cached_active_or_completed_results_or_access_each_others_runs(self):
        content = self.png()
        other = {'X-Counting-Client': '5f6b4372-cd28-4b38-ae06-f0daa3212667'}
        with patch.object(counting, 'execute_run', new_callable=AsyncMock) as execute:
            first = (await self.client.post('/api/counting/runs', files={'file': ('elk.png', content)})).json()
            second = (
                await self.client.post('/api/counting/runs', files={'file': ('elk.png', content)}, headers=other)
            ).json()
            self.assertNotEqual(first['id'], second['id'])
            self.assertNotIn('owner_key', first)
            saved = await counting.load_run(first['id'])
            saved.update(status='complete', uncertain=[dict(id='U1', x=10, y=20, decision='pending')])
            await counting.save_run(saved)
            self.assertEqual(
                (await self.client.get('/api/counting/runs', params={'sha256': first['image_sha256']})).json(),
                [counting.public_run(saved)],
            )
            history = (
                await self.client.get('/api/counting/runs', params={'sha256': first['image_sha256']}, headers=other)
            ).json()
            self.assertEqual([r['id'] for r in history], [second['id']])
            base = f'/api/counting/runs/{first["id"]}'
            for method, suffix, body in [
                ('GET', '', None),
                ('POST', '/cancel', None),
                ('GET', '/export', None),
                ('GET', '/uncertain/U1/crop', None),
                ('PATCH', '/uncertain/U1', {'decision': 'accept'}),
            ]:
                response = await self.client.request(method, base + suffix, headers=other, json=body)
                self.assertEqual(response.status_code, 404)
            await asyncio.sleep(0)
            self.assertEqual(execute.await_count, 2)
            self.assertEqual((await counting.load_run(first['id']))['uncertain'][0]['decision'], 'pending')
        self.client.headers.clear()
        self.assertEqual((await self.client.get(base)).status_code, 401)
        self.assertEqual(
            (await self.client.post('/api/counting/runs', files={'file': ('elk.png', content)})).status_code, 401
        )

    async def test_unowned_legacy_results_are_preserved_but_never_shared(self):
        content = self.png()
        old = dict(id='legacy', image_sha256=hashlib.sha256(content).hexdigest(), status='complete', annotations=[])
        await counting.save_run(old)
        await counting.initialize()
        self.assertEqual(await counting.load_run('legacy'), old)
        self.assertEqual(
            (await self.client.get('/api/counting/runs', params={'sha256': old['image_sha256']})).json(), []
        )
        self.assertEqual((await self.client.get('/api/counting/runs/legacy')).status_code, 404)
        with patch.object(counting, 'execute_run', new_callable=AsyncMock):
            response = await self.client.post('/api/counting/runs', files={'file': ('elk.png', content)})
            self.assertNotEqual(response.json()['id'], 'legacy')

    async def test_real_mcp_transport_returns_image_content_and_validates_review(self):
        work = self.root / 'mcp'
        work.mkdir()
        source = work / 'input.png'
        Image.new('RGB', (80, 60), 'white').save(source)
        (work / 'source.json').write_text(json.dumps({'image_path': str(source), 'width': 80, 'height': 60}))
        params = StdioServerParameters(command=sys.executable, args=['-m', 'wildlife_counter.counting_mcp', str(work)])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool('inspect_region', {'region': 'r0c0'})
                self.assertTrue(any(c.type == 'image' for c in result.content))
                result = await session.call_tool(
                    'record_region',
                    {'region': 'r0c0', 'points': [], 'uncertain': [], 'notes': 'empty source inspected'},
                )
                self.assertFalse(result.isError)
                result = await session.call_tool('finish_census', {'summary': 'No animals in synthetic fixture'})
                self.assertFalse(result.isError)
        self.assertTrue(json.loads((work / 'ledger.json').read_text())['submitted'])

    async def test_subscription_runner_forces_chatgpt_and_removes_api_keys(self):
        work = self.root / 'subscription'
        census = agent.Census(work / 'input.png', work, 80, 60)
        census.records['r0c0'] = {'points': [{'x': 10, 'y': 20}], 'uncertain': [], 'notes': 'partial'}
        census.seen.add('r0c0')
        census.save()

        async def events():
            yield json.dumps({'type': 'turn.completed', 'usage': {}}).encode() + b'\n'

        proc = SimpleNamespace(
            stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()),
            stdout=events(),
            returncode=0,
            wait=AsyncMock(return_value=0),
        )
        with (
            patch.dict(
                os.environ, OPENAI_API_KEY='test-openai', CODEX_API_KEY='test-codex', ANTHROPIC_API_KEY='test-anthropic'
            ),
            patch('wildlife_counter.counting_codex.shutil.which', return_value='/test/codex'),
            patch('wildlife_counter.counting_codex.asyncio.create_subprocess_exec', new_callable=AsyncMock) as launch,
        ):
            launch.return_value = proc
            run = {'model': 'openai-responses:gpt-6-astra'}
            persist = AsyncMock()
            await run_codex(run, census, persist)
            self.assertEqual(run['preview']['points'][0]['x'], 10)
            self.assertEqual(run['preview']['regions'][0]['status'], 'recorded')
            self.assertFalse(census.submitted)
            persist.assert_awaited()
        self.assertIn('forced_login_method="chatgpt"', launch.call_args.args)
        for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'):
            self.assertNotIn(key, launch.call_args.kwargs['env'])
        self.assertIn('read-only', launch.call_args.args)
