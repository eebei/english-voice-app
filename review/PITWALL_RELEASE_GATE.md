# PITWALL 出荷ゲート正本

最終更新: 2026-08-24 JST  
適用対象: Desktop installer、同梱Bridge、Bridge単体版、Railwayサーバー、認証・決済、公開ページ  
目的: ソース上の合格を、利用者へ届く製品の合格と取り違えない。

## 絶対ルール

- Gate 0〜5（変更時はGate 7も）の必須項目が一つでも未確認なら**公開不可**。`該当なし`は理由を書く。
- YujiのWindows／iRacing実走は公開update経路で行うため、明示的な公開GO後はBuildをfield-test candidateとして公開し、Gate 6／8を公開後に確認する。この間は「実機・実走確認済み」「最終出荷署名済み」と表現しない。失敗時はGate 10で直ちに停止判断する。
- 作業者と確認者を分ける。Codexが実装した場合はClaude Code、Claude Codeが実装した場合はCodexが確認者になる。
- 確認者は作業者の報告を転載せず、差分・テスト・完成artifactを自分で確認する。
- `preflight成功`、`workflow成功`、`commit成功`、`公開成功`、`Windows実機成功`、`iRacing実走成功`は別の証拠である。
- Yujiの明示GOなしにpush、private/public build、deploy、releaseを行わない。
- 公開GOは、原則としてprivate candidateの検査完了後に受ける。緊急公開でも必須項目は省略しない。
- 完成artifactの検査がない状態で「Build完成」「更新可能」「利用者へ届いた」と報告しない。

## 役割

| 役割 | 責任 |
|---|---|
| 作業者 | 原因特定、実装、回帰テスト、変更一覧、既知の未確認事項を提示する |
| 確認者 | 受入条件、差分、失敗ログ再生、package内容、完成artifact、反映経路を独立確認する |
| Yuji | build / push / deploy / 公開のGO、Windows・iRacingでしか確認できない最終体験を判断する |

同じAIが作業と確認を兼任した場合は**独立確認済みとしない**。確認者の署名が得られなければ出荷不可。

## Gate 0 — 変更範囲と出荷対象

- [ ] 公開中Build番号、Git SHA、Desktop Release、Bridge Release、Railway SHAを記録した。
- [ ] 今回変更した全ファイルを`git diff --name-status`で列挙した。
- [ ] Desktop / Bridge / server / auth・payment / public pageのどれへ影響するか分類した。
- [ ] 既存の未追跡ファイル・利用者作業を変更またはcommitへ混ぜていない。
- [ ] Build番号を上げる必要性と、出荷する二系統（Desktop同梱Bridge / Bridge単体）を決めた。
- [ ] 実装済み、機械検証済み、artifact検証済み、Windows確認済み、実走確認済みを分離した。

## Gate 1 — 失敗の固定と受入条件

- [ ] 実走ログの時刻、質問、直前telemetry、実際の回答を固定した。
- [ ] 不具合を再現する保存ログまたは最小fixtureを作った。
- [ ] 修正前に失敗し、修正後に成功する回帰テストを追加した。
- [ ] 音声認識揺れ、短い追質問、肯定文、否定文、データなしを含めた。
- [ ] 数字を返す機能は、同一frameの権威値と回答値を比較した。
- [ ] 推測禁止値は、根拠欠落時にfail-closedすることを確認した。
- [ ] 過去値の質問に現在値を代用しないことを確認した。
- [ ] 同じ回答の反復、古いqueue、session/pit/driver切替後の残留状態を確認した。

## Gate 2 — 完全な動線

各変更機能について、次を一列のtraceで確認する。

- [ ] iRacing / driver input → Bridge受信。
- [ ] Bridge受信 → authoritative state / snapshot。
- [ ] state → decision / handler。
- [ ] handler → renderer dispatch。
- [ ] dispatch → speech queue（優先度、dedupe、保留、破棄を含む）。
- [ ] speech queue → TTS開始 → 再生開始または明示的破棄。
- [ ] 発話内容 → debrief / memory / cost記録（対象機能のみ）。
- [ ] session変更、pit cycle、checker、driver交代で必要なstateがresetされる。
- [ ] LLMを通す処理とローカル処理の境界を確認した。
- [ ] ローカルhandlerが無い時、黙ってLLMへ落ちず診断理由を残す。

