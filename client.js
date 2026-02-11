// Moborr.io client — WASD movement with prediction + reconciliation
// Default backend URL (unchanged)
const DEFAULT_BACKEND = 'https://moborr-io-backend.onrender.com';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const titleScreen = document.getElementById('title-screen');
const joinBtn = document.getElementById('joinBtn');
const usernameInput = document.getElementById('username');
const connectStatusEl = document.getElementById('connectStatus');

let loadingScreen = null;

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

// Dynamically create the loading overlay when needed
function createLoadingOverlay() {
  if (loadingScreen) return;

  const overlay = document.createElement('div');
  overlay.className = 'loading-screen';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', 'Loading');

  const inner = document.createElement('div');
  inner.className = 'loading-inner';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  const eyeL = document.createElement('div');
  eyeL.className = 'eye left';
  const eyeR = document.createElement('div');
  eyeR.className = 'eye right';
  avatar.appendChild(eyeL);
  avatar.appendChild(eyeR);

  const main = document.createElement('div');
  main.className = 'loading-title';
  main.id = 'loading-main';
  main.textContent = 'Connecting...';

  const sub = document.createElement('div');
  sub.className = 'loading-sub';
  sub.id = 'loading-sub';
  sub.textContent = 'Preparing the world';

  const uname = document.createElement('div');
  uname.className = 'loading-username';
  uname.id = 'loading-username';
  uname.textContent = '';

  inner.appendChild(avatar);
  inner.appendChild(main);
  inner.appendChild(sub);
  inner.appendChild(uname);
  overlay.appendChild(inner);

  loadingScreen = overlay;
}

// Loading UI helpers (operate on dynamic overlay)
function showLoading(username) {
  createLoadingOverlay();
  const main = loadingScreen.querySelector('#loading-main');
  const sub = loadingScreen.querySelector('#loading-sub');
  const uname = loadingScreen.querySelector('#loading-username');
  if (main) main.textContent = 'Connecting...';
  if (sub) sub.textContent = 'Preparing the world';
  if (uname) uname.textContent = username || '';

  // attach to body if not already
  if (!document.body.contains(loadingScreen)) document.body.appendChild(loadingScreen);
}
function setLoadingError(text) {
  createLoadingOverlay();
  const main = loadingScreen.querySelector('#loading-main');
  const sub = loadingScreen.querySelector('#loading-sub');
  const uname = loadingScreen.querySelector('#loading-username');
  if (main) main.textContent = 'Connection error';
  if (sub) sub.textContent = text || '';
  if (uname) uname.textContent = '';
  if (!document.body.contains(loadingScreen)) document.body.appendChild(loadingScreen);
}
function hideLoading() {
  if (loadingScreen && document.body.contains(loadingScreen)) {
    document.body.removeChild(loadingScreen);
  }
}

// Helper: are we typing in a text field? If so, don't treat movement keys as gameplay input.
function isTyping() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName || '').toLowerCase();
  // consider inputs, textareas, and contenteditable elements as typing targets
  return tag === 'input' || tag === 'textarea' || ae.isContentEditable;
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

  // regenerate grass pattern when DPI or size changes
  createGrassPattern();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// --- Grass background pattern ---
// We'll create an offscreen canvas pattern that looks like small grassy blades.
// The pattern is anchored to world coordinates so it scrolls with the camera.
let grassPattern = null;
let grassPatternSize = 128;
function createGrassPattern() {
  grassPatternSize = Math.max(64, Math.round(Math.min(160, 128 * (dpr || 1))));
  const c = document.createElement('canvas');
  c.width = grassPatternSize;
  c.height = grassPatternSize;
  const g = c.getContext('2d');

  // base green
  g.fillStyle = '#4aa04a'; // mid green
  g.fillRect(0, 0, c.width, c.height);

  // subtle darker stripes
  g.fillStyle = 'rgba(38, 94, 38, 0.06)';
  for (let i = 0; i < 6; i++) {
    const y = Math.random() * c.height;
    g.fillRect(0, y, c.width, 1 + Math.random() * 2);
  }

  // draw blades
  for (let i = 0; i < c.width * c.height / 120; i++) {
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    const h = 6 + Math.random() * 18;
    const sway = (Math.random() - 0.5) * 6;
    const light = Math.random() * 20 + 20;
    g.strokeStyle = `rgba(${20 + light},${80 + light},${20 + light},${0.85 + Math.random() * 0.15})`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + sway, y - h / 2, x + sway * 1.4, y - h);
    g.stroke();
  }

  // occasional flowers/dots for variety
  for (let i = 0; i < 8; i++) {
    g.fillStyle = ['#ffd24a', '#ffe08b', '#ffd1e6'][Math.floor(Math.random() * 3)];
    g.beginPath();
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    g.arc(x, y, 1 + Math.random() * 1.6, 0, Math.PI * 2);
    g.fill();
  }

  grassPattern = ctx.createPattern(c, 'repeat');
}

