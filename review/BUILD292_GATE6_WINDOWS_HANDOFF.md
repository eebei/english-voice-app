# Build 292 Gate 6/8 実機確認手順

## 対象artifact（固定）

- Desktop private run: `33467780133`
- Bridge private run: `33467786983`
- 対象SHA: `2d1b7ae573434c129ddb85c15604c2a1a2fcecd6`
- 製品Build: **292**
- Desktop installer SHA-256: `6f395056ef33925546fb5d5bc9ede94432690b4cb932fde2d71483c4b6bed30d`
- Desktop installer bytes: `100718834`

## Gate 6 起動確認

1. 上記SHAのBuild 292 installerをWindowsへインストール／上書き。
2. 起動画面・診断で`buildNum=292`を確認。
3. `RUNTIME_MODULE_STATUS`が`status:"loaded"`、`missing:[]`、14本であることを確認。
4. Bridgeが1プロセスで起動し、PTT・TTS・Overlay・設定保存が動くことを確認。
5. `もう入るか`、`are we pitting`、`are they coming in`は相談として処理されることを確認。
6. `この周で入るよ`、`box this lap`は命令として処理されることを確認。

## Gate 8 実走確認

- 1レース以上をBuild 292で走行し、ログを保存する。
- GAP（前後・クラス対象）、燃料ウィンドウ、Plan A/B、アンダーカット、反射イベント、デブリーフ記憶を確認する。
- 誤発話、数字不一致、質問と命令の取り違えがあれば時刻付きで記録する。

## ACK記録

Windows実機の確認結果と実走ログが揃うまで、Gate 6／Gate 8を合格扱いにしない。Gate 5のprivate artifact検査済みとは別の証拠である。

---

# 追補（Claude Code・2026-09-01）

Codex の上記手順は残す。**Build 292 を出した主目的が上に無い**ため足す。

## 0. インストール前に必ずやること

private artifact なので、公開の更新窓からは取れない。Actions から落とす。

```
https://github.com/eebei/english-voice-app/actions/runs/33467780133
→ Artifacts → OMORAY-PITWALL-Desktop-Build-292-20260901-0354
```

