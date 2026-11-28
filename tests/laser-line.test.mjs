import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
delete globalThis.System

const { AREA_LASER_LINE, isLaser, laserBalance, laserHits, laserLine } =
	await import("../dist/Classes/Context/LaserLine.js")
const { evaluateTacticalPlans } = await import("../dist/Classes/Plannification/TacticalPlanner.js")
const { executeTacticalPlan } = await import("../dist/Classes/Plannification/TacticalExecution.js")
const { executeReservePlan } = await import("../dist/Classes/Plannification/ReservePlan.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig, LOG_CONTEXT } = await import("../dist/Toolbox/Logger.js")

class FakeChest {}

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const laser = (extra = {}) => ({
	id: 42, name: "laser", cost: 5, minRange: 2, maxRange: 9, maxUses: -1, needsLos: true, launchType: 1, area: AREA_LASER_LINE,
	features: [{ type: Effect.DAMAGE, minValue: 20, maxValue: 20 }], ...extra
})

/**
 * Moi en (0,0), sans PM, 5 PT : un seul tir de laser (20 dégâts moyens). `enemies`, `allies`, `chests` : [x, y, vie].
 * Deux ennemis ou plus : pas de terme `N` (un seul ennemi), le score vaut exactement U + touches collatérales.
 */
function world({ enemies = [], allies = [], chests = [], weapon = laser(), obstacles = [] } = {}) {
	const grid = new Map()
	for (let x = -2; x <= 12; x++) for (let y = -2; y <= 12; y++) {
		grid.set(`${x},${y}`, { id: grid.size, x, y, entity: null, obstacle: false, empty: true })
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	for (const [x, y] of obstacles) cell(x, y).obstacle = true
	const events = []
	const config = new LogConfig()
	config.setAll(false)
	config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	const aligned = (from, to) => (from.x === to.x || from.y === to.y)
	const hit = (from, to, item) => aligned(from, to) && distance(from, to) >= item.minRange && distance(from, to) <= item.maxRange
	const me = {
		id: 1, name: "me", cell: cell(0), life: 100, maxLife: 100, strength: 0, wisdom: 0, absoluteShield: 0,
		relativeShield: 0, tp: 5, mp: 0, weapon, weapons: [weapon], chips: [], say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) { return this.tp >= this.weapon.cost && target.life > 0 && hit(this.cell, target.cell, this.weapon) },
		canUseChip: () => false,
		chipCells: () => [],
		setWeapon() { return true },
		moveToward() { return 0 },
		moveAwayFrom() { return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target))
			events.push(`shoot:${target.id}`)
			this.tp -= this.weapon.cost
			return 1
		},
		useChip: () => 0
	}
	let nextId = 2
	const make = ([x, y, life = 100], extra = {}) => {
		const entity = {
			id: nextId++, name: `e${nextId}`, cell: cell(x, y), life, maxLife: 100, mp: 0, tp: 6, strength: 0,
			weapon: null, weapons: [], chips: [], absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], ...extra
		}
		entity.cell.entity = entity
		return entity
	}
	const foes = enemies.map((spec) => make(spec))
	const friends = allies.map((spec) => make(spec))
	const boxes = chests.map((spec) => {
		const chest = Object.assign(Object.create(FakeChest.prototype), make(spec))
		chest.cell.entity = chest
		return chest
	})
	me.cell.entity = me
	globalThis.Chest = FakeChest
	const everyone = () => [...foes, ...boxes]
	globalThis.Fight = {
		turn: 1, me, getNearestEnemy: () => foes[0] ?? null, getAliveEnemies: () => everyone().filter((e) => e.life > 0),
		getEnemies: everyone, getAllies: () => [me, ...friends],
		weaponCells: (target, w) => [...grid.values()].filter((from) => hit(from, target.cell, w))
	}
	globalThis.Field = { cellFromXY: cell, lineOfSight: () => true, distance, getObstacles: () => [] }
	const reachable = computeReachableCells(me, 0, Fight.turn)
	const context = () => ({
		reachable, threat: new ThreatMap(me.id, 1, new Map([...reachable.entries()].map((entry) =>
			[entry.cell.x * 4096 + entry.cell.y, { cell: entry.cell, danger: 0, mpCost: entry.cost, breakdown: [] }])), {
			candidateCells: reachable.size, truncated: false, inputsTruncated: false,
			pairsEvaluated: 0, lineOfSightCalls: 0, enemyCount: foes.length
		})
	})
	const profile = new LeekProfile()
	return { me, foes, friends, boxes, events, cell, grid, context, evaluate: () => evaluateTacticalPlans(me, profile, context()), profile }
}

