// Moborr.io client — WASD movement with prediction + reconciliation + interpolation
// Connects to configurable backend URL (set it on the title screen).
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const joinBtn = document.getElementById('joinBtn');
const usernameInput = document.getElementById('username');
const serverUrlInput = document.getElementById('serverUrl');
const connectStatus = document.getElementById('connectStatus');

let socket = null;
let myId = null;

const players = new Map(); // id -> { id, username, x, y, vx, vy, color, interp }
const pendingInputs = [];

const SPEED = 180; // px/sec
const SEND_RATE = 20; // inputs per second
const INPUT_DT = 1 / SEND_RATE;
const MAP = { width: canvas.width, height: canvas.height, padding: 16 };

let localState = { x: MAP.width / 2, y: MAP.height / 2, vx: 0, vy: 0 };
let inputSeq = 0;

// keyed state
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

// --- Networking / Connect logic ---
function getSavedServerUrl() {
  return localStorage.getItem('moborr_serverUrl') || window.location.origin;
}
function saveServerUrl(url) {
  localStorage.setItem('moborr_serverUrl', url);
}

// show a short status text on title
function setStatus(text, visible = true) {
  if (!connectStatus) return;
  connectStatus.hidden = !visible;
  connectStatus.textContent = text || '';
}

// connect using chosen server url
function setupSocket(username, serverUrl) {
  setStatus('Connecting…');
  // ensure a URL is provided
  if (!serverUrl) serverUrl = window.location.origin;
  // Use websocket + polling fallback
  try {
    socket = io(serverUrl, { transports: ['websocket','polling'] });
  } catch (err) {
    setStatus('Invalid server URL');
    console.error(err);
    return;
  }

  socket.on('connect', () => {
    myId = socket.id;
    setStatus('Connected — joining…');
    socket.emit('join', username);
  });

  socket.on('connect_error', (err) => {
    console.warn('connect_error', err);
    setStatus('Connection failed — check server URL and CORS');
  });

  socket.on('disconnect', (reason) => {
    console.warn('disconnected', reason);
    setStatus('Disconnected from server');
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
    setStatus('Joined — ready', true);
    // small delay, then hide title screen
    setTimeout(() => { titleScreen.classList.add('hidden'); setStatus('', false); }, 350);
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
        // server authoritative position + reconciliation
        const serverSeq = sp.lastProcessedInput || 0;
        existing.x = sp.x; existing.y = sp.y; existing.vx = sp.vx; existing.vy = sp.vy;
        // reconcile local predicted state
        localState.x = sp.x; localState.y = sp.y; localState.vx = sp.vx; localState.vy = sp.vy;
        // drop processed inputs
        let i = 0;
        while (i < pendingInputs.length && pendingInputs[i].seq <= serverSeq) i++;
        pendingInputs.splice(0, i);
        // reapply pending inputs
        for (const inpt of pendingInputs) applyInputToState(localState, inpt.input, inpt.dt);
        // reflect on local player record for rendering
        const me = players.get(myId);
        if (me) { me.x = localState.x; me.y = localState.y; me.vx = localState.vx; me.vy = localState.vy; }
      } else {
        // interpolation for remote players
        const interp = existing.interp || createInterp();
        interp.startX = existing.x; interp.startY = existing.y;
        interp.targetX = sp.x; interp.targetY = sp.y;
        interp.startTime = now; interp.endTime = now + (1000 / SEND_RATE) * 1.2;
        existing.vx = sp.vx; existing.vy = sp.vy;
        existing.interp = interp;
      }
    }
  });

  // once connected, start input loop
  socket.on('connect', () => startInputLoop());
}

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
  const serverUrl = (serverUrlInput.value || getSavedServerUrl()).trim();
  if (!serverUrl) {
    setStatus('Please enter a Server URL (or host backend on same origin).');
    return;
  }
  saveServerUrl(serverUrl);
  setStatus('Starting connection...');
  setupSocket(name, serverUrl);
});

usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
serverUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

// keyboard input
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

// rendering
function drawGrid() {
  ctx.fillStyle = '#07121a';
  ctx.fillRect(0, 0, MAP.width, MAP.height);

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const tileSize = 40;
  for (let x = 0; x <= MAP.width; x += tileSize) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, MAP.height); ctx.stroke();
  }
  for (let y = 0; y <= MAP.height; y += tileSize) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(MAP.width, y + 0.5); ctx.stroke();
  }
}

function drawPlayers(now) {
  for (const p of players.values()) {
    let drawX = p.x, drawY = p.y;
    if (p.id !== myId && p.interp) {
      const t = Math.max(0, Math.min(1, (now - p.interp.startTime) / Math.max(1, (p.interp.endTime - p.interp.startTime))));
      const tt = t * t * (3 - 2 * t);
      drawX = p.interp.startX + (p.interp.targetX - p.interp.startX) * tt;
      drawY = p.interp.startY + (p.interp.targetY - p.interp.startY) * tt;
    }

    ctx.beginPath();
    ctx.fillStyle = p.color || '#5ab';
    ctx.strokeStyle = '#0008';
    ctx.lineWidth = 3;
    ctx.arc(drawX, drawY, 18, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const initials = (p.username || 'P').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    ctx.fillText(initials, drawX, drawY);

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '12px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, drawX, drawY + 32);

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

// on load: populate server URL input from localStorage or origin
window.addEventListener('load', () => {
  serverUrlInput.value = getSavedServerUrl();
  // focus username
  usernameInput.focus();
});

// cleanup
window.addEventListener('beforeunload', () => {
  stopInputLoop();
  if (socket) socket.disconnect();
});
