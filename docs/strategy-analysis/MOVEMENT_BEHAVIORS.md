# Movement Behaviors System for Kassbi v4

## Overview

Kassbi now uses an intelligent **Movement Behavior System** that dynamically selects the optimal movement strategy based on combat scenario. This replaces simple "move toward" or "move away" with contextual, intelligent positioning.

## Movement Behavior Types

### 1. **RETREAT_TO_CORNER** (Defensive)
**When**: Enemy can shoot next turn, we cannot
**What**: Finds the nearest corner/obstacle away from enemy
**Why**: Minimizes incoming damage by maximizing distance to enemy and using terrain as cover

**Algorithm**:
- Scan all obstacles on the field
- Score each obstacle: `scoreAwayFromEnemy - scoreDistance * 0.1`
- Select obstacle with highest score (far from enemy, not too far from us)
- Move toward that corner

**Example**: Enemy closes in, we're out of range → retreat to nearest corner for safety

---

### 2. **AGGRESSIVE_KITING** (Offensive)
**When**: We can shoot next turn, enemy cannot
**What**: Maintains optimal distance for attack while enemy retreats
**Why**: Maximizes our damage output while minimizing enemy counterattack

**Algorithm**:
- Calculate optimal distance = (ourMaxRange + enemyMaxRange) / 2
- If distance > optimal → chase closer
- If distance < optimal - 1 → back away slightly
- Keep enemy in range while staying outside their reach

**Example**: We equip flamethrower (range 4-6), enemy has pistol (range 1-3) → maintain distance 3-4 and chase if they retreat

---

### 3. **ZONE_CONTROL** (Balanced)
**When**: Both can shoot next turn
**What**: Maintains tactical advantage zone
**Why**: Optimal damage while minimizing received damage in mutual threat

**Algorithm**:
- If distance > ourMaxRange → move closer to enter our weapon range
- If distance < enemyMaxRange → move away to exit their weapon range
- Finds the "sweet spot" where we can shoot but they cannot

**Example**: Standoff situation → position to be just outside their range while inside ours

---

### 4. **TERRAIN_AWARE** (Advanced)
**When**: Moving toward target with terrain considerations
**What**: Chooses paths that use obstacles for cover or positioning advantage
**Why**: Improves survivability by using natural cover

**Algorithm**:
- Find cells we can move to
- Prioritize cells near obstacles (within 2 cells)
- Select cell that offers cover while advancing

**Status**: API-dependent (requires Field.getObstacles())

---

### 5. **SIMPLE_ADVANCE** (Fallback)
**When**: None of the above conditions apply
**What**: Basic forward movement toward target
**Why**: Default behavior when no tactical advantage exists

---

### 6. **SIMPLE_RETREAT** (Fallback)
**When**: Defensive scenario without terrain options
**What**: Retreat directly away from enemy
**Why**: Fallback when corner-finding fails

---

## Behavior Selection Logic

The system selects behaviors in this priority order:

```typescript
if (enemyCanShoot && !iCanShoot) {
    → RETREAT_TO_CORNER (prioritize survival)
} else if (iCanShoot && !enemyCanShoot) {
    → AGGRESSIVE_KITING (pursue advantage)
} else if (iCanShoot && enemyCanShoot) {
    → ZONE_CONTROL (maintain advantage position)
} else {
    → SIMPLE_ADVANCE (close gap, prepare for combat)
}
```

## Integration with Existing Systems

### Movement During Planing
- `planMove()` now calls `getOptimalBehavior()` to select strategy
- Chooses behavior based on combat prediction (can we/enemy shoot next turn?)
- Logs chosen behavior in action description

### Retreat During Hide Phase
- `planHide()` explicitly uses `RETREAT_TO_CORNER` for defensive repositioning
- Triggered when life is low and distance is favorable for escape

### Combat Prediction Integration
- Reuses existing `predictContactNextTurn()` method
- Same distance/range logic used for behavior selection
- Coordinated with `shouldPrioritizeDefense()` and `shouldBoostAttack()`

## Configuration & Customization

### Via LeekProfile
Extend profile with behavior options:
```typescript
{
    preferredMinRange: 2,      // Influences zone control distance
    preferredMaxRange: 6,      // Influences zone control distance
    allowHiding: true,         // Enables retreat to corner
    strategyName: "BALANCED"   // Changes aggression/risk tolerance
}
```

### Direct Behavior Override
For testing specific behavior:
```typescript
// Force aggressive kiting regardless of situation
movementBehavior.executeBehavior(MOVEMENT_BEHAVIOR.AGGRESSIVE_KITING)
```

---

## Expected Combat Impact

### Pre-v4 (Simple Movement)
- Always move toward if out of range
- Always move away if too close
- No terrain consideration
- Predictable enemy response

### Post-v4 (Behavior-Based)
- **Survival**: Better corner retreats minimize damage
- **Offense**: Optimal kiting maintains range advantage
- **Adaptability**: Different behaviors for different scenarios
- **Unpredictability**: Terrain-aware positioning surprises enemies
- **Tactical**: Can trap enemies in corners (like observed in testing!)

---

## Debug Output

When a movement action is taken, the action name includes the behavior:
```
"Move [retreat_to_corner]" → Retreating to nearest safe corner
"Move [aggressive_kiting]" → Chasing with optimal distance maintenance
"Move [zone_control]" → Maintaining tactical advantage position
"Move [terrain_aware]" → Moving with terrain cover
```

---

## Future Enhancements

1. **Path Avoidance**: Remember corner locations that failed, avoid them next time
2. **Enemy Behavior Learning**: Detect if enemy is fleeing vs aggressive, adjust behavior
3. **Weapon-Specific Behaviors**: Different strategies for shotgun (close range) vs sniper (far range)
4. **Team Awareness** (if 2v2): Coordinate retreat zones with teammate
5. **Cooldown Prediction**: Account for weapon cooldowns in next-turn prediction

---

## Testing Movement Behaviors

```typescript
// Test retreat to corner
leek.distance = () => 3; // 3 cells away
enemy.canShoot = true; we.canShoot = false;
behavior = getOptimalBehavior() // → RETREAT_TO_CORNER

// Test aggressive kiting
leek.distance = () => 4; // 4 cells away
enemy.canShoot = false; we.canShoot = true;
behavior = getOptimalBehavior() // → AGGRESSIVE_KITING

// Test zone control
leek.distance = () => 3;
enemy.canShoot = true; we.canShoot = true;
behavior = getOptimalBehavior() // → ZONE_CONTROL
```

---

## Key Files Modified

- **MovementBehavior.ts**: New system with 6 behaviors
- **Plannification.ts** (v3→v4): Integrates MovementBehavior in planMove() and planHide()
- **ChangeLog.md**: Documents v4 release

---

## Versioning

- LeekScript @version: 5.8
- MovementBehavior file version: 1 (new)
- Plannification file version: 4 (behavior integration)