test("laser geometry: min range skipped, same axis only, obstacle stops a LOS weapon, same cell goes down", () => {
	const cells = new Map()
	for (let x = -1; x <= 10; x++) for (let y = -1; y <= 10; y++) cells.set(`${x},${y}`, { x, y, obstacle: false, entity: null })
	const at = (x, y) => cells.get(`${x},${y}`) ?? null
	const from = at(2, 2)
	const ids = (line) => line.map((c) => `${c.x},${c.y}`)
	assert.deepEqual(ids(laserLine(from, at(5, 2), laser({ maxRange: 5 }), at)), ["4,2", "5,2", "6,2", "7,2"])
	assert.deepEqual(ids(laserLine(from, at(2, 0), laser({ maxRange: 4 }), at)), ["2,0", "2,-1"].filter((id) => cells.has(id)))
	assert.deepEqual(laserLine(from, at(4, 3), laser(), at), [])
	assert.deepEqual(ids(laserLine(from, from, laser({ maxRange: 3 }), at)), ["2,4", "2,5"])
	at(6, 2).obstacle = true
	assert.deepEqual(ids(laserLine(from, at(5, 2), laser({ maxRange: 9 }), at)), ["4,2", "5,2"])
	assert.equal(laserLine(from, at(5, 2), laser({ maxRange: 9, needsLos: false }), at).length, 7)
	assert.equal(isLaser({ area: AREA_LASER_LINE }), true)
	assert.equal(isLaser({ area: 1 }), false)
	assert.equal(isLaser({}), false)
})

test("laser balance: other enemies add, allies subtract, each bounded by its life, the primary target is not counted twice", () => {
	const primary = { id: 1, life: 100 }
	const hits = { enemies: [primary, { id: 2, life: 15 }], allies: [{ id: 3, life: 8 }, { id: 4, life: 100 }], chests: [] }
	assert.equal(laserBalance(hits, 1, () => 20, primary), 15 - 8 - 20)
	assert.equal(laserBalance(hits, 2, () => 20, primary), 15 - 8 - 40)
	const line = [{ entity: { id: 9, life: 0 } }, { entity: primary }, { entity: { id: 8, life: 5 } }]
	const found = laserHits(line, (entity) => entity.id === 8 ? "ally" : "enemy")
	assert.deepEqual([found.enemies.length, found.allies.length], [1, 1])
})

test("planning: a laser crossing two enemies scores more than one that crosses a single enemy", () => {
	// Deux ennemis dans les deux cas (donc pas de `N`) : seul l'alignement change. Un monde à la fois (globaux du jeu).
	const planAligned = world({ enemies: [[3, 0], [6, 0]] }).evaluate().plan
	const planApart = world({ enemies: [[3, 0], [4, 4]] }).evaluate().plan
	assert.equal(planAligned.weaponShots, 1)
	assert.equal(planAligned.usefulDamage, 20)
	assert.equal(planAligned.score - planApart.score, 20)
})

test("planning: the aim is chosen to hit the most enemies, even when the main target is not the nearest", () => {
	// Cible la plus proche (0,3) seule sur sa ligne ; (4,0) et (7,0) sont alignés : viser l'un touche les deux.
	const w = world({ enemies: [[0, 3], [4, 0], [7, 0]] })
	const { plan } = w.evaluate()
	assert.equal(plan.score, 40)
	assert.ok([3, 4].includes(plan.target.id))
})

