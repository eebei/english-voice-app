# OMORAY PITWALL 引き継ぎ

最終更新: 2026-08-15 JST

## Build 271 公開候補

- Chief Engineer Mode v0、Fuel Window T-1判断、Plan A/Bの対象周BOX callを実装。
- `⚙ Settings` で走行順3名・現在担当・ON/OFFを保存し、Race中の本人 `ACTIVE → DRIVER_HANDOFF` だけでローカル引き継ぎを発話する。
- Plan Bの旧「1周延長」をFuel Window起点の条件付きアンダーカットへ統一。
- 内部実測: Chief Engineer 16/16、Driver Handoff 154/154、Engineer Cards 94/94、Bridge再計算75/75、全`preflight.sh`合格・`出荷可`。
- 詳細証拠: `review/BUILD271_CHIEF_ENGINEER_AND_FUEL_WINDOW_EVIDENCE.md`。
- 別PCの次ドライバーへ送るチーム共有クラウドは未実装。v0は同じPC上のLunaによる引き継ぎ。

## 公開済みの基準点

- リポジトリ: `eebei/english-voice-app` / ブランチ: `main`
- 公開済みビルド: **270** — コミット `f05b86e`（`Build 270 debrief continuity and radio diagnostics`）
- 公開インストーラー: `https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe`
- GitHub Actions の Windows ビルド: `31791353378` 成功。
- 公開後の URL 取得を確認済み: 96MB、SHA-256 `e3baabcdd7054904d7a210ff6418b9521d9b7240dcb310a333247ccb5251a6ee`。

Build 270 は、Build 269 のピット直後燃料余裕・短いピット追加入力・ピットサイクル中順位コールの修正を含む。その上で、デブリーフ継続質問、質問数の圧縮、発話診断、利用者向けの秘匿情報を伏せた診断ログを追加する。

これは Windows 側の更新受信確認、実 iRacing テレメトリ、音声の間合い、ドライバーにとっての有用性を実証するものではない。これらは実走で確認する。

## Build 270 の運用品質改善

既存の未追跡ファイルやレビュー成果物を、この変更群に混ぜない。意図した変更は以下。

- `desktop/memory-action-layer.js`, `desktop/renderer.html`
  - 同一ドライバー・コース・車両に一致するデブリーフ記録があれば、汎用的な聞き取りを繰り返さず、次回は過去の要点を一つだけ引き継いで尋ねる。
  - 選んだ聞き取りはローカルに記録し、同じ過去回答を繰り返し尋ねない。
  - 初回デブリーフは最大二問。製品へのフィードバックは従来の頻度を保ち、走行根拠として転用しない。
- `desktop/renderer.html`, `tests-speech-latency-trace.js`, `preflight.sh`
  - ドライバー向け発話ごとに、キュー投入、TTS 開始、再生開始、破棄の経路を、優先度・生成元とともにローカル診断ログへ残す。
  - これは計測の配線であり、`300ms` や `500ms` を未測定のまま約束するものではない。
- `desktop/main.js`, `desktop/preload.js`, `desktop/renderer.html`
  - `📦 診断ログ` は、現在セッションを秘匿情報を伏せた形でデスクトップへ保存する。保存先を開くだけで、外部送信はしない。
- `public/pitwall.html`
  - Super Formula、INDYCAR、GTP/プロトタイプ、言語別プログラムの公募および無料アクセス案内を公開ページから外す。
  - 現在の公開対象を GT3 / ロードコース、実測燃費・ピット・安全・デブリーフとし、今後のクラス対応やセットアップ助言は明確に分ける。
  - デスクトップ利用者が Bridge を別途ダウンロードするという旧案内を修正する。デスクトップアプリには Bridge が含まれ、起動時に開始する。

## 既存アーキテクチャの事実

- デスクトップアプリは起動時に同梱 Bridge を開始し、Bridge は iRacing を監視してライブテレメトリが可能になれば接続する。
- レンダラーには既に優先度キューがある。P0 安全、P1 危険、P2 手順、P3 戦略、P4 情報、P5 会話。高い優先度は低い優先度だけを中断できる。
- Memory V2 はドライバー・コース・車両に紐づくデブリーフ根拠を保存・再読込し、一致履歴を暫定燃費および Plan A/B/C に利用する。今回の変更は、その継続性をドライバーにも一問の形で見えるようにするもの。
- 現在の更新は「更新検知と、利用者が押すインストーラーリンク」であり、無操作の差分自動更新ではない。本当の自動更新は署名済み更新フィードと差分更新の設計を要し、セキュリティ確認を含む別プロジェクトとして扱う。

## この変更群で完了した検証

- `node tests-memory-action-layer.js` — 26 チェック成功。
- `node tests-evidence-debrief.js` — 41/41 成功。
- `node tests-speech-latency-trace.js` — 3/3 成功。
- `node tests-desktop-state.js` — 9/9 成功。
- `node --check desktop/main.js`、`node --check desktop/preload.js`、レンダラーの抽出スクリプト構文、`git diff --check` を確認済み。
- これらのテストは Anthropic、Google STT、Google TTS の実運用 API を呼び出していない。

## 実走で残る確認

1. ビルド / Windows: 旧ビルドへ上書きインストールし、表示 Build 番号と Bridge 自動開始を確認する。
2. iRacing: 実機で検出からライブテレメトリ状態へ変わることを確認する。
3. 無線: 停止車両または並走車両のコールと通常会話を一件ずつ採取し、`SPEECH_LATENCY` の優先度・生成元・経路を確認する。数値目標は実測前に断定しない。
4. デブリーフ: 同じ車両・コースを完走し、焦点を絞った一問に答える。次の同一条件セッションで、旧アンケートの繰り返しではなく別の継続質問になることを確認する。
5. 診断: `📦 診断ログ` を押し、デスクトップに `OMORAY-PITWALL-support-*.txt` ができること、外部共有前に秘匿情報が伏せられていることを確認する。
6. ホームページ: 所有者承認済みの別デプロイ後、PC とモバイルで表示確認する。

## 現在の商用・製品対象

- 中核: GT3 とロードコースのレース運用 — 実測燃費、ピットタイミング、レース文脈、安全コール、簡潔な無線、デブリーフ。
- GTP/プロトタイプ、Super Formula、INDYCAR、オーバル、ダート、深いセットアップ助言を、現在提供済みの機能として販売しない。
- 今回は料金、紹介、無料期間、利用権に触れていない。本番の料金・トライアル・紹介ロジックは変更していない。

## 次の作業

1. Windows 実機で、旧ビルドからの更新、表示 Build 番号、Bridge 自動開始を確認する。
2. iRacing 実走で、無線診断・デブリーフ継続質問を確認する。
3. 本当の無操作自動更新とストリーミング TTS は、別の安全確認付き設計として進める。
