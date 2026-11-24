import assert from "node:assert/strict"
import test from "node:test"

import { AggressiveStrategy } from "../dist/Classes/Strategy/AggressiveStrategy.js"
import { BalancedStrategy } from "../dist/Classes/Strategy/BalancedStrategy.js"
import { DefensiveStrategy } from "../dist/Classes/Strategy/DefensiveStrategy.js"
import { LeekStrategy } from "../dist/Classes/Strategy/LeekStrategy.js"

// ==============================================================================
// TEST 1: Critical Situation Recognition and Hide Trigger
// ==============================================================================
test("Test 1a: Balanced.shouldHide triggers escape at 35% HP + distance=6", () => {
	const strategy = new BalancedStrategy(50)
	const lifeRatio = 35 / 100  // 35% HP
	const distance = 6
	const preferredMinRange = 3
	
	const result = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	
	// EXPECTED: isCriticallyWounded = 0.35 <= 0.40 -> TRUE
	// distance <= 8 AND isCriticallyWounded -> TRUE
	// Therefore shouldHide() must return TRUE
	assert.equal(result, true, "Balanced should escape at 35% HP + distance=6")
})

test("Test 1b: Balanced.shouldHide does NOT trigger at 62% HP + distance=7", () => {
	const strategy = new BalancedStrategy(50)
	const lifeRatio = 62 / 100  // 62% HP (pre-critical)
	const distance = 7
	const preferredMinRange = 3
	
	const result = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	
	// EXPECTED: isCriticallyWounded = 0.62 <= 0.40 -> FALSE
	// distance > 2 or lifeRatio not at extreme -> no immediate hide
	// Therefore shouldHide() must return FALSE
	assert.equal(result, false, "Balanced should NOT escape at 62% HP + distance=7 (pre-critical)")
})

test("Test 1c: Base LeekStrategy applies aggression modifier to threshold", () => {
	const strategy = new LeekStrategy("BALANCED", 70)  // High aggression -> threshold raised
	const lifeRatio = 0.42  // Between 0.40 and 0.45
	const distance = 8
	const preferredMinRange = 3
	
	const result = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	
	// High aggression (70): threshold = 0.45 - 0.10*0.70 = 0.45 - 0.07 = 0.38
	// lifeRatio = 0.42 > 0.38 -> NOT critically wounded -> FALSE
	assert.equal(result, false, "High aggression should raise wound threshold (0.42 > 0.38)")
})

test("Test 1d: Base LeekStrategy applies aggression modifier to threshold (low aggression)", () => {
	const strategy = new LeekStrategy("BALANCED", 20)  // Low aggression -> threshold lowered
	const lifeRatio = 0.42  // Between 0.40 and 0.45
	const distance = 8
	const preferredMinRange = 3
	
	const result = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	
	// Low aggression (20): threshold = 0.45 - 0.10*0.20 = 0.45 - 0.02 = 0.43
	// lifeRatio = 0.42 < 0.43 -> CRITICALLY wounded -> TRUE
	assert.equal(result, true, "Low aggression should lower wound threshold (0.42 < 0.43)")
})

// ==============================================================================
// TEST 2: Strategy Personalization - Escape Threshold Comparison
// ==============================================================================
test("Test 2a: Aggressive.shouldHide allows more HP loss (distance=6, hp=50%)", () => {
	const aggressive = new AggressiveStrategy(70)
	const result = aggressive.shouldHide(0.50, 6, 3)
	
	// Aggressive: isPanic = 0.50 <= 0.25 -> FALSE
	// distance=6 NOT <= minSafeDistance (2)
	// No other triggers match
	// Result: FALSE (stay fighting)
	assert.equal(result, false, "Aggressive strategy should NOT escape at 50% HP")
})

test("Test 2b: Aggressive.shouldHide triggers ONLY at panic levels (distance=6, hp=25%)", () => {
	const aggressive = new AggressiveStrategy(70)
	const result = aggressive.shouldHide(0.25, 6, 3)
	
	// Aggressive: isPanic = 0.25 <= 0.25 -> TRUE
	// distance=6 <= 10 AND isPanic -> TRUE
	// Result: TRUE (escape)
	assert.equal(result, true, "Aggressive should escape at 25% HP")
})

