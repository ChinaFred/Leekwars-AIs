import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
delete globalThis.Chest

const { equipOpeningWeapon, pickOpeningWeapon, contactWindow } = await import("../dist/Brain/OpeningWeapon.js")

// Kassbi : Magnum 1-8 (85 dégâts, 17 par PT) et Épée large 1-1 (105 dégâts, 21 par PT).
const magnum = { id: 1, name: "magnum", cost: 5, minRange: 1, maxRange: 8, features: [{ type: 1, minValue: 80, maxValue: 90 }] }
const sword = { id: 2, name: "broadsword", cost: 5, minRange: 1, maxRange: 1, features: [{ type: 1, minValue: 100, maxValue: 110 }] }

function world(distance, { weapon = null, mp = 3, enemyMp = 3 } = {}) {
	const equipped = []
	const enemy = { id: 2, life: 100, mp: enemyMp, cell: { id: 2, x: distance, y: 0 } }
	const me = {
		id: 1, life: 100, tp: 10, mp, strength: 0, weapon, weapons: [magnum, sword], cell: { id: 1, x: 0, y: 0 },
		distance: (other) => Math.abs(other.cell.x - 0),
		setWeapon(chosen) { equipped.push(chosen.name); this.weapon = chosen; this.tp -= 1; return 1 }
	}
	globalThis.Fight = { me, turn: 1, getNearestEnemy: () => enemy, getEnemies: () => [enemy], getAliveEnemies: () => [enemy], getAllies: () => [me] }
	return { me, equipped }
}
const planWith = (later) => ({ later })

test("contact window: far enemy leaves only the long end of the longest range", () => {
	assert.deepEqual(contactWindow({ distance: 20, myMp: 3, enemyMp: 3 }, 8), { min: 8, max: 11 })
	assert.deepEqual(contactWindow({ distance: 32, myMp: 3, enemyMp: 3 }, 8), { min: 8, max: 11 })
	assert.deepEqual(contactWindow({ distance: 2, myMp: 3, enemyMp: 3 }, 8), { min: 1, max: 1 })
})

test("(a) enemy at 20 cells, the plan fires the Magnum on later turns: the Magnum is equipped", () => {
	const w = world(20)
	equipOpeningWeapon(w.me, planWith({ turns: 2, weapon: magnum }), 3)
	assert.deepEqual(w.equipped, ["magnum"])
})

test("(a) the plan's weapon wins even when the ratio and the contact favour the other", () => {
	const w = world(1)
	equipOpeningWeapon(w.me, planWith({ turns: 2, weapon: magnum }), 3)
	assert.deepEqual(w.equipped, ["magnum"])
})

test("(b) no weapon in the simulated turns, enemy far: the ranged weapon is preferred", () => {
	for (const distance of [20, 32]) {
		const w = world(distance)
		equipOpeningWeapon(w.me, planWith({ turns: 2, weapon: null }), 3)
		assert.deepEqual(w.equipped, ["magnum"], `distance ${distance}`)
	}
})

test("(b) no plan, depth 1 or planAct fallback: same fallback, enemy far", () => {
	for (const plan of [null, planWith({ turns: 0, weapon: null }), {}]) {
		const w = world(20)
		equipOpeningWeapon(w.me, plan, 3)
		assert.deepEqual(w.equipped, ["magnum"])
	}
	assert.equal(pickOpeningWeapon(world(20).me, { distance: 20, myMp: 3, enemyMp: 3 }), magnum)
})

test("(c) enemy already at a plausible melee contact: the broadsword is eligible again", () => {
	for (const distance of [1, 2]) {
		const w = world(distance)
		equipOpeningWeapon(w.me, planWith({ turns: 2, weapon: null }), 3)
		assert.deepEqual(w.equipped, ["broadsword"], `distance ${distance}`)
	}
})

test("(c) without enemy information the damage per TP rule is unchanged", () => {
	const w = world(5)
	globalThis.Fight.getAliveEnemies = () => []
	equipOpeningWeapon(w.me, null, 3)
	assert.deepEqual(w.equipped, ["broadsword"])
	assert.equal(pickOpeningWeapon(w.me), sword)
})

test("(d) unchanged outside turn 1, with a weapon in hand, without TP", () => {
	const late = world(20)
	Fight.turn = 2
	equipOpeningWeapon(late.me, planWith({ turns: 2, weapon: magnum }), 3)
	const armed = world(20, { weapon: sword })
	equipOpeningWeapon(armed.me, planWith({ turns: 2, weapon: magnum }), 3)
	const broke = world(20)
	broke.me.tp = 0
	equipOpeningWeapon(broke.me, planWith({ turns: 2, weapon: magnum }), 3)
	assert.deepEqual([late.equipped, armed.equipped, broke.equipped], [[], [], []])
	assert.equal(armed.me.weapon, sword)
})
