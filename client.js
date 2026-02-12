// Moborr.io client — polygon maze walls with smooth movement prediction/reconciliation
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

// Game state
const players = new Map(); // id -> player object
const pendingInputs = [];

// Networking / rates
const SEND_RATE = 30; // inputs per second (client -> server)
const INPUT_DT = 1 / SEND_RATE;
const SERVER_TICK_RATE = 30; // server snapshot rate
const SPEED = 260; // px/sec (must match server)

// Avatar / visuals
const PLAYER_RADIUS = 26;

// Map with walls
const MAP = { width: 12000, height: 12000, padding: 16, walls: [] };

let localState = { x: MAP.width / 2, y: MAP.height / 2, vx: 0, vy: 0 };
let inputSeq = 0;

// Input state
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

// --- Grass pattern setup ---
let grassPattern = null;
let grassPatternSize = 128;

function createGrassPattern() {
  grassPatternSize = Math.max(64, Math.round(Math.min(160, 128 * (dpr || 1))));
  const c = document.createElement('canvas');
  c.width = grassPatternSize;
  c.height = grassPatternSize;
  const g = c.getContext('2d');

  // base green
  g.fillStyle = '#4aa04a';
  g.fillRect(0, 0, c.width, c.height);

  // subtle darker stripes
  g.fillStyle = 'rgba(38, 94, 38, 0.06)';
  for (let i = 0; i < 6; i++) {
    const y = Math.random() * c.height;
    g.fillRect(0, y, c.width, 1 + Math.random() * 2);
  }

  // blades of grass
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

  // small flowers/dots
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

// --- Pseudo-noise for jagged walls ---
function pseudo(x, y, seed = 1337) {
  return (Math.abs(Math.sin(x * 127.1 + y * 311.7 + seed) * 43758.5453) % 1);
}

// --- Jagged wall generation ---
const JAG_SEGMENT_LENGTH = 20;
const JAG_DISPLACEMENT = 8;
let jaggedWallCache = [];

function buildJaggedPoints(polyPoints, segmentLength = JAG_SEGMENT_LENGTH, jagMag = JAG_DISPLACEMENT) {
  if (!Array.isArray(polyPoints) || polyPoints.length < 2) return polyPoints || [];
  const out = [];
  for (let i = 0; i < polyPoints.length; i++) {
    const a = polyPoints[i];
    const b = polyPoints[(i + 1) % polyPoints.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / segLen;
    const ny = dx / segLen;
    const steps = Math.max(1, Math.ceil(segLen / segmentLength));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const noise = pseudo(px * 0.08, py * 0.08);
      const offset = (noise - 0.5) * 2 * jagMag;
      const alt = pseudo(px * 0.07 + 37.13, py * 0.11 + 91.7) - 0.5;
      const finalOffset = offset * (0.8 + 0.4 * alt);
      const jx = px + nx * finalOffset;
      const jy = py + ny * finalOffset;
      out.push({ x: jx, y: jy });
    }
  }
  return out;
}

function rebuildJaggedWallCache() {
  jaggedWallCache = [];
  for (const w of MAP.walls) {
    if (w && Array.isArray(w.points) && w.points.length >= 3) {
      const jagged = buildJaggedPoints(w.points, JAG_SEGMENT_LENGTH, JAG_DISPLACEMENT);
      jaggedWallCache.push({ id: w.id || null, jagged });
    }
  }
}

// --- Polygon collision detection ---
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const dv = vx*vx + vy*vy;
  let t = dv > 0 ? (wx * vx + wy * vy) / dv : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + vx * t, cy = ay + vy * t;
  const dx = px - cx, dy = py - cy;
  return { dist: Math.hypot(dx, dy), closest: { x: cx, y: cy } };
}

