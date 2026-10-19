#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function extractLocalScripts(html) {
  return [...String(html || '').matchAll(/<script\s+src="([^"]+\.js)"/g)]
    .map(match => match[1])
    .filter(src => !/^(?:https?:)?\/\//i.test(src));
}

function normalizePackageEntry(entry) {
  return String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function missingRuntimeScripts(localScripts, packageEntries) {
  const normalized = new Set((packageEntries || []).map(normalizePackageEntry));
  return (localScripts || []).filter(src => !normalized.has(normalizePackageEntry(src)));
}

function verifyPackagedRuntime(options = {}) {
  const desktopDir = options.desktopDir || path.resolve(__dirname, '..');
  const rendererPath = options.rendererPath || path.join(desktopDir, 'renderer.html');
  const asarPath = options.asarPath || path.join(desktopDir, 'dist', 'win-unpacked', 'resources', 'app.asar');
  const asar = options.asar || require('@electron/asar');
  const localScripts = extractLocalScripts(fs.readFileSync(rendererPath, 'utf8'));
  if (!localScripts.length) throw new Error('renderer has no local runtime scripts');
  const packageEntries = asar.listPackage(asarPath);
  const missing = missingRuntimeScripts(localScripts, packageEntries);
  if (missing.length) throw new Error(`missing packaged runtime modules: ${missing.join(', ')}`);
  return { localScripts, packageEntries: packageEntries.length };
}

// --json FILE: machine-readable result for the CI artifact (written on failure too).
function writeJsonResult(file, payload) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.assign({ schema: 'pitwall.renderer_runtime.v1', created_at: new Date().toISOString() }, payload), null, 1));
}

if (require.main === module) {
  const jsonAt = process.argv.indexOf('--json');
  const jsonFile = jsonAt > 0 ? process.argv[jsonAt + 1] : null;
  const asarAt = process.argv.indexOf('--asar');   // default: dist/win-unpacked/resources/app.asar
  let result;
  try {
    result = verifyPackagedRuntime(asarAt > 0 ? { asarPath: path.resolve(process.argv[asarAt + 1]) } : {});
  } catch (e) {
    if (jsonFile) writeJsonResult(jsonFile, { ok: false, error: String(e && e.message || e) });
    throw e;
  }
  if (jsonFile) writeJsonResult(jsonFile, { ok: true, local_scripts: result.localScripts, package_entries: result.packageEntries });
  process.stdout.write(`verified packaged runtime modules: ${result.localScripts.join(', ')}\n`);
}

module.exports = { extractLocalScripts, normalizePackageEntry, missingRuntimeScripts, verifyPackagedRuntime };
