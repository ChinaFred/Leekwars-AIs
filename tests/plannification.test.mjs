import assert from "node:assert/strict"
import test from "node:test"

import { planAct } from "../dist/Brain/PlanActScenario.js"

test("planAct heals, shields, moves, attacks with chips, and shoots in order", () => {
	const actions = []
	let tp = 7
	let mp = 3
	let equippedWeapon = null
	let inRange = false
	const cell = { x: 0, y: 0, empty: false, obstacle: false, entity: null }
	const target = {
		id: 2,
		name: "enemy",
		cell,
		mp: 2,
		weapon: { maxRange: 3 }
	}
	const weakWeapon = {
		name: "weak",
		cost: 3,
		minRange: 0,
		maxRange: 2,
		features: [{ type: 1, minValue: 5, maxValue: 10 }]
	}
	const strongWeapon = {
		name: "strong",
		cost: 2,
		minRange: 1,
		maxRange: 5,
		features: [{ type: 1, minValue: 12, maxValue: 18 }]
	}
	const bandage = {
		name: "bandage",
		cost: 1,
		currentCooldown: 0,
		features: [{ type: 2, minValue: 5, maxValue: 15 }]
	}
	const shield = {
		name: "shield",
		cost: 1,
		currentCooldown: 0,
		features: [{ type: 3, minValue: 10, maxValue: 10 }]
	}
	const attackChip = {
		name: "attack chip",
		cost: 1,
		currentCooldown: 0,
		features: [{ type: 1, minValue: 4, maxValue: 8 }]
	}
	const me = {
		id: 1,
		name: "me",
		cell,
		life: 70,
		maxLife: 100,
		mp,
		tp,
		strength: 0,
		wisdom: 0,
		weapons: [weakWeapon, strongWeapon],
		chips: [bandage, shield, attackChip],
		get weapon() { return equippedWeapon },
		distance: () => 4,
		setWeapon(weapon) {
			actions.push("equip")
			equippedWeapon = weapon
			tp -= 1
		},
		useChip(chip) {
			actions.push(chip.name)
			tp -= chip.cost
		},
		chipCells: () => [cell],
		canUseWeapon: () => inRange && equippedWeapon !== null && tp >= equippedWeapon.cost,
		moveToward() {
			actions.push("move")
			mp -= 1
			inRange = true
		},
		useWeapon() {
			actions.push("shoot")
			tp -= equippedWeapon.cost
		},
		moveAwayFrom() {
			actions.push("retreat")
			mp = 0
		}
	}

	globalThis.Fight = {
		me,
		getNearestEnemy: () => target,
		getEnemies: () => [target],
		getAliveEnemies: () => [target],
		getAllies: () => [me]
	}
	globalThis.Weapon = { pistol: weakWeapon }
	globalThis.Chip = { bandage }
	globalThis.Effect = {
		DAMAGE: 1,
		HEAL: 2,
		ABSOLUTE_SHIELD: 3,
		RELATIVE_SHIELD: 4
	}

	planAct(me)

	assert.equal(equippedWeapon, strongWeapon)
	assert.deepEqual(actions, ["equip", "bandage", "shield", "move", "attack chip", "shoot"])
	assert.equal(tp, 1)
	assert.equal(mp, 2)
})

test("planAct does nothing when there is no enemy", () => {
	globalThis.Fight = {
		me: {},
		getNearestEnemy: () => null,
		getEnemies: () => [],
		getAliveEnemies: () => [],
		getAllies: () => []
	}

	assert.equal(planAct({}), undefined)
})
