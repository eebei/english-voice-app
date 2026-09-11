#!/usr/bin/env python3
"""★P0-3 Bridge 実処理試験（Codex差戻し再指摘対応：2026-09-10続報3）

「Bridgeの製品payload/summary生成を直接実行してcust_id/checker_fuel_lを
assertする。共用生成関数の切り出し、または既存実poll replayの利用でよい。
文字列grepで送出の実行証拠を代用しない。Python試験のソースパスは__file__
基準に直し、MD掲載コマンドを直下から再実行する。」

対応：
1. bridge.py に telemetry_live / session_summary が実際に呼ぶ共用純粋関数
   build_telemetry_identity_field() / build_summary_identity_and_freeze_fields()
   を新設し、poll_iracing() 側もこれらを呼ぶよう書き換えた（文字列一致で
   間接確認していた旧テストを、この関数を直接呼ぶ実処理試験に置換）。
2. 本ファイルは __file__ 基準の絶対パスで bridge.py を読むため、
   リポジトリ直下からの実行でも irsdk-bridge 内からの実行でも同じ結果になる。
"""

import os
import sys

# ★__file__基準：cwdに依存しない（Codex指摘：直下からの実行でFileNotFoundError）
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _THIS_DIR)
import bridge

failures = []


def check(label, condition):
    status = 'OK' if condition else 'FAIL'
    print(f'  [{status}] {label}')
    if not condition:
        failures.append(label)


# ★実際の iRacing SessionInfo YAML の DriverInfo セクション形式
#   （bridge.py の parse_session_info が期待するフィールド名と一致させる）
SAMPLE_YAML = """
WeekendInfo:
  TrackName: spa francorchamps gp
  TrackDisplayName: Spa-Francorchamps
  EventType: Race
  SeriesID: 123
DriverInfo:
  DriverCarIdx: 2
  Drivers:
  - CarIdx: 0
    UserName: Other Driver A
    CarNumber: "5"
    IsSpectator: 0
    CarIsPaceCar: 0
    CarClassID: 84
    CarClassShortName: GT3
    CarScreenName: BMW M4 GT3
    CustID: 111111
    IRating: 2500
    LicLevel: 4
    LicSubLevel: 30
  - CarIdx: 1
    UserName: Other Driver B
    CarNumber: "7"
    IsSpectator: 0
    CarIsPaceCar: 0
    CarClassID: 84
    CarClassShortName: GT3
    CarScreenName: Ferrari 296 GT3
    CustID: 222222
    IRating: 3000
    LicLevel: 4
    LicSubLevel: 40
  - CarIdx: 2
    UserName: Test Player
    CarNumber: "99"
    IsSpectator: 0
    CarIsPaceCar: 0
    CarClassID: 84
    CarClassShortName: GT3
    CarScreenName: Mercedes-AMG GT3 2020
    CustID: 315555
    IRating: 2800
    LicLevel: 4
    LicSubLevel: 50
"""

print('\n━━ Bridge 実関数試験: parse_session_info() ━━\n')

print('Test 1: 実YAMLから player_cust_id が正しく抽出される（複数driverの中から自分を特定）')
result = bridge.parse_session_info(SAMPLE_YAML)
check('player_car_idx == 2（DriverCarIdx由来）', result.get('player_car_idx') == 2)
check('player_cust_id == 315555（CarIdx==2のCustID、他driverと混同しない）',
      result.get('player_cust_id') == 315555)
check('player_car_class == "GT3"', result.get('player_car_class') == 'GT3')
check('player_car_model == "Mercedes-AMG GT3 2020"', result.get('player_car_model') == 'Mercedes-AMG GT3 2020')
check('track == "spa francorchamps gp"', result.get('track') == 'spa francorchamps gp')

print('\nTest 2: CustID欠損（フィールド無し）でも player_cust_id は None（捏造しない）')
yaml_no_custid = SAMPLE_YAML.replace('    CustID: 315555\n', '')
result2 = bridge.parse_session_info(yaml_no_custid)
check('player_cust_id is None（欠損は欠損のまま）', result2.get('player_cust_id') is None)

print('\nTest 3: DriverCarIdx が他driverのCustIDと取り違えない（境界値：末尾driverが自分）')
yaml_last_is_player = SAMPLE_YAML.replace('DriverCarIdx: 2', 'DriverCarIdx: 0')
result3 = bridge.parse_session_info(yaml_last_is_player)
check('DriverCarIdx=0 なら CarIdx=0（111111）を採用、315555を誤って使わない',
      result3.get('player_cust_id') == 111111)

print('\n━━ Bridge 実関数試験: 実payload生成関数を直接実行（grep代用の解消） ━━\n')

# ★実際に parse_session_info() を通した info dict を、telemetry_live /
#   session_summary が呼ぶのと同じ共用関数へそのまま渡す。文字列出現数を
#   数えるgrepではなく、実際の入出力で cust_id / freeze 値が届くことを検証する。
info = bridge.parse_session_info(SAMPLE_YAML)

print('Test 4: telemetry_live が実際に呼ぶ build_telemetry_identity_field() で cust_id が届く')
telemetry_cust_id = bridge.build_telemetry_identity_field(info)
check('telemetry_live payload の cust_id == 315555（実parse結果から実生成）',
      telemetry_cust_id == 315555)

print('\nTest 5: session_summary が実際に呼ぶ build_summary_identity_and_freeze_fields() で cust_id/freeze が届く')
summary_fields = bridge.build_summary_identity_and_freeze_fields(info, 3.9)
check('summary payload の cust_id == 315555', summary_fields.get('cust_id') == 315555)
check('summary payload の fuel_at_finish == 3.9', summary_fields.get('fuel_at_finish') == 3.9)
check('summary payload の checker_fuel_l == 3.9', summary_fields.get('checker_fuel_l') == 3.9)

print('\nTest 6: CustID欠損時、両payload生成関数とも捏造せずNoneを返す')
info_no_cust = bridge.parse_session_info(yaml_no_custid)
check('telemetry_live: cust_id is None（欠損のまま）',
      bridge.build_telemetry_identity_field(info_no_cust) is None)
summary_fields_no_cust = bridge.build_summary_identity_and_freeze_fields(info_no_cust, None)
check('session_summary: cust_id is None（欠損のまま）', summary_fields_no_cust.get('cust_id') is None)
check('session_summary: fuel系もNone（freeze未確定）', summary_fields_no_cust.get('fuel_at_finish') is None)

print('\nTest 7: 別driverのinfoを渡すと別driverのCustIDが届く（取り違えの実処理検証）')
info_other_player = bridge.parse_session_info(yaml_last_is_player)  # DriverCarIdx=0のYAML
check('別driver(CarIdx=0,CustID=111111)のtelemetry_live cust_idは111111（315555ではない）',
      bridge.build_telemetry_identity_field(info_other_player) == 111111)

print('\n━━ 結果 ━━\n')
if failures:
    print(f'✗ {len(failures)} 件失敗:')
    for f in failures:
        print(f'  - {f}')
    sys.exit(1)
else:
    print('✓ All parse_session_info 実関数試験 PASSED')
    sys.exit(0)
