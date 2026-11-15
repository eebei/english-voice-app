#!/usr/bin/env python3
"""U1だけを入れた「計測用候補」を、Build306(基準 896f47d)から作る。STR-001の戦略変更（pit-strategy-compare・server.js・router・on_pit）は含めない。
  python3 tools/u1-make-candidate.py <outdir>
現在のworktreeのU1差分（独立ファイル＋bridge.py/renderer.htmlのU1ブロック＋main.js/irsdk_mem.py）を、基準tree(git archive)へ移植する。
移植できなかった箇所があれば失敗する（黙って欠けない）。出力: <outdir>/tree（候補）, <outdir>/u1-only.patch（基準との差分）"""
import os, re, shutil, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = '896f47d'
out = sys.argv[1]
tree = os.path.join(out, 'tree')
shutil.rmtree(out, ignore_errors=True)
os.makedirs(tree)
subprocess.run('git archive %s | tar -x -C %s' % (BASE, tree), shell=True, cwd=ROOT, check=True)
subprocess.run(['ln', '-s', os.path.join(ROOT, 'node_modules'), os.path.join(tree, 'node_modules')], check=True)

def rd(p): return open(os.path.join(ROOT, p), encoding='utf-8').read()
def wr(p, s): open(os.path.join(tree, p), 'w', encoding='utf-8').write(s)
def rb(p): return open(os.path.join(tree, p), encoding='utf-8').read()

# 1) U1の独立ファイル・検査・計測ツール（共有ファイルのharnessは検査用）
for p in ['irsdk-bridge/field_snapshot.py', 'irsdk-bridge/tests_u1_field_snapshot.py', 'desktop/field-snapshot.js', 'tests-u1-field-snapshot-e2e.js',
          'tools/u1-dump-replay.py', 'tools/u1-measure.py', 'tools/u1-mutate.py', 'tests-fullrenderer-harness.js']:
    shutil.copy(os.path.join(ROOT, p), os.path.join(tree, p))
# 共有ファイルのうちU1しか触っていないもの
for p in ['irsdk-bridge/irsdk_mem.py', 'irsdk-bridge/replay_harness.py', 'desktop/main.js']:
    shutil.copy(os.path.join(ROOT, p), os.path.join(tree, p))

def block(src, start, end_marker, include_end=False):
    i = src.index(start)
    j = src.index(end_marker, i)
    return src[i:(j + len(end_marker) if include_end else j)]

def insert_before(s, anchor, text, count=1):
    assert s.count(anchor) == count, (anchor, s.count(anchor))
    return s.replace(anchor, text + anchor, 1)

