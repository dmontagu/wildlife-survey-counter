import unittest

from scripts.eval_census_run import compare


class EvaluationTests(unittest.TestCase):
    def fixture(self):
        run = dict(
            id='test',
            image_filename='test.jpg',
            image_sha256='same',
            status='complete',
            annotations=[dict(x=10, y=10), dict(x=11, y=10)],
            uncertain=[],
            usage={},
        )
        audit = dict(audit=dict(image_sha256='same'), annotations=[dict(x=10, y=10), dict(x=100, y=100)])
        return run, audit

    def test_equal_counts_do_not_hide_duplicate_and_miss(self):
        run, audit = self.fixture()
        result = compare(run, audit, 5)
        self.assertEqual(result['count_difference'], 0)
        self.assertEqual(result['matched'], 1)
        self.assertEqual(len(result['unmatched_predictions']), 1)
        self.assertEqual(len(result['unmatched_audit']), 1)

    def test_wrong_source_and_incomplete_run_are_not_scored(self):
        run, audit = self.fixture()
        run['image_sha256'] = 'different'
        with self.assertRaisesRegex(ValueError, 'hashes'):
            compare(run, audit, 5)
        run['status'] = 'error'
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            compare(run, audit, 5)
