import assert from "node:assert/strict"
import test from "node:test"

import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { OBJECTIVES, objectiveFor } from "../dist/Classes/Plannification/BookObjective.js"
import { MIN_SAFE_DISTANCE, shouldHeal, shouldHealWithThreat, shouldHide, shouldShield } from "../dist/Classes/Plannification/TacticalScore.js"

test("profile fixes the aggression at construction and clamps it to 0-100; all behaviors are allowed by default", () => {
	assert.equal(new LeekProfile().aggression, 50)
	assert.equal(new LeekProfile(150).aggression, 100)
	assert.equal(new LeekProfile(-5).aggression, 0)
	const profile = new LeekProfile(30)
	assert.deepEqual([profile.allowHealing, profile.allowShielding, profile.allowHiding], [true, true, true])
})

test("frozen fallback thresholds: heal, shield, hide as functions of the aggression", () => {
	assert.equal(shouldHeal(50, 0.32), true)
	assert.equal(shouldHeal(50, 0.33), false)
	assert.equal(shouldHealWithThreat(50, 0.50, 10), true)
	assert.equal(shouldHealWithThreat(50, 0.50, 11), false)
	assert.equal(shouldHeal(0, 0.40), true)
	assert.equal(shouldHeal(100, 0.26), false)
	assert.equal(shouldShield(50, 0.37, 6, 6), true)
	assert.equal(shouldShield(50, 0.37, 7, 6), false)
	assert.equal(shouldShield(50, 0.38, 6, 6), false)
	assert.equal(MIN_SAFE_DISTANCE, 2)
	assert.equal(shouldHide(50, 0.22, 1), true)
	assert.equal(shouldHide(50, 0.51, 1), false)
	assert.equal(shouldHide(50, 0.25, 10), true)
	assert.equal(shouldHide(50, 0.25, 11), false)
})

test("book objective: 50 is the damage objective, low aggression values heal and shield, high aggression values damage and approach", () => {
	const turn = (change) => ({ damage: 0, heal: 0, shield: 0, exposed: 0, progress: 0, kills: false, won: false, tpSpent: 0, boostsCast: 0, ...change })
	const sample = [turn({ damage: 40, exposed: 30 }), turn({ heal: 40 }), turn({ shield: 40, exposed: 10 }), turn({ progress: 3 }), turn({ damage: 40, kills: true })]
	for (const outcome of sample) assert.equal(objectiveFor(50).score(outcome), OBJECTIVES.damage.score(outcome))
	const cautious = objectiveFor(0), bold = objectiveFor(100)
	const hit = turn({ damage: 40, exposed: 30 }), heal = turn({ heal: 40 }), approach = turn({ progress: 3 })
	assert.ok(cautious.score(heal) - cautious.score(hit) > bold.score(heal) - bold.score(hit), "caution prefers healing to a risky hit")
	assert.ok(bold.score(approach) > cautious.score(approach), "boldness values closing in")
	assert.ok(bold.score(hit) > cautious.score(hit), "boldness values the risky hit")
	assert.equal(objectiveFor(-10).name, objectiveFor(0).name)
})
