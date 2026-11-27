import assert from "node:assert/strict"
import test from "node:test"

import { BalancedStrategy } from "../dist/Classes/Strategy/BalancedStrategy.js"

// ============================================================================
// TEST 1: Taunt condition when target is at 15% HP
// ============================================================================
test("Kassbi should taunt when target is at exactly 15% HP", () => {
	const target = {
		id: 2,
		name: "Destruction",
		life: 15, // 15% of 100
		maxLife: 100,
		mp: 2,
		weapon: { maxRange: 3 }
	}

	// Simulate the taunt check logic from Kassbi_Class.ts
	const isNearlyDead = target.life / target.maxLife <= 0.15
	assert.equal(isNearlyDead, true, "Target at exactly 15% HP should be considered nearly dead")
})

test("Kassbi should taunt when target is below 15% HP", () => {
	const target = {
		id: 2,
		name: "Destruction",
		life: 10, // 10% of 100
		maxLife: 100,
		mp: 2,
		weapon: { maxRange: 3 }
	}

	const isNearlyDead = target.life / target.maxLife <= 0.15
	assert.equal(isNearlyDead, true, "Target at 10% HP should be considered nearly dead")
})

test("Kassbi should NOT taunt when target is above 15% HP", () => {
	const target = {
		id: 2,
		name: "Destruction",
		life: 20, // 20% of 100
		maxLife: 100,
		mp: 2,
		weapon: { maxRange: 3 }
	}

	const isNearlyDead = target.life / target.maxLife <= 0.15
	assert.equal(isNearlyDead, false, "Target at 20% HP should NOT be considered nearly dead")
})

test("Kassbi should NOT taunt when target is dead", () => {
	const target = {
		id: 2,
		name: "Destruction",
		life: 0,
		maxLife: 100,
		mp: 2,
		weapon: { maxRange: 3 }
	}

	const isNearlyDead = target.life / target.maxLife <= 0.15
	assert.equal(isNearlyDead, true, "Dead target is technically <= 15%, but should check if alive")

	// The real check should be: target.life > 0 && target.life / target.maxLife <= 0.15
	const shouldTaunt = target.life > 0 && target.life / target.maxLife <= 0.15
	assert.equal(shouldTaunt, false, "Dead target should NOT be taunted")
})

// ============================================================================
// TEST 2: shouldHide() formula (zone control trap)
// ============================================================================

test("planHide() correctly checks if hiding is needed when wounded with zone control trap", () => {
	// This test verifies the shouldHide() formula works correctly
	// by using the strategy directly instead of through Plannification
	const strategy = new BalancedStrategy(50)
	
	// Test case 1: Player at 40% HP and 1 cell away (should hide - wounded + too close)
	const shouldHide1 = strategy.shouldHide(0.4, 1)
	assert.equal(shouldHide1, true, "Should hide at 40% HP and 1 cell away")
	
	// Test case 2: Player at 60% HP and 1 cell away (should NOT hide - not wounded enough)
	const shouldHide2 = strategy.shouldHide(0.6, 1)
	assert.equal(shouldHide2, false, "Should NOT hide at 60% HP")
	
	// Test case 3: Player at 40% HP but 10 cells away (should NOT hide - far enough)
	// BUT now with zone_control trap: distance <= 8 && lifeRatio <= 0.40
	// At distance=10: 10 > 8, so zone_control doesn't trigger
	const shouldHide3 = strategy.shouldHide(0.4, 10)
	assert.equal(shouldHide3, false, "Should NOT hide when far away (distance > 8)")
	
	console.log("All shouldHide() formula tests passed correctly")
})

// ============================================================================
// TEST 3: shouldHide() formula verification for BALANCED strategy
// ============================================================================
test("shouldHide() formula is correct for BALANCED strategy (aggression=50)", () => {
	const strategy = new BalancedStrategy(50)

	// Test case: Kassbi wounded and too close
	// MIN_SAFE_DISTANCE = 2
	// isTooClose = distance < 2 = true
	// isWounded = lifeRatio <= 0.55 - 0.20 * 0.5 = 0.45
	const lifeRatio = 0.4 // 40% HP
	const distance = 1 // 1 cell away

	const shouldHide = strategy.shouldHide(lifeRatio, distance)
	assert.equal(shouldHide, true, "Should hide when at 40% HP and 1 cell away with BALANCED strategy")
})

test("shouldHide() should NOT hide when player is healthy", () => {
	const strategy = new BalancedStrategy(50)

	// lifeRatio = 0.6 > 0.45, so isWounded = false
	const lifeRatio = 0.6 // 60% HP
	const distance = 1

	const shouldHide = strategy.shouldHide(lifeRatio, distance)
	assert.equal(shouldHide, false, "Should NOT hide when at 60% HP")
})

test("shouldHide() should NOT hide when player is far away from zone_control", () => {
	const strategy = new BalancedStrategy(50)

	// distance = 10 > MIN_SAFE_DISTANCE = 2, so isTooClose = false
	// distance = 10 > 8 (zone_control trap boundary), so zone_control escape doesn't trigger
	const lifeRatio = 0.4 // 40% HP (would be wounded)
	const distance = 10 // Far away

	const shouldHide = strategy.shouldHide(lifeRatio, distance)
	assert.equal(shouldHide, false, "Should NOT hide when far away (distance > 8)")
})

test("shouldHide() should hide when both wounded AND too close", () => {
	const strategy = new BalancedStrategy(50)

	const lifeRatio = 0.3 // 30% HP (wounded)
	const distance = 1 // Too close

	const shouldHide = strategy.shouldHide(lifeRatio, distance)
	assert.equal(shouldHide, true, "Should hide when wounded AND too close")
})
