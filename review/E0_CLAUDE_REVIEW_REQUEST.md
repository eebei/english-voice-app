# Codex → Claude Code：Unit E0 v3 独立レビュー依頼

**日付**：2026-07-26
**状態**：実装・機械検証完了、未コミット
**禁止事項**：Claude承認およびYuji承認まで、commit / push / exe build を行わない

## 目的

耐久チームイベントで、PITWALLがローカル利用者以外のドライバーへ
自動音声を出さないようにする。同時に、利用者のPTT会話、本人再搭乗後の
自動サポート、真の完走summaryを壊さない。

## 実走ログから確定した入力契約

- チームメイト走行中、ローカルの `driver_state` は `garage` のままでも、
  チーム車のSpeed/Lap/Positionは動き続ける。
- ドライバー交代時、チームメイトのpit走行により `driver_state='pit'` が
  一時的に観測され得る。したがってpit単独では本人再搭乗と判定できない。
- ローカル利用者の `IsOnTrack` に対応する `driver_state='track'` は
  本人再搭乗の自動確認に使える。
- PTTは観戦中にも使うため、activity復帰信号にしてはならない。
- `CHECKER_OUT` は総合首位がチェッカーを受けた状態であり、
  ローカル利用者の完走証拠ではない。
- Practiceでもチームメイト走行が存在するため、Raceだけの判定にしない。

## 変更ファイル

- `irsdk-bridge/driver_activity.py`（新規）
- `irsdk-bridge/tests_driver_handoff.py`（新規）
- `irsdk-bridge/bridge.py`
- `irsdk-bridge/race_lifecycle.py`
- `irsdk-bridge/tests_judge_llm_gate.py`
- `preflight.sh`
- `TEAM_STATE.md`（現行役割と期限の記録のみ）

`PITWALL_発話種別一覧.txt` はYuji所有の未追跡ファイルであり、変更・commit対象外。

## 実装契約

### 1. driver activity

- `ACTIVE → garage` で `DRIVER_HANDOFF`。
- garage継続30秒で `INACTIVE_DRIVER`。
- `HANDOFF/INACTIVE + track` で本人再搭乗と判断し `ACTIVE`。
- `HANDOFF/INACTIVE + pit` は自動復帰しない。
- pit内での例外的な復帰には、PTTと分離した
  websocket command `resume_driving_support` を使用する。
- `FINISHED` は `PLAYER_FINISHED` だけを権威源とし、DEBRIEF単独ではlockしない。

### 2. 自動音声ゲート

- 非ACTIVE時はdeny-by-default。
- PTT、接続状態、session info等の非音声metaだけallow-listで通す。
- radio / judge_call / pace_checkを含む自動音声候補は全て落とす。
- activity gateはdirector gateより前に置く。

### 3. summary

- Race summaryは `PLAYER_FINISHED × FINISHED` かつ最終ラップ記録反映後だけ生成する。
- summary payloadはpending化し、`broadcast()` が `DISPATCHED` を返すまで同一payloadを保持する。
- `HELD` / `DROPPED` では `summary_sent=True` にしない。
- Practice/Qualify summaryはgarageで確定せず、権威あるSessionNum変更時だけ旧セッション記録から送る。
- SessionNum変更時に配送不能だった非Race summaryは、新セッションへ誤配送しないため持ち越さない。

### 4. telemetry断とCHECKER_OUT

- RACING/CHECKER_OUT中の一時的な `telemetry_active=False` では状態を保持する。
- PLAYER_FINISHED後のtelemetry断またはgarage帰還でのみDEBRIEFへ進む。
- CHECKER_OUT中のgarageだけではDEBRIEFへ進めない。

### 5. 候補状態の消費

- catchup / defend / battleの段階状態は、`broadcast()==DISPATCHED` の場合だけ更新する。
- 非ACTIVE→ACTIVEを新しい本人スティント境界とし、燃料、Final Lap、
  post-contact、multiclass、battle/catchup/defend、danger/stopped等の
  ドライバー限定状態を初期化する。
- 旧 `garage→pit` の燃料resetは、チームメイトpitを本人復帰と誤認するため削除する。

## Codex側の検証結果

```text
tests_driver_handoff.py          125 / 125
tests_race_lifecycle.py           28 / 28
tests_judge_llm_gate.py           92 / 92
tests_bridge_lifecycle_wiring.py  73 / 73
tests_class_map.py                13 / 13
tests_f2time_contract.py          19 / 19
tests_irsdk_mem.py                18 / 18
tests_session_info_extent.py     120 / 120
関連8スイート合計              488 / 488
./preflight.sh                   出荷可
git diff --check                 PASS
py_compile                       PASS
```

preflightのHTTP統合テストはローカルport listenを必要とするため、
sandbox外の通常環境で再実行し全緑を確認した。

## 変異試験

- pitのmanual resume条件削除 → チームメイトpitでACTIVEへ誤復帰
- SessionNum変更条件削除 → garage相当でも非Race summaryを誤確定
- telemetry断を無条件DEBRIEFへ戻す → RACING中断で永久停止
- pending再送ループ削除 → summary配送失敗から回復不能
- `DISPATCHED`確認削除 → HELD/DROPPEDでも段階状態を消費
- FINISHED lock削除 → 完走後に巻き戻る
- summary成功条件削除 → 送信失敗でもsent扱い
- activity allow-listをallow-all化 → 非ACTIVE中のvoiceが通過

全変異を対応テストが検出し、復元後に全緑を確認済み。

## Claudeへ依頼する反対尋問

1. `track` を本人再搭乗の権威入力とする契約が、3本の実走ログと矛盾しないか。
2. `pit` 自動復帰禁止とmanual resume fallbackに、本人を永久停止させる経路がないか。
3. PTT会話がactivityを復帰させず、同時に非ACTIVE中も会話経路として維持されるか。
4. deny-by-default gateより前に、音声または段階状態を消費する経路が残っていないか。
5. CHECKER_OUTとPLAYER_FINISHEDの分離に、早すぎるDEBRIEFまたは完走summary欠落がないか。
6. pending summaryが二重配送、最終ラップ欠落、別セッション誤配送を起こさないか。
7. SessionNum/sig両reset経路でE0状態とpendingが確実に破棄されるか。
8. ACTIVE復帰時resetが不足または過剰で、燃料・Final Lap・multiclassへ副作用を作らないか。
9. `broadcast()` の3値文字列がtruthyであることにより、暗黙bool判定する既存callerが壊れていないか。
10. 静的テストだけで通っている重要契約があれば、本番相当fixtureまたは変異試験を追加すべきか。

## 判定依頼

- **APPROVE**：コミット可能
- **CHANGES REQUIRED**：P0/P1/P2、再現条件、必要な受入テストを明記

承認後も、exe buildと実走投入にはYujiの最終承認を必要とする。
