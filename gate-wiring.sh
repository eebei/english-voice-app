#!/usr/bin/env bash
# 配線 lint 専用Gate（Codex 判断 2026-09-06）
#
#   目的：**fixture 自己検査だけで実コードの未配線を緑にしない**。
#
#   契約:
#     1. `WIRING_BASE` を**明示必須**にする。既定値を置かない。
#        既定を「現在の候補SHA」にすると、そこから差分ゼロで**自明に緑**になり、
#        このGateが何も守らなくなる（実際に `4de36b8` で 対象0/合格 になった）。
#        比較点は**そのスライスの開始点**を指定すること（例：Build 298 なら `6c25500`）。
#     2. fixture 自己検査（tests-wiring.js）が全緑であること。
#     3. 実コード lint の未配線が0であること。
#     4. 対象0は**不合格（exit 1）**。「検査対象が無い」を緑にすると、比較点を誤ったまま素通りする。
#     5. いずれか赤なら exit 1。
set -u
fail=0
cd "$(dirname "$0")"

if [ -z "${WIRING_BASE:-}" ]; then
  echo "❌ WIRING_BASE が未指定。比較点（スライスの開始SHA）を明示すること"
  echo "   例: WIRING_BASE=6c25500 bash gate-wiring.sh"
  exit 1
fi
BASE="$WIRING_BASE"

echo "▶ 配線 lint 自己検査（fixture）"
if out=$(node tests-wiring.js 2>&1); then echo "   ✅ ${out##*[}"; else echo "   ❌ 不合格"; echo "$out"|tail -8; fail=1; fi

echo "▶ 実コードの配線（比較点 ${BASE:0:7}）"
lint=$(node tools/wiring-lint.js --base "$BASE" 2>&1); lint_status=$?
echo "$lint" | tail -1 | sed 's/^/   /'
if [ "$lint_status" -ne 0 ]; then echo "$lint" | grep "❌" | sed 's/^/   /'; fail=1; fi
# ★対象0は**不合格**。警告表示だけにしていたため exit 0 で通っていた（Codex 指摘）。
#   「検査対象が無い」を合格として通すと、比較点を間違えたまま Gate が素通りする。
if echo "$lint" | grep -q "対象 0 /"; then
  echo "   ❌ 対象0：この比較点では何も検査していない。スライスの開始点を指定すること"
  fail=1
fi

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ wiring gate 合格"; else echo "❌ wiring gate 不合格"; fi
exit $fail
