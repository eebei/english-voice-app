'use strict';
/* WO019 — test-only clock boundary for the real server.js child of wo019_desktop_runtime.js.
 *
 * The renderer runs on the replay's virtual clock. server.js validates raceContext freshness
 * against its own Date.now(), so a real-clock server would reject every context as stale (a
 * harness artifact, not product behaviour). Each request from the runtime carries the
 * renderer's current virtual time in `x-wo019-clock-ms`; this preload re-bases the server's
 * Date on it (real time keeps elapsing between requests). No route or handler is touched.
 */
const http = require('http');
const RealDate = Date;
let offsetMs = 0;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, ...rest) {
  if (event === 'request' && req && req.headers) {
    const virtualNow = Number(req.headers['x-wo019-clock-ms']);
    if (Number.isFinite(virtualNow)) offsetMs = virtualNow - RealDate.now();
  }
  return emit.call(this, event, req, ...rest);
};
class VirtualDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offsetMs); }
  static now() { return RealDate.now() + offsetMs; }
}
global.Date = VirtualDate;
