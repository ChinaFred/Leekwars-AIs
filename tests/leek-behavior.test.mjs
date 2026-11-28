import assert from "node:assert/strict"
import test from "node:test"

import { LeekBehavior, MIN_SAFE_DISTANCE } from "../dist/Classes/LeekBehavior.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"

test("profile fixes the aggression at construction and clamps it to 0-100; all behaviors are allowed by default", () => {
	assert.equal(new LeekProfile().aggression, 50)
	assert.equal(new LeekProfile(150).aggression, 100)
	assert.equal(new LeekProfile(-5).aggression, 0)
	assert.equal(new LeekProfile(75).behavior.aggression, 75)
	const profile = new LeekProfile(30)
	assert.deepEqual([profile.allowHealing, profile.allowShielding, profile.allowHiding], [true, true, true])
})

test("healing: life <= 0.40 - 0.15 x aggression, or <= 0.50 with an enemy within 10 cells", () => {
	const behavior = new LeekBehavior(50)
	assert.equal(behavior.shouldHeal(0.32), true)
	assert.equal(behavior.shouldHeal(0.33), false)
	assert.equal(behavior.shouldHealWithThreat(0.50, 10), true)
	assert.equal(behavior.shouldHealWithThreat(0.50, 11), false)
	assert.equal(behavior.shouldHealWithThreat(0.51, 5), false)
	assert.equal(new LeekBehavior(0).shouldHeal(0.40), true)
	assert.equal(new LeekBehavior(100).shouldHeal(0.26), false)
})

test("shielding: life <= 0.45 - 0.15 x aggression and the enemy within its threat range", () => {
	const behavior = new LeekBehavior(50)
	assert.equal(behavior.shouldShield(0.37, 6, 6), true)
	assert.equal(behavior.shouldShield(0.37, 7, 6), false)
	assert.equal(behavior.shouldShield(0.38, 6, 6), false)
})

test("hiding: too close and wounded, in contact at half life, or in panic within 10 cells", () => {
	const behavior = new LeekBehavior(50)
	assert.equal(MIN_SAFE_DISTANCE, 2)
	assert.equal(behavior.shouldHide(0.22, 1), true) // trop près, vie <= 0,225
	assert.equal(behavior.shouldHide(0.50, 1), true) // au contact
	assert.equal(behavior.shouldHide(0.51, 1), false)
	assert.equal(behavior.shouldHide(0.25, 10), true) // panique
	assert.equal(behavior.shouldHide(0.25, 11), false)
	assert.equal(behavior.shouldHide(0.40, 5), false)
})
