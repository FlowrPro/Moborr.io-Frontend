// Moborr.io client — ultra-smooth velocity-based movement with adaptive smoothing
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

// Player image
let playerImage = null;
function loadPlayerImage() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      playerImage = img;
      resolve();
    };
    img.onerror = () => {
      console.warn('Failed to load player image, will use fallback');
      resolve();
    };
    img.src = '/assets/player.png';
  });
}

// Game state
const players = new Map();
const pendingInputs = [];

// Inventory and hotbar state
let playerInventory = []; // Array of petal instances
let hotbar = new Array(8).fill(null); // 8 slots, null = empty
let selectedHotbarSlot = null;
let inventoryOpen = false;

// Networking / rates
const SEND_RATE = 30;
const INPUT_DT = 1 / SEND_RATE;
const SERVER_TICK_RATE = 30;
const SPEED = 260;

// Avatar / visuals
const PLAYER_RADIUS = 26;

// Map
const MAP = { width: 12000, height: 12000, padding: 16 };

let localState = { x: MAP.width / 2, y: MAP.height / 2, vx: 0, vy: 0 };
let inputSeq = 0;

// Wall system - Large winding snake-like walls with maze pattern
const WALLS = [];
function generateMazeWalls() {
  // Create a maze-like pattern with long, winding walls that have dead ends and tunnels
  // The walls create an organic, snake-like path through the map
  
  const wallThickness = 600; // Very thick walls
  const mapW = MAP.width;
  const mapH = MAP.height;
  
  // Main perimeter-like wall on the left side, winding up
  WALLS.push({
    x: 0,
    y: 0,
    width: wallThickness,
    height: mapH * 0.4
  });
  
  // Wall extends right from top-left
  WALLS.push({
    x: 0,
    y: 0,
    width: mapW * 0.35,
    height: wallThickness
  });
  
  // First major turn - goes down on the right side of top section
  WALLS.push({
    x: mapW * 0.3,
    y: wallThickness,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  // Horizontal wall in middle-left area - dead end
  WALLS.push({
    x: 0,
    y: mapH * 0.35,
    width: mapW * 0.25,
    height: wallThickness
  });
  
  // Major vertical wall in center - creates main corridor
  WALLS.push({
    x: mapW * 0.45,
    y: mapH * 0.2,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  // Winding wall on right side - goes up and down
  WALLS.push({
    x: mapW * 0.65,
    y: 0,
    width: wallThickness,
    height: mapH * 0.5
  });
  
  // Right side bottom section - creates a tunnel effect
  WALLS.push({
    x: mapW * 0.7,
    y: mapH * 0.45,
    width: mapW * 0.3,
    height: wallThickness
  });
  
  // Bottom perimeter wall - long horizontal
  WALLS.push({
    x: 0,
    y: mapH * 0.8,
    width: mapW * 0.6,
    height: wallThickness
  });
  
  // Bottom right area - creates winding path
  WALLS.push({
    x: mapW * 0.55,
    y: mapH * 0.65,
    width: wallThickness,
    height: mapH * 0.35
  });
  
  // Center area - creates maze-like dead ends
  WALLS.push({
    x: mapW * 0.2,
    y: mapH * 0.5,
    width: mapW * 0.2,
    height: wallThickness
  });
  
  // Left-center vertical tunnel
  WALLS.push({
    x: mapW * 0.1,
    y: mapH * 0.5,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  // Right-center section - more maze complexity
  WALLS.push({
    x: mapW * 0.75,
    y: mapH * 0.6,
    width: wallThickness,
    height: mapH * 0.2
  });
  
  // Additional winding on bottom-left
  WALLS.push({
    x: mapW * 0.15,
    y: mapH * 0.7,
    width: wallThickness,
    height: mapH * 0.3
  });
  
  // Top-right corner tunnel
  WALLS.push({
    x: mapW * 0.8,
    y: mapH * 0.15,
    width: mapW * 0.2,
    height: wallThickness
  });
}

function getWallCollisionBox(wall) {
  // Return an axis-aligned bounding box for the wall
  return {
    x: wall.x,
    y: wall.y,
    width: wall.width,
    height: wall.height
  };
}

// Swept circle-rectangle collision: checks if moving from oldPos to newPos collides
function getCollisionNormal(oldX, oldY, newX, newY, radius) {
  for (const wall of WALLS) {
    const box = getWallCollisionBox(wall);
    
    // Find closest point on wall box to the new position
    const closestX = Math.max(box.x, Math.min(newX, box.x + box.width));
    const closestY = Math.max(box.y, Math.min(newY, box.y + box.height));
    
    const distX = newX - closestX;
    const distY = newY - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    
    if (distance < radius) {
      // Collision detected - return collision info
      const len = Math.hypot(distX, distY);
      const nx = len > 1e-6 ? distX / len : 0;
      const ny = len > 1e-6 ? distY / len : 0;
      const penetration = radius - distance;
      
      return {
        collided: true,
        nx, ny,
        penetration,
        wall,
        distance
      };
    }
  }
  
  return { collided: false };
}

function checkWallCollision(x, y, radius) {
  // Check if a point + radius collides with any wall
  for (const wall of WALLS) {
    const box = getWallCollisionBox(wall);
    
    // Find the closest point on the wall box to the circle center
    const closestX = Math.max(box.x, Math.min(x, box.x + box.width));
    const closestY = Math.max(box.y, Math.min(y, box.y + box.height));
    
    // Calculate distance
    const distX = x - closestX;
    const distY = y - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    
    if (distance < radius) {
      return true; // Collision detected
    }
  }
  return false;
}

// Simple spatial grid for collision optimization
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }
  
  getKey(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
  
  getNearbyWalls(x, y, radius) {
    const nearbyWalls = new Set();
    const searchRadius = Math.ceil(radius / this.cellSize) + 1;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const wallsInCell = this.grid.get(key);
        if (wallsInCell) {
          wallsInCell.forEach(w => nearbyWalls.add(w));
        }
      }
    }
    
    return Array.from(nearbyWalls);
  }
  
  build(walls) {
    this.grid.clear();
    for (const wall of walls) {
      const minCellX = Math.floor(wall.x / this.cellSize);
      const minCellY = Math.floor(wall.y / this.cellSize);
      const maxCellX = Math.floor((wall.x + wall.width) / this.cellSize);
      const maxCellY = Math.floor((wall.y + wall.height) / this.cellSize);
      
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        for (let cy = minCellY; cy <= maxCellY; cy++) {
          const key = `${cx},${cy}`;
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key).push(wall);
        }
      }
    }
  }
}

const wallGrid = new SpatialGrid(1000); // 1000px cells

function checkWallCollisionOptimized(x, y, radius) {
  const nearbyWalls = wallGrid.getNearbyWalls(x, y, radius);
  for (const wall of nearbyWalls) {
    const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.width));
    const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.height));
    
    const distX = x - closestX;
    const distY = y - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    
    if (distance < radius) {
      return true;
    }
  }
  return false;
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

  g.fillStyle = '#4aa04a';
  g.fillRect(0, 0, c.width, c.height);

  g.fillStyle = 'rgba(38, 94, 38, 0.06)';
  for (let i = 0; i < 6; i++) {
    const y = Math.random() * c.height;
    g.fillRect(0, y, c.width, 1 + Math.random() * 2);
  }

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
  const uname = loadingScreen.querySelector('#loading-username');
  if (main) main.textContent = 'Connection error';
  if (sub) sub.textContent = text || '';
  if (uname) uname.textContent = '';
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
      const ox = - (camX % grassPatternSize);
      const oy = - (camY % grassPatternSize);
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
  for (const wall of WALLS) {
    const screenX = wall.x - camX;
    const screenY = wall.y - camY;
    
    // Only draw if wall is visible on screen
    if (screenX + wall.width < -50 || screenX > vw + 50 ||
        screenY + wall.height < -50 || screenY > vh + 50) {
      continue;
    }
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(screenX, screenY, wall.width, wall.height);
    
    // Add subtle border for definition
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 2;
    ctx.strokeRect(screenX, screenY, wall.width, wall.height);
  }
}

