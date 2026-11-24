import assert from "node:assert/strict"
import test from "node:test"

import { LeekProfile } from "../dist/LeekProfile.js"
import { AggressiveStrategy } from "../dist/Strategy/AggressiveStrategy.js"
import { BalancedStrategy } from "../dist/Strategy/BalancedStrategy.js"
import { DefensiveStrategy } from "../dist/Strategy/DefensiveStrategy.js"

test("profile normalizes role, aggression, range, and support settings", () => {
	const profile = new LeekProfile()
	profile.setRole("ATTACKER")
	profile.setAggression(150)
	profile.setPreferredRange(-2, 4)
	profile.setSupportOptions(false, true, false)

	assert.equal(profile.role, "AGGRESSIVE")
	assert.equal(profile.strategyName, "AGGRESSIVE")
	assert.equal(profile.aggression, 100)
	assert.equal(profile.preferredMinRange, 0)
	assert.equal(profile.preferredMaxRange, 4)
	assert.equal(profile.allowHealing, false)
	assert.equal(profile.allowShielding, true)
	assert.equal(profile.allowHiding, false)
})

test("balanced strategy keeps the original healing threshold", () => {
	const strategy = new BalancedStrategy(50)

	assert.equal(strategy.shouldHeal(0.9, 0.2), true)
	assert.equal(strategy.shouldHeal(0.9, 0.199), false)
})

test("aggressive and defensive strategies retain distinct healing rules", () => {
	const aggressive = new AggressiveStrategy(50)
	const defensive = new DefensiveStrategy(50)

	assert.equal(aggressive.shouldHeal(0.32, 0), true)
	assert.equal(aggressive.shouldHeal(0.33, 0), false)
	assert.equal(defensive.shouldHeal(0.82, 0), true)
	assert.equal(defensive.shouldHeal(0.83, 0), false)
	assert.equal(defensive.shouldHeal(1, 0.35), true)
})
