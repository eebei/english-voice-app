const { WebSocketServer } = require('ws');
const irsdk = require('node-irsdk');

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

console.log('OMORAY PITWALL Bridge started');
console.log('WebSocket: ws://localhost:' + PORT);
console.log('Waiting for iRacing...');

function broadcast(event) {
  var msg = JSON.stringify(event);
  wss.clients.forEach(function(client) {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', function(ws) {
  console.log('Browser connected');
  ws.send(JSON.stringify({ type: 'connected' }));
});

irsdk.init({ telemetryUpdateInterval: 1000 });
var iracing = irsdk.getInstance();

var prev = {
  pos: null,
  lapTime: null,
  fuel: null,
  lap: null,
  lapsTotal: null,
  onPit: null
};

iracing.on('Connected', function() {
  console.log('iRacing connected!');
  broadcast({ type: 'iracing_connected' });
});

iracing.on('Disconnected', function() {
  console.log('iRacing disconnected');
  broadcast({ type: 'iracing_disconnected' });
});

iracing.on('Telemetry', function(data) {
  var t = data.values;
  if (!t) return;

  var pos     = t.PlayerCarPosition;
  var lapTime = t.LapLastLapTime;
  var fuel    = t.FuelLevel;
  var lap     = t.Lap;
  var lapsTot = t.SessionLapsTotal;
  var onPit   = t.OnPitRoad;
  var onTrack = t.IsOnTrack;

  if (pos !== null && prev.pos !== null && pos !== prev.pos) {
    var gained = prev.pos - pos;
    if (gained > 0) {
      broadcast({ type: 'radio', trigger: 'position_up',
        message: 'P' + pos + ' now! You gained ' + gained + ' position. Keep the pressure on.' });
    } else {
      broadcast({ type: 'radio', trigger: 'position_down',
        message: 'P' + pos + '. We lost a position. Talk to me, what happened out there?' });
    }
  }

  if (lapTime && prev.lapTime && lapTime > 0 && prev.lapTime > 0) {
    var delta = lapTime - prev.lapTime;
    if (delta > 0.8) {
      broadcast({ type: 'radio', trigger: 'pace_drop',
        message: 'Pace is falling. Last lap ' + lapTime.toFixed(1) + 's, previous ' + prev.lapTime.toFixed(1) + 's. That is ' + delta.toFixed(1) + ' seconds off. Talk to me.' });
    }
  }

  if (fuel !== null && fuel < 5 && (prev.fuel === null || prev.fuel >= 5)) {
    broadcast({ type: 'radio', trigger: 'fuel_warning',
      message: 'Fuel warning. ' + fuel.toFixed(1) + ' litres remaining. Fuel save from now. Confirm.' });
  }

  if (lapsTot && lap && lapsTot > 0 && lap === lapsTot && lap !== prev.lap) {
    broadcast({ type: 'radio', trigger: 'final_lap',
      message: 'Final lap. P' + pos + '. Bring it home clean. No mistakes. You have got this.' });
  }

  if (onPit && !prev.onPit) {
    broadcast({ type: 'radio', trigger: 'pit_entry',
      message: 'Box confirmed. Tyres and fuel. Speed limiter on. Focus.' });
  }

  if (prev.onPit && !onPit && onTrack) {
    broadcast({ type: 'radio', trigger: 'pit_exit',
      message: 'Out of the pits. P' + pos + '. Tyres need a lap to come in. Build it up gradually.' });
  }

  prev = { pos: pos, lapTime: lapTime, fuel: fuel, lap: lap, lapsTotal: lapsTot, onPit: onPit };
});

process.on('SIGINT', function() {
  console.log('Bridge stopped');
  irsdk.cleanup();
  process.exit(0);
});
