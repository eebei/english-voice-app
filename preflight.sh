#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 出荷前チェック（2026-07-20 新設）
#   きっかけ：`data` と `msg` を書き間違えた1行が websocket ハンドラを殺し、
#   Lunaが喋るたびに接続が切れて、ドライバーの問いかけに一切答えられなくなった。
#   予選が丸ごと無駄になった。機械が一瞬で見つけられる種類のミスだった。
#   ビルド前に必ず通す。ここを通らないものは出荷しない。
# ═══════════════════════════════════════════════════════════════
set -u
fail=0

echo "── Python: 未定義変数・構文（pyflakes）"
if python3 -m pyflakes irsdk-bridge/bridge.py irsdk-bridge/dump_all_vars.py irsdk-bridge/log_strategy_timeseries.py irsdk-bridge/irsdk_mem.py irsdk-bridge/race_lifecycle.py irsdk-bridge/class_map.py irsdk-bridge/f2time_contract.py irsdk-bridge/driver_activity.py irsdk-bridge/final_lap.py irsdk-bridge/fuel_strategy.py irsdk-bridge/endurance_fuel.py irsdk-bridge/strategy_options.py irsdk-bridge/session_authority.py irsdk-bridge/pit_loss_calibrator.py irsdk-bridge/pit_exit_forecaster.py irsdk-bridge/pit_cycle_tracker.py 2>&1 | grep -E "undefined name|invalid syntax|syntax error"; then
  echo "   ❌ 致命的な問題あり"; fail=1
else
  echo "   ✅ 未定義変数なし"
fi

echo "── JavaScript: 構文"
for f in prompts.js server.js engineer-card.js desktop/memory-action-layer.js desktop/strategy-playbook.js; do
  if node --check "$f" 2>&1 | head -3; then echo "   ✅ $f"; else echo "   ❌ $f"; fail=1; fi
done

echo "── renderer.html 内のスクリプト構文"
python3 - <<'PY' > /tmp/_r.js
import re
html=open('desktop/renderer.html').read()
print(max(re.findall(r'<script[^>]*>(.*?)</script>', html, re.S), key=len))
PY
if node --check /tmp/_r.js >/dev/null 2>&1; then echo "   ✅ renderer"; else echo "   ❌ renderer 構文エラー"; node --check /tmp/_r.js 2>&1|head -3; fail=1; fi

echo "── 発話ディレクターの競合テスト"
if node tests-speak-priority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-speak-priority.js 2>&1|tail -5; fail=1; fi

echo "── 非同期割り込みテスト（本番コードを抽出して実行）"
if node tests-speak-async.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-speak-async.js 2>&1|tail -6; fail=1; fi

echo "── TTS/Audio失敗経路の診断計装テスト（2026-07-23 Codex再指摘 P0/P1）"
if node tests-tts-fail-logging.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-tts-fail-logging.js 2>&1|grep "❌"|head -6; fail=1; fi

echo "── 発話レイテンシー／fate trace契約（公開前実測ゲート）"
if node tests-speech-latency-trace.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-speech-latency-trace.js 2>&1|grep "❌"|head -6; fail=1; fi

echo "── usageSessionId初期化テスト（TDZ再発防止・2026-07-23 Codex再指摘）"
if node tests-usage-session-init.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-usage-session-init.js 2>&1|tail -10; fail=1; fi

echo "── Google使用量のレース帰属テスト（2026-07-23 Codex再指摘）"
if node tests-usage-google-attribution.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-usage-google-attribution.js 2>&1|tail -15; fail=1; fi

echo "── Cost Telemetry自動回収・再送・利用文脈分類（2026-07-26）"
if node tests-cost-telemetry.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-cost-telemetry.js 2>&1|tail -15; fail=1; fi

echo "── 原価ゲート全契約・Windows cost-meter同梱（恒久出荷ゲート）"
if node tests-cost-gate.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-cost-gate.js 2>&1|tail -15; fail=1; fi

