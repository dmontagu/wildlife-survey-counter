import random
import unittest

from scripts.census_evals import localization


class LocalizationTests(unittest.TestCase):
    ref = [dict(x=100.0 * i, y=100.0 * j) for i in range(1, 6) for j in range(1, 6)]

    def test_right_count_in_wrong_places_scores_near_zero(self):
        rng = random.Random(0)
        shuffled = [dict(x=rng.uniform(0, 5000), y=rng.uniform(1000, 5000)) for _ in self.ref]
        scores = localization(shuffled, self.ref, [], 20)
        self.assertEqual(len(shuffled), len(self.ref))
        self.assertLess(scores['f1'], 0.1)

    def test_small_jitter_within_radius_is_a_perfect_match(self):
        jittered = [dict(x=p['x'] + 5, y=p['y'] - 5) for p in self.ref]
        self.assertEqual(localization(jittered, self.ref, [], 20)['f1'], 1.0)

    def test_two_points_on_one_animal_cost_precision_not_recall(self):
        doubled = self.ref + [dict(x=102.0, y=100.0)]
        scores = localization(doubled, self.ref, [], 20)
        self.assertEqual(scores['recall'], 1.0)
        self.assertEqual(scores['false_positives'], 1)

    def test_point_on_a_reference_possible_animal_is_neutral(self):
        possible = [dict(x=900.0, y=900.0, reason='overlap')]
        scores = localization(self.ref + [dict(x=905.0, y=900.0)], self.ref, possible, 20)
        self.assertEqual(scores['f1'], 1.0)
        self.assertEqual(scores['neutral_possible'], 1)

    def test_empty_prediction_on_empty_image_is_correct(self):
        self.assertEqual(localization([], [], [], 20)['f1'], 1.0)
        self.assertEqual(localization([], self.ref, [], 20)['f1'], 0.0)


if __name__ == '__main__':
    unittest.main()
