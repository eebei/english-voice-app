#!/usr/bin/env bash
# private artifact が「対象SHAの中身を本当に含んでいるか」を実物で検査する。
#
# ★なぜ要るか（2026-08-26）
#   Gate 5 の検査を、その場限りのシェル操作で毎回やり直していた。
#   同じ手順を二人が別々に打ち直す形は、Build 282 で証拠が古いまま残った事故と
#   同じ性質の弱さを持つ。手順を道具にして、作業者と確認者が同じものを回す。
#
#   CI が artifact へ同梱する `BUILD-*-GATE5-MANIFEST.json` は runner の自己申告
#   なので、証拠として採らず、こちらで計算した実測値と突合するだけに使う。
#
# 使い方:
#   ./verify-artifact.sh <run-id> <target-sha> <build-number>
#   ./verify-artifact.sh 32911905149 8851712 286
#
#   --keep    作業ディレクトリを消さない（中身を見たい時）
#   --dir D   作業ディレクトリを指定する（既に落としてある zip を再利用できる）
#
# 必要なもの: gh（認証済み） / bsdtar / shasum / node / python3
# 外部有料APIは呼ばない。

set -u

RUN_ID=""; TARGET_SHA=""; BUILD_NUM=""; KEEP=0; WORK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --dir) WORK="$2"; shift 2 ;;
    *) if [ -z "$RUN_ID" ]; then RUN_ID="$1"; elif [ -z "$TARGET_SHA" ]; then TARGET_SHA="$1";
       else BUILD_NUM="$1"; fi; shift ;;
  esac
done

if [ -z "$RUN_ID" ] || [ -z "$TARGET_SHA" ] || [ -z "$BUILD_NUM" ]; then
  echo "使い方: ./verify-artifact.sh <run-id> <target-sha> <build-number> [--keep] [--dir D]"
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT" || exit 2
[ -n "$WORK" ] || WORK="$(mktemp -d "${TMPDIR:-/tmp}/pw-artifact-XXXXXX")"
mkdir -p "$WORK"
fail=0
note() { echo "   $1"; }
ok()   { echo "   ✅ $1"; }
bad()  { echo "   ❌ $1"; fail=1; }

echo "対象 run      : $RUN_ID"
echo "対象SHA       : $TARGET_SHA"
echo "Build番号     : $BUILD_NUM"
echo "作業ディレクトリ: $WORK"
echo ""

# ── 1. run が対象SHAを本当にビルドしたか ───────────────────────────
echo "── 1. run と対象SHAの一致"
RUN_JSON="$(gh run view "$RUN_ID" --json headSha,conclusion,event 2>/dev/null)"
if [ -z "$RUN_JSON" ]; then bad "run $RUN_ID を取得できない"; exit 1; fi
HEAD_SHA="$(printf '%s' "$RUN_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["headSha"])')"
CONCL="$(printf '%s' "$RUN_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["conclusion"])')"
case "$HEAD_SHA" in
  "$TARGET_SHA"*) ok "headSha が対象SHAと一致 ($HEAD_SHA)" ;;
  *) bad "headSha=$HEAD_SHA が対象SHA=$TARGET_SHA と違う。**この artifact は別のコードから作られている**" ;;
esac
[ "$CONCL" = "success" ] && ok "run は success" || bad "run の結論が $CONCL"

# ── 2. 公開していないこと ─────────────────────────────────────────
echo "── 2. Publish がスキップされたか"
PUB="$(gh run view "$RUN_ID" --json jobs 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=[s["conclusion"] for j in d.get("jobs",[]) for s in j.get("steps",[]) if "Publish" in s.get("name","")]
print(",".join(r) if r else "none")')"
[ "$PUB" = "skipped" ] && ok "Publish to Release -> skipped" || bad "Publish の結論が '$PUB'（公開された可能性）"

# ── 3. artifact 取得 ──────────────────────────────────────────────
echo "── 3. artifact 取得"
ART="$(gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/artifacts" 2>/dev/null | python3 -c '
import json,sys
a=json.load(sys.stdin).get("artifacts",[])
if a:
    x=a[0]
    print("\t".join([str(x["id"]),x["name"],str(x["size_in_bytes"])]))')"
if [ -z "$ART" ]; then bad "artifact が見つからない"; exit 1; fi
ART_ID="$(printf '%s' "$ART" | cut -f1)"
ART_NAME="$(printf '%s' "$ART" | cut -f2)"
note "artifact: $ART_NAME ($(printf '%s' "$ART" | cut -f3) bytes)"
case "$ART_NAME" in
  *"Build-$BUILD_NUM-"*) ok "artifact 名が Build $BUILD_NUM を名乗っている" ;;
  *) bad "artifact 名が Build $BUILD_NUM と一致しない: $ART_NAME" ;;
esac