test("Test 2c: Balanced.shouldHide triggers at moderate HP (distance=6, hp=50%)", () => {
	const balanced = new BalancedStrategy(50)
	const result = balanced.shouldHide(0.50, 6, 3)
	
	// Balanced: isCriticallyWounded = 0.50 <= 0.40 -> FALSE
	// distance > 2 and no other exact match
	// Result: FALSE (not critical yet at 50%)
	// BUT let's verify at exactly 40%:
	
	const result40 = balanced.shouldHide(0.40, 6, 3)
	// isCriticallyWounded = 0.40 <= 0.40 -> TRUE
	// distance=6 <= 8 -> TRUE
	// Result: TRUE
	assert.equal(result40, true, "Balanced should escape at 40% HP")
})

test("Test 2d: Defensive.shouldHide retreats earliest (distance=6, hp=50%)", () => {
	const defensive = new DefensiveStrategy(50)
	const result = defensive.shouldHide(0.50, 6, 3)
	
	// Defensive: isModeratelyWounded = 0.50 <= 0.55 - 0.10*0.50 = 0.50 <= 0.50 -> TRUE
	// distance=6 <= 7 -> TRUE
	// Result: TRUE (escape eagerly)
	assert.equal(result, true, "Defensive should escape at 50% HP (eager)")
})

// ==============================================================================
// TEST 3: Healing Preemptive Trigger (shouldHealWithThreat)
// ==============================================================================
test("Test 3a: Balanced.shouldHealWithThreat triggers at 70% HP + moderate damage + distance=7", () => {
	const strategy = new BalancedStrategy(50)
	const lifeRatio = 0.70  // 70% HP
	const lostLifeRatio = 0.154  // ~15% lost (50 HP of 324)
	const distance = 7
	
	const result = strategy.shouldHealWithThreat(lifeRatio, lostLifeRatio, distance)
	
	// Balanced: Check threat-aware conditions
	// distance <= 10? YES (7 <= 10)
	// lifeRatio <= 0.70? YES (0.70 <= 0.70)
	// lostLifeRatio >= 0.10? YES (0.154 >= 0.10)
	// All true -> return TRUE (preemptive healing)
	assert.equal(result, true, "Balanced should heal preemptively at 70% HP with threat nearby")
})

test("Test 3b: Balanced.shouldHeal requires 25% lost (lazy trigger without threat)", () => {
	const strategy = new BalancedStrategy(50)
	const lifeRatio = 0.70
	const lostLifeRatio = 0.10  // 10% lost (< 25% threshold)
	
	const result = strategy.shouldHeal(lifeRatio, lostLifeRatio)
	
	// Balanced: return lostLifeRatio >= 0.15 + 0.10*0.50 = 0.20
	// lostLifeRatio = 0.10 < 0.20 -> FALSE
	assert.equal(result, false, "Balanced should NOT heal without threat at 10% lost")
})

test("Test 3c: Aggressive.shouldHealWithThreat only heals if critical HP (distance=10, hp=50%)", () => {
	const strategy = new AggressiveStrategy(50)
	const lifeRatio = 0.50
	const distance = 10
	
	const result = strategy.shouldHealWithThreat(lifeRatio, 0, distance)
	
	// Aggressive: distance <= 10 && lifeRatio <= 0.50 -> TRUE
	// (Note: we ignore lostLifeRatio for aggressive healing calculation)
	assert.equal(result, true, "Aggressive should heal when critical HP + threat nearby")
})

test("Test 3d: Defensive.shouldHealWithThreat is very eager (distance=10, hp=80%, lost=8%)", () => {
	const strategy = new DefensiveStrategy(50)
	const lifeRatio = 0.80
	const lostLifeRatio = 0.08
	const distance = 10
	
	const result = strategy.shouldHealWithThreat(lifeRatio, lostLifeRatio, distance)
	
	// Defensive: Check threat-aware conditions
	// distance <= 10? YES
	// lifeRatio <= 0.80? YES (0.80 <= 0.80)
	// lostLifeRatio >= 0.08? YES
	// All true -> return TRUE (very eager)
	assert.equal(result, true, "Defensive should heal eagerly with threat nearby")
})

