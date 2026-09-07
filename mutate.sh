#!/usr/bin/env bash
# 変異試験ランナーの薄いwrapper。引数はそのまま Node runner へ渡す。
# 実体は tools/mutate.js（受入条件 A-1〜A-8 は共有MDの Codex 記載が正本）。
set -euo pipefail
exec node "$(dirname "$0")/tools/mutate.js" "$@"