echo "── Shadow PITWALL Credits台帳・原価換算・二重減算防止（2026-08-03）"
if node tests-shadow-credits.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-shadow-credits.js 2>&1|tail -15; fail=1; fi

echo "── 2モード化・Practice振り返り（Build 243）"
if node tests-practice-mode.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-practice-mode.js 2>&1|tail -15; fail=1; fi

echo "── Update Gate即時遮断・並列確認（2026-07-26）"
if node tests-update-gate-latency.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-update-gate-latency.js 2>&1|tail -15; fail=1; fi

echo "── F1型レース無線・反射短文化（2026-07-26）"
if node tests-radio-brevity.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-radio-brevity.js 2>&1|tail -20; fail=1; fi

echo "── Luna発話安全窓・舵角/ブレーキゲート（2026-07-27）"
if node tests-speech-window.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-speech-window.js 2>&1|tail -20; fail=1; fi

echo "── Telemetry Truth Gate・完全ラップタイム（2026-07-30）"
if node tests-telemetry-truth-gate.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-telemetry-truth-gate.js 2>&1|tail -20; fail=1; fi

echo "── 時間制レース残り時間・燃料・首位GAP Truth Gate（2026-08-02）"
if node tests-timed-race-truth.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-timed-race-truth.js 2>&1|tail -20; fail=1; fi

echo "── iRacing検出済み・ライブテレメトリ待ち診断（2026-07-28）"
if node tests-iracing-detection.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-iracing-detection.js 2>&1|tail -20; fail=1; fi

echo "── デブリーフ自動記憶・明示保存結果契約（2026-07-27）"
if node tests-memory-wiring.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-memory-wiring.js 2>&1|tail -20; fail=1; fi

echo "── PTT即時録音・短音声診断（2026-07-27）"
if node tests-ptt-capture.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-ptt-capture.js 2>&1|tail -20; fail=1; fi

echo "── Desktop設定永続化・会話画面復帰（2026-07-27）"
if node tests-desktop-state.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-desktop-state.js 2>&1|tail -20; fail=1; fi

echo "── Windows NSIS installer・旧更新URL互換（2026-07-27）"
if node tests-nsis-installer.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-nsis-installer.js 2>&1|tail -20; fail=1; fi

echo "── 戦略質問ガード（Phase A1・静的＋実コード）"
if node tests-strategy-guard.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-strategy-guard.js 2>&1|grep "❌"|head -5; fail=1; fi

echo "── 8/8実走失敗ログ再現・Intent実行エンジニア（Build 255）"
if node tests-engineer-card.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-engineer-card.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── 8/15八木さん12h：PACE誤配線・同一スティント反復抑止"
if node tests-live-pace-repetition.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-live-pace-repetition.js; fail=1; fi
echo "[V3 Local Intent Router]"
if node tests-local-intent-router.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-local-intent-router.js; fail=1; fi

echo "── Build 279 前後GAP即答・変化時だけの能動GAP（2026-08-23）"
if python3 -m unittest irsdk-bridge/tests_gap_call_policy.py irsdk-bridge/tests_gap_delivery_guard.py irsdk-bridge/tests_gap_trend_wiring.py >/dev/null 2>&1 \
  && node tests-speech-window.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 -m unittest irsdk-bridge/tests_gap_call_policy.py irsdk-bridge/tests_gap_delivery_guard.py irsdk-bridge/tests_gap_trend_wiring.py; node tests-speech-window.js; fail=1; fi

echo "── 8/23 Build 279アホ回答・古いGAP実走失敗の固定再生（Build 280）"
if node tests-build280-20260823-replay.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build280-20260823-replay.js; fail=1; fi

echo "── レース形式→Plan A/B/C事前戦略・ライブ切替（次期Build）"
if node tests-strategy-playbook.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-strategy-playbook.js 2>&1|tail -15; fail=1; fi

echo "── Memory Action Layer 履歴統合→自発戦略→3周更新（次期Build）"
if node tests-memory-action-layer.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-memory-action-layer.js 2>&1|tail -20; fail=1; fi

