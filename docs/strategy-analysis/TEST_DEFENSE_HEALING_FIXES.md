# 🧪 TEST SUITE: Defense/Heal/Hide Bug Fixes

**Purpose**: Validate all 3 fixes through manual test cases  
**Status**: Ready for execution  
**Estimated Runtime**: ~5 minutes

---

## ✅ TEST #1: shouldPrioritizeDefense() - Mutual Contact + 60% HP

### Scenario Setup
```typescript
const scenario = {
  distance: 1,
  kassbiMaxHP: 329,
  kassbiCurrentHP: 197,  // 59.9% ≈ 60%
  kassbiWeapon: { maxRange: 6 },
  kaineWeapon: { maxRange: 6 },
  kassbiMP: 0,  // No move left
  kaineMP: 0    // No move left
}
```

### Expected Behavior

**OLD (Binary Logic)**:
```
iCanShoot = (distance - mpLeft <= maxRange) = (1 - 0 <= 6) = true
enemyCanShoot = (distance - enemyMP <= enemyMaxRange) = (1 - 0 <= 6) = true
shouldDefense = enemyCanShoot && !iCanShoot = true && !true = FALSE ❌
```

**NEW (Context-Aware)**:
```
Asymmetry: enemyCanShoot && !iCanShoot = true && false = FALSE
Mutual Contact: enemyCanShoot && iCanShoot && lifeRatio <= 0.60
                = true && true && (197/329 <= 0.60)
                = true && true && (0.599 <= 0.60)
                = TRUE ✅
Result: FALSE || TRUE = TRUE ✅ [DEFENSE ENABLED]
```

### Validation Steps

1. **Execute Kassbi turn at distance=1, HP=197**
2. **Check log**: `[Plannification] ChipsAfterShoot: shouldDefense=true`
3. **Verify**: Shield chip is used (not skipped)
4. **Confirm**: Defense takes priority over healing

### Expected Log Output
```
[Plannification] PredictContactNextTurn: distance=1, myMaxReach=1, myMaxRange=6, iCanShoot=true, enemyMaxReach=1, enemyMaxRange=6, enemyCanShoot=true
[Plannification] ChipsAfterShoot: life=0.60, lifeLost=0.40, shouldDefense=true, shouldOffense=false
[Plannification] Shield (defense priority): [chip name]
```

### Pass Criteria
- ✅ `shouldDefense` = true
- ✅ Shield chip applied
- ✅ Healing delayed (defense first)

---

## ✅ TEST #2: shouldHeal() - Threat-Aware Healing (Tour 5 Scenario)

### Scenario Setup (Balanced Strategy)
```typescript
const scenario = {
  strategy: "BALANCED",
  aggression: 50,
  distance: 5,
  kassbiMaxHP: 326,
  kassbiCurrentHP: 253,  // 77.6% (not 71% but realistic)
  lifeLost: 73,          // 22.4% of maxLife
  bandageAvailable: true,
  tpLeft: 20
}
```

### Expected Behavior

**OLD (Threshold Only)**:
```
baseThreshold = 0.15 + 0.10 * (50/100) = 0.25
shouldHeal = lostLifeRatio >= 0.25
           = (73/326 >= 0.25)
           = (0.224 >= 0.25)
           = FALSE ❌ [NO HEAL]
```

**NEW (Threat-Aware)**:
```
Check 1: shouldHeal() = 0.224 >= 0.25 = FALSE
Check 2: shouldHealWithThreat() = 
  distance(5) <= 10 AND lifeRatio(77.6%) <= 70% AND lostRatio(22.4%) >= 10%
  = true AND false AND true
  = FALSE (HP just above threshold)

BUT if HP drops 1 point (77.5% → 76%):
Check 2: shouldHealWithThreat() = 
  distance(5) <= 10 AND lifeRatio(76%) <= 70% AND lostRatio(22.4%) >= 10%
  = true AND false AND true
  = FALSE (still too high)

BUT if HP drops to 70.0%:
Check 2: shouldHealWithThreat() = 
  distance(5) <= 10 AND lifeRatio(70%) <= 70% AND lostRatio(22.4%) >= 10%
  = true AND true AND true
  = TRUE ✅ [HEAL ENABLED] (1 HP triggers threshold!)
```

### Validation Steps

1. **Set Kassbi HP to 253 (77.6%), distance=5**
2. **Execute turn**
3. **Check log**: Should NOT heal (22.4% < 25%)
4. **Gradually reduce HP to 228 (70%)**
5. **Execute turn at distance=5**
6. **Check log**: Should HEAL (threat-aware trigger)

