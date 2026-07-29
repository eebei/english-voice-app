# Fuel Authority / BoP / Luna Safety 独立レビュー依頼

## 背景

2026-07-29 Monza IMSA Fixed 実走で、Bridgeの燃料計算器は実測燃費を保持していた一方、
Lunaが残り周回・タンク容量を推測し、現在燃料と満タン容量を混同した。
無効順位 `P-1` を表彰台として読み上げ、後着summaryでDebriefが二重起動する事象も確認した。

## 変更対象

- `desktop/renderer.html`
- `tests-fuel-authority.js`
- `tests-character-capability-parity.js`
- `preflight.sh`

## 契約

1. 現在燃料、実測L/周、残り周回、必要燃料、マージンはBridgeの `fuel_strategy` を唯一の権威とする。
2. `estimated_crossings_to_finish` が無い場合、残り周回・完走可否・ピット周回を推測しない。
3. タンク容量は全車種についてiRacing SessionInfoの `DriverCarFuelMaxLtr × DriverCarMaxFuelPct` から毎セッション自動取得する。
4. 物理タンク容量、シリーズ燃料制限率、実効BoP/Fixed上限を分離し、車種 × series × season × week × fixed/openで永続化する。
5. 現在燃料とタンク容量を混同しない。
6. 一般的なGT3容量でBoP上限を代用しない。
7. `503 L` のような範囲外・曖昧なSTT値は小数位置を推測せず保存しない。
8. `finish_pos <= 0` を順位・表彰台として読み上げない。
9. 自動Debrief開始後、後着summaryで任意レビューを二重起動しない。
10. LunaJPは女性標準語を維持し、安全・車両異常時はタイム回復より状態確認を優先する。
11. 観測していない事故・スピンを「把握していた」と主張しない。

## 検証済み

- `tests-fuel-authority.js`: 23/23
- `tests-evidence-debrief.js`: 22/22
- `tests-character-capability-parity.js`: 33/33
- `bash preflight.sh`: 全緑

## 第1回レビュー P1 remediation

- `finish_pos <= 0` は `sanitizeSessionEvidence` / `validFinishPosition` の共通入口で除去し、
  音声要約、Evidence panel、LLM注入、本人確認Evidence、race historyの全経路で再検証する。
- 車両異常時の安全確認および未観測事故を把握済みと主張しない契約を、
  LunaJP専用条件から全キャラクター共通契約へ移動した。

## レビュー方法

契約1〜11を file:line evidence でverifyし、P0/P1/P2を報告してください。
修正・commit・push・build・deployは行わないでください。
