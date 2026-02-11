// Moborr.io client — WASD movement with prediction + reconciliation + interpolation
// Default backend URL (keeps previous behavior). No server URL input in UI.
const DEFAULT_BACKEND = 'https://moborr-io-backend.onrender.com';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const joinBtn = document.getElementById('joinBtn');
const usernameInput = document.getElementById('username');

let socket = null;
let myId = null;

const players = new Map(); // id -> { id, username, x, y, vx, vy, color, interp }
const pendingInputs = [];

const SPEED = 180; // px/sec
const SEND_RATE = 20; // inputs per second
const INPUT_DT = 1 / SEND_RATE;
// BIG map: 12000 x 12000 (must match server)
const MAP = { width: 12000, height: 12000, padding: 16 };

let localState = { x: MAP.width / 2, y: MAP.height / 2, vx: 0, vy: 0 };
let inputSeq = 0;

// keypad state
const keys = {};
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

function createInterp() {
  return { targetX: 0, targetY: 0, startX: 0, startY: 0, startTime: 0, endTime: 0 };
}

// Camera / viewport
let dpr = Math.max(1, window.devicePixelRatio || 1);
let viewport = { w: 0, h: 0 }; // in CSS pixels
let viewPixels = { w: 0, h: 0 }; // physical canvas px
function resizeCanvas() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  viewport.w = Math.max(320, window.innerWidth);
  viewport.h = Math.max(240, window.innerHeight);
  canvas.style.width = viewport.w + 'px';
  canvas.style.height = viewport.h + 'px';
  viewPixels.w = Math.floor(viewport.w * dpr);
  viewPixels.h = Math.floor(viewport.h * dpr);
  canvas.width = viewPixels.w;
  canvas.height = viewPixels.h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // work in CSS pixels
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// networking
function setupSocket(username, serverUrl) {
  if (!serverUrl) serverUrl = DEFAULT_BACKEND;
  try {
    socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  } catch (err) {
    console.error('Socket init failed', err);
    return;
  }

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join', username);
  });

  socket.on('currentPlayers', (list) => {
    players.clear();
    list.forEach(p => {
      players.set(p.id, {
        id: p.id, username: p.username, x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0, color: p.color || '#5ab', interp: createInterp()
      });
      if (p.id === myId) {
        localState.x = p.x; localState.y = p.y; localState.vx = p.vx || 0; localState.vy = p.vy || 0;
      }
    });
    // hide title screen
    setTimeout(() => titleScreen.classList.add('hidden'), 150);
  });

  socket.on('newPlayer', (p) => {
    players.set(p.id, { id: p.id, username: p.username, x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0, color: p.color || '#5ab', interp: createInterp() });
  });

  socket.on('playerLeft', (id) => {
    players.delete(id);
  });

  socket.on('stateSnapshot', (data) => {
    const now = Date.now();
    for (const sp of data.players) {
      const existing = players.get(sp.id);
      if (!existing) {
        players.set(sp.id, { id: sp.id, username: sp.username, x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy, color: sp.color || '#5ab', interp: createInterp() });
        continue;
      }

      if (sp.id === myId) {
        const serverSeq = sp.lastProcessedInput || 0;
        existing.x = sp.x; existing.y = sp.y; existing.vx = sp.vx; existing.vy = sp.vy;
        // reconcile local
        localState.x = sp.x; localState.y = sp.y; localState.vx = sp.vx; localState.vy = sp.vy;
        // drop processed inputs
        let i = 0;
        while (i < pendingInputs.length && pendingInputs[i].seq <= serverSeq) i++;
        pendingInputs.splice(0, i);
        // reapply remaining
        for (const inpt of pendingInputs) applyInputToState(localState, inpt.input, inpt.dt);
        const me = players.get(myId);
        if (me) { me.x = localState.x; me.y = localState.y; me.vx = localState.vx; me.vy = localState.vy; }
      } else {
        const interp = existing.interp || createInterp();
        interp.startX = existing.x; interp.startY = existing.y;
        interp.targetX = sp.x; interp.targetY = sp.y;
        interp.startTime = now; interp.endTime = now + (1000 / SEND_RATE) * 1.2;
        existing.vx = sp.vx; existing.vy = sp.vy;
        existing.interp = interp;
      }
    }
  });

  socket.on('connect', () => startInputLoop());
}