### Expected Log Output (at HP=228, distance=5)
```
[Plannification] ChipsAfterShoot: life=0.70, lifeLost=0.30, shouldDefense=false, shouldOffense=false
[Plannification] Heal: bandage (healing=XX, meanDamagePerTp=X.XX, skip=false, distance=5, threat-aware=true)
```

### Pass Criteria
- ✅ At lostRatio=22.4%, distance=5: NO heal (base check)
- ✅ At lifeRatio=70%, distance=5: YES heal (threat-aware)
- ✅ Log shows `threat-aware=true`

---

## ✅ TEST #3: shouldHide() - Preemptive Retreat (Tour 5 Scenario)

### Scenario Setup (Balanced Strategy)
```typescript
const scenario = {
  strategy: "BALANCED",
  aggression: 50,
  distance: 2,
  kassbiMaxHP: 326,
  kassbiCurrentHP: 228,  // 70% HP exactly
  preferredMinRange: 1,
  allowHiding: true,
  mpLeft: 4
}
```

### Expected Behavior

**OLD (AND Logic)**:
```
minSafeDistance = max(2, 1-1) = 2
isTooClose = distance(2) < 2 = FALSE
isWounded = lifeRatio(70%) <= 0.55 - 0.20*(50/100) = lifeRatio <= 0.45 = FALSE
shouldHide = FALSE && FALSE = FALSE ❌ [NO RETREAT]
```

**NEW (OR Logic with Preemptive)**:
```
Check 1: isTooClose && isWounded = FALSE && FALSE = FALSE

Check 2: distance <= 2 && lifeRatio <= 0.70
         = 2 <= 2 && 70% <= 70%
         = TRUE && TRUE
         = TRUE ✅ [RETREAT ENABLED]

Result: FALSE || TRUE = TRUE ✅ [HIDE NOW]
```

### Validation Steps

1. **Set Kassbi distance=2, HP=228 (70%)**
2. **Execute turn**
3. **Check log**: `shouldHide=true`
4. **Verify**: Movement action is "Smart Retreat" (RETREAT_TO_CORNER)
5. **Confirm**: MP is set to 0 (all MP used for retreat)

### Expected Log Output
```
[Plannification] HideCheck: distance=2, lifeRatio=0.70, shouldHide=true
[Plannification] Hide: retreat to corner
[Plannification] Move: distance=2, behavior=retreat_to_corner, mpLeft=4 → 0
```

### Pass Criteria
- ✅ `shouldHide` = true (at distance=2, lifeRatio=70%)
- ✅ Movement behavior is RETREAT_TO_CORNER
- ✅ mpLeft set to 0 (no other moves possible)

---

## 🎭 STRATEGY-SPECIFIC TEST CASES

### Aggressive Strategy

#### Test A: shouldHealWithThreat (Aggressive)
```
Condition: distance <= 10 AND lifeRatio <= 50%
Scenario: distance=5, HP=50%, lifeLost=15%
├─ Distance(5) <= 10? YES
├─ Life(50%) <= 50%? YES  
├─ Result: TRUE ✅ [HEAL IN EMERGENCY]
```

#### Test B: shouldHide (Aggressive)
```
Preemptive: distance <= 1 AND lifeRatio <= 50%
Scenario: distance=1, HP=50%
├─ Distance(1) <= 1? YES
├─ Life(50%) <= 50%? YES
├─ Result: TRUE ✅ [EXTREME RETREAT]

Scenario: distance=2, HP=50%
├─ Distance(2) <= 1? NO
├─ Result: FALSE ❌ [NO RETREAT AT d=2] (more aggressive)
```

### Defensive Strategy

#### Test C: shouldHealWithThreat (Defensive)
```
Condition: distance <= 10 AND lifeRatio <= 80% AND lifeLost >= 8%
Scenario: distance=5, HP=80%, lifeLost=8%
├─ Distance(5) <= 10? YES
├─ Life(80%) <= 80%? YES
├─ Damage(8%) >= 8%? YES
├─ Result: TRUE ✅ [EAGER HEAL]
```

#### Test D: shouldHide (Defensive)
```
Preemptive: distance <= 2 AND lifeRatio <= 75%
Scenario: distance=2, HP=75%
├─ Distance(2) <= 2? YES
├─ Life(75%) <= 75%? YES
├─ Result: TRUE ✅ [EAGER RETREAT]

Scenario: distance=2, HP=76%
├─ Distance(2) <= 2? YES
├─ Life(76%) <= 75%? NO
├─ Result: FALSE ❌ [1% over threshold]
```

---

## 🔧 Automated Test Code (TypeScript)

