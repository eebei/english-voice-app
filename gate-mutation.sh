#!/usr/bin/env bash
# 変異試験ランナー専用Gate（Codex 判断 2026-09-06：通常 preflight からは分離）
#   通常 preflight は短い製品回帰のまま保つ。runner を変更した時だけこれを回す。
#   自己検査3回 → Build 298 変異 → runner メタ変異。
set -u
fail=0
cd "$(dirname "$0")"
for i in 1 2 3; do
  echo "▶ 自己検査 $i/3"
  if out=$(node tests-mutate-runner.js 2>&1); then echo "   ✅ ${out##*[}"; else echo "   ❌ 不合格"; echo "$out"|tail -8; fail=1; fi
done
echo "▶ Build 298 変異"
if out=$(./mutate.sh mutations/build298.json 2>&1); then echo "   ✅ ${out##*[}"; else echo "   ❌ 不合格"; echo "$out"|tail -6; fail=1; fi
echo "▶ runner メタ変異"
if out=$(./mutate.sh mutations/mutate-runner.json 2>&1); then echo "   ✅ ${out##*[}"; else echo "   ❌ 不合格"; echo "$out"|tail -6; fail=1; fi
echo ""
if [ "$fail" -eq 0 ]; then echo "✅ mutation gate 合格"; else echo "❌ mutation gate 不合格"; fi
exit $fail