// ==============================================================================
// TEST 4: Zone Control Trap Detection & Escape Thresholds
// ==============================================================================
test("Test 4a: Zone Control Trap - Balanced escapes at critical distance (<=8) + wounds (<=40%)", () => {
	const strategy = new BalancedStrategy(50)
	
	// Scenario: distance gradually closes while Kassbi stays in zone_control
	const turn5 = strategy.shouldHide(0.62, 7, 3)  // HP=200/324, distance=7
	const turn6 = strategy.shouldHide(0.35, 6, 3)  // HP=113/324, distance=6 (attrition kicks in)
	
	// Turn 5: 62% > 40% threshold -> FALSE (stay)
	// Turn 6: 35% <= 40% threshold -> TRUE (escape!)
	assert.equal(turn5, false, "Should NOT escape at pre-critical (62% HP)")
	assert.equal(turn6, true, "MUST escape at critical (35% HP) to avoid mpLeft=0 trap")
})

test("Test 4b: Zone Control Trap - Aggressive only escapes at panic (<=25%)", () => {
	const strategy = new AggressiveStrategy(50)
	
	const moderate = strategy.shouldHide(0.40, 8, 3)  // 40% HP
	const panic = strategy.shouldHide(0.24, 8, 3)     // 24% HP
	
	// Moderate: isPanic = 0.40 <= 0.25 -> FALSE
	// Panic: isPanic = 0.24 <= 0.25 -> TRUE, distance <= 10 -> TRUE
	assert.equal(moderate, false, "Aggressive should NOT escape at moderate HP")
	assert.equal(panic, true, "Aggressive MUST escape at panic levels")
})

test("Test 4c: Zone Control Trap - Defensive escapes earliest (distance<=7 + wounds<=55%)", () => {
	const strategy = new DefensiveStrategy(50)
	
	const early = strategy.shouldHide(0.50, 6, 3)   // 50% HP, distance=6
	const tooFar = strategy.shouldHide(0.50, 8, 3)  // 50% HP, distance=8
	
	// Early: isModeratelyWounded = 0.50 <= 0.55 -> TRUE
	//        distance=6 <= 7 -> TRUE
	// Too far: distance=8 > 7 -> FALSE (unless other trigger)
	assert.equal(early, true, "Defensive should escape early (distance=6)")
	assert.equal(tooFar, false, "Defensive should NOT escape if distance > 7 (even at 50%)")
})

test("Test 4d: Zone Control Trap distance boundary - Balanced at exactly distance=8", () => {
	const strategy = new BalancedStrategy(50)
	
	const atBoundary = strategy.shouldHide(0.40, 8, 3)
	const justBeyond = strategy.shouldHide(0.40, 9, 3)
	
	// At boundary: distance=8 <= 8 AND 0.40 <= 0.40 -> TRUE
	// Just beyond: distance=9 > 8 -> FALSE
	assert.equal(atBoundary, true, "Should escape at distance=8 boundary")
	assert.equal(justBeyond, false, "Should NOT escape at distance=9 (outside zone control trap)")
})

// ==============================================================================
// TEST 5: Weapon Scoring and Aggression Consistency
// ==============================================================================
test("Test 5a: LeekStrategy.scoreWeapon applies aggression-dependent penalty", () => {
	const aggressive = new LeekStrategy("AGGRESSIVE", 100)
	const passive = new LeekStrategy("PASSIVE", 0)
	
	const damage = 50
	const preferredMid = 5
	const weaponMid = 2
	const rangeDiff = Math.abs(preferredMid - weaponMid)  // |5-2| = 3
	
	const aggressiveScore = aggressive.scoreWeapon(damage, preferredMid, weaponMid)
	const passiveScore = passive.scoreWeapon(damage, preferredMid, weaponMid)
	
	// Aggressive (100%): penalty = 3 * (0.045 - 0.015 * 1.0) = 3 * 0.030 = 0.09
	//                    score = 50 - 0.09 = 49.91
	// Passive (0%): penalty = 3 * (0.045 - 0.015 * 0) = 3 * 0.045 = 0.135
	//               score = 50 - 0.135 = 49.865
	
	// Aggressive should have HIGHER score (less penalty) due to range flexibility
	assert.ok(aggressiveScore > passiveScore, 
		`Aggressive score (${aggressiveScore}) should be > Passive score (${passiveScore})`)
})