```typescript
// Test framework pseudo-code
class DefenseHealingFixTests {
  
  testMutualContactDefense() {
    const p = new Plannification(mockLeek, mockEnemy, profile)
    p.chosenWeapon = { maxRange: 6 }
    // Set distance=1, HP=0.60
    expect(p.shouldPrioritizeDefense()).toBe(true)
  }

  testThreatAwareHealing() {
    const strategy = new BalancedStrategy(50)
    // Test 1: threshold miss
    expect(strategy.shouldHeal(0.70, 0.224)).toBe(false)
    // Test 2: threat-aware catch
    expect(strategy.shouldHealWithThreat(0.70, 0.224, 5)).toBe(true)
  }

  testPreemptiveHide() {
    const strategy = new BalancedStrategy(50)
    // Test 1: old logic fails
    expect(strategy.shouldHide(0.70, 2, 1)).toBe(true) // NEW: should be true
    // Test 2: edge case at threshold
    expect(strategy.shouldHide(0.709, 2, 1)).toBe(true) // just at boundary
  }

  testAggressivePersonality() {
    const agg = new AggressiveStrategy(100)
    // Less eager to heal/hide
    expect(agg.shouldHealWithThreat(0.60, 0.15, 5)).toBe(false) // Not < 50%
    expect(agg.shouldHide(0.60, 2, 1)).toBe(false) // Need d=1
  }

  testDefensivePersonality() {
    const def = new DefensiveStrategy(50)
    // More eager to heal/hide
    expect(def.shouldHealWithThreat(0.80, 0.08, 5)).toBe(true) // Eager threshold
    expect(def.shouldHide(0.75, 2, 1)).toBe(true) // Higher HP threshold
  }
}
```

---

## 📊 Test Results Template

| Test # | Scenario | Expected | Actual | Status |
|--------|----------|----------|--------|--------|
| 1.1 | Mutual contact, HP=60% | shouldDefense=true | ? | ? |
| 2.1 | Threat-aware, HP=70%, d=5 | shouldHeal=true | ? | ? |
| 3.1 | Preemptive hide, d=2, HP=70% | shouldHide=true | ? | ? |
| A.1 | Aggressive heal emergency | shouldHeal=true @ HP=50% | ? | ? |
| B.1 | Aggressive hide extreme | shouldHide=false @ d=2, HP=50% | ? | ? |
| C.1 | Defensive eager heal | shouldHeal=true @ HP=80% | ? | ? |
| D.1 | Defensive eager hide | shouldHide=true @ d=2, HP=75% | ? | ? |

---

## 🎯 Real Combat Test: Kassbi vs Kaine111 Rematch

**Objective**: Compare survival metrics before/after fix

### Measurement Points

**Before Fix** (from logs):
```
Tour 4: HP = 303 (92%)
Tour 5: HP = 253 (71%) ← No heal, no hide → VULNERABLE
Tour 6: HP = 226 (39%) ← Finally heal/hide → TOO LATE
Final: Kassbi defeated
```

**After Fix** (expected):
```
Tour 4: HP = 303 (92%) [same]
Tour 5: HP = 275 (84%) ← HEALED + HIDDEN → SAFER
Tour 6: HP = 265 (81%) ← Maintained distance → STRONGER
...
Tour 10+: Kassbi survives longer (?)
```

### Success Criteria
- ✅ Healing triggered at Tour 5 (before Tour 6)
- ✅ Hiding triggered at Tour 5 (before Tour 6)
- ✅ HP preservation improved by >10%
- ✅ Combat extends 2+ additional turns
- ✅ No new errors in logs

---

## ⏱️ Execution Checklist

- [ ] Create test environment (mock Leek, Enemy entities)
- [ ] Run Test #1 (Mutual Contact Defense)
- [ ] Run Test #2 (Threat-Aware Healing)
- [ ] Run Test #3 (Preemptive Hide)
- [ ] Run Strategy-Specific Tests (A-D)
- [ ] Run Combat Rematch (Kassbi vs Kaine111)
- [ ] Review all logs for `threat-aware=true` and preemptive triggers
- [ ] Compare HP preservation metrics
- [ ] Document results
- [ ] Sign off on deployment

---

## 📝 Notes for Test Execution

1. **Logs should contain**:
   - `shouldDefense=true` for mutual contact @ 60% HP
   - `threat-aware=true` in Heal logs when distance≤10
   - `shouldHide=true` for preemptive case (d=2, HP≤70%)

2. **No regression expected**:
   - Healthy phases (tours 1-3) should behave identically
   - Extreme damage cases should still work
   - Different strategies should maintain personalities

3. **Ops cost verification**:
   - Measure turn duration before/after
   - Should not exceed +1-2ms per turn

---

**Status**: 🟢 READY FOR EXECUTION

All 3 bugs have clear, measurable test cases with expected outcomes.