echo "── Memory V2 ローカル再読込・履歴投入ACK契約（Build 255）"
if node tests-evidence-debrief.js >/dev/null 2>&1 && node tests-memory-import.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-evidence-debrief.js 2>&1|grep "❌"|head -10; node tests-memory-import.js; fail=1; fi

echo "── Luna自己反省記憶：保存→次回ブリーフィング出口"
if node tests-luna-self-memory.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-luna-self-memory.js; fail=1; fi

echo "── /api/chat HTTP統合テスト（stream/non-stream応答契約・P0-1再発防止）"
if node tests-chat-http.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-chat-http.js 2>&1|grep "❌"|head -5; fail=1; fi

echo "── requireAdminテスト（?secret=廃止・timingSafeEqual・2026-07-23 Codexレビュー）"
if node tests-require-admin.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-require-admin.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── Stripe支払い失敗→即時利用停止・再請求成功時の復帰"
if node tests-stripe-entitlement-stop.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-stripe-entitlement-stop.js; fail=1; fi

echo "── \$9.99 Starter Pass：一回払い・30日失効・利用量権利"
if node tests-starter-pass-contract.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-starter-pass-contract.js; fail=1; fi

echo "── iRSDK共有メモリヘッダー定数（合成メモリ・P0-2再発防止）"
if python3 irsdk-bridge/tests_irsdk_mem.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_irsdk_mem.py 2>&1|grep "❌"|head -5; fail=1; fi

echo "── レース終了状態機械（R1・2026-07-21 Codex指示）"
if python3 irsdk-bridge/tests_race_lifecycle.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_race_lifecycle.py 2>&1|grep "❌"|head -5; fail=1; fi

echo "── 同クラスfail-closedゲート（R2・2026-07-21 Codex指示）"
if python3 irsdk-bridge/tests_class_map.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_class_map.py 2>&1|grep "❌"|head -5; fail=1; fi

echo "── F2Time入力契約（R3・2026-07-21 Codex指示）"
if python3 irsdk-bridge/tests_f2time_contract.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_f2time_contract.py 2>&1|grep "❌"|head -5; fail=1; fi

echo "── bridge.py 本番配線（director_active/SessionNum reset/Last5-3-1・2026-07-21 Codex再指摘）"
if python3 irsdk-bridge/tests_bridge_lifecycle_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_bridge_lifecycle_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── judge_call LLM間引きゲート（2026-07-23 Codex設計）"
if python3 irsdk-bridge/tests_judge_llm_gate.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_judge_llm_gate.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── SessionInfo cap 診断計装（Unit 0・2026-07-24 Codex指示）"
if python3 irsdk-bridge/tests_session_info_extent.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_info_extent.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Session ResultsPositions正式順位（2026-08-02）"
if python3 irsdk-bridge/tests_session_results.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_results.py; fail=1; fi

echo "── Driver Handoff / Inactive Driver 認識（Unit E0・2026-07-26 Codex指示）"
if python3 irsdk-bridge/tests_driver_handoff.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_driver_handoff.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Chief Engineer Mode v0：耐久引き継ぎ・Fuel Window T-1動線"
if node tests-chief-engineer-mode.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-chief-engineer-mode.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "[Chief Engineer: cross-PC relay]"
if node tests-chief-cross-pc.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-chief-cross-pc.js 2>&1|tail -15; fail=1; fi

echo "── Final Lap総合首位・壁時計モデル（Unit 1・2026-07-26）"
if python3 irsdk-bridge/tests_final_lap.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_final_lap.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Final Lap本番配線・dispatch確定契約（Unit 1・2026-07-26）"
if python3 irsdk-bridge/tests_final_lap_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_final_lap_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── 耐久燃料L単位band・dispatch確定契約（Unit 2・2026-07-26）"
if python3 irsdk-bridge/tests_fuel_strategy.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_fuel_strategy.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Build 272 現在スティント燃料・複数ストップ・スプラッシュ動線"
if python3 irsdk-bridge/tests_endurance_fuel.py >/dev/null 2>&1 && node tests-endurance-radio.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_endurance_fuel.py; node tests-endurance-radio.js; fail=1; fi

