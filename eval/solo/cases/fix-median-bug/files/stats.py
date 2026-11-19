"""Small statistics helpers used by the reporting job."""


def mean(values):
    if not values:
        raise ValueError("mean of empty list")
    return sum(values) / len(values)


def median(values):
    if not values:
        raise ValueError("median of empty list")
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid]


def percentile(values, p):
    """Nearest-rank percentile, p in [0, 100]."""
    if not values:
        raise ValueError("percentile of empty list")
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, round(p / 100 * len(ordered)) - 1))
    return ordered[k]
