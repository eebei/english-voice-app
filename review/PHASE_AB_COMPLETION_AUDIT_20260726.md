# Phase A–B 完成監査

**日付**：2026-07-26
**期限**：2026-07-31
**完成の定義**：コードが存在するだけでなく、純粋関数テスト、配線テスト、
変異試験、Claude独立レビュー、Yuji承認、exe build、実走確認まで完了すること。

## 現在地

| Unit | 現在の証拠 | 判定 | 完成までに必要なもの |
|---|---|---|---|
| E0 Driver Handoff | 488関連テスト、preflight全緑 | REVIEW READY | Claude承認、Yuji承認、commit/build、チームイベント実走 |
| Final Lap | 7/25ログで1周早い欠陥再現、v4設計 | DESIGN READY | E0確定後に純粋モジュール実装、配線、変異試験、実走 |
| 耐久燃料管理 | 消費量・残燃料・to-finishは動作 | INCOMPLETE | 新Final Lap残周回へ統合、L単位margin、band dedup、E0連携 |
| multiclass集団化 | class単位groups/shapeは実装済み | INCOMPLETE | 5秒段階の台数集約、2秒段階の簡潔化、dispatch後だけstage消費、実ログreplay |
| Session Authority | track/class/EventTypeは送信済み | BROKEN | CarScreenName、現在SessionType、authority prompt、更新時再認識 |
| ピットロス校正 | lane timeと2本の時系列CSVあり | INCOMPLETE | 条件付きサンプル抽出、通常区間差引、中央値/IQR、保存契約、3本以上 |

## 1. 耐久燃料管理

### 現在できている

- クリーンラップだけを最大5周履歴へ入れる。
- 現燃料÷平均消費で `laps_of_fuel_left` を返す。
- 残周回根拠がある時だけto-finishを出し、欠損時は黙る。
- CHECKER_OUT後の燃料警告を止める。
- rendererは実測周回数をconfidenceとしてpromptへ渡す。

### 未完了

現在は、

```python
fuel_needed = avg_fuel_lap * (laps_remaining_est + 1)
margin_laps = (fuel - fuel_needed) / avg_fuel_lap
warning = margin_laps < -0.5
```

であり、合意済みの「+0.5Lを切ったらtight」と違う。
安全マージン1周分を先に加えた上でさらに0.5周不足を警告条件にしており、
単位と意味が混在している。

初版完成契約：

- `required_fuel_l = avg_fuel_lap * estimated_crossings_to_finish`
- `reserve_l = 0.5`
- `margin_l = fuel - required_fuel_l`
- band:
  - `safe`: `margin_l >= 0.5`
  - `tight`: `0.0 <= margin_l < 0.5`
  - `critical`: `margin_l < 0.0`
- 発話はband遷移時だけ。`safe→tight` と `tight→critical` を別イベントとして扱う。
- 同band内では連呼しない。
- 給油後にsafeへ戻れば再武装する。
- `estimated_crossings_to_finish` はFinal Lap Unitと同じ値を使う。
- CHECKER_OUT / PLAYER_FINISHED / DEBRIEFでは新規警告なし。

## 2. multiclass集団化

### 現在できている

- `LapDistPct × player_last_lap` で後方物理ギャップを算出。
- faster classだけをclass名単位でまとめる。
- 15秒観測窓、3秒以内をclusterとしてshapeを作る。
- 5秒と2秒の2段階。
- 8秒超で再武装。

### 未完了・矛盾

- `multiclass_stage[_cn] = _stg` がbroadcast前に更新される。
  E0非ACTIVE、director drop、client未接続でも段階が消費される。
- bridgeは正確な秒数と台数を渡している一方、prompts.jsは
  「クロスクラス秒数は不正確だから絶対言うな」という旧契約のまま。
- 7/25ログでは同クラスが `[5.0,10.6]` の時に
  「1台が5秒後方、その後に1台」と発話している。
  Yujiの新仕様は5秒圏へ入った集団を2〜5台でまとめ、
  実数4.8等を言わないこと。
- stage 1とstage 2で同じ車群を二度詳しく説明すると連呼感が残る。

完成契約：

- stage 1（最初が5秒圏）：
  - 5秒圏へ連続して来るclusterだけを数える。
  - 1台なら「GTP、後方5秒圏内」。
  - 2〜5台なら「GTP、後方5秒圏内にN台」。
  - 6台以上は「GTPの集団、後方5秒圏内」。
  - 総合首位が含まれる時だけ「GTPトップを含む」を付ける。
