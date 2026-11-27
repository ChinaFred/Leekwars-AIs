import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }

const { springChestTrap } = await import("../dist/Brain/ChestTrap.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

class FakeChest {}

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const damage = (id, name, cost, maxRange) => ({
	id, name, cost, minRange: 1, maxRange, maxUses: -1, needsLos: false, currentCooldown: 0, cooldown: 0,
	features: [{ type: Effect.DAMAGE, minValue: 10, maxValue: 10 }]
})

/** Moi en 0, un coffre en `chestX`, un ennemi en `enemyX` (sur la même ligne). */
function arena({ chestX = 3, enemyX = 4, tp = 6, mp = 3, chips = [], weapons = [damage(9, "gun", 2, 5)], equipped = true } = {}) {
	const cells = new Map()
	const cell = (x) => cells.get(x) ?? (cells.set(x, { id: x + 100, x, y: 0, entity: null }), cells.get(x))
	const events = []
	const me = {
		id: 1, name: "me", cell: cell(0), life: 100, maxLife: 100, tp, mp, weapon: equipped ? weapons[0] : null,
		weapons, chips, say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target, weapon = this.weapon) {
			const d = distance(this.cell, target.cell)
			return weapon !== null && this.tp >= weapon.cost && target.life > 0 && d >= 1 && d <= weapon.maxRange
		},
		canUseChip(chip, target) {
			const d = distance(this.cell, target.cell)
			return this.tp >= chip.cost && d >= chip.minRange && d <= chip.maxRange
		},
		setWeapon(w) { events.push(`equip:${w.name}`); this.tp--; this.weapon = w; return true },
		moveAwayFrom(target) { events.push(`flee:${target.id}`); return 1 },
		useWeapon(target) { events.push(`weapon:${target.id}`); this.tp -= this.weapon.cost; target.life -= 10; return 1 },
		useChip(chip, target) { events.push(`chip:${chip.name}:${target.id}`); this.tp -= chip.cost; target.life -= 10; return 1 }
	}
	const make = (id, x) => ({ id, name: `e${id}`, cell: cell(x), life: 100, maxLife: 100,
		distance(other) { return distance(this.cell, other.cell) } })
	const chest = Object.assign(Object.create(FakeChest.prototype), make(20, chestX))
	const enemy = make(30, enemyX)
	const list = [chest, enemy]
	globalThis.Chest = FakeChest
	globalThis.Fight = { turn: 3, me, getAliveEnemies: () => list, getNearestEnemy: () => list[0] }
	const config = new LogConfig()
	config.setAll(false)
	initLeekLogging(config)
	return { me, chest, enemy, events }
}

test("enemy nearer to the chest and chest in range: shoot the chest while TP last, then flee from the chest", () => {
	const w = arena({ chestX: 3, enemyX: 4 }) // moi à 3 du coffre, l'ennemi à 1
	assert.equal(springChestTrap(w.me), true)
	assert.deepEqual(w.events, ["weapon:20", "weapon:20", "weapon:20", `flee:${w.chest.id}`])
	assert.equal(w.chest.life, 70)
})

test("any item counts: a damaging chip shoots when the weapon cannot reach", () => {
	const chip = { ...damage(5, "flash", 3, 6) }
	const w = arena({ weapons: [damage(9, "short", 2, 2)], chips: [chip], tp: 3 })
	assert.equal(springChestTrap(w.me), true)
	assert.deepEqual(w.events, ["chip:flash:20", `flee:${w.chest.id}`])
})

test("a weapon that is not equipped is swapped in (1 TP) when it is the only way to reach the chest", () => {
	const far = damage(7, "rifle", 3, 8)
	const w = arena({ weapons: [damage(9, "short", 2, 2), far], equipped: true, tp: 4 })
	assert.equal(springChestTrap(w.me), true)
	assert.deepEqual(w.events, ["equip:rifle", "weapon:20", `flee:${w.chest.id}`])
})

test("I am nearer to the chest than the enemy (or at equal distance): no trap", () => {
	const nearer = arena({ chestX: 2, enemyX: 5 })
	assert.equal(springChestTrap(nearer.me), false)
	const equal = arena({ chestX: 3, enemyX: 6 })
	assert.equal(springChestTrap(equal.me), false)
	assert.deepEqual([...nearer.events, ...equal.events], [])
})

test("chest out of reach of every weapon and chip: no trap", () => {
	const w = arena({ chestX: 9, enemyX: 10 })
	assert.equal(springChestTrap(w.me), false)
	assert.deepEqual(w.events, [])
})

test("no enemy alive, or no Chest class: no trap", () => {
	const w = arena()
	globalThis.Fight.getAliveEnemies = () => [w.chest]
	assert.equal(springChestTrap(w.me), false)
	delete globalThis.Chest
	const v = arena()
	delete globalThis.Chest
	assert.equal(springChestTrap(v.me), false)
	assert.deepEqual([...w.events, ...v.events], [])
})

test("no MP left: the shots are fired and no flee is attempted", () => {
	const w = arena({ mp: 0, tp: 2 })
	assert.equal(springChestTrap(w.me), true)
	assert.deepEqual(w.events, ["weapon:20"])
})
