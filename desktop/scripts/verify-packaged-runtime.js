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

if (require.main === module) {
  const result = verifyPackagedRuntime();
  process.stdout.write(`verified packaged runtime modules: ${result.localScripts.join(', ')}\n`);
}

module.exports = { extractLocalScripts, normalizePackageEntry, missingRuntimeScripts, verifyPackagedRuntime };
