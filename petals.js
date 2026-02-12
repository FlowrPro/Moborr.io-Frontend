// Petal system - Categories are organizational, petals are specific items

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
  bandage: {
    id: 'bandage',
    name: 'Bandage',
    category: PETAL_CATEGORIES.HEAL,
    icon: '/assets/petals/bandage.png',
    description: 'A simple healing bandage',
    healing: 20 // base healing amount at Common rarity
  },

  regeneration_orb: {
    id: 'regeneration_orb',
    name: 'Regeneration Orb',
    category: PETAL_CATEGORIES.HEAL,
    icon: '/assets/petals/regeneration_orb.png',
    description: 'Heals slowly over time',
    healing: 15,
    duration: 6000 // ms
  },

  // ============ CONSUMABLE CATEGORY ============
  speed_boost: {
    id: 'speed_boost',
    name: 'Speed Boost',
    category: PETAL_CATEGORIES.CONSUMABLE,
    icon: '/assets/petals/speed_boost.png',
    description: 'Temporarily increases movement speed',
    speedMultiplier: 1.5, // base multiplier at Common rarity
    duration: 5000 // ms
  },

  agility_potion: {
    id: 'agility_potion',
    name: 'Agility Potion',
    category: PETAL_CATEGORIES.CONSUMABLE,
    icon: '/assets/petals/agility_potion.png',
    description: 'Boosts speed and acceleration',
    speedMultiplier: 2.0,
    duration: 4000
  },

  // ============ DAMAGER CATEGORY ============
  spike: {
    id: 'spike',
    name: 'Spike',
    category: PETAL_CATEGORIES.DAMAGER,
    icon: '/assets/petals/spike.png',
    description: 'A sharp damaging spike',
    damage: 15,
    health: 25 // petal health
  },

  sharp_thorn: {
    id: 'sharp_thorn',
    name: 'Sharp Thorn',
    category: PETAL_CATEGORIES.DAMAGER,
    icon: '/assets/petals/sharp_thorn.png',
    description: 'A piercing thorn projectile',
    damage: 20,
    health: 20
  },
  // ADD YOUR NEW PETAL HERE:
fireball: {
  id: 'fireball',
  name: 'Fireball',
  category: PETAL_CATEGORIES.DAMAGER,
  icon: '/assets/petals/fireball.png',
  description: 'A burning projectile that explodes on impact',
  damage: 30,        // base damage at Common (will be multiplied by rarity)
  health: 35         // petal health/durability
},
  // ============ SHOOTABLE CATEGORY ============
  pebble_shot: {
    id: 'pebble_shot',
    name: 'Pebble Shot',
    category: PETAL_CATEGORIES.SHOOTABLE,
    icon: '/assets/petals/pebble_shot.png',
    description: 'Shoots small pebbles',
    damage: 5,
    fireRate: 600 // ms between shots
  },

  laser_beam: {
    id: 'laser_beam',
    name: 'Laser Beam',
    category: PETAL_CATEGORIES.SHOOTABLE,
    icon: '/assets/petals/laser_beam.png',
    description: 'Rapid laser fire',
    damage: 8,
    fireRate: 300
  },

  // ============ BUFF CATEGORY ============
  defense_shield: {
    id: 'defense_shield',
    name: 'Defense Shield',
    category: PETAL_CATEGORIES.BUFF,
    icon: '/assets/petals/defense_shield.png',
    description: 'Reduces incoming damage',
    defenseMultiplier: 0.7, // reduces damage by 30% (70% of damage taken)
    duration: 8000
  },

  iron_skin: {
    id: 'iron_skin',
    name: 'Iron Skin',
    category: PETAL_CATEGORIES.BUFF,
    icon: '/assets/petals/iron_skin.png',
    description: 'Hardens your body temporarily',
    defenseMultiplier: 0.5, // reduces damage by 50%
    duration: 6000
  }
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