# ★途中で切れた zip を再利用しない。`-s`（非空）だけで判定すると、
#   中断されたダウンロードの残骸をそのまま証拠に使ってしまう。
ART_BYTES="$(printf '%s' "$ART" | cut -f3)"
HAVE_BYTES="$(stat -f%z "$WORK/artifact.zip" 2>/dev/null || stat -c%s "$WORK/artifact.zip" 2>/dev/null || echo 0)"
if [ "$HAVE_BYTES" != "$ART_BYTES" ]; then
  [ "$HAVE_BYTES" != "0" ] && note "既存 zip は $HAVE_BYTES bytes で期待 $ART_BYTES と違う。取り直す"
  rm -f "$WORK/artifact.zip"
  note "ダウンロード中（数分かかる）…"
  curl -sSL -H "Authorization: token $(gh auth token)" -H "Accept: application/vnd.github+json" \
    -o "$WORK/artifact.zip" \
    "https://api.github.com/repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/artifacts/$ART_ID/zip" \
    || { bad "ダウンロード失敗"; exit 1; }
else
  note "既存 zip を再利用（サイズ一致 $HAVE_BYTES bytes）"
fi
rm -rf "$WORK/extracted"; mkdir -p "$WORK/extracted"
unzip -o -q "$WORK/artifact.zip" -d "$WORK/extracted" || { bad "zip 展開失敗"; exit 1; }

# ── 4. installer ─────────────────────────────────────────────────
echo "── 4. installer（実測）"
UNIQ="$(shasum -a 256 "$WORK"/extracted/*.exe | awk '{print $1}' | sort -u | wc -l | tr -d ' ')"
[ "$UNIQ" = "1" ] && ok "installer 3本すべて同一ハッシュ（latest が古い版を指す事故なし）" \
                  || bad "installer のハッシュが $UNIQ 種類ある"
INST="$(ls "$WORK"/extracted/*Setup-2*.exe 2>/dev/null | head -1)"
[ -n "$INST" ] || INST="$(ls "$WORK"/extracted/*.exe | head -1)"
note "$(basename "$INST")  bytes=$(stat -f%z "$INST" 2>/dev/null || stat -c%s "$INST")  sha256=$(shasum -a 256 "$INST" | cut -d' ' -f1)"

# ── 5. 同梱物を実際に取り出す ────────────────────────────────────
echo "── 5. installer を展開して同梱物を取り出す"
rm -rf "$WORK/unpacked"; mkdir -p "$WORK/unpacked"
( cd "$WORK/unpacked" && bsdtar -xf "$INST" resources 2>/dev/null )
R="$WORK/unpacked/resources"
for f in app.asar OMORAY-PITWALL-Bridge.exe; do
  if [ -f "$R/$f" ]; then
    note "$f  bytes=$(stat -f%z "$R/$f" 2>/dev/null || stat -c%s "$R/$f")  sha256=$(shasum -a 256 "$R/$f" | cut -d' ' -f1)"
  else
    bad "$f が installer に入っていない"
  fi
done

# ── 6. CI manifest との突合（manifest は証拠でなく突合相手）────────
echo "── 6. CI manifest との突合（manifest は runner の自己申告）"
MANI="$(ls "$WORK"/extracted/BUILD-*-GATE5-MANIFEST.json 2>/dev/null | head -1)"
if [ -n "$MANI" ]; then
  python3 - "$MANI" "$INST" "$R" <<'PY'
import json,hashlib,os,sys
m=json.load(open(sys.argv[1])); inst,R=sys.argv[2],sys.argv[3]
for key,p in (('installer',inst),('app_asar',os.path.join(R,'app.asar')),
              ('bridge',os.path.join(R,'OMORAY-PITWALL-Bridge.exe'))):
    if not os.path.exists(p): print(f"   ❌ {key} が無い"); continue
    b=os.path.getsize(p); h=hashlib.sha256(open(p,'rb').read()).hexdigest()
    exp=m.get(key,{})
    print(("   ✅ " if b==exp.get('bytes') and h==str(exp.get('sha256','')).lower() else "   ❌ ")
          +f"{key}  実測 {b} / {h[:16]}…")
PY
else
  note "manifest 無し（この build には同梱されていない）"
fi

# ── 7. app.asar 内の runtime module ──────────────────────────────
echo "── 7. runtime module の欠落検査（renderer の script src から派生）"
rm -rf "$WORK/asar"; mkdir -p "$WORK/asar"
( cd "$REPO_ROOT/desktop" && npx --no-install @electron/asar extract "$R/app.asar" "$WORK/asar" >/dev/null 2>&1 )
if [ ! -f "$WORK/asar/renderer.html" ]; then
  bad "app.asar を展開できない（desktop/node_modules に @electron/asar が要る）"
else
  node - "$WORK/asar" "$TARGET_SHA" <<'NODE' || fail=1
