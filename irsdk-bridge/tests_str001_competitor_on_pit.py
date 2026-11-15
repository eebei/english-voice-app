"""STR-001: competitors[].on_pit の契約を、bridge.py の実ソースの式から取り出して検査する。

契約：車ID(car_idx)・同一frame(on_pit_frame=source_frame_sequence)・観測時刻(on_pit_observed_at)に紐付く。
      配列が取れない／範囲外／想定外の値は None（不明）。「入っていない(False)」にはしない。
iRacing/Bridge本体は動かさない（式だけを偽の配列で評価する）。実走・実SDKでの値は未検証。
"""
import re
import sys
import time
import unittest
from pathlib import Path

SRC = (Path(__file__).parent / "bridge.py").read_text(encoding="utf-8")


def _extract_on_pit_expr():
    m = re.search(r"'on_pit': \((bool\(car_on_pitroad_all\[_si\]\)\s*if \(.*?\) else None)\),\n\s*'on_pit_frame'", SRC, re.S)
    assert m, "competitor_status の on_pit 式が見つからない"
    return m.group(1)


def _eval(arr, si):
    expr = _extract_on_pit_expr()
    return eval("(" + expr + ")", {"car_on_pitroad_all": arr, "_si": si})


class CompetitorOnPit(unittest.TestCase):
    def test_true_false(self):
        arr = [0] * 64
        arr[5] = 1
        self.assertIs(_eval(arr, 5), True)
        self.assertIs(_eval(arr, 6), False)

    def test_unknown_is_none_not_false(self):
        self.assertIsNone(_eval(None, 5))            # 配列が取れない
        self.assertIsNone(_eval([], 5))
        self.assertIsNone(_eval([0, 1], 5))          # 範囲外
        arr = [0] * 64
        arr[3] = 2                                    # 想定外の値
        self.assertIsNone(_eval(arr, 3))
        arr[3] = None
        self.assertIsNone(_eval(arr, 3))
        arr[3] = "1"
        self.assertIsNone(_eval(arr, 3))

    def test_entry_carries_frame_and_time_and_driver_declaration_is_not_here(self):
        i = SRC.index("competitor_status.append({")
        block = SRC[i:i + 2200]
        self.assertIn("'on_pit_frame': ((_race_facts_snapshot or {}).get('source_frame') or {}).get('sequence')", block)
        self.assertIn("'on_pit_observed_at': round(time.time(), 3)", block)
        self.assertIn("'car_idx': _si", block)
        self.assertNotIn("declared", block.lower())   # Driver申告はBridgeの観測に混ぜない

    def test_frame_expression_matches_telemetry_live_source_frame_sequence(self):
        # rendererは on_pit_frame == telemetry_live.source_frame_sequence の時だけ「観測」とする。両者が同じ式であること。
        live = "(_race_facts_snapshot.get('source_frame') or {}).get('sequence')"
        self.assertIn("'source_frame_sequence': (\n                    " + live + "),", SRC)


if __name__ == "__main__":
    unittest.main(verbosity=2)
