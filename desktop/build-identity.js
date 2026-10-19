/* WO021 — one reader for desktop/build-info.json, shared by main.js (window title, Support log
 * header) and the renderer (Build badge, start-gate label, usage telemetry `build`).
 *
 * Contract:
 *   - The product Build number comes from irsdk-bridge/bridge.py BUILD_VERSION. CI writes it into
 *     build-info.json together with a build tag before packaging; ci/runtime_coverage.py checks
 *     that the tracked file carries the same number.
 *   - The tracked source file is explicitly UNBUILT: buildTag === UNBUILT_TAG ('dev', the marker
 *     main.js checkForUpdate already skips). Such a run never names itself as the released
 *     "Build N" artifact: label "Build N (unbuilt source)", usage build "N-unbuilt".
 *   - Only an explicit UNBUILT_TAG means unbuilt. A missing, empty or non-string buildTag, or a
 *     missing/malformed file, stays unknown (empty label, usage 'unknown'); nothing is guessed.
 *     A packaged file (non-marker string tag) keeps the pre-WO021 "Build <buildNum|buildTag>".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitwallBuildIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNBUILT_TAG = 'dev';

  function describe(info) {
    const i = info && typeof info === 'object' ? info : {};
    const num = Number.isInteger(i.buildNum) && i.buildNum > 0 ? i.buildNum : null;
    const tag = typeof i.buildTag === 'string' && i.buildTag ? i.buildTag : null;
    const state = tag == null ? 'unknown' : (tag === UNBUILT_TAG ? 'unbuilt' : 'built');
    const id = num != null ? String(num) : (state === 'built' ? tag : null);
    if (state === 'unknown' || id == null) return { state: 'unknown', product_build: null, built: null, label: '', usage_build: 'unknown' };
    const built = state === 'built';
    return {
      state,
      product_build: num,
      built,
      label: built ? 'Build ' + id : 'Build ' + id + ' (unbuilt source)',
      usage_build: built ? id : id + '-unbuilt',
    };
  }

  return { UNBUILT_TAG, describe };
});