// Inventory UI functions
function createInventoryUI() {
  let inv = document.getElementById('inventory-container');
  if (inv) return; // already exists

  const container = document.createElement('div');
  container.id = 'inventory-container';
  container.className = 'inventory-container hidden';

  const panel = document.createElement('div');
  panel.className = 'inventory-panel';
  panel.id = 'inventory-panel';

  const header = document.createElement('div');
  header.className = 'inventory-header';
  header.innerHTML = '<h2>Inventory</h2><button class="inventory-close" aria-label="Close inventory">✕</button>';

  const dragHint = document.createElement('div');
  dragHint.className = 'inventory-hint';
  dragHint.textContent = 'Drag a petal to equip it';

  const grid = document.createElement('div');
  grid.className = 'inventory-grid';
  grid.id = 'inventory-grid';

  panel.appendChild(header);
  panel.appendChild(dragHint);
  panel.appendChild(grid);
  container.appendChild(panel);
  document.body.appendChild(container);

  // Close button
  header.querySelector('.inventory-close').addEventListener('click', toggleInventory);

  // Close when clicking outside
  container.addEventListener('click', (e) => {
    if (e.target === container) toggleInventory();
  });

  // Allow drag and drop back to inventory
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
    if (data.type === 'hotbar') {
      // Remove from hotbar (drag back to inventory = unequip)
      hotbar[data.slot] = null;
      renderHotbar();
    }
  });
}

