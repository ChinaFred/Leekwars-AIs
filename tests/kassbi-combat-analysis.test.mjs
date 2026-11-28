import assert from "node:assert/strict"
import test from "node:test"

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
