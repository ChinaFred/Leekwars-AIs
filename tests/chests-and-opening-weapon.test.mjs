import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }

const { isChest, aliveEnemies, aliveChests, nearestEnemy } = await import("../dist/Classes/Context/Targets.js")
const { equipOpeningWeapon, pickOpeningWeapon } = await import("../dist/Brain/OpeningWeapon.js")

class FakeChest {}

function entity(id, x, extra = {}) {
	return {
		id, name: `e${id}`, level: 1, life: 50, maxLife: 50, mp: 3, tp: 10, strength: 0, agility: 0, wisdom: 0,
		resistance: 0, science: 0, magic: 0, weapon: null, weapons: [], chips: [], effects: [], launchedEffects: [],
		cell: { id: x, x, y: 0, empty: false, obstacle: false, entity: null }, ...extra
	}
}

function chestEntity(id, x) {
	return Object.assign(Object.create(FakeChest.prototype), entity(id, x))
}

const pistol = { id: 1, name: "pistol", cost: 3, minRange: 1, maxRange: 7, features: [{ type: 1, minValue: 15, maxValue: 20 }] }
const laser = { id: 2, name: "laser", cost: 5, minRange: 2, maxRange: 9, features: [{ type: 1, minValue: 40, maxValue: 50 }] }
const magnum = { id: 3, name: "magnum", cost: 5, minRange: 1, maxRange: 12, features: [{ type: 1, minValue: 40, maxValue: 50 }] }

function setFight({ enemies, nearest, me = entity(1, 0), turn = 1 }) {
	globalThis.Fight = {
		me: Object.assign(me, { distance: (other) => Math.abs(other.cell.x - me.cell.x) }),
		turn,
		getNearestEnemy: () => nearest,
		getEnemies: () => enemies,
		getAliveEnemies: () => enemies,
		getAllies: () => [me]
	}
}

test("without the Chest class every entity is an ordinary enemy", () => {
	delete globalThis.Chest
	const enemy = entity(2, 5)
	setFight({ enemies: [enemy], nearest: enemy })
	assert.equal(isChest(enemy), false)
	assert.deepEqual(aliveEnemies(), [enemy])
	assert.deepEqual(aliveChests(), [])
	assert.equal(nearestEnemy(), enemy)
})

test("chests are listed apart and never returned as enemies or as the nearest enemy", () => {
	globalThis.Chest = FakeChest
	const chest = chestEntity(3, 1)
	const enemy = entity(2, 9)
	setFight({ enemies: [chest, enemy], nearest: chest })
	assert.equal(isChest(chest), true)
	assert.deepEqual(aliveEnemies(), [enemy])
	assert.deepEqual(aliveChests(), [chest])
	assert.equal(nearestEnemy(), enemy)
})

test("only chests left: there is no nearest enemy", () => {
	globalThis.Chest = FakeChest
	const chest = chestEntity(3, 1)
	setFight({ enemies: [chest], nearest: chest })
	assert.equal(nearestEnemy(), null)
})

test("opening weapon: best damage per TP, longest range on a tie", () => {
	assert.equal(pickOpeningWeapon({ weapons: [pistol, laser], strength: 0 }), laser)
	assert.equal(pickOpeningWeapon({ weapons: [magnum, laser], strength: 0 }), magnum)
	assert.equal(pickOpeningWeapon({ weapons: [], strength: 0 }), null)
})

test("turn 1 with no weapon equipped: equips one with the leftover TP; never later or twice", () => {
	delete globalThis.Chest
	const equipped = []
	const me = entity(1, 0, {
		weapons: [pistol, laser],
		setWeapon(weapon) { equipped.push(weapon.name); this.weapon = weapon; this.tp -= 1 }
	})
	setFight({ enemies: [], nearest: null, me })

	Fight.turn = 2
	equipOpeningWeapon(me)
	assert.deepEqual(equipped, [])

	Fight.turn = 1
	equipOpeningWeapon(me)
	equipOpeningWeapon(me)
	assert.deepEqual(equipped, ["laser"])
	assert.equal(me.tp, 9)
})

test("turn 1 with no TP left or no weapon: nothing is equipped", () => {
	const calls = []
	const setWeapon = (weapon) => calls.push(weapon.name)
	const broke = entity(1, 0, { weapons: [pistol], tp: 0, setWeapon })
	setFight({ enemies: [], nearest: null, me: broke })
	equipOpeningWeapon(broke)
	const unarmed = entity(1, 0, { weapons: [], setWeapon })
	setFight({ enemies: [], nearest: null, me: unarmed })
	equipOpeningWeapon(unarmed)
	assert.deepEqual(calls, [])
})

test("turn(): a chest is listed and observed apart, never identified as an enemy, and a weapon is equipped on turn 1", async () => {
	globalThis.Chest = FakeChest
	const { turn } = await import("../dist/Main/Kassbi_Class.js")
	const { enemyMemory, chestMemory } = await import("../dist/Brain/TurnObservation.js")
	const equipped = []
	const me = entity(1, 0, {
		weapons: [pistol],
		say() {},
		setWeapon(weapon) { equipped.push(weapon.name); this.weapon = weapon; this.tp -= 1 },
		canUseWeapon: () => false,
		canUseChip: () => false,
		moveToward() { return 0 },
		moveAwayFrom() { return 0 },
		useWeapon() { return 0 },
		useChip() { return 0 }
	})
	const chest = chestEntity(31, 1)
	const enemy = entity(32, 12)
	setFight({ enemies: [chest, enemy], nearest: chest, me })

	turn()

	assert.equal(enemyMemory.has(32), true)
	assert.equal(enemyMemory.has(31), false)
	assert.equal(chestMemory.has(31), true)
	assert.equal(chestMemory.has(32), false)
	assert.equal(me.weapon, pistol)
	assert.equal(equipped.length, 1)
})