test("planning: an ally on the line lowers the score by its damage bounded by its life, and steers the aim away", () => {
	const w = world({ enemies: [[3, 0], [0, 4]], allies: [[6, 0, 8], [0, 7, 100]] })
	const { plan } = w.evaluate()
	assert.equal(plan.target.id, 2, "line with the weak ally (8 life) costs 8, the other 20")
	assert.equal(plan.score, 20 - 8)
	assert.deepEqual(plan.laserAllies, [w.friends[0].id])
	// Même plan sans allié : 20.
	assert.equal(world({ enemies: [[3, 0], [0, 4]] }).evaluate().plan.score, 20)
})

test("planning: a shot that costs more on allies than it brings is not taken", () => {
	const w = world({ enemies: [[3, 0], [8, 8]], allies: [[6, 0, 100]] })
	const { plan } = w.evaluate()
	assert.equal(plan === null || plan.weaponShots === 0, true)
	executeTacticalPlan(w.me, plan ?? { target: w.foes[0], shotCell: w.me.cell, destination: w.me.cell, beforeMp: 0, afterMp: 0,
		weapon: null, weaponShots: 0, chips: [], protection: [], tpUsed: 0, usefulDamage: 0, danger: 0, score: 0 })
	assert.deepEqual(w.events, [])
})

test("planning: a chest on the line rules the shot out, behind the target as well as in front", () => {
	for (const chest of [[6, 0], [2, 0]]) {
		const w = world({ enemies: [[3, 0], [0, 4]], chests: [chest] })
		const { plan } = w.evaluate()
		assert.equal(plan.target.id, 3, `chest at ${chest}: the other line is chosen`)
		assert.equal(plan.score, 20)
	}
	const only = world({ enemies: [[3, 0], [8, 8]], chests: [[6, 0]] })
	const { plan } = only.evaluate()
	assert.equal(plan === null || plan.weaponShots === 0, true)
})

test("execution: the real line is rechecked, an unplanned ally or a chest cancels the shot", () => {
	const w = world({ enemies: [[3, 0], [0, 4]], allies: [[6, 0, 8], [0, 7, 100]] })
	const { plan } = w.evaluate()
	// Un allié arrive sur la ligne choisie après le plan.
	const late = { id: 99, name: "late", cell: w.cell(9, 0), life: 50, maxLife: 50 }
	late.cell.entity = late
	w.friends.push(late)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, [], "ally #99 was not planned")
	// Sans nouvel arrivant : le tir part.
	const ok = world({ enemies: [[3, 0], [0, 4]], allies: [[6, 0, 8], [0, 7, 100]] })
	executeTacticalPlan(ok.me, ok.evaluate().plan)
	assert.deepEqual(ok.events, ["shoot:2"])
	// Un coffre apparaît sur la ligne.
	const box = world({ enemies: [[3, 0], [0, 4]] })
	const chestPlan = box.evaluate().plan
	const chest = Object.assign(Object.create(FakeChest.prototype), { id: 77, name: "chest", cell: box.cell(5, 0), life: 50, maxLife: 50 })
	chest.cell.entity = chest
	box.boxes.push(chest)
	executeTacticalPlan(box.me, chestPlan)
	assert.deepEqual(box.events, [])
})

test("reserve plan (plan B): never fires a laser through a chest or into allies worth more than the enemies", () => {
	const run = (spec) => {
		const w = world(spec)
		const done = executeReservePlan(w.me, w.profile, undefined, undefined)
		return { done, events: w.events }
	}
	assert.deepEqual(run({ enemies: [[3, 0]] }).events, ["shoot:2"])
	assert.deepEqual(run({ enemies: [[3, 0]], chests: [[6, 0]] }).events, [])
	assert.deepEqual(run({ enemies: [[3, 0]], allies: [[6, 0, 100]] }).events, [])
	assert.deepEqual(run({ enemies: [[3, 0], [7, 0]], allies: [[6, 0, 100]] }).events, ["shoot:2"], "enemy 100 life behind outweighs nothing: 20 + 20 - 20 > 0")
})
