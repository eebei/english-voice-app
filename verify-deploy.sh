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

# ★2026-08-25：SHA一致は「そのコミットが起動した」証拠であって、
#   「新しい経路が実際に生きている」証拠ではない。
#   スライス3で auth.init() に `CREATE TABLE strategy_decisions` を足したため、
#   マイグレーション失敗時は auth.isReady() が false のまま起動しうる。
#   その時 /api/version は正しい SHA を返すのに、記憶APIは 503 を返し続ける。
#   Build 281（SHAは合っていたが module が入っていなかった）と同じ型なので、
#   経路そのものを外から叩いて区別する。
#
#   認証情報は使わない。**未認証で 401 が返ることが正常**＝
#     401 → 経路が生きていて認証も効いている ✅
#     404 → 経路が存在しない（この版が入っていない／登録に失敗）
#     503 → auth/DB が未準備（テーブル作成が失敗している疑い）
#     200 → **認証が外れている＝重大**
probe_endpoint() {
  local path="$1" label="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$URL$path" 2>/dev/null)"
  case "$code" in
    401|403) echo "   ✅ $label ($code 未認証で拒否＝経路は生きている)" ;;
    404)     echo "   ❌ $label (404 経路が無い＝この版はまだ本番に入っていない)"; return 1 ;;
    503)     echo "   ❌ $label (503 auth/DB が未準備＝テーブル作成の失敗を疑う)"; return 1 ;;
    200)     echo "   ❌ $label (200 **認証が外れている**)"; return 1 ;;
    "")      echo "   ❌ $label (応答なし)"; return 1 ;;
    *)       echo "   ❌ $label (予期しない $code)"; return 1 ;;
  esac
  return 0
}

verify_live_routes() {
  echo "経路確認（未認証で叩いて、生きているかを区別する）:"
  local bad=0
  probe_endpoint "/api/memory/decisions" "戦略判断の正本 GET" || bad=1
  return $bad
}

MATCH=0
case "$WANT" in
  "$LIVE"*) MATCH=1 ;;
esac
case "$LIVE" in
  "$WANT"*) MATCH=1 ;;
esac

if [ "$MATCH" -eq 1 ]; then
  echo "✅ SHA一致 — 本番はこのコミットで起動している"
  if verify_live_routes; then
    echo "✅ 経路も生きている — サーバー側は反映済み"
    exit 0
  fi
  echo "❌ **SHAは合っているのに経路が死んでいる。** 反映済みとして扱わないこと。"
  echo "   Railway のログで auth の初期化（DBマイグレーション）失敗を確認すること。"
  exit 1
fi

echo "❌ 不一致 — **本番はまだ古いコミットで動いている**"
if git cat-file -e "$LIVE" 2>/dev/null; then
  echo "   本番のコミット: $(git log --oneline -1 "$LIVE")"
  BEHIND="$(git rev-list --count "$LIVE..$WANT" 2>/dev/null || echo '?')"
  echo "   本番は $BEHIND コミット遅れている"
fi
echo "   Railway の Deployments で最新デプロイの成否を確認すること。"
exit 1