## Gate 3 — ソースと機械検証

- [ ] 変更ファイルの構文・静的検査に合格した。
- [ ] 対象単体テスト、配線テスト、保存ログ再生、関連回帰テストに合格した。
- [ ] `./preflight.sh`が全項目合格した。
- [ ] `git diff --check`に合格した。
- [ ] 完全diffを作業者が再読し、変更漏れ・デバッグ残り・秘密情報がない。
- [ ] 通常テストでAnthropic / Google STT / Google TTS等の有料実API呼出が0件である。
- [ ] LLM・STT・TTS・Railway負荷・利用権へ影響する場合、原価影響と計測方法を記録した。
- [ ] テストがソースを直接requireするだけで、製品package経路を飛ばしていないか確認した。

## Gate 4 — Build前の独立レビュー

- [ ] 作業者が、目的・原因・変更diff・テスト結果・未確認事項を確認者へ渡した。
- [ ] 確認者が原因と修正の対応関係を独立に確認した。
- [ ] 確認者が元の実走失敗を再生した。
- [ ] 確認者が境界値、欠損値、古い値、session切替、連続質問を反証した。
- [ ] 確認者がpackage manifestとworkflowを確認した。
- [ ] P0/P1指摘が0件。残るP2以下はYujiへ明示した。
- [ ] 確認者名、確認時刻、対象SHAを記録した。

## Gate 5 — Private candidate artifact

Yujiのbuild GO後、最初は`publish=false`で作る。

- [ ] Desktop workflowが意図したSHAをcheckoutした。
- [ ] `bridge.py`の製品Build番号と`build-info.json`が一致した。
- [ ] Desktop同梱Bridgeが同じ対象SHAから生成された。
- [ ] 完成`app.asar`を列挙し、rendererが参照する全ローカルJSが存在する。
- [ ] `local-intent-router.js`、`fuel-plan-guard.js`、memory、strategy、cost moduleが存在する。
- [ ] 同梱`OMORAY-PITWALL-Bridge.exe`が存在し、0 byteでない。
- [ ] NSIS installerが生成され、artifact名に製品Build番号と日時がある。
- [ ] artifactのbytesとSHA-256を記録した。
- [ ] 確認者がCIログとartifact内容を独立確認した。

## Gate 6 — Windows candidate確認（Yujiの運用では公開後）

- [ ] クリーンインストールが成功する。
- [ ] 公開中の旧exeから上書きインストールが成功する。
- [ ] Desktop表示Build、BridgeログBuild、対象Buildが一致する。
- [ ] Desktop起動で同梱Bridgeが開始し、二重起動しない。
- [ ] iRacing未起動、検出済み、live telemetryの各状態表示が正しい。
- [ ] 起動ログに必要moduleのloaded / missing状態が記録され、全てloadedである。
- [ ] PTT、マイク、TTS、overlay、Settings保存、診断ログ出力を確認した。
- [ ] 更新通知から正しいinstallerへ到達できる。無操作の自動更新とは表現しない。
- [ ] 旧互換URLと現行URLが同じcandidateを指すことを確認した。

## Gate 7 — Server / 認証 / 決済（変更時必須）

- [ ] server変更を含む場合、Railway deployment成功だけでなく`./verify-deploy.sh`で本番SHA一致を確認した。
- [ ] Desktopとserverの要求契約・後方互換性を確認した。
- [ ] auth / payment変更時、未認証、期限切れ、支払失敗、再開、二重Webhook、別ユーザーを確認した。
- [ ] Starter Passは一回払い、30日、利用量上限、自動更新なしの契約と一致する。
- [ ] 本番StripeテストはYujiの明示許可後だけ行い、テスト決済と実顧客売上を混同しない。
- [ ] public page変更時、PC / mobile、日本語 / 英語、CTA、規約、価格、決済遷移を確認した。

