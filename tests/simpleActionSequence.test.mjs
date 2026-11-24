import assert from "node:assert/strict"
import test from "node:test"

import { simpleActionSequence } from "../dist/Brain/simpleActionSequence.js"

test("simple action sequence equips, approaches, attacks, and retreats", () => {
	const actions = []
	let mp = 2
	let tp = 3
	let weapon = null
	let attacksAvailable = false
	const enemy = { id: 2, name: "enemy" }
	const pistol = { cost: 2 }

	globalThis.Fight = { getNearestEnemy: () => enemy }
	globalThis.Weapon = { pistol }

	const me = {
		get mp() { return mp },
		get tp() { return tp },
		get weapon() { return weapon },
		setWeapon(value) {
			actions.push("equip")
			weapon = value
			tp -= 1
		},
		moveToward(target) {
			assert.equal(target, enemy)
			actions.push("move")
			mp -= 1
			attacksAvailable = true
		},
		canUseWeapon(target) {
			assert.equal(target, enemy)
			return attacksAvailable && tp >= pistol.cost
		},
		useWeapon(target) {
			assert.equal(target, enemy)
			actions.push("attack")
			tp -= pistol.cost
			attacksAvailable = tp >= pistol.cost
		},
		moveAwayFrom(target) {
			assert.equal(target, enemy)
			actions.push("retreat")
			mp = 0
		}
	}

	simpleActionSequence(me)

	assert.deepEqual(actions, ["equip", "move", "attack", "retreat"])
	assert.equal(mp, 0)
	assert.equal(tp, 0)
})

test("simple action sequence does nothing when there is no enemy", () => {
	globalThis.Fight = { getNearestEnemy: () => null }
	globalThis.Weapon = { pistol: { cost: 2 } }

	const me = {
		get weapon() { return null },
		setWeapon() { assert.fail("must not equip without a target") },
		moveToward() { assert.fail("must not move without a target") },
		canUseWeapon() { assert.fail("must not check attacks without a target") },
		useWeapon() { assert.fail("must not attack without a target") },
		moveAwayFrom() { assert.fail("must not retreat without a target") }
	}

	assert.equal(simpleActionSequence(me), undefined)
})

test("simple action sequence stops approaching when movement makes no progress", () => {
	const actions = []
	const enemy = { id: 2, name: "enemy" }
	globalThis.Fight = { getNearestEnemy: () => enemy }
	globalThis.Weapon = { pistol: { cost: 1 } }
	const me = {
		mp: 2,
		tp: 2,
		weapon: globalThis.Weapon.pistol,
		moveToward() { actions.push("move") },
		canUseWeapon() { return false },
		useWeapon() { actions.push("attack") },
		moveAwayFrom() { actions.push("retreat") }
	}

	simpleActionSequence(me)

	assert.deepEqual(actions, ["move", "retreat"])
})