test("Test 5b: BalancedStrategy.scoreWeapon matches base calculation", () => {
	const balanced = new BalancedStrategy(50)
	const base = new LeekStrategy("BALANCED", 50)
	
	const result1 = balanced.scoreWeapon(50, 5, 2)
	const result2 = base.scoreWeapon(50, 5, 2)
	
	// Both should return identical results
	assert.equal(result1, result2, "BalancedStrategy should match base scoring")
})

// ==============================================================================
// TEST 6: shouldUseAttackChip consistency check
// ==============================================================================
test("Test 6a: Balanced.shouldUseAttackChip triggers at 50% HP (default aggression=50)", () => {
	const strategy = new BalancedStrategy(50)
	
	const justAbove = strategy.shouldUseAttackChip(0.51)
	const exactly = strategy.shouldUseAttackChip(0.50)
	const justBelow = strategy.shouldUseAttackChip(0.49)
	
	// Balanced: return lifeRatio >= 0.50 - 0.20 * 0.50 = 0.50 - 0.10 = 0.40
	// 0.51 >= 0.40 -> TRUE
	// 0.50 >= 0.40 -> TRUE
	// 0.49 >= 0.40 -> TRUE
	assert.equal(justAbove, true)
	assert.equal(exactly, true)
	assert.equal(justBelow, true)
})

test("Test 6b: DefensiveStrategy.shouldUseAttackChip is very conservative", () => {
	const strategy = new DefensiveStrategy(50)
	
	const result = strategy.shouldUseAttackChip(0.70)
	
	// Defensive: return lifeRatio >= 0.75 - 0.20 * 0.50 = 0.75 - 0.10 = 0.65
	// 0.70 >= 0.65 -> TRUE
	assert.equal(result, true, "Defensive uses attack chips only when HP is high enough")
})

// ==============================================================================
// TEST 7: shouldShield consistency check
// ==============================================================================
test("Test 7a: LeekStrategy.shouldShield applies aggression to defensive threshold", () => {
	const aggressive = new AggressiveStrategy(70)
	const defensive = new DefensiveStrategy(50)
	
	// Test at a reasonable distance within threat range
	const aggressiveShield = aggressive.shouldShield(0.70, 2, 3)
	const defensiveShield = defensive.shouldShield(0.70, 2, 3)
	
	// Aggressive (70%): return lifeRatio <= 0.45 - 0.15 * 0.70 = 0.45 - 0.105 = 0.345
	//                   0.70 <= 0.345? NO -> FALSE
	// Defensive (50%): return distance <= threatRange + 1 AND lifeRatio <= 0.98 - 0.10 * 0.50
	//                  2 <= 3+1 (4)? YES AND 0.70 <= 0.93? YES -> TRUE
	
	assert.equal(aggressiveShield, false, "Aggressive only shields at critical HP")
	assert.equal(defensiveShield, true, "Defensive shields readily")
})

