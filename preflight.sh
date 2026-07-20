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
if python3 -m pyflakes irsdk-bridge/bridge.py 2>&1 | grep -E "undefined name|invalid syntax|syntax error"; then
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

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ 出荷可"; else echo "❌ 出荷不可（上記を直すこと）"; fi
exit $fail
