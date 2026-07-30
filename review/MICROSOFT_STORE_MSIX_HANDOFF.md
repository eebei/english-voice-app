# Microsoft Store / MSIX handoff

## Purpose

Build a Store-signed OMORAY PITWALL package without changing or publishing the
existing NSIS release. The Store build bundles the same PyInstaller bridge and
uses Microsoft Store update delivery.

## Partner Center identity

The reserved product identity is configured in `desktop/package.json`:

- Package/Identity/Name: `OMORAY.OMORAYPITWALL`
- Package/Identity/Publisher: `CN=29CFAD71-6272-4675-AE22-C0F8D243BBD8`
- Publisher display name: `OMORAY`

These values must continue to match Partner Center exactly.

## Build

Run the manual GitHub Actions workflow:

`Build OMORAY PITWALL Microsoft Store package`

The workflow only creates a private Actions artifact. It does not create a
GitHub Release or submit/publish anything to Microsoft Store.

## Required Windows verification before Store submission

1. Desktop launches from the installed package.
2. Bundled `OMORAY-PITWALL-Bridge.exe` starts exactly once.
3. iRacing shared-memory telemetry reaches the desktop over localhost port 8765.
4. Steering-wheel buttons, microphone input, PTT and audio playback work.
5. Overlay remains topmost without stealing iRacing focus.
6. Desktop settings and pit calibration survive an app update.
7. Closing PITWALL terminates its bundled bridge.
8. Store build never presents the GitHub NSIS forced-update gate.
9. Smart App Control permits the Store-installed package and its bundled bridge.

## Release boundary

Uploading the package to Partner Center, submitting certification, publishing a
Store listing, and changing the public download link are separate explicit
release actions.