function toggleInventory() {
  inventoryOpen = !inventoryOpen;
  const inv = document.getElementById('inventory-container');
  if (inv) {
    inv.classList.toggle('hidden');
  }
  if (inventoryOpen) {
    renderInventoryGrid();
    // Position popup centered on screen
    const panel = document.getElementById('inventory-panel');
    if (panel) {
      panel.style.left = 'calc(50% - 190px)'; // Center horizontally (380px width / 2)
      panel.style.top = 'calc(50% - 300px)'; // Center vertically (600px max height / 2)
    }
  }
}

function renderInventoryGrid() {
  const grid = document.getElementById('inventory-grid');
  if (!grid) return;

  grid.innerHTML = '';

  if (playerInventory.length === 0) {
    grid.innerHTML = '<div class="inventory-empty">No petals yet</div>';
    return;
  }

  // Group by rarity
  const byRarity = {};
  playerInventory.forEach(petal => {
    if (!byRarity[petal.rarity]) {
      byRarity[petal.rarity] = [];
    }
    byRarity[petal.rarity].push(petal);
  });

  // Rarity order
  const rarityOrder = ['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythical', 'Godly'];
  
  for (const rarity of rarityOrder) {
    const petals = byRarity[rarity];
    if (!petals) continue;

    const rarityLabel = document.createElement('div');
    rarityLabel.className = 'inventory-rarity-label';
    rarityLabel.style.color = RARITY_COLORS[rarity];
    rarityLabel.textContent = rarity;
    grid.appendChild(rarityLabel);

    const rarityGrid = document.createElement('div');
    rarityGrid.className = 'inventory-rarity-grid';

    petals.forEach((petal, idx) => {
      const item = document.createElement('div');
      item.className = 'inventory-item';
      item.style.borderColor = RARITY_COLORS[petal.rarity];
      item.style.backgroundColor = RARITY_COLORS[petal.rarity] + '40';
      
      item.innerHTML = `
        <div class="inventory-item-icon">
          <img src="${petal.icon}" alt="${petal.name}" class="inventory-item-img">
        </div>
        <div class="inventory-item-label">${petal.name}</div>
        <div class="inventory-item-qty">×${petal.quantity}</div>
      `;

      // Add tooltip
      item.addEventListener('mouseenter', (e) => {
        showTooltip(e, petal);
      });
      item.addEventListener('mouseleave', hideTooltip);

      // Drag to hotbar
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'inventory', petal: petal }));
      });

      rarityGrid.appendChild(item);
    });

    grid.appendChild(rarityGrid);
  }
}