## Gate 8 — iRacing実走スモーク（Yujiの運用では公開後）

自動テストで代替できない。変更に関係する最小限をcandidateで確認する。

- [ ] Practice → Qualifying → Raceのsession認識が切り替わる。
- [ ] 車両、コース、クラス、race formatを正しく認識する。
- [ ] 燃料、残り時間/周回、順位、前後GAPをdashboard値と同時刻で照合する。
- [ ] 前後GAP質問、短い追質問、データなしを各一回確認する。
- [ ] 停止車、コースアウト、左右車両など今回対象の安全コールを確認する。
- [ ] 舵角・ブレーキ中の保留と、安全P0/P1の即時性を確認する。
- [ ] ピット前、pit road、box、給油後、blend後で状態と発話が更新される。
- [ ] checker後に燃料・戦略・順位変動の不要発話が続かない。
- [ ] debriefが実際の走行事実と一致し、創作周回・現在値の過去値化がない。
- [ ] 診断ログに質問直前snapshot、route、queue、再生/破棄が残る。

## Gate 9 — 公開と公開後照合

Yujiの公開GO後にだけ実施する。

- [ ] 公開workflowがprivate candidateで検査したSHAを使用した。
- [ ] Desktop Release名のBuild番号が製品Buildと一致する。
- [ ] Bridge ReleaseとDesktop同梱Bridgeの世代が一致する。
- [ ] 公開URLからinstallerを実際に取得した。
- [ ] 公開取得物のbytes / SHA-256が公開artifactと一致した。
- [ ] latest、日付版、旧互換URLの指す中身を照合した。
- [ ] 本番Railway SHAを再確認した（server変更時）。
- [ ] 旧Build利用者の更新動線で新Buildへ到達できた。
- [ ] `HANDOFF.md`へ、SHA、workflow ID、artifact hash、server SHA、Windows確認、実走未確認を分けて記録した。

## Gate 10 — 公開停止条件とロールバック

次のいずれかがあれば新規配布を止める。

- [ ] 権威データが存在するのにno-data回答へ落ちる。
- [ ] 燃料、残周回、順位、GAP、ピット指示で事実と異なる断定がある。
- [ ] 安全コールmodule、燃料guard、Bridgeがpackageに存在しない。
- [ ] 旧Buildから更新できない、起動できない、PTT/TTSが機能しない。
- [ ] 認証・支払失敗後も利用できる、別ユーザーの権利が混ざる。
- [ ] server SHAと出荷対象SHAが一致しない。

発生時は公開Releaseの差し替えを独断で行わず、Yujiへ影響範囲、回避方法、rollback候補を提示してGOを受ける。

## 出荷署名欄

```text
製品Build:
対象Git SHA:
変更領域: Desktop / Bridge / Server / Auth-Payment / Public Page

作業者:
作業完了時刻:
対象テスト:
preflight:
外部有料API呼出:

確認者:
独立確認時刻:
P0/P1:
Private artifact workflow:
Artifact bytes / SHA-256:
app.asar module検査:
Windows candidate:
iRacing candidate:
Server SHA:

未確認事項:
Yuji build GO:
Yuji public GO:
公開後取得照合:
最終判定: 出荷可 / 出荷不可
```

## 今回のBuild 281欠陥を検出する必須反証

- rendererが`local-intent-router.js`を参照しているのに、installerの`app.asar`へ存在しない場合は失敗する。
- rendererが参照するローカルJSを追加したのにpackage manifestへ追加し忘れた場合は失敗する。
- GAP質問直前に`gapBehind`があるのに、`router_missing` / `unhandled` / server no-dataへ落ちた場合は失敗する。
- Lunaがdebriefでは値を読めるがlive回答で読めない場合は、保存成功で合格にせずlive動線を不合格にする。
- 現在の路面温度を「昨日」「前回」の値として返した場合は失敗する。
