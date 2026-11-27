import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }

const { evaluateTacticalPlans } = await import("../dist/Classes/Plannification/TacticalPlanner.js")
const { executeTacticalPlan } = await import("../dist/Classes/Plannification/TacticalExecution.js")
const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")
const { aliveEnemies } = await import("../dist/Classes/Context/Targets.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { planAct } = await import("../dist/Brain/PlanActScenario.js")
const { equipOpeningWeapon } = await import("../dist/Brain/OpeningWeapon.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

class FakeChest {}

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const gun = () => ({
	id: 9, name: "gun", cost: 2, minRange: 1, maxRange: 5, maxUses: -1, needsLos: false,
	features: [{ type: Effect.DAMAGE, minValue: 10, maxValue: 10 }]
})

/** Deux ou trois entités alignées : moi en 0, un coffre (le plus proche) et un ennemi armé plus loin. */
function arena({ chest = true, enemy = true, chestArmed = false, tp = 6 } = {}) {
	const grid = new Map()
	for (let x = -4; x <= 8; x++) for (let y = -4; y <= 4; y++) {
		grid.set(`${x},${y}`, { id: grid.size, x, y, entity: null, obstacle: false, empty: true })
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	const events = []
	const weapon = gun()
	const me = {
		id: 1, name: "me", cell: cell(0), life: 100, maxLife: 100, strength: 0, wisdom: 0, absoluteShield: 0,
		relativeShield: 0, tp, mp: 0, weapon, weapons: [weapon], chips: [], say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) {
			const d = distance(this.cell, target.cell)
			return this.weapon !== null && this.tp >= this.weapon.cost && target.life > 0 && d >= 1 && d <= 5
		},
		canUseChip: () => false,
		chipCells: () => [],
		setWeapon(w) { events.push(`equip:${w.name}`); this.tp--; this.weapon = w; return true },
		moveToward() { events.push("move"); return 0 },
		moveAwayFrom() { events.push("retreat"); return 0 },
		useWeapon(target) {
			events.push(`shoot:${target.id}`)
			this.tp -= this.weapon.cost
			target.life -= 10
			return 1
		},
		useChip() { return 0 }
	}
	const make = (id, x, extra = {}) => ({
		id, name: `e${id}`, cell: cell(x), life: 100, maxLife: 100, mp: 0, tp: 6, strength: 0, weapon: null,
		weapons: [], chips: [], absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], ...extra
	})
	const list = []
	const theChest = chest ? Object.assign(Object.create(FakeChest.prototype),
		make(20, 2, chestArmed ? { weapon: gun() } : {})) : null
	const theEnemy = enemy ? make(30, 4, { weapon: gun() }) : null
	if (theChest) list.push(theChest)
	if (theEnemy) list.push(theEnemy)
	me.cell.entity = me
	for (const e of list) e.cell.entity = e
	globalThis.Fight = {
		turn: 1, me, getNearestEnemy: () => list[0] ?? null, getAliveEnemies: () => list,
		getEnemies: () => list, getAllies: () => [me],
		weaponCells: (target, w) => [...grid.values()].filter((from) => {
			const d = distance(from, target.cell)
			return d >= w.minRange && d <= w.maxRange
		})
	}
	globalThis.Field = {
		cellFromXY: cell, lineOfSight: () => true, distance, getObstacles: () => [],
		getCellFromXY: cell
	}
	globalThis.Chip = { bandage: { name: "bandage", cost: 2, minRange: 0, maxRange: 1, features: [] } }
	const config = new LogConfig()
	config.setAll(false)
	initLeekLogging(config)
	return { me, chest: theChest, enemy: theEnemy, events, list }
}

function buildContext(w) {
	const memory = new EnemyMemory()
	memory.updateReachable(w.me, [], aliveEnemies(), Fight.turn)
	memory.updateThreatMap(w.me, aliveEnemies(), Fight.turn)
	return { reachable: memory.getReachable(w.me.id), threat: memory.getThreatMap(), memory }
}

test("danger map and tactical planner agree on the enemy count when a chest is the nearest entity", () => {
	globalThis.Chest = FakeChest
	const w = arena()
	const context = buildContext(w)
	assert.equal(context.threat.enemyCount, 1)
	assert.equal(context.memory.has?.(w.chest.id) ?? false, false, "the chest never enters the enemy memory")
	const result = evaluateTacticalPlans(w.me, new LeekProfile(), context)
	assert.notEqual(result.plan, null, `no fallback expected, got: ${result.reason}`)
	assert.equal(result.plan.target.id, w.enemy.id)
	executeTacticalPlan(w.me, result.plan)
	assert.ok(w.events.length > 0)
	assert.ok(w.events.every((event) => event === `shoot:${w.enemy.id}`), w.events.join(","))
	assert.equal(w.chest.life, 100)
})

test("control: without the Chest class the same chest is a plain unarmed enemy and the planner falls back", () => {
	delete globalThis.Chest
	const w = arena()
	const context = buildContext(w)
	assert.equal(context.threat.enemyCount, 1)
	assert.equal(evaluateTacticalPlans(w.me, new LeekProfile(), context).reason, "stale/inconsistent enemy count")
})

test("an armed chest still adds nothing to the danger map or its breakdown", () => {
	globalThis.Chest = FakeChest
	const w = arena({ chestArmed: true })
	const context = buildContext(w)
	assert.equal(context.threat.enemyCount, 1)
	for (const entry of context.reachable.entries()) {
		const danger = context.threat.dangerAt(entry.cell)
		assert.ok(danger === null || danger >= 0)
	}
	const ids = new Set()
	for (const entry of context.threat.entries?.() ?? []) {
		for (const part of entry.breakdown) ids.add(part.enemyId)
	}
	assert.ok(!ids.has(w.chest.id))
	assert.equal(evaluateTacticalPlans(w.me, new LeekProfile(), context).plan?.target.id, w.enemy.id)
})

test("planAct without context (legacy path) shoots the enemy, never the nearer chest", () => {
	globalThis.Chest = FakeChest
	const w = arena()
	planAct(w.me, new LeekProfile())
	assert.ok(w.events.includes(`shoot:${w.enemy.id}`), `expected a shot at the enemy, got: ${w.events.join(",")}`)
	assert.ok(!w.events.includes(`shoot:${w.chest.id}`))
	assert.equal(w.chest.life, 100)
})

test("only a chest alive: planAct does nothing and never targets it", () => {
	globalThis.Chest = FakeChest
	const w = arena({ enemy: false })
	const context = buildContext(w)
	assert.equal(context.threat.enemyCount, 0)
	planAct(w.me, new LeekProfile(), context)
	assert.deepEqual(w.events, [])
	assert.equal(w.chest.life, 100)
})

test("opening weapon: not equipped when a weapon is already held, when dead, or when the TP are spent", () => {
	globalThis.Chest = FakeChest
	const w = arena({ enemy: false })
	w.me.weapon = w.me.weapons[0]
	equipOpeningWeapon(w.me)
	w.me.weapon = null
	w.me.life = 0
	equipOpeningWeapon(w.me)
	w.me.life = 100
	w.me.tp = 0
	equipOpeningWeapon(w.me)
	assert.deepEqual(w.events, [])
	w.me.tp = 1
	equipOpeningWeapon(w.me)
	assert.deepEqual(w.events, ["equip:gun"])
})

test("turn() with a chest as the only enemy: the chest is listed apart, no error, nothing shot", async () => {
	globalThis.Chest = FakeChest
	const { turn } = await import("../dist/Main/Kassbi_Class.js")
	const { enemyMemory, chestMemory } = await import("../dist/Brain/TurnObservation.js")
	const w = arena({ enemy: false })
	w.me.weapon = null
	turn()
	assert.equal(chestMemory.has(w.chest.id), true)
	assert.equal(enemyMemory.has(w.chest.id), false)
	assert.ok(!w.events.some((event) => event.startsWith("shoot")))
	assert.deepEqual(w.events, ["equip:gun"], "turn 1 still equips the best weapon")
})