function resolveCirclePolygon(p, poly) {
  const inside = pointInPolygon(p.x, p.y, poly);
  let minOverlap = Infinity;
  let pushVec = null;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i+1) % poly.length];
    const res = pointToSegmentDistance(p.x, p.y, a.x, a.y, b.x, b.y);
    const d = res.dist;
    const overlap = p.radius - d;
    if (overlap > 0 && overlap < minOverlap) {
      const ex = b.x - a.x, ey = b.y - a.y;
      let nx = -ey, ny = ex;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen; ny /= nlen;
      const sampleX = res.closest.x + nx * 2;
      const sampleY = res.closest.y + ny * 2;
      const sampleInside = pointInPolygon(sampleX, sampleY, poly);
      if (sampleInside) { nx = -nx; ny = -ny; }
      minOverlap = overlap;
      pushVec = { nx, ny, overlap };
    }
  }

  if (inside && !pushVec) {
    let cx = 0, cy = 0;
    for (const q of poly) { cx += q.x; cy += q.y; }
    cx /= poly.length; cy /= poly.length;
    let nx = p.x - cx, ny = p.y - cy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const overlap = p.radius + 1;
    p.x += nx * overlap; p.y += ny * overlap;
    p.vx = 0; p.vy = 0;
    return;
  }

  if (pushVec && pushVec.overlap > 0) {
    p.x += pushVec.nx * pushVec.overlap;
    p.y += pushVec.ny * pushVec.overlap;
    const vn = p.vx * pushVec.nx + p.vy * pushVec.ny;
    if (vn > 0) { p.vx -= vn * pushVec.nx; p.vy -= vn * pushVec.ny; }
  }
}

function clientPointInsideWall(x, y, margin = 6) {
  for (const w of MAP.walls) {
    if (w && Array.isArray(w.points)) {
      if (pointInPolygon(x, y, w.points)) return true;
    }
  }
  return false;
}

// --- Map clamping with collision ---
function clampToMapWithWalls(px, py, radius) {
  const padding = MAP.padding;
  px = Math.max(padding + radius, Math.min(MAP.width - padding - radius, px));
  py = Math.max(padding + radius, Math.min(MAP.height - padding - radius, py));
  
  const p = { x: px, y: py, vx: localState.vx, vy: localState.vy, radius };
  
  for (const w of MAP.walls) {
    if (w && Array.isArray(w.points)) {
      resolveCirclePolygon(p, w.points);
    }
  }
  
  return { x: p.x, y: p.y };
}

// Loading overlay
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
  const eyeL = document.createElement('div'); eyeL.className = 'eye left';
  const eyeR = document.createElement('div'); eyeR.className = 'eye right';
  avatar.appendChild(eyeL); avatar.appendChild(eyeR);

  const main = document.createElement('div'); main.className = 'loading-title'; main.id = 'loading-main'; main.textContent = 'Connecting...';
  const sub = document.createElement('div'); sub.className = 'loading-sub'; sub.id = 'loading-sub'; sub.textContent = 'Preparing the world';
  const uname = document.createElement('div'); uname.className = 'loading-username'; uname.id = 'loading-username'; uname.textContent = '';

  inner.appendChild(avatar);
  inner.appendChild(main);
  inner.appendChild(sub);
  inner.appendChild(uname);
  overlay.appendChild(inner);

  loadingScreen = overlay;
}

function showLoading(username) {
  createLoadingOverlay();
  const main = loadingScreen.querySelector('#loading-main');
  const sub = loadingScreen.querySelector('#loading-sub');
  const uname = loadingScreen.querySelector('#loading-username');
  if (main) main.textContent = 'Connecting...';
  if (sub) sub.textContent = 'Preparing the world';
  if (uname) uname.textContent = username || '';
  if (!document.body.contains(loadingScreen)) document.body.appendChild(loadingScreen);
}

function setLoadingError(text) {
  createLoadingOverlay();
  const main = loadingScreen.querySelector('#loading-main');
  const sub = loadingScreen.querySelector('#loading-sub');
  if (main) main.textContent = 'Connection error';
  if (sub) sub.textContent = text || '';
  if (!document.body.contains(loadingScreen)) document.body.appendChild(loadingScreen);
}

function hideLoading() {
  if (loadingScreen && document.body.contains(loadingScreen)) document.body.removeChild(loadingScreen);
}

// Typing guard
function isTyping() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || ae.isContentEditable;
}

