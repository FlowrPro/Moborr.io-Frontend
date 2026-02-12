// Petal system - Categories are organizational, petals are specific items
// This file is used by BOTH client and server

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

// Petal Categories (organizational only)
const PETAL_CATEGORIES = {
  HEAL: 'heal',
  CONSUMABLE: 'consumable',
  DAMAGER: 'damager',
  SHOOTABLE: 'shootable',
  BUFF: 'buff'
};

// ALL PETALS - Add new petals here!
// Each petal needs: id, name, category, icon path, description, and type-specific stats
const PETALS = {
  // ============ HEAL CATEGORY ============
  // Add HEAL petals here

  // ============ CONSUMABLE CATEGORY ============
  // Add CONSUMABLE petals here

  // ============ DAMAGER CATEGORY ============
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    category: PETAL_CATEGORIES.DAMAGER,
    icon: '/assets/petals/fireball.webp',
    description: 'A burning projectile that explodes on impact',
    damage: 30,        // base damage at Common (will be multiplied by rarity)
    health: 35         // petal health/durability
  },
  // Add more DAMAGER petals here

  // ============ SHOOTABLE CATEGORY ============
  // Add SHOOTABLE petals here

  // ============ BUFF CATEGORY ============
  // Add BUFF petals here
};

// Create a petal instance with rarity
function createPetal(petalId, rarity = 'Common') {
  const petalDef = PETALS[petalId];
  if (!petalDef) {
    console.error('Petal not found:', petalId);
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
    name: petalDef.name,
    category: petalDef.category,
    rarity: rarity,
    icon: petalDef.icon,
    description: petalDef.description,
    quantity: 1,
    
    // Apply rarity multiplier to numeric stats
    healing: petalDef.healing ? petalDef.healing * multiplier : undefined,
    damage: petalDef.damage ? petalDef.damage * multiplier : undefined,
    health: petalDef.health ? petalDef.health * multiplier : undefined,
    speedMultiplier: petalDef.speedMultiplier ? petalDef.speedMultiplier * multiplier : undefined,
    defenseMultiplier: petalDef.defenseMultiplier,
    fireRate: petalDef.fireRate, // doesn't scale with rarity
    duration: petalDef.duration, // doesn't scale with rarity
    
    // Metadata
    createdAt: Date.now(),
    cooldown: 0
  };

  return petal;
}

// Execute petal effect based on category
function usePetal(petal, playerState) {
  const now = Date.now();
  
  // Check cooldown
  if (petal.cooldown > now) {
    console.log('Petal on cooldown');
    return false;
  }

  switch (petal.category) {
    case PETAL_CATEGORIES.HEAL:
      // Healing petals restore health
      if (petal.healing !== undefined) {
        playerState.health = Math.min(playerState.maxHealth, playerState.health + petal.healing);
        petal.cooldown = now + 1000; // 1 second cooldown
      }
      break;

    case PETAL_CATEGORIES.CONSUMABLE:
      // Consumables apply temporary buffs
      if (petal.speedMultiplier !== undefined) {
        playerState.speedMultiplier = petal.speedMultiplier;
        petal.cooldown = now + 500;
        setTimeout(() => {
          playerState.speedMultiplier = 1;
        }, petal.duration);
      }
      break;

    case PETAL_CATEGORIES.DAMAGER:
      // Damagers shoot projectiles (would be handled by server)
      petal.cooldown = now + 800;
      return { 
        action: 'shoot', 
        damage: petal.damage, 
        health: petal.health 
      };

    case PETAL_CATEGORIES.SHOOTABLE:
      // Shootables continuously fire
      petal.cooldown = now + petal.fireRate;
      return { 
        action: 'shoot', 
        damage: petal.damage 
      };

    case PETAL_CATEGORIES.BUFF:
      // Buffs apply temporary stat boosts
      if (petal.defenseMultiplier !== undefined) {
        playerState.defenseMultiplier = petal.defenseMultiplier;
        petal.cooldown = now + 1500;
        setTimeout(() => {
          playerState.defenseMultiplier = 1;
        }, petal.duration);
      }
      break;

    default:
      console.error('Unknown petal category:', petal.category);
      return false;
  }

  return true;
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PETAL_CATEGORIES,
    PETALS,
    RARITY_MULTIPLIERS,
    RARITY_COLORS,
    createPetal,
    usePetal
  };
}
