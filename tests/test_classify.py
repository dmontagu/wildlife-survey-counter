import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from PIL import Image

from wildlife_counter import counting
from wildlife_counter.classify import Classification, Label, ToolError, finish, record_classes, view_batch
from wildlife_counter.classify_run import estimate_animal_px
from wildlife_counter.config import settings
from wildlife_counter.db import init_db


def jpeg(width=200, height=120) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='JPEG')
    return out.getvalue()


class ClassificationToolTests(unittest.TestCase):
    def classification(self, points):
        root = Path(tempfile.mkdtemp())
        image = root / 'source.jpg'
        image.write_bytes(jpeg())
        return Classification(image, root / 'work', 200, 120, points, animal_px=20)

    def test_every_elk_in_a_viewed_batch_must_be_labelled_exactly_once(self):
        c = self.classification([dict(x=10, y=10), dict(x=40, y=10)])
        with self.assertRaisesRegex(ToolError, 'View the batch'):
            record_classes(c, 'b1', [Label(id=1, cls='cow'), Label(id=2, cls='spike')])
        view_batch(c, 'b1')
        with self.assertRaisesRegex(ToolError, r'Missing: \[2\]'):
            record_classes(c, 'b1', [Label(id=1, cls='cow')])
        with self.assertRaisesRegex(ToolError, 'Unrecorded batches'):
            finish(c, 'done')
        record_classes(c, 'b1', [Label(id=1, cls='cow'), Label(id=2, cls='spike')])
        self.assertEqual(finish(c, 'done')['by_class'], {'cow': 1, 'spike': 1})

    def test_host_rechecks_completion_from_saved_state(self):
        c = self.classification([dict(x=10, y=10)])
        view_batch(c, 'b1')
        record_classes(c, 'b1', [Label(id=1, cls='calf')])
        finish(c, 'done')
        reloaded = Classification(c.image_path, c.work_dir, 200, 120, c.points, animal_px=20)
        reloaded.load()
        self.assertTrue(reloaded.submitted)
        # A forged "submitted" flag without labels is not trusted.
        (c.work_dir / 'classes.json').write_text(
            '{"viewed": [], "recorded": [], "labels": {}, "submitted": true, "summary": ""}'
        )
        reloaded.load()
        self.assertFalse(reloaded.submitted)

    def test_animal_size_estimate_is_bounded(self):
        self.assertEqual(estimate_animal_px([]), 80.0)
        grid = [dict(x=x * 50.0, y=y * 50.0) for x in range(5) for y in range(5)]
        self.assertAlmostEqual(estimate_animal_px(grid), 66.0)
        self.assertEqual(estimate_animal_px([dict(x=0.0, y=0.0)] * 5), 8.0)


class ClassificationAPITests(unittest.IsolatedAsyncioTestCase):
    client_token = '0d9b2c55-6f3c-4a39-9a51-1c2f62a8b0aa'

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patch = patch.multiple(
            settings,
            db_path=root / 'runs.db',
            sandbox_work_dir=root / 'work',
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

    @staticmethod
    async def fake_classify(c, run, model, effort, on_event=None):
        c.labels = {i: dict(cls='spike' if i == 1 else 'cow', note='') for i in range(1, len(c.points) + 1)}
        c.submitted = True
        run['estimated_cost_usd'] = 0.25
        return True

    async def test_classifies_current_markers_by_their_own_ids(self):
        points = '[{"id": 7, "x": 10, "y": 10}, {"id": 42, "x": 100, "y": 50}]'
        with patch.object(counting, 'run_classification', self.fake_classify):
            response = await self.client.post(
                '/api/counting/classify', files={'file': ('a.jpg', jpeg())}, data={'points': points}
            )
            self.assertEqual(response.status_code, 202)
            run_id = response.json()['id']
            await counting.tasks[run_id]
        run = (await self.client.get(f'/api/counting/runs/{run_id}')).json()
        self.assertEqual(run['status'], 'complete')
        self.assertEqual(run['classes'], {'7': 'spike', '42': 'cow'})
        self.assertEqual(run['estimated_cost_usd'], 0.25)
        # Classification jobs never answer "is this image counted?".
        listed = await self.client.get('/api/counting/runs', params={'sha256': run['image_sha256']})
        self.assertEqual(listed.json(), [])

    async def test_rejects_markers_outside_the_image_or_with_duplicate_ids(self):
        for points in [
            '[{"id": 1, "x": 500, "y": 10}]',
            '[{"id": 1, "x": 1, "y": 1}, {"id": 1, "x": 2, "y": 2}]',
            '[]',
        ]:
            response = await self.client.post(
                '/api/counting/classify', files={'file': ('a.jpg', jpeg())}, data={'points': points}
            )
            self.assertEqual(response.status_code, 422, points)
        self.assertFalse(counting.tasks)

    async def count_and_classify(self, classifier):
        async def fake_census(run, census, persist):
            first = next(iter(census.regions))
            census.records[first] = dict(points=[dict(x=10, y=10), dict(x=30, y=20)], uncertain=[], notes='')
            census.submitted = True
            run['estimated_cost_usd'] = 1.0

        with (
            patch('wildlife_counter.counting_codex.run_codex', fake_census),
            patch.object(counting, 'run_classification', classifier),
        ):
            response = await self.client.post(
                '/api/counting/runs', params={'classify': 'true'}, files={'file': ('b.jpg', jpeg())}
            )
            run_id = response.json()['id']
            await counting.tasks[run_id]
        return (await self.client.get(f'/api/counting/runs/{run_id}')).json()

    async def test_count_and_classify_labels_the_census_points_and_adds_the_cost(self):
        run = await self.count_and_classify(self.fake_classify)
        self.assertEqual(run['status'], 'complete')
        self.assertTrue(run['classified'])
        self.assertEqual([a['category'] for a in run['annotations']], ['spike', 'cow'])
        self.assertEqual(run['estimated_cost_usd'], 1.25)

    async def test_failed_classification_keeps_the_count_and_leaves_markers_unclassified(self):
        async def failing(c, run, model, effort, on_event=None):
            run['error'] = '429 Too Many Requests'
            return False

        run = await self.count_and_classify(failing)
        self.assertEqual(run['status'], 'complete')
        self.assertEqual(len(run['annotations']), 2)
        self.assertEqual({a['category'] for a in run['annotations']}, {'unclassified'})
        self.assertIn('429', run['classification_error'])


if __name__ == '__main__':
    unittest.main()