function createHotbarUI() {
  const hotbarContainer = document.createElement('div');
  hotbarContainer.id = 'hotbar-container';
  hotbarContainer.className = 'hotbar-container';

  for (let i = 0; i < 8; i++) {
    const slot = document.createElement('div');
    slot.className = 'hotbar-slot';
    slot.id = `hotbar-slot-${i}`;
    slot.dataset.slot = i;

    const icon = document.createElement('div');
    icon.className = 'hotbar-slot-icon';
    icon.id = `hotbar-icon-${i}`;

    const label = document.createElement('div');
    label.className = 'hotbar-slot-label';
    label.textContent = i + 1;

    const qty = document.createElement('div');
    qty.className = 'hotbar-slot-qty';
    qty.id = `hotbar-qty-${i}`;

    slot.appendChild(icon);
    slot.appendChild(qty);
    slot.appendChild(label);

    // Drag and drop - accept items from inventory
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      slot.classList.add('drag-over');
    });

    slot.addEventListener('dragleave', () => {
      slot.classList.remove('drag-over');
    });

    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.type === 'inventory') {
        equipToHotbar(data.petal, i);
      } else if (data.type === 'hotbar') {
        // Swap between hotbar slots
        const tempPetal = hotbar[i];
        hotbar[i] = hotbar[data.slot];
        hotbar[data.slot] = tempPetal;
        renderHotbar();
      }
    });

    // Allow dragging FROM hotbar
    slot.addEventListener('dragstart', (e) => {
      const petal = hotbar[i];
      if (!petal) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'hotbar', slot: i }));
      slot.style.opacity = '0.5';
    });

    slot.addEventListener('dragend', () => {
      slot.style.opacity = '1';
    });

    hotbarContainer.appendChild(slot);
  }

  document.body.appendChild(hotbarContainer);
}

function equipToHotbar(petal, hotbarSlot) {
  if (!petal || hotbarSlot < 0 || hotbarSlot >= 8) return;

  hotbar[hotbarSlot] = petal;
  renderHotbar();

  // Tell server
  socket.emit('equipPetal', { petalInstanceId: petal.instanceId, hotbarSlot });
}

function renderHotbar() {
  for (let i = 0; i < 8; i++) {
    const petal = hotbar[i];
    const iconEl = document.getElementById(`hotbar-icon-${i}`);
    const qtyEl = document.getElementById(`hotbar-qty-${i}`);
    const slot = document.getElementById(`hotbar-slot-${i}`);

    if (!petal) {
      iconEl.innerHTML = '';
      qtyEl.innerHTML = '';
      slot.style.borderColor = '#999';
      slot.style.backgroundColor = '#e8e8e8';
      return;
    }

    // Display petal image in hotbar
    iconEl.innerHTML = `<img src="${petal.icon}" alt="${petal.name}" class="hotbar-item-img">`;
    qtyEl.textContent = petal.quantity > 1 ? `×${petal.quantity}` : '';
    
    slot.style.borderColor = '#888';
    slot.style.backgroundColor = '#f5f5f5';
  }
}