// apply input to a state (prediction)
function applyInputToState(state, input, dt) {
  state.vx = input.x * SPEED;
  state.vy = input.y * SPEED;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.x = Math.max(MAP.padding, Math.min(MAP.width - MAP.padding, state.x));
  state.y = Math.max(MAP.padding, Math.min(MAP.height - MAP.padding, state.y));
}

let sendInterval = null;
function startInputLoop() {
  if (!socket || sendInterval) return;
  sendInterval = setInterval(() => {
    const input = getInputVector();
    inputSeq++;
    socket.emit('input', { seq: inputSeq, dt: INPUT_DT, input });
    pendingInputs.push({ seq: inputSeq, dt: INPUT_DT, input });
    applyInputToState(localState, input, INPUT_DT);
    const me = players.get(myId);
    if (me) { me.x = localState.x; me.y = localState.y; me.vx = localState.vx; me.vy = localState.vy; }
  }, 1000 / SEND_RATE);
}
function stopInputLoop() {
  if (sendInterval) clearInterval(sendInterval);
  sendInterval = null;
}

// UI wiring
joinBtn.addEventListener('click', () => {
  const name = (usernameInput.value || 'Player').trim();
  if (!name) return;
  setupSocket(name, DEFAULT_BACKEND);
});

// keyboard
window.addEventListener('keydown', (e) => {
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = true; e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = false; e.preventDefault();
  }
});

// Rendering: camera follows local player; draw only what's visible
const tileSize = 40;
function worldToScreen(wx, wy, camX, camY) {
  return { x: wx - camX, y: wy - camY };
}

function drawGrid(camX, camY, vw, vh) {
  // background
  ctx.fillStyle = '#07121a';
  ctx.fillRect(0, 0, vw, vh);

  // draw visible grid lines only
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;

  const startX = Math.floor(camX / tileSize) * tileSize;
  const endX = Math.ceil((camX + vw) / tileSize) * tileSize;
  for (let x = startX; x <= endX; x += tileSize) {
    const sx = Math.round(x - camX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, vh);
    ctx.stroke();
  }

  const startY = Math.floor(camY / tileSize) * tileSize;
  const endY = Math.ceil((camY + vh) / tileSize) * tileSize;
  for (let y = startY; y <= endY; y += tileSize) {
    const sy = Math.round(y - camY) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(vw, sy);
    ctx.stroke();
  }
}

function drawPlayers(camX, camY, now) {
  for (const p of players.values()) {
    // compute screen position
    let px = p.x, py = p.y;
    if (p.id !== myId && p.interp) {
      const t = Math.max(0, Math.min(1, (now - p.interp.startTime) / Math.max(1, (p.interp.endTime - p.interp.startTime))));
      const tt = t * t * (3 - 2 * t);
      px = p.interp.startX + (p.interp.targetX - p.interp.startX) * tt;
      py = p.interp.startY + (p.interp.targetY - p.interp.startY) * tt;
    }
    const screen = worldToScreen(px, py, camX, camY);
    // quick cull
    if (screen.x < -100 || screen.x > viewport.w + 100 || screen.y < -100 || screen.y > viewport.h + 100) continue;

    // avatar
    ctx.beginPath();
    ctx.fillStyle = p.color || '#5ab';
    ctx.strokeStyle = '#0008';
    ctx.lineWidth = 3;
    ctx.arc(screen.x, screen.y, 18, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    // initials
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const initials = (p.username || 'P').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    ctx.fillText(initials, screen.x, screen.y);

    // name
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '12px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, screen.x, screen.y + 32);

    // local highlight
    if (p.id === myId) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 6;
      ctx.arc(screen.x, screen.y, 28, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function render() {
  const now = Date.now();
  // camera centers on local player
  const me = players.get(myId);
  // fallback to localState if server hasn't sent
  const cx = (me ? me.x : localState.x) - viewport.w / 2;
  const cy = (me ? me.y : localState.y) - viewport.h / 2;
  // clamp camera to world bounds so you can't see outside the map
  const camX = Math.max(0, Math.min(MAP.width - viewport.w, cx));
  const camY = Math.max(0, Math.min(MAP.height - viewport.h, cy));

  drawGrid(camX, camY, viewport.w, viewport.h);
  drawPlayers(camX, camY, now);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// on load focus username
window.addEventListener('load', () => {
  usernameInput.focus();
});

// cleanup
window.addEventListener('beforeunload', () => {
  stopInputLoop();
  if (socket) socket.disconnect();
});
