# Build 282 — Gate 5 private artifact evidence

検査日時: 2026-08-25 JST  
対象Git SHA: `81a912b79272deb248ce537111e32dd9c70125cb`  
GitHub Actions run: `32815638686`  
artifact: `OMORAY-PITWALL-Desktop-Build-282-20260825-0609`  
公開: なし（`Publish to Release` は `skipped`）

## Workflow evidence

- workflow は上記 SHA を checkout して成功した。
- Windows runner 上で `irsdk-bridge/bridge.py` から `OMORAY-PITWALL-Bridge.exe` を PyInstaller 生成し、Desktop resource へ copy した。
- workflow の packaged-runtime verification は成功した。確認した local module は `memory-action-layer.js`、`strategy-playbook.js`、`fuel-plan-guard.js`、`cost-meter.js`、`local-intent-router.js`、`session-memory.js`。
- `Publish to Release` step は `skipped`。public release / latest URL は変更していない。

## Artifact direct inspection

日付付き NSIS installer `OMORAY-PITWALL-Setup-20260825-0609.exe` を直接展開した。

| Item | Evidence |
|---|---|
| Product Build | `bridge.py` source: Build 282; packaged `build-info.json.buildNum`: `282` |
| Build tag | `20260825-0609` |
| app.asar | exists, 4.0 MB; SHA-256 `16dabbb3aae144b30e1b9554bdd742e5054b76fd3c2322ef3e7b33ff322cd13a` |
| Bundled Bridge | exists, 16 MB (non-zero); SHA-256 `0b0dbd681e7ff214545341817f3294bc30a669b62c44893fc3819bdc156a7f39` |
| Installer | 100,633,388 bytes; SHA-256 `2eb3d85a49c39ca8bc2a28b7cf183e2313103cfb0feaf9ae4ff4ff7569a82b58` |
| Renderer-local JS | all 6 references are present in `app.asar`; missing list is empty |

The artifact was extracted locally under `artifacts/build282-private-gate5-20260825-0610/expanded/` for this inspection. It is not a public distribution location.

## Gate status

The technical artifact checks for Gate 5 are complete. This is not a release approval:

- Independent reviewer signature is still required by the gate policy.
- Gate 6 (Windows candidate) and Gate 8 (iRacing smoke) are unperformed.
- No tester distribution or public release is authorized by this record.
