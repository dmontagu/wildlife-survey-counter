import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from wildlife_counter.counting_agent import Census, split_region


class SplitRegionTests(unittest.TestCase):
    def census(self):
        return Census(Path('unused.png'), Path(tempfile.mkdtemp()), 1684, 972, region_size=400)

    def test_thin_edge_strip_splits_along_its_long_side(self):
        # Regression: an 84px-wide edge strip with >20 animals could be neither split nor recorded.
        children = split_region(SimpleNamespace(deps=self.census()), 'r0c4')  # pyright: ignore[reportArgumentType]
        self.assertEqual(list(children.values()), [[1600, 0, 1684, 200], [1600, 200, 1684, 400]])

    def test_regular_region_splits_into_quadrants(self):
        children = split_region(SimpleNamespace(deps=self.census()), 'r0c0')  # pyright: ignore[reportArgumentType]
        self.assertEqual(len(children), 4)


if __name__ == '__main__':
    unittest.main()