// Canvas / DPR / resize
let dpr = Math.max(1, window.devicePixelRatio || 1);
let viewport = { w: 0, h: 0 };
let viewPixels = { w: 0, h: 0 };

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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  createGrassPattern();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Grass background draw
function drawBackground(camX, camY, vw, vh) {
  if (!grassPattern) {
    ctx.fillStyle = '#4aa04a';
    ctx.fillRect(0, 0, vw, vh);
    return;
  }
  try {
    if (typeof grassPattern.setTransform === 'function') {
      const t = new DOMMatrix();
      const ox = -(camX % grassPatternSize);
      const oy = -(camY % grassPatternSize);
      t.e = ox; t.f = oy;
      grassPattern.setTransform(t);
    }
  } catch (err) {
    // ignore
  }
  ctx.fillStyle = grassPattern;
  ctx.fillRect(0, 0, vw, vh);

  const grad = ctx.createLinearGradient(0, 0, 0, vh);
  grad.addColorStop(0, 'rgba(0,0,0,0.02)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.06)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, vw, vh);
}

// Draw walls
function drawWalls(camX, camY, vw, vh) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  
  for (const w of jaggedWallCache) {
    if (w && Array.isArray(w.jagged) && w.jagged.length >= 3) {
      ctx.beginPath();
      ctx.fillStyle = '#6b4f3b';
      ctx.moveTo(w.jagged[0].x - camX, w.jagged[0].y - camY);
      for (let i = 1; i < w.jagged.length; i++) {
        ctx.lineTo(w.jagged[i].x - camX, w.jagged[i].y - camY);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  
  ctx.restore();
}

// Networking / socket
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
        id: p.id,
        username: p.username,
        x: p.x,
        y: p.y,
        vx: p.vx || 0,
        vy: p.vy || 0,
        color: p.color || '#29a',
        interp: createInterp(),
        dispX: p.x,
        dispY: p.y,
        _bobPhase: Math.random() * Math.PI * 2,
        _nextBlink: 1 + Math.random() * 4,
        _blinkTime: 0
      });
      if (p.id === myId) {
        localState.x = p.x; localState.y = p.y; localState.vx = p.vx || 0; localState.vy = p.vy || 0;
      }
    });

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
    players.set(p.id, {
      id: p.id,
      username: p.username,
      x: p.x,
      y: p.y,
      vx: p.vx || 0,
      vy: p.vy || 0,
      color: p.color || '#29a',
      interp: createInterp(),
      dispX: p.x,
      dispY: p.y,
      _bobPhase: Math.random() * Math.PI * 2,
      _nextBlink: 1 + Math.random() * 4,
      _blinkTime: 0
    });
  });

  socket.on('playerLeft', (id) => {
    players.delete(id);
  });

  socket.on('stateSnapshot', (data) => {
    const now = Date.now();
    for (const sp of data.players) {
      const existing = players.get(sp.id);
      if (!existing) {
        players.set(sp.id, {
          id: sp.id,
          username: sp.username,
          x: sp.x,
          y: sp.y,
          vx: sp.vx,
          vy: sp.vy,
          color: sp.color || '#29a',
          interp: createInterp(),
          dispX: sp.x,
          dispY: sp.y,
          _bobPhase: Math.random() * Math.PI * 2,
          _nextBlink: 1 + Math.random() * 4,
          _blinkTime: 0
        });
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

        existing.x = localState.x;
        existing.y = localState.y;
        existing.vx = localState.vx;
        existing.vy = localState.vy;

        const interp = existing.interp || createInterp();
        interp.startX = interp.targetX || existing.x;
        interp.startY = interp.targetY || existing.y;
        interp.targetX = existing.x;
        interp.targetY = existing.y;
        interp.startTime = now;
        interp.endTime = now + 40;
        existing.interp = interp;
      } else {
        const interp = existing.interp || createInterp();
        interp.startX = existing.x; interp.startY = existing.y;
        interp.targetX = sp.x; interp.targetY = sp.y;
        interp.startTime = now;
        interp.endTime = now + (1000 / SERVER_TICK_RATE) * 1.1;
        existing.vx = sp.vx; existing.vy = sp.vy;
        existing.x = sp.x;
        existing.y = sp.y;
        existing.interp = interp;
      }
    }
  });

  socket.on('walls', (wallData) => {
    MAP.walls = wallData || [];
    rebuildJaggedWallCache();
  });
}