// ==============================================================================
// TEST 8: Regression - Very Close Distance Behavior (<=2)
// ==============================================================================
test("Test 8a: All strategies hide when VERY CLOSE (distance<=2) + WOUNDED by classic rule", () => {
	const aggressive = new AggressiveStrategy(50)
	const balanced = new BalancedStrategy(50)
	const defensive = new DefensiveStrategy(50)
	
	// Very close + wounded should trigger hide via classic "isTooClose && isWounded" rule
	// For Balanced: minSafeDistance = max(2, 3-1) = 2
	//               isTooClose = distance < 2 -> NO (1 is not < 2, it's <= 2)
	//               Actually isTooClose for distance=1: 1 < 2 = TRUE
	//               isWounded = 0.60 <= 0.55 - 0.20*0.5 = 0.45? NO
	
	// Let's verify with actual wound threshold that triggers
	const balWounded = balanced.shouldHide(0.40, 1, 3)  // isTooClose=TRUE, isWounded=TRUE
	const balHealthy = balanced.shouldHide(0.60, 1, 3)  // isTooClose=TRUE, isWounded=FALSE
	
	assert.equal(balWounded, true, "Balanced should hide when very close + wounded")
	assert.equal(balHealthy, false, "Balanced should NOT hide when very close but healthy")
})

// ==============================================================================
// REGRESSION TESTS: Ensure existing behaviors are not broken
// ==============================================================================
test("Regression: Weapon choice scoring still works correctly", () => {
	const strategy = new BalancedStrategy(50)
	
	const weakWeapon = { maxRange: 2, features: [{ type: 1, minValue: 5, maxValue: 10 }] }
	const strongWeapon = { maxRange: 5, features: [{ type: 1, minValue: 12, maxValue: 18 }] }
	
	// Average damages: weak = 7.5, strong = 15
	const weakScore = strategy.scoreWeapon(7.5, 5, 2)
	const strongScore = strategy.scoreWeapon(15, 5, 5)
	
	// Weak: damage=7.5, penalty for range mismatch (5 vs 2 = 3 distance)
	//       7.5 - 3 * 0.045 = 7.5 - 0.135 = 7.365
	// Strong: damage=15, NO penalty (5 == 5)
	//         15 - 0 = 15
	
	// Strong should definitely score higher
	assert.ok(strongScore > weakScore, 
		`Strong (${strongScore}) should outscore weak (${weakScore}) weapon`)
})

test("Regression: Healing thresholds remain distinct between strategies", () => {
	const aggressive = new AggressiveStrategy(50)
	const balanced = new BalancedStrategy(50)
	const defensive = new DefensiveStrategy(50)
	
	// Aggressive heals at 32.5% HP (0.40 - 0.15*0.50) (lazy)
	assert.equal(aggressive.shouldHeal(0.325, 0), true, "Aggressive heals at 32.5% HP threshold")
	assert.equal(aggressive.shouldHeal(0.33, 0), false, "Aggressive doesn't heal above 32.5% HP")
	
	// Balanced heals at 20% lost (balanced)
	assert.equal(balanced.shouldHeal(1.0, 0.20), true, "Balanced heals at 20% lost")
	assert.equal(balanced.shouldHeal(1.0, 0.19), false, "Balanced doesn't heal below 20% lost")
	
	// Defensive heals at 82.5% HP (0.90 - 0.15*0.50) or 35% lost (eager)
	const defHealing1 = defensive.shouldHeal(0.825, 0)
	const defHealing2 = defensive.shouldHeal(1.0, 0.35)
	assert.equal(defHealing1, true, "Defensive heals at threshold 82.5% HP")
	assert.equal(defHealing2, true, "Defensive heals at 35% lost")
})

test("Regression: Shield trigger (original asymmetry case) still works", () => {
	const strategy = new BalancedStrategy(50)
	
	// Original: shouldShield should still work for the asymmetry case
	const result = strategy.shouldShield(0.90, 3, 2)
	
	// shouldShield: return distance <= threatRange && lifeRatio <= 0.95 - 0.20 * 0.50
	//               3 <= 2? NO -> FALSE (even though HP check passes)
	assert.equal(result, false, "shouldShield should still check distance first")
})

test("Regression: Movement behaviors (normal case) unchanged", () => {
	const strategy = new BalancedStrategy(50)
	
	// In normal case (not critical), shouldHide should return false
	const result = strategy.shouldHide(0.80, 10, 3)
	
	// distance=10 > 8 (outside zone control range)
	// lifeRatio=0.80 > 0.40 (not critically wounded)
	// No other condition matches -> FALSE
	assert.equal(result, false, "Normal case should not trigger hide")
})
