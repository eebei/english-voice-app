#!/usr/bin/env node
const fs = require('fs');
const p = require('path').join(__dirname, 'desktop', 'renderer.html');
const s = fs.readFileSync(p, 'utf8');
function ok(label, cond) { if (!cond) throw new Error('FAIL ' + label); console.log('PASS', label); }

const connected = s.slice(s.indexOf("if(data.type==='iracing_connected')"), s.indexOf("if(data.type==='iracing_disconnected')"));
const live = s.slice(s.indexOf("if(data.type==='telemetry_live')"), s.indexOf("if(data.type==='telemetry_error')"));
const stale = s.slice(s.indexOf('function markTelemetryStale'), s.indexOf('function connectBridge'));

ok('connected event does not claim live', connected.includes('iracingLive=false') && !connected.includes('iracingLive=true'));
ok('telemetry snapshot is required for live', live.includes('lastTelemetryAt=Date.now()') && live.includes('iracingLive=true'));
ok('stale watchdog is bounded', s.includes('TELEMETRY_STALE_MS = 12000'));
ok('stale telemetry disables usage billing', stale.includes('usageIracingLive=false'));
ok('stale telemetry cannot reach Luna', stale.includes('lastTelemetry=null') && stale.includes('lastSectors=null'));
ok('bridge failure has an explicit UI path', s.includes("data.type==='telemetry_error'"));