// Background draw (replaces grid)
function drawBackground(camX, camY, vw, vh) {
  // fallback plain green if pattern isn't ready
  if (!grassPattern) {
    ctx.fillStyle = '#4aa04a';
    ctx.fillRect(0, 0, vw, vh);
    return;
  }

  // If pattern supports setTransform, offset the pattern to world coordinates so it scrolls with the map.
  try {
    if (typeof grassPattern.setTransform === 'function') {
      // translate pattern by camera offset modulo pattern size to keep tiles aligned with world coords
      const t = new DOMMatrix();
      const ox = - (camX % grassPatternSize);
      const oy = - (camY % grassPatternSize);
      t.e = ox;
      t.f = oy;
      grassPattern.setTransform(t);
    }
  } catch (err) {
    // ignore if not supported
  }

  ctx.fillStyle = grassPattern;
  ctx.fillRect(0, 0, vw, vh);

  // lightly darken far edges for vignette
  const grad = ctx.createLinearGradient(0, 0, 0, vh);
  grad.addColorStop(0, 'rgba(0,0,0,0.02)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.06)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, vw, vh);
}

// networking
function setupSocket(username, serverUrl) {
  if (!serverUrl) serverUrl = DEFAULT_BACKEND;
  try {
    socket = io(serverUrl, { transports: ['websocket', 'polling'] });
  } catch (err) {
    console.error('Socket init failed', err);
    setLoadingError('Invalid server URL');
    return;
  }

  socket.on('connect', () => {
    myId = socket.id;
    if (loadingScreen) {
      const main = loadingScreen.querySelector('#loading-main');
      const sub = loadingScreen.querySelector('#loading-sub');
      if (main) main.textContent = 'Connected';
      if (sub) sub.textContent = 'Receiving world…';
    }
    socket.emit('join', username);
  });

  socket.on('connect_error', (err) => {
    console.warn('connect_error', err);
    setLoadingError('Connection failed — check server/CORS');
  });

  socket.on('disconnect', (reason) => {
    console.warn('disconnected', reason);
    setLoadingError('Disconnected from server');
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

    // finalize and enter game
    if (loadingScreen) {
      const main = loadingScreen.querySelector('#loading-main');
      const sub = loadingScreen.querySelector('#loading-sub');
      if (main) main.textContent = 'Ready';
      if (sub) sub.textContent = '';
    }

    setTimeout(() => {
      hideLoading();
      startInputLoop();
    }, 220);
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
        localState.x = sp.x; localState.y = sp.y; localState.vx = sp.vx; localState.vy = sp.vy;
        let i = 0;
        while (i < pendingInputs.length && pendingInputs[i].seq <= serverSeq) i++;
        pendingInputs.splice(0, i);
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

  socket.on('connect', () => {
    // keep input loop started only after world ready (we start it after currentPlayers)
  });
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
  // show loading screen and begin the connection process
  titleScreen.classList.add('hidden'); // hide title
  showLoading(name);
  setupSocket(name, DEFAULT_BACKEND);
});

// ensure Enter works and don't let the global handlers see these key events
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
  // Stop propagation so window-level movement handlers won't intercept typing keys (W/A/S/D)
  e.stopPropagation();
});
usernameInput.addEventListener('keypress', (e) => e.stopPropagation());
usernameInput.addEventListener('keyup', (e) => e.stopPropagation());

// keyboard: ignore movement handling if the user is focused on a text field
window.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = true; e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (isTyping()) return;
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = false; e.preventDefault();
  }
});

// Rendering: camera follows local player; draw only what's visible
const tileSize = 40;
function worldToScreen(wx, wy, camX, camY) {
  return { x: wx - camX, y: wy - camY };
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

// Minimap
function drawMinimap(camX, camY) {
  // size: responsive but bounded
  const maxSize = Math.min(260, Math.floor(viewport.w * 0.28));
  const size = Math.max(120, maxSize);
  const padding = 12;
  const w = size;
  const h = Math.round(size * (MAP.height / MAP.width)); // keep aspect relative to map (very wide map -> short minimap)
  const mmW = w;
  const mmH = Math.min(size, Math.max(80, h)); // clamp height

  const x = viewport.w - mmW - padding;
  const y = padding;

  // background
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(10,20,10,0.66)'; // dark translucent
  roundRect(ctx, x - 2, y - 2, mmW + 4, mmH + 4, 8);
  ctx.fill();

  // inner background (green-ish)
  ctx.fillStyle = 'rgba(70,120,60,0.9)';
  roundRect(ctx, x, y, mmW, mmH, 6);
  ctx.fill();

  // border
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, mmW - 1, mmH - 1, 6);
  ctx.stroke();

  // draw players as dots
  for (const p of players.values()) {
    const px = x + (p.x / MAP.width) * mmW;
    const py = y + (p.y / MAP.height) * mmH;

    if (p.id === myId) {
      // my player: yellow dot with small halo
      ctx.beginPath();
      ctx.fillStyle = '#ffe04a';
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,224,74,0.14)';
      ctx.arc(px, py, 7.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.fillStyle = '#bdbdbd';
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // camera rectangle (where the viewport sits in the world)
  const camRectX = x + (camX / MAP.width) * mmW;
  const camRectY = y + (camY / MAP.height) * mmH;
  const camRectW = Math.max(2, (viewport.w / MAP.width) * mmW);
  const camRectH = Math.max(2, (viewport.h / MAP.height) * mmH);

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.2;
  ctx.rect(camRectX, camRectY, camRectW, camRectH);
  ctx.stroke();

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// Main render loop
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

  // Draw background (grass)
  drawBackground(camX, camY, viewport.w, viewport.h);

  // Draw players
  drawPlayers(camX, camY, now);

  // Draw minimap
  drawMinimap(camX, camY);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// on load focus username and update viewport
window.addEventListener('load', () => {
  usernameInput.focus();
  resizeCanvas();
});

// cleanup
window.addEventListener('beforeunload', () => {
  stopInputLoop();
  if (socket) socket.disconnect();
});
