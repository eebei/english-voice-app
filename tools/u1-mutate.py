#!/usr/bin/env python3
"""U1 変異試験：実装を1か所ずつ壊し、検査が落ちる（＝検査が効いている）ことを確かめる。落ちない変異は「検査の穴」として報告する。
  python3 tools/u1-mutate.py
各変異は終了時に必ず元へ戻す（finally）。"""
import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = ['python3', 'irsdk-bridge/tests_u1_field_snapshot.py']
NODE = ['node', 'tests-u1-field-snapshot-e2e.js']
FSP, BRP, RDP, FSJ = 'irsdk-bridge/field_snapshot.py', 'irsdk-bridge/bridge.py', 'desktop/renderer.html', 'desktop/field-snapshot.js'
MUT = [
    ('M1 世代混在でもok扱い', FSP, "gen = 'consistent' if consistent is True else ('mixed' if consistent is False else 'unverified')", "gen = 'consistent'", PY),
    ('M2 tick再確認をやめる', BRP, "if tick_after == tick:", "if True:", PY),
    ('M3 bool配列を4バイトで読む', BRP, "_FIELD_TYPE_FMT = {1: ('B', 1),", "_FIELD_TYPE_FMT = {1: ('i', 4),", PY),
    ('M4 離脱を欠測に混ぜる', FSP, "if surface == SURFACE_NOT_IN_WORLD:", "if False:", PY),
    ('M5 car_leaveイベントを出さない', FSP, "c.get('st') == 'out' and 'car_leave' not in ev:", "False and 'car_leave' not in ev:", PY),
    ('M6 putが書込みを待つ', FSP, "self.q.put_nowait(snap)\n            return True", "self.q.put(snap)\n            return True", PY),
    ('M7 硬上限で止まらない', FSP, "if self.run_bytes >= self.run_hard:", "if False:", PY),
    ('M8 混在snapshotも送信する', FSP, "if snap['ok'] and send is not None:", "if send is not None:", PY),
    ('M9 変化の合図を使わない', FSP, "if light and light.get('consistent') is True:", "if False:", PY),
    ('M10 allow-listから外す', BRP, "    'field_snapshot',\n", "", PY),
    ('M11 記録失敗でpipeline生成が落ちる', FSP, "        except Exception as e:   # 作れなくても安全側（記録なしで走り続ける）", "        except ZeroDivisionError as e:", PY),
    ('M12 個人名を記録に入れる', FSP, "rec = {'i': i, 'no': info.get('number'), 'c': info.get('class_id'), 'r': role}", "rec = {'i': i, 'no': info.get('number'), 'c': info.get('class_id'), 'r': role, 'name': 'Name Secret'}", PY),
    ('M13 ローテーションで冒頭を消す', FSP, "        while os.path.exists(self._filename()):\n            self.part += 1\n", "        [os.remove(os.path.join(self.directory, n)) for n in os.listdir(self.directory) if n.endswith('.jsonl')]\n        while os.path.exists(self._filename()):\n            self.part += 1\n", PY),
    ('M14 受信側が未知キーを許す', FSJ, "if (!TOP_KEYS.includes(k)) return 'unexpected_field';", "if (false) return 'unexpected_field';", NODE),
    ('M15 受信側が重複seqを許す', FSJ, "if (msg.seq <= st.lastSeq && id === st.identity)", "if (false)", NODE),
    ('M16 受信側が世代混在を許す', FSJ, "if (s.ok !== true || s.gen !== 'consistent')", "if (false)", NODE),
    ('M17 受信側が件数不一致を許す', FSJ, "if (c.target !== competitors || c.other !== s.cars.length - competitors || c.observed + c.departed + c.missing !== c.target) return 'counts_mismatch';", "", NODE),
    ('M18 rendererが受信を捨てる', RDP, "try{fieldSnapshotReceiver.receive(data);}catch(_){}return;", "return;", NODE),
    ('M19 期待セッションの照合をやめる', FSJ, "if (expect.session_num !== undefined && s.session_num !== expect.session_num) return null;", "", NODE),
    ('M21 保持値の古さを見ない', FSJ, "if (isNum(expect.max_age_s) && isNum(expect.now_s) && expect.now_s - s.observed_at > expect.max_age_s) return null;", "", NODE),
    ('M22 別epochのseq逆戻りを拒否する', FSJ, "if (msg.seq <= st.lastSeq && id === st.identity)", "if (msg.seq <= st.lastSeq)", NODE),
    ('M20 out車に値があっても通す', FSJ, "return 'out_car_has_values';", "/* allowed */", NODE),
    ('M23 名簿の世代照合をやめる(identity_stale無効)', FSP, "identity_ok = isinstance(roster_session_num, int) and (ctx or {}).get('session_num') == roster_session_num", "identity_ok = True", PY),
    ('M24 名簿を作り直さず旧entryを残す', FSP, "        self.roster = roster_from_drivers(drivers)\n        self.race_id = race_id", "        self.roster = {**self.roster, **roster_from_drivers(drivers)}\n        self.race_id = race_id", PY),
    ('M25 名簿のSessionNum印を更新しない', FSP, "        self.session = session_num if isinstance(session_num, int) and not isinstance(session_num, bool) else None\n", "        self.session = 0\n", PY),
    ('M26 役割を無視して全員競技車', FSP, "role = info.get('role') if info.get('role') in ROLES else 'car'", "role = 'car'", PY),
    ('M27 countsに競技車以外を含める', FSP, "'target': observed + departed + missing,", "'target': len(cars),", PY),
    ('M28 変数ヘッダの要素数を無視', BRP, "n = min(count, info[2]) if info else 0", "n = count if info else 0", PY),
    ('M29 宣言型をヘッダに残さない', FSP, "'declared_types': self.declared,", "'declared_types': None,", PY),
    ('M30 同stampで既存ファイルへ追記', FSP, "while os.path.exists(self._filename()):", "while False:", PY),
    ('M31 受信側がroster_session_num照合をやめる', FSJ, "if (!isInt(s.roster_session_num) || s.roster_session_num !== s.session_num) return 'identity_stale';", "", NODE),
    ('M32 受信側が役割検査を先にやらない', FSJ, "if (s.cars.some(x => x && typeof x === 'object' && !ROLES.includes(x.r))) return 'bad_role';", "", NODE),
    ('M34 宣言型の診断ログを出さない', BRP, "on_declared=lambda _d: log(", "on_declared=lambda _d: None and log(", PY),
    ('M35 更新番号が違っても名簿を読み直さない', FSP, "if cur_update is not None and cur_update != self.update:", "if False and cur_update is not None and cur_update != self.update:", PY),
    ('M36 SessionNum変更後の番号前進待ちをやめる', FSP, "if self.update is not None and self.change_update is not None and self.update > self.change_update:", "if True:", PY),
    ('M37 打ち切り(fail-open)をやめる', FSP, "elif now - self.change_at >= self.FAIL_OPEN_S:", "elif False:", PY),
    ('M38 更新番号が読めない時に縮退せず未確認にする', FSP, "        if cur_update is not None and confirmed:\n            confirmed = self.update is not None and self.update == cur_update\n", "        if confirmed:\n            confirmed = self.update is not None and self.update == cur_update\n", PY),
    ('M39 番号→YAML→番号の2回読み検証をやめる', BRP, "    if u0 is not None and u1 != u0:\n        return None\n", "", PY),
    ('M41 snapshotのrace idを名簿と別の値にする', BRP, "'race_instance_id': _fr['race_id'], 'session_num': cur_snum,", "'race_instance_id': _this_frame_race_instance_id, 'session_num': cur_snum,", PY),
    ('M42 読み直し失敗後の再試行間隔をなくす', FSP, "if self.last_fail_at is None or now - self.last_fail_at >= self.RETRY_GAP_S:", "if True:", PY),
    ('M43 roster_updateを記録しない', FSP, "'roster_update': roster_update if isinstance(roster_update, int) and not isinstance(roster_update, bool) else None,", "'roster_update': None,", PY),
    ('M44 受信側がroster_updateの型を見ない', FSJ, "if (!intOrNull(s.roster_update)) return 'bad_roster_update';", "", NODE),
    ('M45 更新番号のheader位置を誤る', BRP, "H_SESSION_INFO_UPDATE = 12 ", "H_SESSION_INFO_UPDATE = 8 ", PY),
    ('M46 snapshot側がconfirmedを見ない', FSP, "and roster_confirmed is not False\n", "\n", PY),
]
only = sys.argv[1:]
res = []
for name, path, old, new, cmd in MUT:
    if only and not any(o in name for o in only):
        continue
    full = os.path.join(ROOT, path)
    src = open(full, encoding='utf-8').read()
    if src.count(old) != 1:
        res.append((name, 'SKIP(置換対象が%d件)' % src.count(old))); continue
    try:
        open(full, 'w', encoding='utf-8').write(src.replace(old, new))
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=400)
        res.append((name, 'KILLED(検査が落ちた)' if p.returncode != 0 else 'SURVIVED(検査の穴)'))
    except subprocess.TimeoutExpired:
        res.append((name, 'KILLED(timeout＝詰まり検出)'))
    finally:
        open(full, 'w', encoding='utf-8').write(src)
for n, r in res:
    print('%-40s %s' % (n, r))
surv = [n for n, r in res if r.startswith('SURVIVED') or r.startswith('SKIP')]
print('\n変異 %d 件中 検出 %d・生存/未適用 %d' % (len(res), len(res) - len(surv), len(surv)))
sys.exit(1 if surv else 0)