const fs=require('fs'),path=require('path'),cp=require('child_process');
const [asar,sha]=process.argv.slice(2);
// 検査対象は **artifact 側の renderer** から派生させる。
// 手元のソースから作ると、artifact が古くても「一致」に見えてしまう。
const html=fs.readFileSync(path.join(asar,'renderer.html'),'utf8');
const want=[...html.matchAll(/<script src="([a-z0-9-]+\.js)"><\/script>/g)].map(m=>m[1]);
const missing=want.filter(f=>!fs.existsSync(path.join(asar,f)));
want.forEach(f=>console.log('   '+(missing.includes(f)?'❌':'✅')+' '+f));
console.log(missing.length?('   ❌ missing packaged runtime modules: '+missing.join(', '))
                          :`   ✅ 欠落なし (${want.length}/${want.length})`);
// 中身が対象SHAと同じか。Windows runner は CRLF で checkout するので正規化して比べる。
const norm=s=>s.replace(/\r/g,'');
let diff=0;
for(const f of want.concat(['renderer.html'])){
  let src;
  try{ src=cp.execSync(`git show ${sha}:desktop/${f}`,{encoding:'utf8',stdio:['ignore','pipe','ignore']}); }
  catch(e){ console.log('   ❌ '+f+' が対象SHAに存在しない'); diff++; continue; }
  const got=fs.readFileSync(path.join(asar,f),'utf8');
  if(norm(src)!==norm(got)){ console.log('   ❌ '+f+' が対象SHAと違う'); diff++; }
}
console.log(diff?`   ❌ 対象SHAと違うファイル ${diff} 件`:'   ✅ 同梱物は対象SHAと一致（CRLF正規化後）');
process.exit(missing.length||diff?1:0);
NODE
fi
BI="$WORK/asar/build-info.json"
if [ -f "$BI" ]; then
  GOT="$(python3 -c "import json;print(json.load(open('$BI'))['buildNum'])" 2>/dev/null)"
  [ "$GOT" = "$BUILD_NUM" ] && ok "build-info.json の buildNum = $GOT" \
                            || bad "build-info.json の buildNum が $GOT（期待 $BUILD_NUM）"
fi

# ── 8. Bridge 実行体 ─────────────────────────────────────────────
echo "── 8. Bridge 実行体（PyInstaller は圧縮するので zlib 展開して見る）"
if [ -f "$R/OMORAY-PITWALL-Bridge.exe" ]; then
  python3 - "$R/OMORAY-PITWALL-Bridge.exe" "$BUILD_NUM" <<'PY'
import zlib,sys
path,build=sys.argv[1],sys.argv[2]
data=open(path,'rb').read(); found=set(); n=0
want=[f"Build {build}".encode(), b"active_decision_id"]
# BUILD_VERSION は bridge.py の1行なので、新旧の文字列は**同じストリーム**に現れる。
# よって「旧が無いこと」はそのストリーム内で判定できる。全走査は4分かかり、
# 道具として使われなくなるため、揃った時点で打ち切る。
stale=f"Build {int(build)-1}".encode()
stale_in_same_stream=False
for i in range(len(data)-2):
    if data[i]==0x78 and data[i+1] in (0x01,0x9c,0xda,0x5e):
        try: out=zlib.decompressobj().decompress(data[i:i+4_000_000])
        except Exception: continue
        if len(out)<200: continue
        n+=1
        for p in want:
            if p in out:
                found.add(p.decode())
                if p.startswith(b"Build ") and stale in out: stale_in_same_stream=True
        if all(p.decode() in found for p in want): break
bad=False
for p in want:
    s=p.decode()
    print(("   ✅ " if s in found else "   ❌ ")+f"{s} が Bridge に実在")
    if s not in found: bad=True
if stale_in_same_stream:
    print(f"   ❌ 同じ箇所に旧 {stale.decode()} も入っている"); bad=True
elif f"Build {build}" in found:
    print(f"   ✅ 同じ箇所に旧 {stale.decode()} は無い")
print(f"   （展開した zlib ストリーム: {n}／全走査ではなく検出時点で打ち切り）")
sys.exit(1 if bad else 0)
PY
  [ $? -eq 0 ] || fail=1
  # 2系統の取り違え（Electron同梱用は pygame を含む。単体用は含まない）
  PG="$(strings -a "$R/OMORAY-PITWALL-Bridge.exe" 2>/dev/null | grep -ci pygame)"
  [ "${PG:-0}" -gt 0 ] && ok "pygame $PG 件（Electron同梱用の正しい系統）" \
                       || bad "pygame が無い＝Bridge単体用を掴んでいる（PTT が欠ける）"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "✅ artifact は対象SHA $TARGET_SHA の中身を含んでいる"
  echo "   ただしこれは **Gate 5 の証拠**であり、Windows起動・server反映・実走の証拠ではない。"
else
  echo "❌ 検査不合格。この artifact を Build $BUILD_NUM の証拠に使わないこと。"
fi
[ "$KEEP" -eq 1 ] && echo "作業ディレクトリを残した: $WORK" || rm -rf "$WORK"
exit $fail
