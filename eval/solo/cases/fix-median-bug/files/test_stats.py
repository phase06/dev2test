import unittest

from stats import mean, median, percentile


class StatsTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3, 4]), 2.5)

    def test_median_odd(self):
        self.assertEqual(median([3, 1, 2]), 2)

    def test_median_even(self):
        self.assertEqual(median([4, 1, 3, 2]), 2.5)

    def test_median_unsorted_even(self):
        self.assertEqual(median([10, 0, 7, 3]), 5)

    def test_percentile(self):
        self.assertEqual(percentile([15, 20, 35, 40, 50], 40), 20)

    def test_empty(self):
        with self.assertRaises(ValueError):
            median([])


if __name__ == "__main__":
    unittest.main()
