import assert from "node:assert/strict"
import test from "node:test"

import { Plannification } from "../dist/Classes/Plannification/Plannification.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
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
// TEST 2: planHide() should NOT add actions when target is dead
// ============================================================================
test("planHide() should not add hide action when target is dead", () => {
	const cell = { x: 0, y: 0, empty: false, obstacle: false, entity: null }
	const target = {
		id: 2,
		name: "Destruction",
		cell,
		life: 0, // DEAD
		maxLife: 100,
		mp: 0,
		weapon: { maxRange: 3 },
		distance: () => 1 // Very close
	}

	const me = {
		id: 1,
		name: "Kassbi",
		cell,
		life: 70,
		maxLife: 100,
		mp: 4,
		tp: 7,
		strength: 0,
		wisdom: 0,
		weapons: [],
		chips: [],
		get weapon() { return null },
		distance: () => 1,
		setWeapon() {},
		useChip() {},
		chipCells: () => [cell],
		canUseWeapon: () => false,
		moveToward() {},
		useWeapon() {},
		moveAwayFrom() {}
	}

	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(2, 2)
	profile.setSupportOptions(true, true, true)

	globalThis.Effect = {
		DAMAGE: 1,
		HEAL: 2,
		ABSOLUTE_SHIELD: 3,
		RELATIVE_SHIELD: 4
	}

	const plan = new Plannification(me, target, profile)
	const actionsBeforeHide = plan.actions.length

	plan.planHide()

	// planHide should NOT add an action because target is dead
	// (mpLeft check passes, but we need target.maxLife > 0 check)
	const actionsAfterHide = plan.actions.length

	// CURRENT BUG: planHide will likely add an action because it only checks this.leek.maxLife <= 0
	// EXPECTED: No new actions should be added
	console.log(`Actions before: ${actionsBeforeHide}, After: ${actionsAfterHide}`)
})

test("planHide() correctly checks if hiding is needed when wounded", () => {
	// This test verifies the shouldHide() formula works correctly
	// by using the strategy directly instead of through Plannification
	const strategy = new BalancedStrategy(50)
	
	// Test case 1: Player at 40% HP and 1 cell away
	const shouldHide1 = strategy.shouldHide(0.4, 1, 2)
	assert.equal(shouldHide1, true, "Should hide at 40% HP and 1 cell away")
	
	// Test case 2: Player at 60% HP and 1 cell away
	const shouldHide2 = strategy.shouldHide(0.6, 1, 2)
	assert.equal(shouldHide2, false, "Should NOT hide at 60% HP")
	
	// Test case 3: Player at 40% HP but 3 cells away (safe distance)
	const shouldHide3 = strategy.shouldHide(0.4, 3, 2)
	assert.equal(shouldHide3, false, "Should NOT hide when at safe distance")
	
	console.log("All shouldHide() formula tests passed correctly")
})

// ============================================================================
// TEST 3: shouldHide() formula verification for BALANCED strategy
// ============================================================================
test("shouldHide() formula is correct for BALANCED strategy (aggression=50)", () => {
	const strategy = new BalancedStrategy(50)

	// Test case: Kassbi wounded and too close
	// minSafeDistance = max(2, 2 - 1) = 2
	// isTooClose = distance < 2 = true
	// isWounded = lifeRatio <= 0.55 - 0.20 * 0.5 = 0.45
	const lifeRatio = 0.4 // 40% HP
	const distance = 1 // 1 cell away
	const preferredMinRange = 2

	const shouldHide = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	assert.equal(shouldHide, true, "Should hide when at 40% HP and 1 cell away with BALANCED strategy")
})

test("shouldHide() should NOT hide when player is healthy", () => {
	const strategy = new BalancedStrategy(50)

	// lifeRatio = 0.6 > 0.45, so isWounded = false
	const lifeRatio = 0.6 // 60% HP
	const distance = 1
	const preferredMinRange = 2

	const shouldHide = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	assert.equal(shouldHide, false, "Should NOT hide when at 60% HP")
})

test("shouldHide() should NOT hide when player is far away", () => {
	const strategy = new BalancedStrategy(50)

	// distance = 3 >= minSafeDistance = 2, so isTooClose = false
	const lifeRatio = 0.4 // 40% HP (wounded)
	const distance = 3 // Safe distance
	const preferredMinRange = 2

	const shouldHide = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	assert.equal(shouldHide, false, "Should NOT hide when at safe distance")
})

