from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from pydantic_ai import BinaryContent
from scripts import build_dataset, census, make_training_data

from wildlife_counter.agent import submit_annotations
from wildlife_counter.sandbox import SubprocessSandbox


class CensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / 'test.png'
        Image.new('RGB', (81, 61), 'white').save(self.image)
        self.output = self.root / 'run'
        census.prepare(self.image, self.output, core=40, halo=10)

    def tearDown(self):
        self.temp.cleanup()

    def review(self):
        r = json.loads((self.output / 'review.json').read_text())
        r['reviewer'] = 'test'
        r['method'] = 'synthetic test'
        for t in r['tiles'].values():
            t['status'] = 'reviewed'
        return r

    def save_review(self, review):
        census.write_json(self.output / 'review.json', review)

    def test_every_pixel_has_exactly_one_owner_including_boundaries(self):
        ts = census.tiles(81, 61, 40, 10)
        for y in range(61):
            for x in range(81):
                self.assertEqual(sum(census.contains(t['core'], x, y) for t in ts), 1)
        self.assertFalse(any(census.contains(t['core'], 81, 61) for t in ts))

    def test_pending_regions_cannot_be_reported_as_complete(self):
        with self.assertRaisesRegex(ValueError, 'Reviewer'):
            census.finalize(self.output)
        review = self.review()
        review['tiles']['r00c01']['status'] = 'pending'
        self.save_review(review)
        with self.assertRaisesRegex(ValueError, 'unreviewed tiles'):
            census.finalize(self.output)

    def test_uncertainty_is_separate_and_distinct_neighbors_survive(self):
        review = self.review()
        review['tiles']['r00c00']['points'] = [[39, 20]]
        review['tiles']['r00c01']['points'] = [[40, 20]]
        review['tiles']['r00c01']['uncertain'] = [[45, 25]]
        self.save_review(review)
        result = census.finalize(self.output)
        self.assertEqual(result['count_interval'], [2, 3])
        self.assertFalse(result['accuracy_certified'])
        annotations = json.loads((self.output / 'annotations.json').read_text())['annotations']
        self.assertEqual(len(annotations), 2)
        self.assertTrue(all(a['category'] == 'unclassified' for a in annotations))
        self.assertTrue(all(a['reviewStatus'] == 'unconfirmed' for a in annotations))

    def test_bad_coordinates_and_duplicates_fail(self):
        for points in ([[40, 20]], [[float('nan'), 20]], [[1, 1], [1, 1]]):
            review = self.review()
            review['tiles']['r00c00']['points'] = points
            self.save_review(review)
            with self.assertRaises(ValueError):
                census.finalize(self.output)

    def test_source_change_invalidates_review(self):
        self.save_review(self.review())
        Image.new('RGB', (81, 61), 'black').save(self.image)
        with self.assertRaisesRegex(ValueError, 'Source image has changed'):
            census.finalize(self.output)

    def test_consolidation_retains_raw_evidence_and_separate_neighbors(self):
        points = [
            {'id': 1, 'x': 20, 'y': 20, 'confidence': 0.9, 'bbox': [10, 10, 30, 30]},
            {'id': 2, 'x': 21, 'y': 20, 'confidence': 0.8, 'bbox': [11, 10, 31, 30]},
            {'id': 3, 'x': 30, 'y': 20, 'confidence': 0.7, 'bbox': [20, 10, 40, 30]},
        ]
        census.write_json(self.output / 'proposals.json', {'points': points})
        census.consolidate(self.output)
        result = json.loads((self.output / 'candidates.json').read_text())['points']
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['raw_ids'], [1, 2])
        self.assertEqual(json.loads((self.output / 'proposals.json').read_text())['points'], points)


class SandboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_images_are_image_content_and_python_uses_same_interpreter(self):
        with tempfile.TemporaryDirectory() as temp:
            sandbox = SubprocessSandbox(Path(temp))
            Image.new('RGB', (20, 20)).save(Path(temp) / 'input.png')
            result = await sandbox.execute(
                'import sys\nfrom PIL import Image\n'
                'Image.open("input.png").crop((0,0,10,10)).save("crop.png")\n'
                'print(sys.executable)'
            )
            self.assertEqual(result.exit_code, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), sys.executable)
            content = await sandbox.read_file('crop.png')
            self.assertIsInstance(content, BinaryContent)
            self.assertEqual(content.media_type, 'image/png')
            self.assertEqual(content.data, (Path(temp) / 'crop.png').read_bytes())
            self.assertIn('Error', await sandbox.read_file('../input.png'))

    async def test_submission_rejects_invalid_coordinates_before_changing_result(self):
        deps = SimpleNamespace(image_width=100, image_height=50, result_annotations=['previous'])
        ctx = SimpleNamespace(deps=deps)
        for points in (
            [{'x': 100, 'y': 2}],
            [{'x': -1, 'y': 2}],
            [{'x': 1, 'y': float('nan')}],
            [{'x': 1, 'y': 2, 'confidence': 1.1}],
        ):
            response = await submit_annotations(ctx, json.dumps(points), 'test')
            self.assertTrue(response.startswith('Error'))
            self.assertEqual(deps.result_annotations, ['previous'])
        response = await submit_annotations(ctx, '[{"x":99.9,"y":49.9}]', 'test')
        self.assertTrue(response.startswith('Submitted'))
        self.assertEqual((deps.result_annotations[0]['x'], deps.result_annotations[0]['y']), (99, 49))


class TrainingTests(unittest.TestCase):
    def test_tiles_clip_boxes_and_include_partially_visible_animals(self):
        lines = make_training_data.tile_labels([(-5, 10), (639, 639), (700, 700)], 0, 0, 20)
        self.assertEqual(len(lines), 2)
        for line in lines:
            _, x, y, w, h = map(float, line.split())
            self.assertGreaterEqual(x - w / 2, -1e-6)
            self.assertLessEqual(x + w / 2, 1 + 1e-6)
            self.assertGreaterEqual(y - h / 2, -1e-6)
            self.assertLessEqual(y + h / 2, 1 + 1e-6)
        self.assertEqual(make_training_data.tile_origins(100), [0])
        self.assertEqual(make_training_data.tile_origins(1200), [0, 512, 560])

    def test_rebuilding_drops_stale_tiles_from_excluded_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dataset, output = root / 'dataset', root / 'training'
            dataset.mkdir()
            census.write_json(
                dataset / 'manifest.json',
                {
                    'images': [
                        {'stem': 'suspect', 'image_file': 'missing.jpg', 'tier': 'unreviewed-suspect'},
                    ]
                },
            )
            census.write_json(dataset / 'calibration.json', {})
            for kind in ['images', 'labels']:
                (output / kind / 'train').mkdir(parents=True)
                (output / kind / 'train' / 'stale.txt').write_text('stale')
            with (
                patch.object(make_training_data, 'DATASET_DIR', dataset),
                patch.object(make_training_data, 'OUT_DIR', output),
            ):
                make_training_data.main()
            self.assertEqual(list((output / 'images' / 'train').iterdir()), [])
            self.assertEqual(list((output / 'labels' / 'train').iterdir()), [])
            self.assertTrue((output / 'dataset.yaml').exists())

    def test_audit_overrides_require_source_identity_and_separate_uncertainty(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / 'elk.png'
            Image.new('RGB', (20, 20)).save(image)
            audit = {
                'image': {'filename': 'elk.png', 'width': 20, 'height': 20},
                'annotations': [{'x': 5, 'y': 5, 'state': 'auto-detected'}],
                'audit': {
                    'image_sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                    'coverage': 'all tiles reviewed',
                    'reviewer': 'test',
                    'method': 'test',
                    'visible_count': 1,
                    'possible_additional': 1,
                    'count_interval': [1, 2],
                    'uncertain': [{'x': 10, 'y': 10}],
                    'training_eligible': False,
                },
            }
            census.write_json(root / 'audit.json', audit)
            self.assertIn('elk', build_dataset.load_audits({'elk': image}, root))
            audit['audit']['training_eligible'] = True
            census.write_json(root / 'audit.json', audit)
            with self.assertRaisesRegex(ValueError, 'Uncertain audit'):
                build_dataset.load_audits({'elk': image}, root)
            audit['audit']['training_eligible'] = False
            audit['audit']['image_sha256'] = 'wrong'
            census.write_json(root / 'audit.json', audit)
            with self.assertRaisesRegex(ValueError, 'source image'):
                build_dataset.load_audits({'elk': image}, root)


if __name__ == '__main__':
    unittest.main()