let tooltipEl = null;
function showTooltip(event, petal) {
  if (tooltipEl) hideTooltip();

  tooltipEl = document.createElement('div');
  tooltipEl.className = 'tooltip';
  tooltipEl.innerHTML = `
    <div class="tooltip-name">${petal.name}</div>
    <div class="tooltip-rarity" style="color: ${RARITY_COLORS[petal.rarity]}">${petal.rarity}</div>
    <div class="tooltip-category">${petal.category}</div>
    <div class="tooltip-description">${petal.description}</div>
    ${petal.healing !== undefined ? `<div class="tooltip-stat">Healing: ${petal.healing.toFixed(1)}</div>` : ''}
    ${petal.damage !== undefined ? `<div class="tooltip-stat">Damage: ${petal.damage.toFixed(1)}</div>` : ''}
    ${petal.health !== undefined ? `<div class="tooltip-stat">Health: ${petal.health.toFixed(1)}</div>` : ''}
  `;

  document.body.appendChild(tooltipEl);

  const rect = event.target.getBoundingClientRect();
  tooltipEl.style.left = (rect.right + 10) + 'px';
  tooltipEl.style.top = rect.top + 'px';
}

function hideTooltip() {
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}

// Inventory button
function createInventoryButton() {
  const btn = document.createElement('button');
  btn.id = 'inventory-btn';
  btn.className = 'inventory-btn';
  btn.title = 'Open Inventory (E)';
  btn.innerHTML = '<img src="/assets/inventory-icon.png" alt="Inventory" onerror="this.textContent=\'📦\'">';
  
  document.body.appendChild(btn);

  btn.addEventListener('click', toggleInventory);
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
    if (!Array.isArray(list)) {
      console.error('Invalid currentPlayers data');
      return;
    }
    
    players.clear();
    list.forEach(p => {
      // Validate player data
      if (!p.id || typeof p.id !== 'string') return;
      
      players.set(p.id, {
        id: p.id,
        username: p.username || 'Unknown',
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        vx: Number(p.vx) || 0,
        vy: Number(p.vy) || 0,
        color: p.color || '#29a',
        dispX: Number(p.x) || 0,
        dispY: Number(p.y) || 0,
        lastUpdateTime: Date.now(),
        smoothX: Number(p.x) || 0,
        smoothY: Number(p.y) || 0,
        correctionDist: 0
      });
      if (p.id === myId) {
        localState.x = Number(p.x) || 0;
        localState.y = Number(p.y) || 0;
        localState.vx = Number(p.vx) || 0;
        localState.vy = Number(p.vy) || 0;
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
    if (!p || !p.id) {
      console.error('Invalid newPlayer data');
      return;
    }
    
    players.set(p.id, {
      id: p.id,
      username: p.username || 'Unknown',
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      vx: Number(p.vx) || 0,
      vy: Number(p.vy) || 0,
      color: p.color || '#29a',
      dispX: Number(p.x) || 0,
      dispY: Number(p.y) || 0,
      lastUpdateTime: Date.now(),
      smoothX: Number(p.x) || 0,
      smoothY: Number(p.y) || 0,
      correctionDist: 0
    });
  });

  socket.on('playerLeft', (id) => {
    if (typeof id === 'string') {
      players.delete(id);
    }
  });

  socket.on('playerInventory', (data) => {
    // Receive inventory from server
    if (Array.isArray(data.inventory)) {
      playerInventory = data.inventory;
      hotbar = data.hotbar || new Array(8).fill(null);
      renderHotbar();
      renderInventoryGrid();
    }
  });

  socket.on('stateSnapshot', (data) => {
    if (!data || !Array.isArray(data.players)) {
      console.error('Invalid stateSnapshot data');
      return;
    }
    
    const now = Date.now();
    for (const sp of data.players) {
      if (!sp.id || typeof sp.id !== 'string') continue;
      
      const existing = players.get(sp.id);
      
      if (!existing) {
        players.set(sp.id, {
          id: sp.id,
          username: sp.username || 'Unknown',
          x: Number(sp.x) || 0,
          y: Number(sp.y) || 0,
          vx: Number(sp.vx) || 0,
          vy: Number(sp.vy) || 0,
          color: sp.color || '#29a',
          dispX: Number(sp.x) || 0,
          dispY: Number(sp.y) || 0,
          lastUpdateTime: now,
          smoothX: Number(sp.x) || 0,
          smoothY: Number(sp.y) || 0,
          correctionDist: 0
        });
        continue;
      }

      if (sp.id === myId) {
        // Local player reconciliation
        const serverSeq = sp.lastProcessedInput || 0;
        localState.x = Number(sp.x) || 0;
        localState.y = Number(sp.y) || 0;
        localState.vx = Number(sp.vx) || 0;
        localState.vy = Number(sp.vy) || 0;

        let i = 0;
        while (i < pendingInputs.length && pendingInputs[i].seq <= serverSeq) i++;
        pendingInputs.splice(0, i);
        for (const inpt of pendingInputs) applyInputToState(localState, inpt.input, inpt.dt);

        existing.x = localState.x;
        existing.y = localState.y;
        existing.vx = localState.vx;
        existing.vy = localState.vy;
        existing.smoothX = localState.x;
        existing.smoothY = localState.y;
        existing.lastUpdateTime = now;
      } else {
        // Remote players: smooth velocity changes gradually
        existing.x = Number(sp.x) || 0;
        existing.y = Number(sp.y) || 0;
        existing.vx = Number(sp.vx) || 0;
        existing.vy = Number(sp.vy) || 0;
        existing.lastUpdateTime = now;
        
        // Calculate distance from extrapolated position to actual position
        const timeSinceUpdate = (now - existing.lastUpdateTime) / 1000;
        const extrapolatedX = existing.x + existing.vx * timeSinceUpdate;
        const extrapolatedY = existing.y + existing.vy * timeSinceUpdate;
        
        const corrDist = Math.hypot(existing.x - extrapolatedX, existing.y - extrapolatedY);
        existing.correctionDist = corrDist;
      }
    }
  });

  // Timeout for stale connections
  let socketTimeout = null;
  socket.on('connect', () => {
    if (socketTimeout) clearTimeout(socketTimeout);
    socketTimeout = setTimeout(() => {
      if (socket && socket.connected) {
        console.warn('Socket timeout - no data received');
        socket.disconnect();
      }
    }, 15000);
  });

  socket.on('disconnect', () => {
    if (socketTimeout) clearTimeout(socketTimeout);
  });
}

// Apply input to state with sliding collision
function applyInputToState(state, input, dt) {
  const oldX = state.x;
  const oldY = state.y;
  
  state.vx = input.x * SPEED;
  state.vy = input.y * SPEED;
  
  const desiredX = state.x + state.vx * dt;
  const desiredY = state.y + state.vy * dt;
  
  // Check collision
  const collision = getCollisionNormal(state.x, state.y, desiredX, desiredY, PLAYER_RADIUS);
  
  if (collision.collided) {
    // Sliding collision: move along the wall
    const friction = 0.95; // friction factor
    
    // Try moving only X
    const testX = desiredX;
    const testY = state.y;
    if (!checkWallCollisionOptimized(testX, testY, PLAYER_RADIUS)) {
      state.x = testX;
      state.y = testY;
    } else {
      // Try moving only Y
      const testX2 = state.x;
      const testY2 = desiredY;
      if (!checkWallCollisionOptimized(testX2, testY2, PLAYER_RADIUS)) {
        state.x = testX2;
        state.y = testY2;
      }
      // else: don't move
    }
  } else {
    state.x = desiredX;
    state.y = desiredY;
  }
  
  // Clamp to map bounds
  state.x = Math.max(MAP.padding, Math.min(MAP.width - MAP.padding, state.x));
  state.y = Math.max(MAP.padding, Math.min(MAP.height - MAP.padding, state.y));
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
    if (me) {
      me.x = localState.x;
      me.y = localState.y;
      me.vx = localState.vx;
      me.vy = localState.vy;
      me.dispX = localState.x;
      me.dispY = localState.y;
    }
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
  loadPlayerImage().then(() => {
    generateMazeWalls();
    wallGrid.build(WALLS);
    
    // Create UI for inventory and hotbar
    createInventoryButton();
    createInventoryUI();
    createHotbarUI();
    
    // Add test petals to inventory
    const testPetal1 = createPetal('fireball', 'Common');
    const testPetal2 = createPetal('fireball', 'Uncommon');
    const testPetal3 = createPetal('fireball', 'Rare');
    const testPetal4 = createPetal('fireball', 'Legendary');
    playerInventory = [testPetal1, testPetal2, testPetal3, testPetal4];
    renderInventoryGrid();
    
    setupSocket(name, DEFAULT_BACKEND);
  });
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
  e.stopPropagation();
});
usernameInput.addEventListener('keypress', (e) => e.stopPropagation());
usernameInput.addEventListener('keyup', (e) => e.stopPropagation());

