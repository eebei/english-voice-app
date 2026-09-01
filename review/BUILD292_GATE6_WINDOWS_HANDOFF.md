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