zip 内の3本（`Setup-20260901-0354.exe` / `Setup-latest.exe` / `Desktop-latest.exe`）は
**SHA-256 が完全一致**（実測済み）。どれでもよい。

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-20260901-0354.exe -Algorithm SHA256
```

期待値 `6F395056EF33925546FB5D5BC9EDE94432690B4CB932FDE2D71483C4B6BED30D` / 100,718,834 bytes。
**一致しなければインストールしない。**別物を掴んでいる。

未署名なので **SmartScreen が出る** → 「詳細情報」→「実行」。

## 1. ★最重要 — この Build の目的は診断2つの実データ

Build 292 が運ぶ本体は**新機能ではなく、原因不明の3件を確定させる計装**である。
**1レース走ってログを保存すれば、それだけで目的は達成される。**

走行後、デスクトップの `OMORAY-bridge-debug-<日時>.log` に対して:

```powershell
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "RACE SUMMARY GATE"
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "INCIDENTS DIAG"
```

| 診断 | 何を確定させるか |
|---|---|
| `RACE SUMMARY GATE` | **レースsummaryが実走3本連続で1度も発行されず**、最終順位・iRating・公式incidentsがデブリーフへ届いていない。3条件（`should_fire` / `lap_time_settled` / `latest_lap_recorded`）のどれで止まったかを出す |
| `INCIDENTS DIAG` | 8/31夜に「Incidents 0」と言ったが公式は **3**。iRacingが何を返していたのか、変数が読めていたのかを出す |

**この2行が1件も出なければ、それ自体が結果**（レース終了検知に到達していない）なので、
ログをそのまま渡してほしい。消さないこと。

## 2. デブリーフで見てほしい1点

8/31夜のデブリーフは、**前日の質問を「今回はIncidents 0」ごと復唱した**（12時間前の数値を今日の事実として再生）。
Build 292 で、測定値を含む質問は再利用しないようにした。

- ✅ 期待：`前回と同じことを聞くね。` の後に**数字が出ない**、または followup 自体が出ない
- ❌ 不合格：`前回と同じことを聞くね。今回はIncidents ○。…` のように**数字付きの復唱**が出る

## 3. Codex 手順 5/6 についての注意

上記 Codex 手順の 5（`もう入るか` 等）と 6（`この周で入るよ` 等）は、
**`engineer-card.js` ＝ サーバー側**の挙動であり、**Build 292 とは別経路**である。
本番 Railway には `2d1b7ae` で反映済み（`./verify-deploy.sh` で SHA 一致を実測）。

したがって：

- ここが直っていても **Build 292 の合格根拠にはならない**
- ここが壊れていても **Build 292 の不合格にはならない**（server 側の問題）

**Build 292 の合否は、上の1と2、および module 14本と `buildNum=292` で判定する。**
混同すると、8/19 に塞いだ「exe側とサーバー側の取り違え」が再発する。

## 4. module は 14 本（Build 291 の 14 本と同数）

```powershell
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "RUNTIME_MODULE_STATUS"
```

`cost-meter` / `decision-memory` / `driving-style-v1` / `fuel-plan-guard` / `gap-freshness` /
`local-intent-router` / `luna-self-memory` / `memory-action-layer` / `pddp` / `reflex-events` /
`relative-pace` / `session-memory` / `strategy-playbook` / `team-plan`

**本数が同じなので、本数だけで 291 と区別できない。** タイトルバーと Bridge ログの `Build 292` で見分ける。

## 5. 走行条件の希望（Gate 8・収束計画 §4）

`review/CONVERSATION_QUALITY_CONVERGENCE_V1.md` §4 の「条件を散らす」に従うと、
**同じスプリントを繰り返しても新しい情報は出ない**。優先度順:

1. **黄旗／コーションが出るレース** — 実走3本すべて `num_cautions: 0`。`yellow_flag` は一度も発火していない
2. マルチクラス — Road Atlanta で連呼が最悪化した条件
3. 耐久／ドライバー交代 — Chief Mode・Team Plan が実走未通過

ただし**1レース走ればこの Build の主目的（診断2件）は達成される**ので、
条件が揃わないことを理由に走行を遅らせる必要はない。

## 6. 未確認として残るもの

- ~~Gate 5 は Claude Code 一人での検査~~ → **解消。Codex が `b6eee5f` で独立再計算し全項目一致、Gate 5 は独立確認済み・合格。**
- `preflight.sh` 86スイート全緑は **Claude Code 側の実行環境**での結果。
- 公開前に `./verify-deploy.sh` で本番 SHA をもう一度確認する（Codex 指摘）。


---

# ★公開版の値へ更新（2026-09-02・Claude Code）

Build 292 は**公開済み**。private artifact ではなく、**公開版**を使うこと。
上の「0. インストール前に必ずやること」の SHA と bytes は private candidate のものなので、
**以下の公開版の値で照合する**（electron-builder は再現ビルドでないため両者は一致しない。既知）。

## 取得先（更新窓からそのまま到達できる）

```
https://github.com/eebei/english-voice-app/releases/tag/desktop-latest
→ OMORAY-PITWALL-Setup-latest.exe
```

| 項目 | 値 |
|---|---|
| ファイル | `OMORAY-PITWALL-Setup-latest.exe`（`Desktop-latest.exe` / `Setup-20260902-0131.exe` と同一） |
| サイズ | **100,716,261 bytes** |
| SHA-256 | **`89A2C7DB54E41DE9D071DA86B60B5BCA220DB4BA697AA4A741E8FD5827591EC0`** |
| 対象SHA | `2d1b7ae573434c129ddb85c15604c2a1a2fcecd6` |
| buildTag | `20260902-0131`（UTC） |

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-latest.exe -Algorithm SHA256
```

**Yuji の通常運用（旧exe起動 → 更新窓 → Update → 新exe起動）でそのまま到達する。**

公開物を実際に取得して展開検査済み：runtime module **14/14**、`buildNum=292`、
同梱Bridge に `Build 292` / `RACE SUMMARY GATE` / `INCIDENTS DIAG` あり、`Build 291` は0件。

## ★今日のログについての注意

**実名削除（`8ee6b6f`）は Build 292 に入っていない。** 今日のログの `DRIVER` 行には
他ドライバーの実名が入る。共有する前に伏せ字化する（Claude Code 側で実施可能）。
実名削除は Build 293 で入る。
