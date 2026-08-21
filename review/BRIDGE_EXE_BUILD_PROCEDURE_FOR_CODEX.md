# Bridge exe のビルド手順 — Codex への回答

回答: 2026-08-20 / Claude Code
出典: リポジトリ内の実物（`.github/workflows/build-desktop.yml` / `.github/workflows/build-bridge.yml` / `.gitignore`）を読んで確認。記憶や推測ではない。

## 質問

> 現在のリポジトリには `irsdk-bridge/bridge.py` はあるが、Electron が要求する
> `desktop/bridge/OMORAY-PITWALL-Bridge.exe` は Git 管理されていない。
> Build 257〜277 で、どの環境・どのコマンド・どの出力先で生成していたか。

---

## 結論

**Bridge exe は誰の手元にも存在しない。GitHub Actions の Windows ランナーが毎回生成し、成果物だけを出して捨てている。**

`desktop/bridge/OMORAY-PITWALL-Bridge.exe` が Git に無いのは事故ではなく設計。`.gitignore` にも入っていない（除外されているのではなく、**そもそも誰もコミットしていない**）。CI がビルド時に生成して Electron へ同梱する。Build 257〜277 まで一貫してこの形。

したがって「リポジトリに無いから壊れている」ではない。**チェックアウト直後に `desktop/bridge/` が空なのが正常な状態**である。

---

## 実際のコマンド（2系統ある）

### A. `build-desktop.yml` — Electron に同梱する用（**本命**）

```yaml
runs-on: windows-latest
- uses: actions/setup-python@v5
  with:
    python-version: '3.12'

- name: Build bridge EXE
  run: |
    python -m pip install --upgrade pip
    pip install websockets pyinstaller pygame pyaudio
    pyinstaller --onefile --name OMORAY-PITWALL-Bridge --console --hidden-import pygame irsdk-bridge/bridge.py

- name: Bundle bridge into desktop app
  shell: pwsh
  run: |
    New-Item -ItemType Directory -Force -Path desktop/bridge
    Copy-Item dist/OMORAY-PITWALL-Bridge.exe desktop/bridge/OMORAY-PITWALL-Bridge.exe
```

出力先は **`dist/`**。そこから **`desktop/bridge/`** へコピーして Electron が要求する位置に置く。2段階。

### B. `build-bridge.yml` — Bridge 単体配布用（Inno Setup インストーラ）

```yaml
runs-on: windows-latest
python-version: '3.12'

pip install websockets pyinstaller
pyinstaller --onefile --name OMORAY-PITWALL-Bridge --console irsdk-bridge/bridge.py

choco install innosetup --no-progress -y
iscc irsdk-bridge/installer.iss
```

出力先は `dist/OMORAY-PITWALL-Bridge.exe` と `installer_output/OMORAY-PITWALL-Setup.exe`。

---

## 2系統の差分（**ここを取り違えると壊れた exe ができる**）

| | 依存パッケージ | `--hidden-import` |
|---|---|---|
| A. build-desktop | websockets, pyinstaller, **pygame, pyaudio** | **あり**（`--hidden-import pygame`） |
| B. build-bridge | websockets, pyinstaller | なし |

`pygame` は PTT の音声再生、`pyaudio` はマイク入力に使う。
**手元で再現するなら必ず A を使うこと。** B のコマンドでビルドすると、PTT 周りが欠けた exe ができる。

---

## PyInstaller 設定

**`.spec` ファイルは存在しない。** 設定はコマンドライン引数のみ：

- `--onefile` — 単一 exe
- `--name OMORAY-PITWALL-Bridge`
- `--console` — コンソールウィンドウあり
- `--hidden-import pygame` — A のみ

カスタム spec を探しても見つからないのはそのため。

---

## 手元でビルドする場合

```bash
pip install websockets pyinstaller pygame pyaudio
pyinstaller --onefile --name OMORAY-PITWALL-Bridge --console --hidden-import pygame irsdk-bridge/bridge.py
mkdir -p desktop/bridge && cp dist/OMORAY-PITWALL-Bridge.exe desktop/bridge/OMORAY-PITWALL-Bridge.exe
```

### ただし **Windows 実機が必須**

PyInstaller はクロスコンパイルできない。**macOS / Linux からは Windows exe を作れない。**
Yuji の作業機は darwin なので、**手元ビルドという選択肢はそもそも存在しない**。

exe の実物が要る場合は、CI を回して private artifact を落とすのが唯一の道：

```bash
gh workflow run build-desktop.yml --ref main -f publish=false
```

`publish=false` なら公開リリースには載らず、artifact だけが残る。配布物と**完全に同じもの**が手に入る（手元ビルドだと Python バージョンや依存のズレが混入し、同一性を保証できない）。

---

## 踏みやすい罠 2つ

### ① `bridge.py` だけを変更しても desktop ビルドは発火しない

```yaml
# build-desktop.yml
push:
  paths:
    - 'desktop/**'      # ← bridge.py は含まれない
```

```yaml
# build-bridge.yml
push:
  paths:
    - 'irsdk-bridge/bridge.py'
    - 'irsdk-bridge/pit_loss_calibrator.py'
    - 'irsdk-bridge/pit_exit_forecaster.py'
    - 'irsdk-bridge/installer.iss'
```

`bridge.py` を直すと **B だけが自動で走り、A は走らない**。
つまり **Actions が緑でも Electron 側は古い bridge を抱えたまま**になる。A は必ず手動 `workflow_dispatch` で回すこと。

Build 277（2026-08-19）でも実際にこれを踏み、手動で `32202494283` / `32214106754` を回して解消した。

### ② 製品 Build 番号の出所は `bridge.py` ただ一箇所

```powershell
$bridgeSource = Get-Content -Raw irsdk-bridge/bridge.py
$buildMatch = [regex]::Match($bridgeSource, 'BUILD_VERSION\s*=\s*"Build\s+(\d+)')
# buildNumはGitHub run番号ではなく、bridgeと同じ製品Build番号を使う。
```

`irsdk-bridge/bridge.py:54` の `BUILD_VERSION` が唯一の真実。GitHub の run 番号ではない。
ここを上げ忘れると、**中身は新しいのに古い番号で出荷される**。

---

## 補足：更新が届いたかの確認

exe 側とサーバー側で経路が分かれている。exe 側だけ確認しても「届いた」とは言えない。

| 系統 | 経路 | 確認方法 |
|---|---|---|
| exe 側 | GitHub Actions → installer | workflow の成否＋installer を実際に DL して SHA-256 照合 |
| サーバー側 | `server.js` / `prompts.js` / `engineer-card.js` / `auth.js` → Railway | **`./verify-deploy.sh`**（2026-08-19 新設） |

`./verify-deploy.sh` は本番 `/api/version` の commit SHA とローカル HEAD を突合し、不一致なら失敗する。
サーバー側を変更した push の後は必ず実行すること。**preflight が見ているのは手元のコードであって、本番に届いたかではない。**
