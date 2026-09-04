# 2026-09-04 記憶×戦略／GAP identity／複合 intent 実装報告

## 狙い

対処療法ではなく、次の3本を製品経路で一つの契約へ寄せる。

1. 過去走行の個人記憶を次戦のピット周回へ使う。
2. GAPの数字・対象車・クラス・方向・計測時刻を分離しない。
3. 「プランA！何周目？」のような一発話内の複数要求を片方だけ捨てない。

## 実装したこと

- `pw_raceHistory` にセッション種別、レース形式、規定時間／周回、燃料・タイヤ規則を保存。
- driver ID・車・コース・シリーズ一致を必須にした燃費記憶取得を追加。規則違いは不採用、setup／路温差は低確信推定に降格。
- 認証済み利用者には、利用者IDを持たない旧集計燃費・平均ラップを流用しない。
- スタート時に実測した燃料をセッション固定し、タンク上限との混同を解消。
- ピット周回を `pit_entry_after_lap` と `pit_service_lap` に分離。
  - 52.3L、7.87L/周の例は「6周を走り終えて進入、作業は7周目」。
- Plan A/B/Cの各周回を構造で保持し、複合質問では計画名と周回を1回答に合成。
- レース中の隣接同クラスGAPは、長時間止まり得る `CarIdxF2Time` より毎pollの `CarIdxLapDistPct` 計測を優先。
- GAP権威レコードを class・class position・carIdx・sampled_at 込みでDesktopへ渡す。
- LLMには裸のGAP数字を渡さず、対象クラス／車両ID／計測源と一体で渡す。
- ローカルGAP回答もクラスが確定していれば「後ろのGT3 5.8秒」のように述べる。
- GTP等の速いクラスは2標本の縮小から接近率と到達予測を計算し、最短ETAの車を主脅威として選ぶ。別のGT3 GAPは参照しない。

## 機械検証

- strategy playbook: 45 checks
- engineer card / multi-intent: 116/116
- personal session-memory tunnel: 124/124
- local intent router: 54/54
- GAP freshness: 70/70
- Bridge GAP authority/wiring: 50 tests
- JS syntax / Python syntax / `git diff --check`: 合格

### Claude独立反証（追記）

`review/CLAUDE_VERIFICATION_OF_CODEX_IMPL_20260904.md` の独立検証結果も合格。

- 8/30–31実走68件＋9/4実走17件、合計85件を旧版／新版へ投入。
- 単一intent分類は **85/85で旧版と一致**。
- `classifyAll()` が複数intentを返したのは、従来失敗していた次の2件だけ。
  - 「プランa！何週目？」
  - 「プランaだったら何週目に入ってた。」
- 9/4実測（7.87L/周、開始52.3L）で再生し、`pit_entry_after_lap:6`、
  `pit_service_lap:7` を算出。実ログのLap 6終端で進入／Lap 7作業と一致。
- Claude環境では `preflight.sh` も出荷可。当方環境との差はHTTP bind環境差として残す。

`preflight.sh` は製品ロジック群が合格。ただしCodex環境でHTTP server bind系2件と未deploy確認が不合格。よって出荷可とは扱わない。

## まだ主張しないこと

- Windows実機起動、iRacing実走、耳でのTTS確認は未実施。
- 過去ログの位置配列を使った新GAP方式のフル再生は未実施。
- 旧Bridgeと新Desktopの混在は許可しない。Gate 5でBridge／Desktopの対象SHAと
  runtime module同梱一致を確認する。
- commit / push / Build / 公開は未実施。
- GTPの接近率は短い2標本からの推定であり、確定の「真の秒差」ではない。計測値として区別する。

## 実走で確認する診断点

- `GAP AUTHORITY` の source が `physical_traffic_gap` で、carIdxとclassが質問回答まで一致するか。
- GTPコールの `target_car_idx`、`closing_rate_s_per_s`、`time_to_reach_s` が同一候補車由来か。
- `STRATEGY_PLAYBOOK` の開始燃料、燃費、`pit_entry_after_lap`／`pit_service_lap` が一致するか。
- 「プランA！何周目？」が一度のPTTで両方回答されるか。