echo "── Final Lap authority→耐久燃料本番配線（Unit 2・2026-07-26）"
if python3 irsdk-bridge/tests_fuel_strategy_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_fuel_strategy_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Session Authority純粋契約（Unit 3・2026-07-26）"
if python3 irsdk-bridge/tests_session_authority.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_authority.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── SessionInfo→renderer→prompt権威配線（Unit 3・2026-07-26）"
if python3 irsdk-bridge/tests_session_authority_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_authority_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── E0×Final Lap×燃料×Session Authority統合契約（2026-07-26）"
if python3 irsdk-bridge/tests_phase_ab_integration.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_phase_ab_integration.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Phase B ピットロス通常区間差引・中央値/IQR（2026-07-29）"
if python3 irsdk-bridge/tests_pit_loss_calibrator.py >/dev/null 2>&1 && python3 irsdk-bridge/tests_pit_loss_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_pit_loss_calibrator.py; python3 irsdk-bridge/tests_pit_loss_wiring.py; fail=1; fi

echo "── Phase C ピット復帰順位・blend shadow forecast（2026-07-30）"
if python3 irsdk-bridge/tests_pit_exit_forecaster.py >/dev/null 2>&1 && python3 irsdk-bridge/tests_pit_exit_forecaster_wiring.py >/dev/null 2>&1 && python3 irsdk-bridge/tests_pit_cycle_tracker.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_pit_exit_forecaster.py; python3 irsdk-bridge/tests_pit_exit_forecaster_wiring.py; python3 irsdk-bridge/tests_pit_cycle_tracker.py; fail=1; fi

echo "── Phase P 本人Practice Profile（IBT/設定指紋・ローカル限定）"
if python3 irsdk-bridge/tests_practice_profile.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_practice_profile.py; fail=1; fi

echo "── Strategy Plan所有・Pit Loss配線（Build 255）"
if python3 irsdk-bridge/tests_strategy_plan_wiring.py >/dev/null 2>&1 && python3 irsdk-bridge/tests_strategy_options.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_strategy_plan_wiring.py; python3 irsdk-bridge/tests_strategy_options.py; fail=1; fi

echo "── Build 232 実走ハードニング（TTS・話法・ピット・燃料・更新）"
if node tests-build232-hardening.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build232-hardening.js; fail=1; fi

echo "── Build 236 Race権威・燃料回答・Luna安全話法（2026-07-29）"
if node tests-build236-race-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build236-race-authority.js; fail=1; fi

echo "── セッション証拠デブリーフ・本人確認Memory（2026-07-28）"
if node tests-evidence-debrief.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-evidence-debrief.js; fail=1; fi

echo "── 指名ライバルCarIdx固定・GAP非代用（2026-08-02）"
if node tests-named-rival.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-named-rival.js; fail=1; fi

echo "── 全7キャラクター 判断・記憶・安全契約共通化（2026-07-29）"
if node tests-character-capability-parity.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-character-capability-parity.js; fail=1; fi

echo "── Fuel authority・BoP容量・結果/debrief fail-close（2026-07-29）"
if node tests-fuel-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-fuel-authority.js; fail=1; fi

echo "── Weekend authority・予選fail-close・Luna話法・修理時間（2026-07-29）"
if python3 irsdk-bridge/tests_weekend_authority.py >/dev/null 2>&1 && node tests-weekend-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_weekend_authority.py; node tests-weekend-authority.js; fail=1; fi

echo "── Build 244 初回telemetry・LIVE truth gate（恒久出荷ゲート）"
if python3 irsdk-bridge/tests_startup_liveness.py >/dev/null 2>&1 && node tests-telemetry-liveness.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_startup_liveness.py; node tests-telemetry-liveness.js; fail=1; fi

