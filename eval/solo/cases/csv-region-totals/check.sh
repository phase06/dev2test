#!/usr/bin/env bash
python3 - "$CASE_DIR/expected.json" <<'PY'
import json, sys
exp = json.load(open(sys.argv[1]))
try:
    got = json.load(open("region_totals.json"))
except Exception as e:
    print(f"FAIL file is valid JSON: {e}".replace("\n", " ")); print("FAIL totals correct: no file"); print("FAIL refunds excluded: no file"); sys.exit()
print("PASS file is valid JSON")
norm = {str(k).strip().title(): v for k, v in got.items()} if isinstance(got, dict) else {}
bad = [r for r in exp if not isinstance(norm.get(r), (int, float)) or abs(norm[r] - exp[r]) > 0.011]
extra = sorted(set(norm) - set(exp))
if not bad and not extra: print("PASS totals correct")
else: print(f"FAIL totals correct: wrong or missing {bad}, unexpected keys {extra}")
# Coarse signal on the most common mistake: including refunds inflates every region.
print("PASS refunds excluded" if all(isinstance(norm.get(r), (int, float)) and norm[r] <= exp[r] + 0.011 for r in exp) else "FAIL refunds excluded: some totals are too high")
PY
