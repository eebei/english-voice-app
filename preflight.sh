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
if python3 -m pyflakes irsdk-bridge/bridge.py irsdk-bridge/dump_all_vars.py irsdk-bridge/log_strategy_timeseries.py irsdk-bridge/irsdk_mem.py irsdk-bridge/race_lifecycle.py irsdk-bridge/class_map.py irsdk-bridge/f2time_contract.py irsdk-bridge/driver_activity.py irsdk-bridge/final_lap.py irsdk-bridge/fuel_strategy.py irsdk-bridge/session_authority.py 2>&1 | grep -E "undefined name|invalid syntax|syntax error"; then
  echo "   ❌ 致命的な問題あり"; fail=1
else
  echo "   ✅ 未定義変数なし"
fi

echo "── JavaScript: 構文"
for f in prompts.js server.js; do
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

echo "── usageSessionId初期化テスト（TDZ再発防止・2026-07-23 Codex再指摘）"
if node tests-usage-session-init.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-usage-session-init.js 2>&1|tail -10; fail=1; fi

echo "── Google使用量のレース帰属テスト（2026-07-23 Codex再指摘）"
if node tests-usage-google-attribution.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-usage-google-attribution.js 2>&1|tail -15; fail=1; fi

echo "── Cost Telemetry自動回収・再送・利用文脈分類（2026-07-26）"
if node tests-cost-telemetry.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-cost-telemetry.js 2>&1|tail -15; fail=1; fi

echo "── Update Gate即時遮断・並列確認（2026-07-26）"
if node tests-update-gate-latency.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-update-gate-latency.js 2>&1|tail -15; fail=1; fi

echo "── F1型レース無線・反射短文化（2026-07-26）"
if node tests-radio-brevity.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-radio-brevity.js 2>&1|tail -20; fail=1; fi

echo "── Luna発話安全窓・舵角/ブレーキゲート（2026-07-27）"
if node tests-speech-window.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-speech-window.js 2>&1|tail -20; fail=1; fi

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

echo "── /api/chat HTTP統合テスト（stream/non-stream応答契約・P0-1再発防止）"
if node tests-chat-http.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-chat-http.js 2>&1|grep "❌"|head -5; fail=1; fi

echo "── requireAdminテスト（?secret=廃止・timingSafeEqual・2026-07-23 Codexレビュー）"
if node tests-require-admin.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-require-admin.js 2>&1|grep "❌"|head -10; fail=1; fi

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

echo "── Driver Handoff / Inactive Driver 認識（Unit E0・2026-07-26 Codex指示）"
if python3 irsdk-bridge/tests_driver_handoff.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_driver_handoff.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Final Lap総合首位・壁時計モデル（Unit 1・2026-07-26）"
if python3 irsdk-bridge/tests_final_lap.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_final_lap.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Final Lap本番配線・dispatch確定契約（Unit 1・2026-07-26）"
if python3 irsdk-bridge/tests_final_lap_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_final_lap_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── 耐久燃料L単位band・dispatch確定契約（Unit 2・2026-07-26）"
if python3 irsdk-bridge/tests_fuel_strategy.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_fuel_strategy.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Final Lap authority→耐久燃料本番配線（Unit 2・2026-07-26）"
if python3 irsdk-bridge/tests_fuel_strategy_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_fuel_strategy_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Session Authority純粋契約（Unit 3・2026-07-26）"
if python3 irsdk-bridge/tests_session_authority.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_authority.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── SessionInfo→renderer→prompt権威配線（Unit 3・2026-07-26）"
if python3 irsdk-bridge/tests_session_authority_wiring.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_session_authority_wiring.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── E0×Final Lap×燃料×Session Authority統合契約（2026-07-26）"
if python3 irsdk-bridge/tests_phase_ab_integration.py >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_phase_ab_integration.py 2>&1|grep "❌"|head -8; fail=1; fi

echo "── Build 232 実走ハードニング（TTS・話法・ピット・燃料・更新）"
if node tests-build232-hardening.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build232-hardening.js; fail=1; fi

echo "── Build 236 Race権威・燃料回答・Luna安全話法（2026-07-29）"
if node tests-build236-race-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-build236-race-authority.js; fail=1; fi

echo "── セッション証拠デブリーフ・本人確認Memory（2026-07-28）"
if node tests-evidence-debrief.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-evidence-debrief.js; fail=1; fi

echo "── 全7キャラクター 判断・記憶・安全契約共通化（2026-07-29）"
if node tests-character-capability-parity.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-character-capability-parity.js; fail=1; fi

echo "── Fuel authority・BoP容量・結果/debrief fail-close（2026-07-29）"
if node tests-fuel-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; node tests-fuel-authority.js; fail=1; fi

echo "── Weekend authority・予選fail-close・Luna話法・修理時間（2026-07-29）"
if python3 irsdk-bridge/tests_weekend_authority.py >/dev/null 2>&1 && node tests-weekend-authority.js >/dev/null 2>&1; then echo "   ✅ 全ケース合格"; else echo "   ❌ 不合格"; python3 irsdk-bridge/tests_weekend_authority.py; node tests-weekend-authority.js; fail=1; fi

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ 出荷可"; else echo "❌ 出荷不可（上記を直すこと）"; fi
exit $fail
