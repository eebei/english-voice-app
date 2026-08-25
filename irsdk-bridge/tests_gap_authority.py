"""G1: GAP 権威レコードの回帰（2026-08-25）。

実走ログ `OMORAY-bridge-debug-20260823-1403.log` の失敗を固定する。
値・方向・対象車が同時に確定すること、矛盾したら黙ることを検査する。

外部APIは呼ばない。
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import gap_authority as ga  # noqa: E402

SK = 'okayama|gt3|race|2'


class DirectionIsNeverHiddenByAbs(unittest.TestCase):
    """abs() で方向矛盾を隠さない。"""

    def test_negative_signed_gap_is_ahead(self):
        self.assertEqual(ga.signed_gap_direction(-3.8), ga.DIRECTION_AHEAD)

    def test_positive_signed_gap_is_behind(self):
        self.assertEqual(ga.signed_gap_direction(2.4), ga.DIRECTION_BEHIND)

    def test_zero_and_missing_have_no_direction(self):
        for value in (0, None, '', True):
            self.assertIsNone(ga.signed_gap_direction(value))

    def test_rank_direction_uses_class_position(self):
        self.assertEqual(ga.rank_direction(7, 8), ga.DIRECTION_AHEAD)
        self.assertEqual(ga.rank_direction(9, 8), ga.DIRECTION_BEHIND)
        self.assertIsNone(ga.rank_direction(8, 8))
        self.assertIsNone(ga.rank_direction(0, 8))


class ContradictionFailsClosed(unittest.TestCase):
    """順位と物理位置が食い違う時は発話しない。

    実走で `DIR FIX ... EstTime said behind, position says ahead` が出た区間。
    S/F ライン跨ぎで EstTime の符号が反転しうる。
    """

    def test_agreement_resolves(self):
        direction, conflict = ga.resolve_direction(ga.DIRECTION_AHEAD, ga.DIRECTION_AHEAD)
        self.assertEqual(direction, ga.DIRECTION_AHEAD)
        self.assertIsNone(conflict)

    def test_conflict_yields_no_direction(self):
        direction, conflict = ga.resolve_direction(ga.DIRECTION_AHEAD, ga.DIRECTION_BEHIND)
        self.assertIsNone(direction)
        self.assertEqual(conflict, ga.CONFLICT_RANK_VS_PHYSICAL)

    def test_single_source_is_accepted(self):
        self.assertEqual(ga.resolve_direction(ga.DIRECTION_BEHIND, None)[0], ga.DIRECTION_BEHIND)
        self.assertEqual(ga.resolve_direction(None, ga.DIRECTION_AHEAD)[0], ga.DIRECTION_AHEAD)

    def test_record_is_not_speakable_on_conflict(self):
        # 順位は「前」、F2 の符号は「後ろ」。
        record = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=+5.5, target_car_idx=12,
            target_class_position=7, player_class_position=8,
            sampled_at=100.0)
        self.assertFalse(record['speakable'])
        self.assertEqual(record['reason'], ga.CONFLICT_RANK_VS_PHYSICAL)
        self.assertIsNone(ga.speakable_value(record))
        # 値は記録として残るが、喋ってよい値としては出さない。
        self.assertEqual(record['signed_gap_s'], 5.5)


class ValueAndTargetAreDecidedTogether(unittest.TestCase):
    """値だけ後から上書きしない。対象車が取り残されない。"""

    def test_record_carries_target_identity(self):
        record = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=-3.8, target_car_idx=12, target_class='GT3',
            target_class_position=7, player_class_position=8,
            sampled_at=100.0)
        self.assertTrue(record['speakable'])
        self.assertEqual(record['direction'], ga.DIRECTION_AHEAD)
        self.assertEqual(record['gap_s'], 3.8)          # 表示値は正数
        self.assertEqual(record['signed_gap_s'], -3.8)  # 符号は保持
        self.assertEqual(record['target_car_idx'], 12)
        self.assertEqual(record['target_class'], 'GT3')
        self.assertEqual(record['target_class_position'], 7)
        self.assertEqual(record['sampled_at'], 100.0)

    def test_missing_target_is_not_speakable(self):
        record = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=-3.8, target_car_idx=None,
            target_class_position=7, player_class_position=8, sampled_at=100.0)
        self.assertFalse(record['speakable'])
        self.assertEqual(record['reason'], ga.CONFLICT_NO_TARGET)

    def test_missing_value_is_not_speakable(self):
        record = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=None, target_car_idx=12,
            target_class_position=7, player_class_position=8, sampled_at=100.0)
        self.assertFalse(record['speakable'])
        self.assertEqual(record['reason'], ga.CONFLICT_NO_VALUE)


class GenerationTracksTargetChange(unittest.TestCase):
    """対象車・方向・セッションが変われば世代が進む＝旧候補は別物になる。"""

    def _rec(self, *, idx, direction_sign, previous=None, session_key=SK):
        return ga.build_record(
            session_key=session_key, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=direction_sign * 4.0, target_car_idx=idx,
            target_class_position=7 if direction_sign < 0 else 9,
            player_class_position=8, sampled_at=100.0, previous=previous)

    def test_same_target_keeps_generation(self):
        first = self._rec(idx=12, direction_sign=-1)
        second = self._rec(idx=12, direction_sign=-1, previous=first)
        self.assertEqual(first['generation'], second['generation'])

    def test_overtake_changes_generation(self):
        """追越しで対象車が入れ替わったら別世代。旧候補を再生してはいけない。"""
        first = self._rec(idx=12, direction_sign=-1)
        after = self._rec(idx=31, direction_sign=-1, previous=first)
        self.assertNotEqual(first['generation'], after['generation'])

    def test_direction_flip_changes_generation(self):
        first = self._rec(idx=12, direction_sign=-1)
        flipped = self._rec(idx=12, direction_sign=+1, previous=first)
        self.assertNotEqual(first['generation'], flipped['generation'])

    def test_session_change_changes_generation(self):
        first = self._rec(idx=12, direction_sign=-1)
        other = self._rec(idx=12, direction_sign=-1, previous=first,
                          session_key='monza|gt3|race|3')
        self.assertNotEqual(first['generation'], other['generation'])


class SameClassRecordsComeFromOneSource(unittest.TestCase):
    """隣接順位の値と car_idx を同じ場所から取る（取り残しの根絶）。"""

    STANDINGS = {
        7: {'car_idx': 12, 'signed_gap_s': -5.5},
        9: {'car_idx': 31, 'signed_gap_s': +3.0},
    }

    def test_both_directions_built(self):
        out = ga.build_same_class_records(
            session_key=SK, sampled_at=100.0, standings_by_pos=self.STANDINGS,
            player_class_position=8, player_class='GT3')
        ahead, behind = out[ga.DIRECTION_AHEAD], out[ga.DIRECTION_BEHIND]
        self.assertEqual((ahead['gap_s'], ahead['target_car_idx']), (5.5, 12))
        self.assertEqual((behind['gap_s'], behind['target_car_idx']), (3.0, 31))
        self.assertTrue(ahead['speakable'] and behind['speakable'])

    def test_string_keys_are_accepted(self):
        out = ga.build_same_class_records(
            session_key=SK, sampled_at=100.0,
            standings_by_pos={'7': {'car_idx': 12, 'signed_gap_s': -5.5}},
            player_class_position=8)
        self.assertEqual(out[ga.DIRECTION_AHEAD]['target_car_idx'], 12)

    def test_absent_neighbour_yields_none(self):
        out = ga.build_same_class_records(
            session_key=SK, sampled_at=100.0, standings_by_pos={},
            player_class_position=8)
        self.assertIsNone(out[ga.DIRECTION_AHEAD])
        self.assertIsNone(out[ga.DIRECTION_BEHIND])

    def test_no_player_position_yields_nothing(self):
        for pos in (None, 0, -1):
            out = ga.build_same_class_records(
                session_key=SK, sampled_at=100.0,
                standings_by_pos=self.STANDINGS, player_class_position=pos)
            self.assertIsNone(out[ga.DIRECTION_AHEAD])


class SourceKindsStaySeparate(unittest.TestCase):
    """同クラス順位GAPと物理接近GAPを一つの値へ上書きしない。"""

    def test_kinds_are_distinct_constants(self):
        self.assertNotEqual(ga.SOURCE_SAME_CLASS_BATTLE, ga.SOURCE_PHYSICAL_TRAFFIC)

    def test_kind_change_is_a_different_generation(self):
        battle = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_SAME_CLASS_BATTLE,
            signed_gap_s=-2.0, target_car_idx=12,
            target_class_position=7, player_class_position=8, sampled_at=100.0)
        traffic = ga.build_record(
            session_key=SK, source_kind=ga.SOURCE_PHYSICAL_TRAFFIC,
            signed_gap_s=-2.0, target_car_idx=12,
            target_class_position=7, player_class_position=8,
            sampled_at=100.0, previous=battle)
        self.assertNotEqual(battle['generation'], traffic['generation'])


class FieldFailureIsReproduced(unittest.TestCase):
    """8/23 実走の具体値をそのまま固定する。"""

    def test_1911_behind_value_follows_its_own_target(self):
        """19:11:59『後ろ3.8秒』の直後に DATA CHECK が gapBehind:0.6 だった件。

        別々の権威が別々の対象で値を作れば必ず食い違う。
        同じ standings から作れば、値も対象も一つに決まる。
        """
        out = ga.build_same_class_records(
            session_key=SK, sampled_at=100.0,
            standings_by_pos={9: {'car_idx': 31, 'signed_gap_s': +0.6}},
            player_class_position=8)
        behind = out[ga.DIRECTION_BEHIND]
        self.assertEqual(behind['gap_s'], 0.6)
        self.assertEqual(behind['target_car_idx'], 31)
        self.assertEqual(behind['direction'], ga.DIRECTION_BEHIND)

    def test_1914_ahead_change_is_a_new_generation(self):
        """19:14:16 に『前5.5秒』を作り、19:14:24 には gapAhead:0.7 になっていた。

        同じ対象なら世代は変わらないので、G2 は値の再取得で対応する。
        対象が変わっていれば世代が変わり、旧候補は破棄になる。
        """
        first = ga.build_same_class_records(
            session_key=SK, sampled_at=100.0,
            standings_by_pos={7: {'car_idx': 12, 'signed_gap_s': -5.5}},
            player_class_position=8)
        later_same_car = ga.build_same_class_records(
            session_key=SK, sampled_at=108.0,
            standings_by_pos={7: {'car_idx': 12, 'signed_gap_s': -0.7}},
            player_class_position=8, previous=first)
        self.assertEqual(first[ga.DIRECTION_AHEAD]['generation'],
                         later_same_car[ga.DIRECTION_AHEAD]['generation'])
        self.assertEqual(later_same_car[ga.DIRECTION_AHEAD]['gap_s'], 0.7)

        later_other_car = ga.build_same_class_records(
            session_key=SK, sampled_at=108.0,
            standings_by_pos={7: {'car_idx': 44, 'signed_gap_s': -0.7}},
            player_class_position=8, previous=first)
        self.assertNotEqual(first[ga.DIRECTION_AHEAD]['generation'],
                            later_other_car[ga.DIRECTION_AHEAD]['generation'])


class ApplyIsBehaviourNotStrings(unittest.TestCase):
    """bridge が呼ぶ唯一の入口を挙動で守る。

    ここを文字列検査だけにすると、実際に壊れてもテストが通る
    （G1f 変異で実証済み）。判断はこの関数が持つ。
    """

    STANDINGS = {7: {'car_idx': 12, 'signed_gap_s': -5.5},
                 9: {'car_idx': 31, 'signed_gap_s': +3.0}}

    def _apply(self, standings, **kw):
        return ga.apply_same_class_records(
            session_key=SK, sampled_at=100.0, standings_by_pos=standings,
            player_class_position=kw.pop('pos', 8), **kw)

    def test_values_and_target_ids_are_applied_together(self):
        _, applied, traces = self._apply(self.STANDINGS)
        self.assertEqual(applied['ahead_gap'], 5.5)
        self.assertEqual(applied['ahead_idx'], 12)
        self.assertEqual(applied['behind_gap'], 3.0)
        self.assertEqual(applied['behind_idx'], 31)
        self.assertEqual(traces, [])

    def test_conflicting_direction_applies_nothing_and_traces(self):
        # 順位は前(7)なのに符号は後ろ(+)。値だけ使われてはいけない。
        _, applied, traces = self._apply({7: {'car_idx': 12, 'signed_gap_s': +5.5}})
        self.assertIsNone(applied['ahead_gap'])
        self.assertIsNone(applied['ahead_idx'])
        self.assertEqual(traces[0]['reason'], ga.CONFLICT_RANK_VS_PHYSICAL)
        self.assertEqual(traces[0]['direction'], ga.DIRECTION_AHEAD)

    def test_missing_target_applies_nothing(self):
        _, applied, traces = self._apply({7: {'car_idx': None, 'signed_gap_s': -5.5}})
        self.assertIsNone(applied['ahead_gap'])
        self.assertEqual(traces[0]['reason'], ga.CONFLICT_NO_TARGET)

    def test_one_direction_can_apply_while_the_other_is_silent(self):
        _, applied, traces = self._apply({7: {'car_idx': 12, 'signed_gap_s': +5.5},
                                          9: {'car_idx': 31, 'signed_gap_s': +3.0}})
        self.assertIsNone(applied['ahead_gap'])       # 矛盾 → 黙る
        self.assertEqual(applied['behind_gap'], 3.0)  # 正常 → 出す
        self.assertEqual(len(traces), 1)

    def test_target_change_advances_generation_through_apply(self):
        first, _, _ = self._apply(self.STANDINGS)
        second, applied, _ = ga.apply_same_class_records(
            session_key=SK, sampled_at=108.0,
            standings_by_pos={7: {'car_idx': 44, 'signed_gap_s': -0.7}},
            player_class_position=8, previous=first)
        self.assertEqual(applied['ahead_idx'], 44)
        self.assertNotEqual(first[ga.DIRECTION_AHEAD]['generation'],
                            second[ga.DIRECTION_AHEAD]['generation'])


class BridgeWiringUsesTheAuthority(unittest.TestCase):
    """bridge が権威レコード経由になっていること（値だけの上書きに戻っていない）。"""

    def setUp(self):
        with open(os.path.join(HERE, 'bridge.py'), encoding='utf-8') as fh:
            self.src = fh.read()

    def test_value_only_abs_overwrite_is_gone(self):
        # 8/23 の誤数値の直接原因。復活したら必ず落とす。
        self.assertNotIn('nearest_ahead_gap = abs(_adj_ahead)', self.src)
        self.assertNotIn('nearest_behind_gap = abs(_adj_behind)', self.src)

    def test_standings_carry_car_idx(self):
        self.assertIn("standings_by_pos[_spos] = {'car_idx': _si, 'signed_gap_s': _signed}", self.src)

    def test_bridge_builds_records_and_updates_target_idx(self):
        self.assertIn('gap_authority.apply_same_class_records(', self.src)
        self.assertIn("nearest_ahead_idx = _applied['ahead_idx']", self.src)
        self.assertIn("nearest_behind_idx = _applied['behind_idx']", self.src)

    def test_unspeakable_record_is_traced_not_spoken(self):
        self.assertIn('GAP AUTHORITY: %s not speakable reason=%s', self.src)
        self.assertIn("_t['reason']", self.src)

    def test_records_are_cleared_on_both_session_boundaries(self):
        # Build 281 P1-2：片系統だけのリセットは前セッションの事実を流出させる。
        self.assertIn("'gap_authority_records': {}", self.src)
        self.assertIn("gap_authority_records = _reset['gap_authority_records']", self.src)
        self.assertIn("gap_authority_records = _sig_reset['gap_authority_records']", self.src)


class ProactiveCallReadsTheAuthority(unittest.TestCase):
    """G1b: 自発コールと質問回答が同じ値を読む（二重権威の解消）。

    移動前は `gap_call_policy.observe()` が権威レコードより 390 行前にあり、
    自発コールだけ EstTime 値を読んでいた。19:11:59『後ろ3.8秒』の直後に
    DATA CHECK が `gapBehind:0.6` を出した食い違いはこれ。

    行番号で順序を固定する。並べ替えで壊れたら必ず落ちる。
    """

    def setUp(self):
        with open(os.path.join(HERE, 'bridge.py'), encoding='utf-8') as fh:
            self.lines = fh.read().split('\n')

    def _line_of(self, needle):
        for i, line in enumerate(self.lines, 1):
            if needle in line:
                return i
        self.fail('not found: ' + needle)

    def test_authority_runs_before_the_proactive_call(self):
        authority = self._line_of('gap_authority.apply_same_class_records(')
        observe = self._line_of('_gap_event = gap_call_policy.observe(')
        self.assertLess(authority, observe,
                        'observe() must read authority values, not EstTime leftovers')

    def test_live_context_refresh_also_runs_after_the_authority(self):
        """保留中の GAP を旧スナップショットで解放しないため、
        `_update_gap_live_context()` も権威の後ろでなければならない。"""
        authority = self._line_of('gap_authority.apply_same_class_records(')
        context = self._line_of('_gap_generation = _update_gap_live_context(')
        self.assertLess(authority, context)

    def test_held_gap_is_flushed_after_the_context_refresh(self):
        context = self._line_of('_gap_generation = _update_gap_live_context(')
        for i in range(context, len(self.lines)):
            if self.lines[i].strip() == 'flush_radio()':
                return
        self.fail('flush_radio() must follow the refreshed GAP context')


if __name__ == '__main__':
    unittest.main(verbosity=2)