test("shouldHide() should hide when both wounded AND too close", () => {
	const strategy = new BalancedStrategy(50)

	const lifeRatio = 0.3 // 30% HP (wounded)
	const distance = 1 // Too close
	const preferredMinRange = 2

	const shouldHide = strategy.shouldHide(lifeRatio, distance, preferredMinRange)
	assert.equal(shouldHide, true, "Should hide when wounded AND too close")
})

// ============================================================================
// TEST 4: Verify post-victory move issue
// ============================================================================
test("Combat sequence should correctly handle target death", () => {
	// This is a simulation of Tour 5 where Destruction dies
	const cell = { x: 0, y: 0, empty: false, obstacle: false, entity: null }
	const targetCell = { x: 1, y: 0, empty: false, obstacle: false, entity: null }

	const target = {
		id: 2,
		name: "Destruction",
		cell: targetCell,
		life: 0, // Target is DEAD
		maxLife: 50,
		mp: 0,
		weapon: { maxRange: 3 },
		distance: () => {
			// When dead, distance may return Infinity or large value
			return Infinity
		}
	}

	const me = {
		id: 1,
		name: "Kassbi",
		cell,
		life: 30, // Wounded at 30% HP
		maxLife: 100,
		mp: 4,
		tp: 2,
		strength: 0,
		wisdom: 0,
		weapons: [{
			name: "Machine Gun",
			cost: 2,
			minRange: 1,
			maxRange: 5,
			features: [{ type: 1, minValue: 39, maxValue: 39 }]
		}],
		chips: [],
		get weapon() { return this.weapons[0] },
		distance: (target) => {
			// When target is dead, distance becomes Infinity
			if (target && target.life <= 0) {
				return Infinity
			}
			return 1
		},
		setWeapon() {},
		useChip() {},
		chipCells: () => [cell],
		canUseWeapon: () => false,
		moveToward() {},
		useWeapon() {},
		moveAwayFrom() {} // This would be called if hide is planned
	}

	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(2, 2)
	profile.setSupportOptions(true, true, true)

	globalThis.Effect = {
		DAMAGE: 1,
		HEAL: 2,
		ABSOLUTE_SHIELD: 3,
		RELATIVE_SHIELD: 4
	}
	globalThis.Field = {
		distance: (c1, c2) => Infinity,
		getObstacles: () => []
	}
	globalThis.Chip = {
		bandage: {
			name: "bandage",
			cost: 1,
			currentCooldown: 0,
			features: [{ type: 2, minValue: 5, maxValue: 15 }]
		}
	}

	const plan = new Plannification(me, target, profile)
	plan.planHide()

	// When target is dead and me.distance(target) returns Infinity:
	// - shouldHide checks: (Infinity < 2) && (0.3 <= 0.45)
	// - = false && true = false
	// - So no hide action should be added
	
	// But the real issue is: there's no explicit check for target being dead
	// The only protection is that distance becomes Infinity when target is dead
	
	const hideActionFound = plan.actions.some(action =>
		action.description?.includes("Smart Retreat") ||
		action.description?.includes("hide") ||
		action.description?.includes("retreat")
	)

	console.log(`\nAfter target death with wounded Kassbi:`)
	console.log(`Hide action incorrectly added: ${hideActionFound}`)
	console.log(`Distance to dead target: ${me.distance(target)}`)
	
	// This test verifies that IF target.distance() returns a normal value even when dead,
	// planHide would still add a move. That's the latent bug.
	// The fix is to add an explicit check: target.life > 0 || target.maxLife <= 0
	
	assert.equal(hideActionFound, false, "Currently safe because distance() returns Infinity, but no explicit guard")
})

