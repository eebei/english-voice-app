# PITWALL恒久リリース確認リスト

Build 242/243で、Bridgeが最初のテレメトリ取得時に停止したままDesktopだけが接続済みと表示した事故を受け、全Buildで次を必須とする。

## 自動テスト（Build前）

- [ ] Bridgeの初回poll（完了ラップ0）で例外が発生しない
- [ ] Practice、周回数制Race、時間制Raceの初回snapshotを検証する
- [ ] `telemetry_live`が連続して届き、時刻が更新される
- [ ] Bridgeのpoll thread停止をDesktopへ通知できる
- [ ] 新鮮なsnapshotなしにDesktopがLIVEを表示しない
- [ ] staleになったテレメトリをLunaへ渡さない
- [ ] 既存のBridge、Desktop、Phase、Revenueテストを全件実行する

## 実機スモーク（公開前）

- [ ] iRacing接続後12秒以内にDesktopがLIVEになる
- [ ] 30秒以上走行してLIVEが維持される
- [ ] 1周完了後、ラップ／ベスト更新がログと画面に届く
- [ ] Practice終了時のレビュー提案を確認する
- [ ] Race終了時のデブリーフを確認する
- [ ] Bridge停止時、緑LIVEが消え警告される
- [ ] debug logに`UnboundLocalError`、`Traceback`、poll停止がない

## 出荷ゲート

- [ ] Yuji実走スモーク合格
- [ ] バージョン番号と更新内容が一致
- [ ] commit／push／build／公開は、それぞれ明示されたGOの範囲内だけで実行