- stage 2：
  - 「GTP、2秒圏内」のように簡潔化。台数と実数秒は繰り返さない。
- stageは `broadcast()==DISPATCHED` の時だけ消費。
- renderer promptから「秒数は不正確」の旧制約を削除し、
  bridgeが渡したbucket（5秒圏/2秒圏）だけをauthorityとする。
- 同一classの5→2は最大2コール、再武装まで追加なし。

## 3. Session Authority

### 現在できている

- `TrackName` / `TrackDisplayName` / `EventType` / Sessions map /
  player classをSessionInfoから抽出。
- rendererはtrackとclassを記憶キーへ使う。
- SessionInfo extent診断によりCarScreenNameが200KB内にあることを実走確認済み。

### 現在の破損

- `parse_session_info()` は `CarScreenName` をdriverへ格納していない。
  Lunaへ届くのはGT3等のclassだけで、McLaren等の車モデルは届かない。
- rendererは `data.event_type` を `lastSessionType` へ保存している。
  `EventType`は週末全体の種別であり、現在のPractice/Qualify/Raceではない。
- `sessions_map[cur_snum]` で現在SessionTypeをbridge内部では正しく得ているが、
  rendererへ送っていない。
- CURRENT SESSIONを記憶より上位のauthorityとしてprompt冒頭へ固定する構造がない。

完成契約：

- player driver blockから `CarScreenName` と可能なら `CarPath` を抽出。
- bridgeが `current_session_type = sessions_map[SessionNum]` を
  session_info/telemetryへ構造化して送る。
- rendererは `EventType` と `current_session_type` を別変数で保持する。
- prompt冒頭に、

```text
CURRENT SESSION — AUTHORITATIVE
Track / Car model / Car class / Current session type / Event format
This block overrides memory and prior conversation.
```

を必須挿入。
- SessionNum変更時はauthority blockを更新し、必要なら短い再認識を一度だけ行う。
- memoryの過去track/carは削除しない。優先順位で解決する。
- unknownはunknownとして渡し、記憶から穴埋めしない。

## 4. ピットロス校正

### 既存実測

`strategy_ts-20260721-134043-ai-race.csv` と
`strategy_ts-20260721-203846-ai-race.csv` から、Monzaで少なくとも
次の有効な給油ストップを確認した。

| 開始 | Lap | OnPitRoad総時間 | PitstopActive | 設定給油 | 実燃料増加 |
|---|---:|---:|---:|---:|---:|
| 14:08:07.9 | 5 | 30.37s | 7.23s | 6L | 約5.8L |
| 21:04:21.0 | 9 | 26.97s | 4.23s | 7L→実行時6L | 約5.8L |

他にdrive-through、長時間停止、セッション開始時pit等が混在しているため、
単純平均へ入れてはいけない。

### 未完了

- `pit_lane_sec` は保存されるが、car/trackだけのlocalStorage記録で、
  service内容、green/caution、修理、calculator versionを持たない。
- 通常時同区間通過時間を差し引いておらず、観測総ロスではない。
- 有効サンプルの自動分類と汚染除外がない。
- 2本しかなく、完成条件の3本未満。
- median/IQRとconfidenceがない。
- bridgeへ校正値を返す契約がない。

完成契約：

- サンプルschema：
  `car_model, track, pit_entry_pct, pit_exit_pct, lane_total_s,
   normal_segment_s, observed_loss_s, stall_s, fuel_added_l,
   tire_service, repair_s, caution_state, timestamp, calculator_version`
- `observed_loss_s = lane_total_s - normal_segment_s`
- repair、tow、長時間停止、drive-through、session transitionは別分類。
- 同条件3本未満は`low`。予測用途へは使わず、計測値としてだけ表示。
- 3本以上でmedian/IQRを計算。
- 条件違いを平均しない。
- localStorageからbridgeへ送るより、初版はbridge側JSON保存を正とし、
  rendererは表示・問い合わせだけを担当する。

## 実装順

1. E0独立レビュー・確定
2. Final Lap純粋モジュールと一本化配線
3. 燃料L単位band（Final Lap crossingsを共有）
4. Session Authority
5. multiclass bucket/grouping
6. pit-loss sample extractor/calibrator
7. 全preflight・Claude独立レビュー
8. exe build・実走

Final Lapと燃料は同じ残周回authorityを共有するため連続実装する。
Session AuthorityはAIの誤認を止める独立ブロックとして次に行う。
ピットロスは最低3本の実測が必要なため、コード実装と並行して追加採取する。