const keys = {};
window.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  
  // Inventory toggle with E key or X key
  if (e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 'x') {
    toggleInventory();
    return;
  }
  
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = true;
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  if (isTyping()) return;
  if (['w','a','s','d','ArrowUp','ArrowLeft','ArrowDown','ArrowRight'].includes(e.key)) {
    keys[e.key] = false;
    e.preventDefault();
  }
});

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

// Avatar drawing
function drawPlayerAvatar(screenX, screenY, radius, p) {
  if (playerImage) {
    ctx.save();
    ctx.globalAlpha = 0.95;
    const diameter = radius * 2;
    ctx.drawImage(playerImage, screenX - radius, screenY - radius, diameter, diameter);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.fillStyle = '#17b84a';
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Draw players with smooth extrapolation
let lastFrameTime = performance.now();
function drawPlayers(camX, camY, now, dtSeconds) {
  for (const p of players.values()) {
    if (p.dispX === undefined) p.dispX = p.x;
    if (p.dispY === undefined) p.dispY = p.y;
    if (p.lastUpdateTime === undefined) p.lastUpdateTime = now;
    if (p.smoothX === undefined) p.smoothX = p.x;
    if (p.smoothY === undefined) p.smoothY = p.y;

    if (p.id === myId) {
      // Local player: use direct position with minimal smoothing
      p.dispX = localState.x;
      p.dispY = localState.y;
    } else {
      // Remote players: extrapolate with damped smoothing
      const timeSinceUpdate = (now - p.lastUpdateTime) / 1000;
      
      // Extrapolate based on velocity
      const extrapolX = p.x + p.vx * timeSinceUpdate;
      const extrapolY = p.y + p.vy * timeSinceUpdate;
      
      // Smooth damping factor - smoother the farther away the prediction is
      const dampFactor = Math.min(1, 1 - (p.correctionDist || 0) / 300);
      
      // Blend smoothly toward extrapolated position
      const smoothSpeed = 0.15 * dampFactor; // controls how fast smooth position catches up
      p.dispX = p.smoothX + (extrapolX - p.smoothX) * smoothSpeed;
      p.dispY = p.smoothY + (extrapolY - p.smoothY) * smoothSpeed;
      
      // Update smooth position tracker
      p.smoothX = p.dispX;
      p.smoothY = p.dispY;
    }

    const screen = worldToScreen(p.dispX, p.dispY, camX, camY);
    if (screen.x < -150 || screen.x > viewport.w + 150 || screen.y < -150 || screen.y > viewport.h + 150) continue;

    drawPlayerAvatar(screen.x, screen.y, PLAYER_RADIUS, p);

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

let minimapDirty = true;
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

  // Draw walls on minimap - solid black, no overlapping darkness
  ctx.fillStyle = '#000000';
  for (const wall of WALLS) {
    const mmX = x + (wall.x / MAP.width) * mmW;
    const mmY = y + (wall.y / MAP.height) * mmH;
    const mmWallW = (wall.width / MAP.width) * mmW;
    const mmWallH = (wall.height / MAP.height) * mmH;
    ctx.fillRect(mmX, mmY, mmWallW, mmWallH);
  }

  // Draw players
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

// On load
window.addEventListener('load', () => {
  usernameInput.focus();
  resizeCanvas();
});
