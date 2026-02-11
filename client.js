// Moborr.io client — WASD movement with prediction + reconciliation + interpolation
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const overlay = document.getElementById('title-overlay');
const joinBtn = document.getElementById('joinBtn');
const usernameInput = document.getElementById('username');

let socket = null;
let myId = null;

const players = new Map(); // id -> { id, username, x, y, vx, vy, color, interp }
const pendingInputs = []; // for local player reconciliation

// Simulation params (must match server)
const SPEED = 180; // px/sec
const SEND_RATE = 20; // inputs per second (matches server tick ideally)
const INPUT_DT = 1 / SEND_RATE;
const MAP = { width: canvas.width, height: canvas.height, padding: 16 };

// local prediction state
let localState = { x: 0, y: 0, vx: 0, vy: 0 };
let inputSeq = 0;
let lastServerProcessed = 0;

// input collection
const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false };
function getInputVector() {
  let x = 0, y = 0;
  if (keys.w || keys.ArrowUp) y -= 1;
  if (keys.s || keys.ArrowDown) y += 1;
  if (keys.a || keys.ArrowLeft) x -= 1;
  if (keys.d || keys.ArrowRight) x += 1;
  const len = Math.hypot(x, y);
  if (len > 1e-6) { x /= len; y /= len; }
  return { x, y };
}

// interpolation helper for remote players
function createInterp() {
  return {
    targetX: 0, targetY: 0, startX: 0, startY: 0,
    startTime: 0, endTime: 0
  };
}

// network handlers
function setupSocket(username) {
  socket = io();

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join', username);
  });

  socket.on('currentPlayers', (list) => {
    players.clear();
    list.forEach(p => {
      players.set(p.id, {
        id: p.id,
        username: p.username,
        x: p.x,
        y: p.y,
        vx: p.vx || 0,
        vy: p.vy || 0,
        color: p.color || '#faa',
        interp: createInterp()
      });
      if (p.id === myId) {
        // initialize local predicted state with authoritative pos
        localState.x = p.x; localState.y = p.y; localState.vx = p.vx || 0; localState.vy = p.vy || 0;
      }
    });
  });

  socket.on('newPlayer', (p) => {
    players.set(p.id, {
      id: p.id,
      username: p.username,
      x: p.x,
      y: p.y,
      vx: p.vx || 0,
      vy: p.vy || 0,
      color: p.color || '#faa',
      interp: createInterp()
    });
  });

  socket.on('playerLeft', (id) => {
    players.delete(id);
  });

  // authoritative snapshot
  socket.on('stateSnapshot', (data) => {
    const snapshot = data.players;
    const now = Date.now();

    snapshot.forEach(sp => {
      const existing = players.get(sp.id);
      if (!existing) {
        // new one (can happen)
        players.set(sp.id, {
          id: sp.id,
          username: sp.username,
          x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy, color: sp.color, interp: createInterp()
        });
        return;
      }

      // if this is me, do reconciliation
      if (sp.id === myId) {
        // server's authoritative last processed input sequence
        const serverSeq = sp.lastProcessedInput || 0;
        // update authoritative position
        existing.x = sp.x; existing.y = sp.y; existing.vx = sp.vx; existing.vy = sp.vy;
        // reconcile local predicted state
        localState.x = sp.x; localState.y = sp.y; localState.vx = sp.vx; localState.vy = sp.vy;

        // drop inputs the server has processed
        let i = 0;
        while (i < pendingInputs.length && pendingInputs[i].seq <= serverSeq) i++;
        pendingInputs.splice(0, i);

        // reapply remaining inputs to localState
        for (const inpt of pendingInputs) {
          applyInputToState(localState, inpt.input, inpt.dt);
        }
      } else {
        // remote player -> set up interpolation from existing pos to new authoritative pos
        const interp = existing.interp || createInterp();
        interp.startX = existing.x;
        interp.startY = existing.y;
        interp.targetX = sp.x;
        interp.targetY = sp.y;
        interp.startTime = now;
        interp.endTime = now + (1000 / SEND_RATE) * 1.2; // slightly larger than server tick for smoothing
        existing.vx = sp.vx; existing.vy = sp.vy;
        existing.interp = interp;
      }
    });
  });
}

