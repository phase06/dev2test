#!/usr/bin/env bash
python3 - "$CASE_DIR/expected.json" <<'PY'
import json, sys
exp = json.load(open(sys.argv[1]))
try:
    got = json.load(open("incidents.json"))
    assert isinstance(got, list)
except Exception as e:
    for n in ["file is a JSON list", "codes complete", "counts correct", "first_seen correct", "sorted by count"]: print(f"FAIL {n}: incidents.json missing or not a list")
    sys.exit()
print("PASS file is a JSON list")
by = {str(x.get("code")): x for x in got if isinstance(x, dict)}
want = {x["code"]: x for x in exp}
print("PASS codes complete" if set(by) == set(want) else f"FAIL codes complete: got {sorted(by)}, want {sorted(want)}")
wrong = [c for c in want if by.get(c, {}).get("count") != want[c]["count"]]
print("PASS counts correct" if not wrong else f"FAIL counts correct: wrong for {wrong} (WARN lines are not errors)")
wrong = [c for c in want if by.get(c, {}).get("first_seen") != want[c]["first_seen"]]
print("PASS first_seen correct" if not wrong else f"FAIL first_seen correct: wrong for {wrong}")
counts = [x.get("count", 0) for x in got if isinstance(x, dict)]
print("PASS sorted by count" if counts == sorted(counts, reverse=True) else "FAIL sorted by count")
PY