// Apply input to predicted state
function applyInputToState(state, input, dt) {
  state.vx = input.x * SPEED;
  state.vy = input.y * SPEED;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  
  const clamped = clampToMapWithWalls(state.x, state.y, PLAYER_RADIUS);
  state.x = clamped.x;
  state.y = clamped.y;
}

// Input loop
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
  titleScreen.classList.add('hidden');
  showLoading(name);
  setupSocket(name, DEFAULT_BACKEND);
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
  e.stopPropagation();
});
usernameInput.addEventListener('keypress', (e) => e.stopPropagation());
usernameInput.addEventListener('keyup', (e) => e.stopPropagation());

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

// Avatar drawing with bobbing and blinking
function drawPlayerAvatar(screenX, screenY, radius, p, isLocal, blinkClosedAmount, bobOffset) {
  const faceColor = '#17b84a';
  const outerGold = '#d3b34a';
  const innerGold = '#e6cf78';

  ctx.beginPath();
  ctx.fillStyle = outerGold;
  ctx.arc(screenX, screenY + bobOffset, radius + 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = innerGold;
  ctx.arc(screenX, screenY + bobOffset, radius + 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = faceColor;
  ctx.arc(screenX, screenY + bobOffset, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';
  ctx.arc(screenX, screenY + bobOffset, radius, 0, Math.PI * 2);
  ctx.stroke();

  const eyeOffsetX = Math.max(8, radius * 0.48);
  const eyeOffsetY = -Math.max(6, radius * 0.18);
  const eyeW = Math.max(8, radius * 0.48);
  const eyeH = Math.max(12, radius * 0.8);

  function drawEye(cx, cy, closedAmount) {
    const visibleH = Math.max(0.06, 1 - closedAmount);
    ctx.beginPath();
    ctx.ellipse(cx, cy, eyeW * 0.5, eyeH * 0.5 * visibleH, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();

    if (visibleH > 0.12) {
      ctx.beginPath();
      ctx.ellipse(cx - eyeW * 0.18, cy - eyeH * 0.16 * visibleH, eyeW * 0.18, eyeH * 0.28 * visibleH, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.ellipse(cx, cy, eyeW * 0.36, eyeH * 0.36 * visibleH, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,220,120,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawEye(screenX - eyeOffsetX, screenY + eyeOffsetY + bobOffset, blinkClosedAmount);
  drawEye(screenX + eyeOffsetX, screenY + eyeOffsetY + bobOffset, blinkClosedAmount);

  ctx.beginPath();
  const smileRadius = radius * 0.60;
  const smileY = screenY + radius * 0.28 + bobOffset;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.arc(screenX, smileY, smileRadius, Math.PI * 0.18, Math.PI * 0.82);
  ctx.stroke();

  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffd86a';
  ctx.arc(screenX, smileY + 1.2, smileRadius * 0.96, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
}

// Draw players
let lastFrameTime = performance.now();
function drawPlayers(camX, camY, now, dtSeconds) {
  for (const p of players.values()) {
    if (p.dispX === undefined) p.dispX = p.x;
    if (p.dispY === undefined) p.dispY = p.y;
    if (p._bobPhase === undefined) p._bobPhase = Math.random() * Math.PI * 2;
    if (p._nextBlink === undefined) p._nextBlink = 1 + Math.random() * 4;
    if (p._blinkTime === undefined) p._blinkTime = 0;

    const speedNow = Math.hypot(p.vx || 0, p.vy || 0);
    const moveFactor = Math.min(1, speedNow / SPEED);
    p._bobPhase += dtSeconds * (2.8 + moveFactor * 6.0);
    const bobAmp = 1.5 + moveFactor * 4.0;
    const bobOffset = Math.sin(p._bobPhase) * bobAmp;

    if (p._nextBlink > 0) p._nextBlink -= dtSeconds;
    else if (p._blinkTime <= 0) { p._blinkTime = 0.20; p._nextBlink = 1.5 + Math.random() * 4.0; }
    let blinkClosedAmount = 0;
    if (p._blinkTime > 0) {
      const elapsed = 0.20 - p._blinkTime;
      const prog = Math.max(0, Math.min(1, elapsed / 0.20));
      blinkClosedAmount = Math.sin(prog * Math.PI);
      p._blinkTime -= dtSeconds;
    }

    if (p.id === myId) {
      if (p.interp && now < p.interp.endTime) {
        const t = (now - p.interp.startTime) / Math.max(1, p.interp.endTime - p.interp.startTime);
        const tt = Math.max(0, Math.min(1, t));
        const ease = tt * tt * (3 - 2 * tt);
        p.dispX = p.interp.startX + (p.interp.targetX - p.interp.startX) * ease;
        p.dispY = p.interp.startY + (p.interp.targetY - p.interp.startY) * ease;
      } else {
        p.dispX = localState.x;
        p.dispY = localState.y;
      }
    } else {
      if (p.interp && now < p.interp.endTime) {
        const t = (now - p.interp.startTime) / Math.max(1, p.interp.endTime - p.interp.startTime);
        const tt = Math.max(0, Math.min(1, t));
        const ease = tt * tt * (3 - 2 * tt);
        p.dispX = p.interp.startX + (p.interp.targetX - p.interp.startX) * ease;
        p.dispY = p.interp.startY + (p.interp.targetY - p.interp.startY) * ease;
      } else {
        p.dispX = p.x;
        p.dispY = p.y;
      }
    }

    const screen = worldToScreen(p.dispX, p.dispY, camX, camY);
    if (screen.x < -150 || screen.x > viewport.w + 150 || screen.y < -150 || screen.y > viewport.h + 150) continue;

    drawPlayerAvatar(screen.x, screen.y, PLAYER_RADIUS, p, p.id === myId, blinkClosedAmount, Math.sin(p._bobPhase) * (1.5 + moveFactor * 3.0));

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '12px system-ui, Arial';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, screen.x, screen.y + PLAYER_RADIUS + 14);
  }
}

// Minimap & helpers
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

function drawMinimap(camX, camY) {
  const maxSize = Math.min(260, Math.floor(viewport.w * 0.28));
  const size = Math.max(120, maxSize);
  const padding = 12;
  const w = size;
  const h = Math.round(size * (MAP.height / MAP.width));
  const mmW = w;
  const mmH = Math.min(size, Math.max(80, h));

  const x = viewport.w - mmW - padding;
  const y = padding;

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(10,20,10,0.66)';
  roundRect(ctx, x - 2, y - 2, mmW + 4, mmH + 4, 8);
  ctx.fill();

  ctx.fillStyle = 'rgba(70,120,60,0.9)';
  roundRect(ctx, x, y, mmW, mmH, 6);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, mmW - 1, mmH - 1, 6);
  ctx.stroke();

  for (const p of players.values()) {
    const px = x + (p.x / MAP.width) * mmW;
    const py = y + (p.y / MAP.height) * mmH;

    if (p.id === myId) {
      ctx.beginPath();
      ctx.fillStyle = '#ffe04a';
      ctx.arc(px, py, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,224,74,0.14)';
      ctx.arc(px, py, 9.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.fillStyle = '#bdbdbd';
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

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

// Coordinate helpers
function worldToScreen(wx, wy, camX, camY) {
  return { x: wx - camX, y: wy - camY };
}

// Render loop
function render() {
  const nowPerf = performance.now();
  let dt = (nowPerf - lastFrameTime) / 1000;
  if (dt > 0.05) dt = 0.05;
  lastFrameTime = nowPerf;

  const me = players.get(myId);
  const cx = (me ? me.dispX : localState.x) - viewport.w / 2;
  const cy = (me ? me.dispY : localState.y) - viewport.h / 2;
  const camX = Math.max(0, Math.min(MAP.width - viewport.w, cx));
  const camY = Math.max(0, Math.min(MAP.height - viewport.h, cy));

  drawBackground(camX, camY, viewport.w, viewport.h);
  drawWalls(camX, camY, viewport.w, viewport.h);
  drawPlayers(camX, camY, Date.now(), dt);
  drawMinimap(camX, camY);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// Cleanup
window.addEventListener('beforeunload', () => {
  stopInputLoop();
  if (socket) socket.disconnect();
});

window.addEventListener('load', () => {
  usernameInput.focus();
  resizeCanvas();
});