// apply input to state (used both client prediction and server)
function applyInputToState(state, input, dt) {
  // input: {x, y} normalized direction
  state.vx = input.x * SPEED;
  state.vy = input.y * SPEED;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  // clamp
  state.x = Math.max(MAP.padding, Math.min(MAP.width - MAP.padding, state.x));
  state.y = Math.max(MAP.padding, Math.min(MAP.height - MAP.padding, state.y));
}

// periodic sending of inputs to server
let sendInterval = null;
function startInputLoop() {
  if (!socket) return;
  sendInterval = setInterval(() => {
    const input = getInputVector();
    inputSeq++;
    // send input to server for authoritative processing
    socket.emit('input', { seq: inputSeq, dt: INPUT_DT, input });
    // store locally for reconciliation
    pendingInputs.push({ seq: inputSeq, dt: INPUT_DT, input });
    // apply locally for immediate responsiveness (client-side prediction)
    applyInputToState(localState, input, INPUT_DT);
    // mirror local predicted state into our players map for rendering
    const me = players.get(myId);
    if (me) { me.x = localState.x; me.y = localState.y; me.vx = localState.vx; me.vy = localState.vy; }
  }, 1000 / SEND_RATE);
}

// stop input loop (on disconnect)
function stopInputLoop() {
  if (sendInterval) clearInterval(sendInterval);
  sendInterval = null;
}

// UI handlers
joinBtn.addEventListener('click', () => {
  const name = (usernameInput.value || 'Player').trim();
  overlay.style.display = 'none';
  setupSocket(name);
  // start a small delay, then begin sending inputs
  setTimeout(startInputLoop, 200);
});

usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

// keyboard events
window.addEventListener('keydown', (e) => {
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = true;
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = false;
    e.preventDefault();
  }
});

// rendering
function drawGrid() {
  ctx.fillStyle = '#07121a';
  ctx.fillRect(0, 0, MAP.width, MAP.height);

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const tileSize = 40;
  for (let x = 0; x <= MAP.width; x += tileSize) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, MAP.height);
    ctx.stroke();
  }
  for (let y = 0; y <= MAP.height; y += tileSize) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(MAP.width, y + 0.5);
    ctx.stroke();
  }
}

function drawPlayers(now) {
  for (const p of players.values()) {
    let drawX = p.x, drawY = p.y;
    if (p.id !== myId && p.interp) {
      // interpolation factor
      const t = Math.max(0, Math.min(1, (now - p.interp.startTime) / Math.max(1, (p.interp.endTime - p.interp.startTime))));
      // cubic ease for smoothness
      const tt = t * t * (3 - 2 * t);
      drawX = p.interp.startX + (p.interp.targetX - p.interp.startX) * tt;
      drawY = p.interp.startY + (p.interp.targetY - p.interp.startY) * tt;
    }
    // avatar circle
    ctx.beginPath();
    ctx.fillStyle = p.color || '#5ab';
    ctx.strokeStyle = '#0008';
    ctx.lineWidth = 3;
    ctx.arc(drawX, drawY, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // initials
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initials = (p.username || 'P').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    ctx.fillText(initials, drawX, drawY);

    // name label
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '12px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, drawX, drawY + 32);

    // highlight local player with a ring
    if (p.id === myId) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 6;
      ctx.arc(drawX, drawY, 28, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function render() {
  const now = Date.now();
  drawGrid();
  drawPlayers(now);
  requestAnimationFrame(render);
}

render();

// cleanup on unload
window.addEventListener('beforeunload', () => {
  stopInputLoop();
  if (socket) socket.disconnect();
});