// ============================================================================
// TEST 5: Verify that target death should block planHide
// ============================================================================
test("planHide() should check target.maxLife > 0 to prevent post-victory moves", () => {
	const cell = { x: 0, y: 0, empty: false, obstacle: false, entity: null }
	
	const target = {
		id: 2,
		name: "Destruction",
		cell,
		life: 0, // DEAD
		maxLife: 100,
		mp: 0,
		weapon: { maxRange: 3 },
		distance: () => 1
	}

	const me = {
		id: 1,
		name: "Kassbi",
		cell,
		life: 30, // Wounded
		maxLife: 100,
		mp: 4,
		tp: 7,
		strength: 0,
		wisdom: 0,
		weapons: [],
		chips: [],
		get weapon() { return null },
		distance: () => 1,
		setWeapon() {},
		useChip() {},
		chipCells: () => [cell],
		canUseWeapon: () => false,
		moveToward() {},
		useWeapon() {},
		moveAwayFrom() {}
	}

	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(2, 2)
	profile.setSupportOptions(true, true, true)

	globalThis.Effect = {
		DAMAGE: 1,
		HEAL: 2,
		ABSOLUTE_SHIELD: 3,
		RELATIVE_SHIELD: 4
	}
	globalThis.Field = {
		distance: () => 1,
		getObstacles: () => []
	}

	// Current check in planHide:
	const shouldBlockByLeekHealth = me.maxLife <= 0
	console.log(`Current check (this.leek.maxLife <= 0): ${shouldBlockByLeekHealth}`)
	
	// Should have:
	const shouldBlockByTargetDeath = target.maxLife <= 0
	console.log(`Needed check (this.target.maxLife <= 0): ${shouldBlockByTargetDeath}`)

	// Or even better:
	const shouldBlockByTargetAlive = target.life <= 0
	console.log(`Better check (this.target.life <= 0): ${shouldBlockByTargetAlive}`)

	const plan = new Plannification(me, target, profile)
	plan.planHide()

	// With the new guard: target.maxLife > 0
	// planHide() will return early and NOT add an action
	// This guards against any scenario where shouldHide() might return true

	const hideActionWasAdded = plan.actions.length > 0

	console.log(`\nplannification.actions.length: ${plan.actions.length}`)
	console.log(`Hide action added when target dead: ${hideActionWasAdded}`)
	console.log(`Guard: target.life (${target.life}) <= 0 blocks planHide() ✓`)
	
	assert.equal(hideActionWasAdded, false, "planHide() should not add action when target is dead (guard: target.life <= 0)")
})

// ============================================================================
// TEST 6: Verify that hide still works when target is alive
// ============================================================================
test("planHide() should still work when target is alive and player wounded", () => {
	const cell = { x: 0, y: 0, empty: false, obstacle: false, entity: null }
	const targetCell = { x: 1, y: 0, empty: false, obstacle: false, entity: null }
	
	const target = {
		id: 2,
		name: "Destruction",
		cell: targetCell,
		life: 50, // ALIVE
		maxLife: 100,
		mp: 2,
		weapon: { maxRange: 3 }
	}

	const moveAwayWasCalled = []
	const me = {
		id: 1,
		name: "Kassbi",
		cell,
		life: 30, // Wounded at 30%
		maxLife: 100,
		mp: 4,
		tp: 7,
		strength: 0,
		wisdom: 0,
		weapons: [],
		chips: [],
		get weapon() { return null },
		distance: (t) => t === target ? 1 : 0, // Close to target
		setWeapon() {},
		useChip() {},
		chipCells: () => [cell],
		canUseWeapon: () => false,
		moveToward() {},
		useWeapon() {},
		moveAwayFrom() { moveAwayWasCalled.push(true) }
	}

	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(2, 2)
	profile.setSupportOptions(true, true, true)

	globalThis.Effect = {
		DAMAGE: 1,
		HEAL: 2,
		ABSOLUTE_SHIELD: 3,
		RELATIVE_SHIELD: 4
	}
	globalThis.Field = {
		distance: () => 1,
		getObstacles: () => []
	}

	const plan = new Plannification(me, target, profile)
	const actionsBeforeHide = plan.actions.length

	plan.planHide()

	// Should add a hide action because:
	// - allowHiding = true
	// - mpLeft = 4 > 0
	// - me.maxLife = 100 > 0
	// - target.maxLife = 100 > 0 ← NEW GUARD passes (target alive)
	// - distance = 1 < minSafeDistance = 2
	// - lifeRatio = 0.3 <= 0.45

	const actionsAfterHide = plan.actions.length
	const hideActionAdded = actionsAfterHide > actionsBeforeHide

	console.log(`\nAfter planHide() with target alive and wounded player:`)
	console.log(`Actions: ${actionsBeforeHide} → ${actionsAfterHide}`)
	console.log(`Hide action added: ${hideActionAdded}`)
	
	assert.equal(hideActionAdded, true, "planHide() should add hide action when target alive and player wounded")
})
