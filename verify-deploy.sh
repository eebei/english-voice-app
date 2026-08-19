#!/usr/bin/env bash
# 本番が「今どのコミットで動いているか」を確認する。
#
# ★なぜ要るか（2026-08-19）
#   PITWALL の更新は2系統ある。
#     exe側    : bridge.py / desktop/** → GitHub Actions → installer（成否の証拠が残る）
#     サーバー側: server.js / prompts.js / engineer-card.js / auth.js → Railway
#   サーバー側は「push したから反映されているはず」だけで運用しており、反映を
#   確認する手段が無かった。GitHub Actions が緑でも Railway が落ちていれば、
#   installer だけ新しくて中身は古い、という状態になる。
#   Build 277 の発話短縮はサーバー側にしか無く、まさにこの型だった。
#
# 使い方:
#   ./verify-deploy.sh              ローカルHEADと本番を突合
#   ./verify-deploy.sh <commit>     指定コミットが本番に入っているか
#   ./verify-deploy.sh --url <URL>  別環境（staging等）を見る

set -u

URL="https://omoraypitwall.com"
WANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    *) WANT="$1"; shift ;;
  esac
done
[ -n "$WANT" ] || WANT="$(git rev-parse HEAD 2>/dev/null || echo '')"

if [ -z "$WANT" ]; then
  echo "❌ 比較対象のコミットが分からない（gitリポジトリ外なら引数で渡すこと）"; exit 2
fi

BODY="$(curl -sS --max-time 20 "$URL/api/version" 2>/dev/null)"
if [ -z "$BODY" ]; then
  echo "❌ $URL/api/version に到達できない（本番が落ちているか、まだこの版が出ていない）"
  echo "   Railway の Deployments を見ること。"
  exit 1
fi

LIVE="$(printf '%s' "$BODY" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')"
STARTED="$(printf '%s' "$BODY" | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p')"

if [ -z "$LIVE" ]; then
  echo "⚠️  本番は応答したが commit を返していない。"
  echo "   /api/version がまだ無い版が動いている（＝この変更自体が未反映）か、"
  echo "   RAILWAY_GIT_COMMIT_SHA が注入されていない。応答: $BODY"
  exit 1
fi

echo "本番   : $URL"
echo "起動   : ${STARTED:-unknown}"
echo "本番SHA: $LIVE"
echo "期待SHA: $WANT"

case "$WANT" in
  "$LIVE"*) echo "✅ 一致 — 本番はこのコミットで動いている"; exit 0 ;;
esac
case "$LIVE" in
  "$WANT"*) echo "✅ 一致 — 本番はこのコミットで動いている"; exit 0 ;;
esac

echo "❌ 不一致 — **本番はまだ古いコミットで動いている**"
if git cat-file -e "$LIVE" 2>/dev/null; then
  echo "   本番のコミット: $(git log --oneline -1 "$LIVE")"
  BEHIND="$(git rev-list --count "$LIVE..$WANT" 2>/dev/null || echo '?')"
  echo "   本番は $BEHIND コミット遅れている"
fi
echo "   Railway の Deployments で最新デプロイの成否を確認すること。"
exit 1