echo "── Build 245 上位クラス実接近・簡潔ラップ発話"
if python3 irsdk-bridge/tests_multiclass_approach.py >/dev/null 2>&1 && node tests-build245-radio.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_multiclass_approach.py; node tests-build245-radio.js; fail=1; fi

echo "── Build 277 セットアップ無線の間合い・八木さんログ由来5項目（2026-08-19）"
if node tests-yagi-log-regressions.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-yagi-log-regressions.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── 課金API全経路の認証・5日アクセス期限（2026-08-19 恒久ゲート）"
if node tests-five-day-access.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-five-day-access.js 2>&1|tail -6; fail=1; fi

echo "── デプロイ反映の確認手段（/api/version・verify-deploy.sh・2026-08-19）"
if node tests-deploy-verification.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-deploy-verification.js 2>&1|grep "❌"|head -8; fail=1; fi

echo ""
echo "※ サーバー側（server.js/prompts.js/engineer-card.js/auth.js）を変更した場合は、"
echo "   push 後に ./verify-deploy.sh を実行して本番への反映を確認すること。"
echo "   preflight が見ているのは手元のコードであって、本番に届いたかではない。"

echo "── 記憶→戦略 スライス1：入口→出口トンネル（2026-08-25）"
if node tests-session-memory-tunnel.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-session-memory-tunnel.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── G1 GAP数値権威：値・方向・対象車の同時確定（2026-08-25）"
if python3 irsdk-bridge/tests_gap_authority.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_gap_authority.py 2>&1|tail -12; fail=1; fi

echo "── G2 GAP鮮度：再生直前の照合（14秒の旧数値を再生しない・2026-08-25）"
if node tests-gap-freshness.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-gap-freshness.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Gate 5道具：artifact検査が落ちるべき時に落ちるか（2026-08-26）"
if node tests-artifact-verification.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-artifact-verification.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Gate 6受け皿：起動時module診断が全runtime moduleを見ているか（2026-08-26）"
if node tests-runtime-module-status.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-runtime-module-status.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── スライス2 Decision ID：提案→pit exit→blend→終了→採点→翌回発話（2026-08-25）"
if node tests-decision-memory-tunnel.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-decision-memory-tunnel.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── スライス3 サーバー正本：auth分離・sanitize・表示/訂正/削除/保持期間（2026-08-25）"
if node tests-decision-memory-server.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-decision-memory-server.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── G5 GAP回答の出口：質問→queue待ち→TTS開始で旧数値を再生しない（2026-08-25）"
if node tests-gap-answer-queue.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-gap-answer-queue.js 2>&1|grep "❌"|head -8; fail=1; fi

echo "── 燃料pit timing単一権威：総不足とpit-now分離（2026-08-27）"
if node tests-fuel-timing-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-fuel-timing-authority.js; fail=1; fi

echo "── 運転スタイルV1：60Hz縮約→除外→比較→確認記憶（2026-08-27）"
if python3 irsdk-bridge/tests_driving_style.py >/dev/null 2>&1 && node tests-driving-style-v1.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_driving_style.py; node tests-driving-style-v1.js; fail=1; fi

echo "── Team Plan：ブリーフィング合意→実測→交代→受信→レース後（2026-08-29）"
if node tests-team-plan.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-team-plan.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── Phase F：前後相対ペース authority・GAP訂正保留・単一snapshot（2026-08-29）"
if node tests-phase-f-trackside.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-phase-f-trackside.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── 8/30 RB Ring実走：null→0根絶・交通/ブレンドのpit誤爆（Build 291 replay）"
if node tests-build291-20260830-replay.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build291-20260830-replay.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── Build 291 修正2：会話成立・反射イベント統合（2026-08-30）"
if node tests-build291-fix2.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build291-fix2.js 2>&1|grep "❌"|head -10; fail=1; fi

echo "── PDDP ドライバー成長プログラム（実測→重点→次レース）"
if node tests-pddp.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-pddp.js; fail=1; fi

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ 出荷可"; else echo "❌ 出荷不可（上記を直すこと）"; fi
exit $fail