# 2) bridge.py：5か所
cur = rd('irsdk-bridge/bridge.py'); b = rb('irsdk-bridge/bridge.py')
b = b.replace('import pit_loss_calibrator as pit_loss_calibrator_mod\n', 'import pit_loss_calibrator as pit_loss_calibrator_mod\nimport field_snapshot as field_snapshot_mod\n', 1)
assert 'field_snapshot_mod' in b
b = insert_before(b, "    # session_summary は呼び出し側で should_fire_race_summary() ガード", "    # U1：全車snapshot（データのみ・音声化されない）。非搭乗中も記録・受信を止めない。\n    'field_snapshot',\n") if "    # session_summary は呼び出し側で should_fire_race_summary() ガード" in b else None
assert b and "'field_snapshot'," in b
method = block(cur, '    # U1（全車snapshot）：CarIdx*配列を「同じ1世代」から読む。', '    def read_session_info(self):')
b = insert_before(b, '    def read_session_info(self):\n        try:', method, count=1)
create = block(cur, '    # U1：全車snapshot記録。保存先は Desktop が環境変数で渡す', '    pit_exit_forecast_shadow = None')
_anchor = '    pit_loss_calibrator = pit_loss_calibrator_mod.PitLossCalibrator(PIT_LOSS_PATH)\n'
assert b.count(_anchor) == 1
b = b.replace(_anchor, _anchor + create, 1)
step = block(cur, '        # U1：全車snapshot（1Hz＋イベント）。', "        # Final Lap authorityは総合順位1位のみ。")
b = insert_before(b, "        # Final Lap authorityは総合順位1位のみ。", step)
_parse_anchor = "                latest_session_results = info.get('session_results') or {}\n"
assert b.count(_parse_anchor) == 1
_parse_block = block(cur, "                # U1：全車snapshotの名簿。この解析1回分で作り直し", "                # ★2026-07-21 Codex指示R2「原因修正」：read-only診断。DriverInfoから")
b = b.replace(_parse_anchor, _parse_anchor + _parse_block, 1)
# R7：更新番号（header offset 12）の読取・名簿だけの読み直し・名簿解析の2回読み
_c = '    H_SESSION_INFO_UPDATE = 12'
_cl = cur[cur.index(_c):cur.index('\n', cur.index(_c)) + 1]
_a = '    H_SESSION_INFO_OFFSET = 20\n'
assert b.count(_a) == 1
b = b.replace(_a, _a + _cl, 1)
_m = block(cur, '    def session_info_update(self):', '    def is_active(self):')
_ia = '    def is_active(self):\n        if not self._ptr:\n            return False\n'
assert b.count(_ia) == 1
b = b.replace(_ia, _m + _ia, 1)
_h = block(cur, 'def _field_roster_refresh(reader, fallback_id):', 'def parse_session_info(yaml_str):')
b = insert_before(b, 'def parse_session_info(yaml_str):', _h)
_y_old = "            yaml_str = reader.read_session_info()\n            if yaml_str:\n                info = parse_session_info(yaml_str)\n"
assert b.count(_y_old) == 1
_y_new = block(cur, '            _field_u0 = reader.session_info_update()', "            if yaml_str:\n                info = parse_session_info(yaml_str)\n") + "            if yaml_str:\n                info = parse_session_info(yaml_str)\n"
b = b.replace(_y_old, _y_new, 1)
wr('irsdk-bridge/bridge.py', b)

# 3) renderer.html：3か所
cur = rd('desktop/renderer.html'); r = rb('desktop/renderer.html')
r = insert_before(r, '<script src="relative-pace.js"></script>', '<script src="field-snapshot.js"></script>\n')
handler = block(cur, "      // U1：全車snapshot。検証して保持するだけ", "      if(['telemetry_live','box_authority_snapshot'].includes(data.type)")
r = insert_before(r, "      if(['telemetry_live','box_authority_snapshot'].includes(data.type)", handler)
recv = block(cur, "// U1：全車snapshotの受信（field-snapshot.js）。", "// ══ STR-001")
r = insert_before(r, 'function syncCanonicalStrategyProjection(){', recv)
wr('desktop/renderer.html', r)

# 4) preflight.sh：U1の2ステップだけ
cp = rd('preflight.sh'); pf = rb('preflight.sh')
u1 = block(cp, 'echo "▶ U1 全車snapshot：Bridge側', '\necho ""\nif [ "$fail" -eq 0 ]')
pf = insert_before(pf, '\necho ""\nif [ "$fail" -eq 0 ]', '\n' + u1.rstrip('\n') + '\n')
_old_loop = 'desktop/strategy-playbook.js; do'
assert pf.count(_old_loop) == 1
pf = pf.replace(_old_loop, 'desktop/strategy-playbook.js desktop/field-snapshot.js; do', 1)
wr('preflight.sh', pf)
g = rb('ci/tests_preflight_gates.py')
_old = "'desktop/memory-action-layer.js','desktop/strategy-playbook.js']:"
assert g.count(_old) == 1
wr('ci/tests_preflight_gates.py', g.replace(_old, "'desktop/memory-action-layer.js','desktop/strategy-playbook.js','desktop/field-snapshot.js']:"))

# 5) 差分（基準との）
subprocess.run('git -C %s init -q && git -C %s add -A >/dev/null 2>&1' % (tree, tree), shell=True)
p = subprocess.run(['git', 'diff', '--no-index', '--stat', '--', os.path.join(os.path.dirname(tree), 'base'), tree], capture_output=True, text=True)
print('candidate tree:', tree)
