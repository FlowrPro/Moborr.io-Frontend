// Petal system - all petal definitions and logic

// Rarity multipliers - each rarity is 3x stronger than the previous
const RARITY_MULTIPLIERS = {
  'Common': 1,
  'Uncommon': 3,
  'Rare': 9,
  'Legendary': 27,
  'Mythical': 81,
  'Godly': 243
};

const RARITY_COLORS = {
  'Common': '#808080',
  'Uncommon': '#00AA00',
  'Rare': '#0055FF',
  'Legendary': '#FF00FF',
  'Mythical': '#FF8800',
  'Godly': '#FFFF00'
};

// Petal Types
const PETAL_TYPES = {
  HEAL: 'heal',
  CONSUMABLE: 'consumable',
  DAMAGER: 'damager',
  SHOOTABLE: 'shootable',
  BUFF: 'buff'
};

// Base petal definitions - these are templates
const PETAL_DEFINITIONS = {
  // HEAL type
  basic_heal: {
    id: 'basic_heal',
    name: 'Heal Petal',
    type: PETAL_TYPES.HEAL,
    baseValue: 25, // healing amount at common rarity
    icon: '/assets/petals/heal.png',
    description: 'Restores health when used',
    tooltip: 'Heals your player'
  },

  // CONSUMABLE type
  speed_boost: {
    id: 'speed_boost',
    name: 'Speed Boost',
    type: PETAL_TYPES.CONSUMABLE,
    baseValue: 1.5, // speed multiplier at common rarity
    duration: 5000, // 5 seconds in ms
    icon: '/assets/petals/speed.png',
    description: 'Temporarily increases movement speed',
    tooltip: 'Boosts speed for 5 seconds'
  },

  // DAMAGER type
  damage_petal: {
    id: 'damage_petal',
    name: 'Damage Petal',
    type: PETAL_TYPES.DAMAGER,
    baseDamage: 10,
    baseHealth: 20,
    icon: '/assets/petals/damage.png',
    description: 'A damaging projectile petal',
    tooltip: 'Shoots damaging projectiles'
  },

  // SHOOTABLE type
  projectile: {
    id: 'projectile',
    name: 'Projectile Petal',
    type: PETAL_TYPES.SHOOTABLE,
    baseDamage: 5,
    fireRate: 500, // ms between shots
    icon: '/assets/petals/projectile.png',
    description: 'Continuously shoots projectiles',
    tooltip: 'Rapid-fire projectiles'
  },

  // BUFF type
  defense_buff: {
    id: 'defense_buff',
    name: 'Defense Buff',
    type: PETAL_TYPES.BUFF,
    baseValue: 1.3, // defense multiplier
    duration: 8000, // 8 seconds
    icon: '/assets/petals/defense.png',
    description: 'Increases defense temporarily',
    tooltip: 'Reduces incoming damage'
  }
};

// Create a petal instance with rarity
function createPetal(petalId, rarity = 'Common') {
  const def = PETAL_DEFINITIONS[petalId];
  if (!def) {
    console.error('Petal definition not found:', petalId);
    return null;
  }

  if (!RARITY_MULTIPLIERS[rarity]) {
    console.error('Invalid rarity:', rarity);
    return null;
  }

  const multiplier = RARITY_MULTIPLIERS[rarity];

  // Create petal instance with rarity applied
  const petal = {
    instanceId: Math.random().toString(36).substr(2, 9), // unique instance ID
    id: petalId,
    name: def.name,
    type: def.type,
    rarity: rarity,
    icon: def.icon,
    description: def.description,
    tooltip: def.tooltip,
    quantity: 1,
    
    // Apply rarity multiplier to all numeric base values
    baseValue: def.baseValue ? def.baseValue * multiplier : undefined,
    baseDamage: def.baseDamage ? def.baseDamage * multiplier : undefined,
    baseHealth: def.baseHealth ? def.baseHealth * multiplier : undefined,
    fireRate: def.fireRate, // doesn't scale with rarity
    duration: def.duration, // doesn't scale with rarity
    
    // Metadata
    createdAt: Date.now(),
    cooldown: 0 // current cooldown in ms
  };

  return petal;
}

// Get display info for a petal (for tooltips)
function getPetalTooltip(petal) {
  let tooltip = `<div class="petal-tooltip">
    <div class="petal-name">${petal.name}</div>
    <div class="petal-rarity" style="color: ${RARITY_COLORS[petal.rarity]}">${petal.rarity}</div>
    <div class="petal-description">${petal.description}</div>`;

  // Add type-specific info
  if (petal.baseValue !== undefined) {
    tooltip += `<div class="petal-stat">Value: ${petal.baseValue.toFixed(1)}</div>`;
  }
  if (petal.baseDamage !== undefined) {
    tooltip += `<div class="petal-stat">Damage: ${petal.baseDamage.toFixed(1)}</div>`;
  }
  if (petal.baseHealth !== undefined) {
    tooltip += `<div class="petal-stat">Health: ${petal.baseHealth.toFixed(1)}</div>`;
  }

  tooltip += `</div>`;
  return tooltip;
}

// Execute petal effect
function usePetal(petal, playerState, allPlayers) {
  const now = Date.now();
  
  // Check cooldown
  if (petal.cooldown > now) {
    console.log('Petal on cooldown');
    return false;
  }

  switch (petal.type) {
    case PETAL_TYPES.HEAL:
      playerState.health = Math.min(playerState.maxHealth, playerState.health + petal.baseValue);
      petal.cooldown = now + 1000; // 1 second cooldown
      break;

    case PETAL_TYPES.CONSUMABLE:
      // Apply temporary buff
      playerState.speedMultiplier = petal.baseValue;
      petal.cooldown = now + 2000; // 2 second cooldown
      setTimeout(() => {
        playerState.speedMultiplier = 1;
      }, petal.duration);
      break;

    case PETAL_TYPES.DAMAGER:
      // Shoot damage petal (would create projectile on client/server)
      petal.cooldown = now + 800;
      return { action: 'shoot', damage: petal.baseDamage, health: petal.baseHealth };

    case PETAL_TYPES.SHOOTABLE:
      // Continuous fire (handled by client/server projectile system)
      petal.cooldown = now + petal.fireRate;
      return { action: 'shoot', damage: petal.baseDamage };

    case PETAL_TYPES.BUFF:
      // Apply temporary defense buff
      playerState.defenseMultiplier = petal.baseValue;
      petal.cooldown = now + 1500;
      setTimeout(() => {
        playerState.defenseMultiplier = 1;
      }, petal.duration);
      break;

    default:
      console.error('Unknown petal type:', petal.type);
      return false;
  }

  return true;
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PETAL_TYPES,
    PETAL_DEFINITIONS,
    RARITY_MULTIPLIERS,
    RARITY_COLORS,
    createPetal,
    getPetalTooltip,
    usePetal
  };
}
