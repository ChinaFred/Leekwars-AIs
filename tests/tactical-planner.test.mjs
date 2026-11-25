import assert from "node:assert/strict"
import test from "node:test"
import { evaluateTacticalPlans, executeTacticalPlan, TACTICAL_LIMITS } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { EnemyMemory } from "../dist/Classes/Context/EnemyMemory.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { isCellInLaunchPattern } from "../dist/Classes/Context/LaunchPattern.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
const item = (name, cost, damage, options = {}) => ({
	name, cost, minRange: 1, maxRange: 5, maxUses: -1, needsLos: false,
	features: [{ type: Effect.DAMAGE, minValue: damage, maxValue: damage }], ...options
})
const chip = (name, cost, damage, options = {}) =>
	item(name, cost, damage, { currentCooldown: 0, cooldown: 1, ...options })
const shield = (cost = 2, amount = 30) => chip("shield", cost, 0, {
	minRange: 0, features: [{ type: Effect.ABSOLUTE_SHIELD, minValue: amount, maxValue: amount }]
})
const xyKey = (cell) => cell.x * 4096 + cell.y
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

function world({ tp = 6, mp = 0, gun = item("gun", 2, 10), weapons, chips = [],
	positions = [[3, 0]], danger = () => 0, obstacles = [], lineOfSight = () => true,
	life = 100, cells: coordinates } = {}) {
	delete globalThis.System
	const grid = new Map()
	const coords = coordinates ?? Array.from({ length: 11 }, (_, i) =>
		Array.from({ length: 9 }, (_, j) => [i - 4, j - 4])).flat()
	for (const [x, y] of coords) grid.set(`${x},${y}`, {
		id: grid.size, x, y, entity: null, obstacle: false, empty: true
	})
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	for (const [x, y] of obstacles) Object.assign(cell(x, y), { obstacle: true, empty: false })
	const events = []
	const config = new LogConfig()
	config.setAll(false)
	config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	const me = {
		id: 1, name: "me", cell: cell(0), life, maxLife: 100, strength: 0, wisdom: 0,
		absoluteShield: 0, relativeShield: 0, tp, mp, weapon: gun, weapons: weapons ?? (gun ? [gun] : []), chips,
		say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) { return this.weapon !== null && this.tp >= this.weapon.cost &&
			target.life > 0 && hit(this.cell, target.cell, this.weapon) && !this.denyWeapon },
		canUseChip(chip, target) { return chip.currentCooldown === 0 && chip.maxUses !== 0 &&
			this.tp >= chip.cost && target.life > 0 && hit(this.cell, target.cell, chip) && !this.denyChips },
		chipCells(chip, target) { return [...grid.values()].filter((from) => hit(from, target.cell, chip)) },
		setWeapon(weapon) {
			events.push(`equip:${weapon.name}`)
			if (this.failEquip) return false
			this.tp--
			this.weapon = weapon
			return true
		},
		moveToward(destination, max = this.mp) {
			const targetCell = destination.cell ?? destination
			const reachable = computeReachableCells(this, Math.min(this.mp, max), Fight.turn)
			const cost = reachable.costTo(targetCell)
			if (cost === null || this.failMove) return 0
			this.cell.entity = null
			this.cell.empty = true
			this.cell = targetCell
			targetCell.entity = this
			targetCell.empty = false
			this.mp -= cost
			events.push(`move:${targetCell.x},${targetCell.y}:${cost}`)
			this.afterMove?.()
			return cost
		},
		moveAwayFrom() { events.push("legacy-retreat"); return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target))
			this.tp -= this.weapon.cost
			events.push(`shoot:${target.id}`)
			target.life -= this.weapon.features[0].minValue
			this.afterShot?.()
			return 1
		},
		useChip(chip, target) {
			assert.ok(this.canUseChip(chip, target))
			this.tp -= chip.cost
			chip.currentCooldown = chip.cooldown
			events.push(`chip:${chip.name}:${target.id}`)
			for (const f of chip.features) {
				if (f.type === Effect.DAMAGE) target.life -= f.minValue
				if (f.type === Effect.HEAL) target.life = Math.min(target.maxLife, target.life + f.minValue)
			}
			return 1
		}
	}
	const enemies = positions.map(([x, y], i) => ({
		id: i + 2, name: `enemy${i}`, cell: cell(x, y), life: 100, maxLife: 100, mp: 0,
		weapon: null, absoluteShield: 0, relativeShield: 0
	}))
	me.cell.entity = me
	for (const enemy of enemies) enemy.cell.entity = enemy
	function hit(from, to, item) {
		const d = distance(from, to)
		return d >= item.minRange && d <= item.maxRange &&
			isCellInLaunchPattern(item.launchType, to.x - from.x, to.y - from.y) &&
			(!item.needsLos || lineOfSight(from, to))
	}
	globalThis.Fight = {
		turn: 1, me, getNearestEnemy: () => enemies[0], getAliveEnemies: () => enemies,
		getAllies: () => [me], getEnemies: () => enemies,
		weaponCells: (target, weapon) => [...grid.values()].filter((from) => hit(from, target.cell, weapon))
	}
	globalThis.Field = { cellFromXY: cell, lineOfSight, distance, getObstacles: () => [] }
	globalThis.Chip = { bandage: chip("bandage", 2, 0) }
	const reachable = computeReachableCells(me, mp, Fight.turn)
	function context(options = {}) {
		const entries = new Map([...reachable.entries()].filter((entry) => !options.missing?.(entry.cell))
			.map((entry) => [xyKey(entry.cell), { cell: entry.cell, mpCost: entry.cost,
				danger: danger(entry.cell), breakdown: [] }]))
		return { reachable, threat: new ThreatMap(me.id, options.turn ?? 1, entries, {
			candidateCells: reachable.size, truncated: false, inputsTruncated: false,
			pairsEvaluated: 0, lineOfSightCalls: 0, enemyCount: enemies.length, ...options
		}) }
	}
	const profile = new LeekProfile()
	const evaluate = (input = context()) => evaluateTacticalPlans(me, profile, input)
	return { me, enemies, events, cell, grid, profile, context, evaluate }
}

test("exact PT search beats the ratio-greedy chip combination", () => {
	const w = world({ gun: item("gun", 3, 4), chips: [
		chip("greedy", 4, 9), chip("pairA", 3, 6), chip("pairB", 3, 6)
	] })
	const { plan } = w.evaluate()
	assert.equal(plan.usefulDamage, 12)
	assert.deepEqual(plan.chips.map((c) => c.name), ["pairA", "pairB"])
	assert.equal(plan.tpUsed, 6)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:pairA:2", "chip:pairB:2"])
})

test("a lower-ratio chip uses residual PT and chip-only fighters work without a weapon", () => {
	let w = world({ gun: item("gun", 4, 10), chips: [chip("filler", 2, 4)] })
	let plan = w.evaluate().plan
	assert.equal(plan.usefulDamage, 14)
	assert.equal(plan.weaponShots, 1)
	w = world({ gun: null, chips: [chip("attack", 3, 11)] })
	plan = w.evaluate().plan
	assert.equal(plan.usefulDamage, 11)
	assert.equal(plan.weapon, null)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:attack:2"])
})

test("equipment costs are paid in the competing plans, not after weapon selection", () => {
	const old = item("current", 3, 10)
	const expensive = item("alternative", 3, 12)
	const w = world({ gun: old, weapons: [old, expensive] })
	const plan = w.evaluate().plan
	assert.equal(plan.weapon, old)
	assert.equal(plan.usefulDamage, 20)
	assert.equal(plan.tpUsed, 6)
	const better = item("better", 2, 25)
	w.me.weapons.push(better)
	const switchPlan = w.evaluate().plan
	assert.equal(switchPlan.weapon, better)
	assert.equal(switchPlan.tpUsed, 5)
	executeTacticalPlan(w.me, switchPlan)
	assert.deepEqual(w.events, ["equip:better", "shoot:2", "shoot:2"])
	assert.equal(w.me.tp, 1)
})

test("joint planning reserves PT for protection before exhausting the attack budget", () => {
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], danger: () => 40 })
	const plan = w.evaluate().plan
	assert.equal(plan.weaponShots, 1)
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.danger, 40, "raw danger is retained")
	assert.equal(plan.score, 5)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:shield:1", "shoot:2"])
	const forbidden = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], danger: () => 40 })
	forbidden.profile.allowShielding = false
	assert.equal(forbidden.evaluate().plan.protection.length, 0)
})

test("healing competes with damage and is capped at actual missing life", () => {
	const heal = chip("heal", 2, 0, { minRange: 0,
		features: [{ type: Effect.HEAL, minValue: 30, maxValue: 30 }] })
	const w = world({ tp: 4, life: 60, gun: item("gun", 2, 10), chips: [heal], danger: () => 20 })
	const plan = w.evaluate().plan
	assert.equal(plan.protection[0], heal)
	assert.equal(plan.weaponShots, 1)
	w.me.life = 99
	assert.equal(w.evaluate().plan.protection.length, 0)
})

test("destination must be reachable FROM the shot cell with remaining PM, including return travel", () => {
	const w = world({ tp: 2, mp: 2, gun: item("gun", 2, 50, { maxRange: 3 }),
		positions: [[4, 0]], cells: Array.from({ length: 8 }, (_, i) => [i - 3, 0]),
		danger: (c) => c.x === -2 ? 0 : c.x === 0 ? 10 : 80 })
	const plan = w.evaluate().plan
	assert.equal(plan.shotCell.x, 1)
	assert.equal(plan.destination.x, 0, "cannot travel from +1 to -2 with just one PM left")
	assert.equal(plan.beforeMp, 1)
	assert.equal(plan.afterMp, 1)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["move:1,0:1", "shoot:2", "move:0,0:1"])
	assert.equal(w.me.mp, 0)
})

test("shoot then retreat is evaluated without giving up the shot; allowHiding is respected", () => {
	const w = world({ tp: 2, mp: 1, positions: [[2, 0]], gun: item("gun", 2, 30, { maxRange: 2 }),
		danger: (c) => c.x === -1 ? 0 : 40 })
	let plan = w.evaluate().plan
	assert.equal(plan.beforeMp, 0)
	assert.equal(plan.destination.x, -1)
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["shoot:2", "move:-1,0:1"])
	const stationary = world({ tp: 2, mp: 1, positions: [[2, 0]], gun: item("gun", 2, 30, { maxRange: 2 }),
		danger: (c) => c.x === -1 ? 0 : 40 })
	stationary.profile.allowHiding = false
	plan = stationary.evaluate().plan
	assert.equal(plan.afterMp, 0)
	assert.equal(plan.usefulDamage, 30)
})

test("all practicable targets compete; overkill is capped and never removes their threat", () => {
	const w = world({ tp: 2, mp: 1, positions: [[2, 0], [3, 0]], gun: item("gun", 2, 30),
		danger: (c) => c.x === -1 ? 10 : 50 })
	w.enemies[0].life = 1
	const plan = w.evaluate().plan
	assert.equal(plan.target, w.enemies[1])
	assert.equal(plan.usefulDamage, 30)
	assert.equal(plan.danger, 10)
	assert.equal(plan.destination.x, -1)
	w.enemies[1].life = 10
	const expectedKill = w.evaluate().plan
	assert.equal(expectedKill.usefulDamage, 10)
	assert.equal(expectedKill.danger, 10, "no expected-kill threat discount")
	assert.equal(expectedKill.destination.x, -1)
})

test("range, native LOS and launch pattern, cooldowns and item limits filter plans", () => {
	const w = world({ tp: 6, gun: item("gun", 2, 10, { maxUses: 1 }), chips: [
		chip("cooldown", 1, 200, { currentCooldown: 1 }),
		chip("forbidden", 1, 200, { maxUses: 0 }),
		chip("short", 1, 200, { maxRange: 1 }),
		chip("min", 1, 200, { minRange: 4 }),
		chip("LOS", 1, 200, { needsLos: true }),
		chip("diagonal", 1, 200, { launchType: 2 }),
		chip("legal", 3, 9)
	], lineOfSight: () => false })
	const plan = w.evaluate().plan
	assert.equal(plan.weaponShots, 1)
	assert.deepEqual(plan.chips.map((c) => c.name), ["legal"])
	assert.equal(plan.usefulDamage, 19)
	assert.equal(plan.tpUsed, 5)
})

test("obstacles and occupied cells are not traversed or selected as destinations", () => {
	const w = world({ mp: 2, positions: [[2, 0]], obstacles: [[-1, 0], [0, -1], [0, 1]],
		danger: (c) => c.x < 0 ? 0 : 10 })
	const plan = w.evaluate().plan
	assert.ok(plan)
	assert.notEqual(plan.destination.x, -1)
	assert.ok(plan.beforeMp + plan.afterMp <= 2)
})

test("missing, stale, truncated, invalid danger and inconsistent reachable data require explicit fallback", () => {
	const w = world({ mp: 1 })
	const wrongLeek = w.context()
	wrongLeek.threat.entityId = 99
	const wrongReachableLeek = w.context()
	wrongReachableLeek.reachable = { ...wrongReachableLeek.reachable, entityId: 99,
		isUpToDate: () => false }
	const truncatedReachable = w.context()
	truncatedReachable.reachable = { ...truncatedReachable.reachable, truncated: true }
	for (const context of [
		undefined, { reachable: null, threat: null },
		wrongLeek, wrongReachableLeek, truncatedReachable,
		w.context({ turn: 0 }), w.context({ truncated: true }), w.context({ inputsTruncated: true }),
		w.context({ missing: (cell) => cell.x === 1 }), w.context({ candidateCells: 999 })
	]) {
		const result = evaluateTacticalPlans(w.me, w.profile, context)
		assert.equal(result.plan, null)
		assert.match(result.reason, /missing|stale|truncated/)
	}
	const invalid = world({ danger: () => NaN })
	assert.equal(invalid.evaluate().plan, null)
	w.me.mp = 2
	assert.match(w.evaluate().reason, /stale/)
	assert.deepEqual(w.events, [], "evaluation never spends resources")
})

test("fallback is logged and preserves legacy shots instead of interpreting unknown danger as zero", () => {
	const w = world({ tp: 4 })
	const messages = []
	const original = console.log
	try {
		console.log = (message) => messages.push(message)
		planAct(w.me, w.profile, w.context({ truncated: true }))
	} finally { console.log = original }
	assert.ok(messages.some((m) => m.includes("[Tactical] fallback: truncated data; legacy planning")))
	assert.deepEqual(w.events, ["shoot:2", "shoot:2"])
})

test("planAct uses the tactical path when complete current maps are provided", () => {
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], danger: () => 40 })
	planAct(w.me, w.profile, w.context())
	assert.deepEqual(w.events, ["chip:shield:1", "shoot:2"])
})

test("bounded search and low operation reserve fall back before any action", () => {
	const w = world({ tp: TACTICAL_LIMITS.tp + 1 })
	assert.match(w.evaluate().reason, /bound/)
	w.me.tp = 6
	globalThis.System = { operations: 851, maxOperations: 1000 }
	assert.match(w.evaluate().reason, /operations reserve/)
	delete globalThis.System
	assert.deepEqual(w.events, [])
})

test("provider interruption retains only a complete incumbent when the execution budget permits", () => {
	for (const { start, max, after, retained } of [
		{ start: 600, max: 1000, after: 851, retained: true },
		{ start: 1000, max: 10000, after: 4000, retained: true },
		{ start: 600, max: 1000, after: 969, retained: true },
		{ start: 600, max: 1000, after: 970, retained: false },
		{ start: 600, max: 1000, after: 971, retained: false }
	]) {
		const w = world()
		let operations = start
		globalThis.System = { get operations() { return operations }, maxOperations: max }
		const nativeWeaponCells = Fight.weaponCells
		Fight.weaponCells = (...args) => {
			operations = after
			return nativeWeaponCells(...args)
		}
		try {
			const result = w.evaluate()
			assert.equal(result.plan !== null, retained)
			assert.match(result.reason, /operations reserve/)
			assert.deepEqual(w.events, [], "evaluation must not spend resources after reserve exhaustion")
			if (retained) {
				assert.match(result.plan.searchStatus, /complete incumbent/)
				assert.ok(result.plan.usefulDamage > 0)
				executeTacticalPlan(w.me, result.plan)
				assert.ok(w.events.some(event => event.startsWith("shoot:")))
				assert.ok(w.me.tp >= 0 && w.me.mp >= 0)
			}
		} finally {
			Fight.weaponCells = nativeWeaponCells
			delete globalThis.System
		}
	}
})

test("global search ceiling is exactly 80 %: 799 999 completes, 800 000 stops (shared with the plan B)", () => {
	for (const [after, stopped] of [[799999, false], [800000, true], [800001, true]]) {
		const w = world()
		let operations = 550000 // départ + 249 999 < plafond relatif de 300 000 : seul le plafond global joue
		globalThis.System = { get operations() { return operations }, maxOperations: 1000000 }
		const nativeWeaponCells = Fight.weaponCells
		Fight.weaponCells = (...args) => {
			operations = after
			return nativeWeaponCells(...args)
		}
		try {
			const result = w.evaluate()
			assert.equal(result.reason === "complete search", !stopped, `after ${after}`)
			if (stopped) assert.match(result.reason, /operations reserve/)
			assert.ok(result.plan !== null)
			assert.deepEqual(w.events, [])
		} finally {
			Fight.weaponCells = nativeWeaponCells
			delete globalThis.System
		}
	}
})

test("unexpected tactical API exceptions log a fallback and run legacy planning without tactical actions", () => {
	const w = world({ tp: 4 })
	const messages = []
	const nativeWeaponCells = Fight.weaponCells
	const originalLog = console.log
	Fight.weaponCells = () => { throw new Error("native provider fixture failure") }
	try {
		console.log = (message) => messages.push(message)
		assert.doesNotThrow(() => planAct(w.me, w.profile, w.context()))
	} finally {
		Fight.weaponCells = nativeWeaponCells
		console.log = originalLog
	}
	assert.ok(messages.some((message) =>
		message.includes("[Tactical] fallback: evaluation API unavailable; legacy planning")))
	assert.deepEqual(w.events, ["shoot:2", "shoot:2"])
	assert.ok(!messages.some((message) => message.includes("native provider fixture failure")),
		"the current fallback log intentionally hides the underlying exception detail")
})

test("target-restricted offensive chips are rejected before a plan can consume movement", () => {
	const restricted = chip("enemy-forbidden", 2, 60, { maxRange: 2 })
	const w = world({ tp: 2, mp: 1, gun: null, chips: [restricted] })
	w.me.denyChips = true
	assert.equal(w.me.canUseChip(restricted, w.enemies[0]), false)
	const result = w.evaluate()
	assert.equal(result.plan, null, "geometric chip cells alone do not prove target legality")
})

test("execution rechecks failed equipment, cooldown/LOS/TP, and stops firing at a dead target", () => {
	const old = item("old", 3, 1)
	const better = item("better", 2, 30)
	const w = world({ gun: old, weapons: [old, better], chips: [chip("extra", 1, 20)] })
	const plan = w.evaluate().plan
	w.me.failEquip = true
	w.me.denyChips = true
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["equip:better"], "no use of old weapon at the new weapon's cost")
	const dead = world({ gun: item("gun", 2, 60) })
	const deadPlan = dead.evaluate().plan
	assert.equal(deadPlan.weaponShots, 2)
	dead.me.afterShot = () => { dead.enemies[0].life = 0 }
	executeTacticalPlan(dead.me, deadPlan)
	assert.equal(dead.events.filter((e) => e.startsWith("shoot:")).length, 1)
	assert.equal(dead.me.tp, 4)
	const noTP = world()
	const noTPPlan = noTP.evaluate().plan
	noTP.me.tp = 0
	executeTacticalPlan(noTP.me, noTPPlan)
	assert.deepEqual(noTP.events, [])
})

test("joint planner stops remaining weapon shots after a native refusal, preserving real PT", () => {
	const w = world(), messages = [], original = console.log
	const native = w.me.useWeapon.bind(w.me)
	let calls = 0
	w.me.useWeapon = target => ++calls === 1 ? native(target) : 0
	try { console.log = m => messages.push(m); planAct(w.me, w.profile, w.context()) }
	finally { console.log = original }
	assert.equal(calls, 2)
	assert.deepEqual(w.events, ["shoot:2"])
	assert.equal(w.me.tp, 4)
	assert.ok(messages.some(m => m.includes("[Tactical] execution: weapon refused: result 0")))
	assert.ok(!messages.some(m => m.includes("[Tactical] fallback:")))
})

test("joint planner reports refused protection and executes only the planned shot", () => {
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], danger: () => 40 })
	const messages = [], original = console.log
	let calls = 0
	w.me.useChip = () => { calls++; return 0 }
	try { console.log = m => messages.push(m); planAct(w.me, w.profile, w.context()) }
	finally { console.log = original }
	assert.equal(calls, 1)
	assert.deepEqual(w.events, ["shoot:2"])
	assert.equal(w.me.tp, 2)
	assert.ok(messages.some(m => m.includes("[Tactical] execution: chip refused: shield, result 0")))
	assert.ok(!messages.some(m => m.includes("[Tactical] fallback:")))
})

test("joint planner scores only the complete validated danger snapshot", () => {
	const w = world({ mp: 2, tp: 2 }), context = w.context()
	const native = context.threat.dangerAt.bind(context.threat)
	let reads = 0
	context.threat.dangerAt = cell => { reads++; return native(cell) }
	const result = evaluateTacticalPlans(w.me, w.profile, context)
	assert.notEqual(result.plan, null)
	assert.equal(reads, context.reachable.size)
	assert.deepEqual(w.events, [])
})

test("EnemyMemory map omitting an unarmed enemy causes explicit unknown-danger fallback", () => {
	const w = world({ positions: [[3, 0], [4, 0]] })
	Object.assign(w.enemies[0], { tp: 4, strength: 0, weapon: item("enemy gun", 2, 10),
		weapons: [], chips: [] })
	Object.assign(w.enemies[1], { tp: 4, strength: 0, weapon: null, weapons: [], chips: [] })
	const memory = new EnemyMemory()
	memory.updateReachable(w.me, [], w.enemies, Fight.turn)
	memory.updateThreatMap(w.me, w.enemies, Fight.turn)
	const context = { reachable: memory.getReachable(w.me.id), threat: memory.getThreatMap() }
	assert.equal(context.threat.enemyCount, 1)
	assert.equal(evaluateTacticalPlans(w.me, w.profile, context).reason, "stale/inconsistent enemy count")
	const messages = [], original = console.log
	try { console.log = m => messages.push(m); planAct(w.me, w.profile, context) }
	finally { console.log = original }
	assert.deepEqual(w.events, ["shoot:2", "shoot:2", "shoot:2"])
	assert.ok(messages.some(m => m.includes("fallback: stale/inconsistent enemy count")))
	assert.ok(messages.some(m => m.includes("danger unknown")))
})

test("execution aborts a failed approach and checks final blockers after shooting", () => {
	const approach = world({ mp: 1, gun: item("gun", 2, 20, { maxRange: 2 }) })
	const plan = approach.evaluate().plan
	assert.equal(plan.beforeMp, 1)
	approach.me.failMove = true
	executeTacticalPlan(approach.me, plan)
	assert.deepEqual(approach.events, [])
	const retreat = world({ tp: 2, mp: 1, positions: [[2, 0]], gun: item("gun", 2, 30, { maxRange: 2 }),
		danger: (c) => c.x === -1 ? 0 : 40 })
	const retreatPlan = retreat.evaluate().plan
	retreat.me.afterShot = () => { retreat.cell(-1).entity = { id: 99 } }
	executeTacticalPlan(retreat.me, retreatPlan)
	assert.deepEqual(retreat.events, ["shoot:2"])
})

test("dynamic native checks reject a chip entering cooldown and shots losing LOS after approach", () => {
	const ready = chip("ready", 2, 60)
	const w = world({ tp: 4, chips: [ready] })
	const plan = w.evaluate().plan
	assert.equal(plan.chips[0], ready)
	ready.currentCooldown = 2
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["shoot:2"])
	const approach = world({ tp: 2, mp: 1, gun: item("gun", 2, 20, { maxRange: 2 }) })
	const approachPlan = approach.evaluate().plan
	approach.me.afterMove = () => { approach.me.denyWeapon = true }
	executeTacticalPlan(approach.me, approachPlan)
	assert.deepEqual(approach.events, ["move:1,0:1"])
})

test("profile role/aggression weights explicitly trade immediate damage against potential danger", () => {
	for (const [role, aggression, weight] of [
		["AGGRESSIVE", 0, 1.125], ["AGGRESSIVE", 100, 0.375],
		["BALANCED", 0, 1.5], ["BALANCED", 100, 0.5],
		["DEFENSIVE", 0, 1.875], ["DEFENSIVE", 100, 0.625]
	]) {
		const w = world({ tp: 2, gun: item("gun", 2, 30), danger: () => 10 })
		w.profile.setRole(role)
		w.profile.setAggression(aggression)
		assert.equal(w.evaluate().plan.score, 30 - weight * 10)
	}
})

// With aggression 50, a shot is worth 15 and the shield absorbs up to 30 danger.
for (const [role, crossover] of [
	["AGGRESSIVE", 20], ["BALANCED", 15], ["DEFENSIVE", 12]
]) {
	test(`${role} switches between two shots and protection at the score crossover`, () => {
		for (const [danger, expected] of [
			[crossover - 0.1, ["shoot:2", "shoot:2"]],
			[crossover + 0.1, ["chip:shield:1", "shoot:2"]]
		]) {
			const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], danger: () => danger })
			w.profile.setRole(role)
			planAct(w.me, w.profile, w.context())
			assert.deepEqual(w.events, expected, `${role}, danger ${danger}`)
		}
	})
}

for (const role of ["AGGRESSIVE", "BALANCED", "DEFENSIVE"]) test(`${role}: search boundaries retain a complete incumbent where permitted`, () => {
	for (const [start, max, below, boundary] of [
		[600, 1000, 849, 850], [1000, 10000, 3999, 4000]
	]) {
		const cases = [[below, true], [boundary, true], [boundary + 1, true]]
		if (max === 1000) cases.push([969, true], [970, false], [971, false])
		for (const [after, shouldPlan] of cases) {
			const w = world()
			w.profile.setRole(role)
			let operations = start
			globalThis.System = { get operations() { return operations }, maxOperations: max }
			const nativeWeaponCells = Fight.weaponCells
			Fight.weaponCells = (...args) => {
				operations = after
				return nativeWeaponCells(...args)
			}
			try {
				const result = w.evaluate()
				assert.equal(result.plan !== null, shouldPlan)
				if (after >= boundary) {
					assert.equal(result.reason, "operations reserve")
					if (shouldPlan) assert.match(result.plan.searchStatus, /complete incumbent/)
				}
				assert.deepEqual(w.events, [])
				if (after >= boundary && shouldPlan) {
					assert.ok(result.plan.usefulDamage > 0)
					executeTacticalPlan(w.me, result.plan)
					assert.ok(w.events.some(event => event.startsWith("shoot:")))
					assert.ok(w.me.tp >= 0 && w.me.mp >= 0)
				}
			} finally {
				Fight.weaponCells = nativeWeaponCells
				delete globalThis.System
			}
		}
	}
})

test("target shields lower useful damage; no reachable attack falls back for legacy approach", () => {
	const w = world({ tp: 2, positions: [[2, 0], [3, 0]] })
	w.enemies[0].relativeShield = 50
	w.enemies[0].absoluteShield = 2
	assert.equal(w.evaluate().plan.target, w.enemies[1])
	w.enemies.pop()
	assert.equal(w.evaluate().plan.usefulDamage, 3)
	const far = world({ tp: 2, positions: [[5, 0]], gun: item("gun", 2, 30, { maxRange: 1 }) })
	assert.equal(far.evaluate().plan, null)
	assert.deepEqual(far.events, [])
})

test("shared search handles the formerly bounded combination without spending PT or PM during evaluation", () => {
	const weapons = Array.from({ length: 4 }, (_, i) => item(`gun${i}`, 2, 10 + i, { maxRange: 20 }))
	const w = world({ tp: 30, mp: 4, gun: weapons[0], weapons,
		chips: Array.from({ length: 8 }, (_, i) => chip(`chip${i}`, 2, 8 + i, { maxRange: 20 })),
		positions: [[4, 0], [4, 1], [4, -1], [5, 0]] })
	const result = w.evaluate()
	assert.ok(result.plan)
	assert.equal(result.reason, "complete search")
	assert.ok(result.plan.tpUsed <= w.me.tp)
	assert.ok(result.plan.beforeMp + result.plan.afterMp <= w.me.mp)
	assert.deepEqual(w.events, [])
	assert.equal(w.me.tp, 30)
	assert.equal(w.me.mp, 4)
	executeTacticalPlan(w.me, result.plan)
	assert.ok(w.events.some(event => event.startsWith("chip:") || event.startsWith("shoot:")))
	assert.ok(w.me.tp >= 0 && w.me.mp >= 0)
})

test("active turn passes real EnemyMemory maps into the joint planner", async () => {
	globalThis.Color = { rgb: () => 0 }
	const { turn } = await import("../dist/Main/Kassbi_Class.js")
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()] })
	Object.assign(w.enemies[0], {
		tp: 4, strength: 0, weapon: item("enemy gun", 2, 20, { maxRange: 8 }),
		weapons: [], chips: [], effects: [], launchedEffects: []
	})
	initLeekLogging(new LogConfig().setAll(false))
	turn()
	assert.deepEqual(w.events, ["chip:shield:1", "shoot:2"])
})

test("active turn feeds the stagnation counter: observed once at the start of the turn and handed to the planner", async () => {
	globalThis.Color = { rgb: () => 0 }
	const { turn, stagnation } = await import("../dist/Main/Kassbi_Class.js")
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()] })
	Object.assign(w.enemies[0], {
		tp: 4, strength: 0, weapon: item("enemy gun", 2, 20, { maxRange: 8 }),
		weapons: [], chips: [], effects: [], launchedEffects: []
	})
	const observed = [], offense = []
	const lifeBefore = w.enemies[0].life, distanceBefore = distance(w.me.cell, w.enemies[0].cell)
	const observe = stagnation.observe, noteOffense = stagnation.noteOffense
	stagnation.observe = function (...args) { observed.push(args); return observe.apply(this, args) }
	stagnation.noteOffense = function () { offense.push(true); return noteOffense.apply(this) }
	try {
		initLeekLogging(new LogConfig().setAll(false))
		turn()
	} finally { delete stagnation.observe; delete stagnation.noteOffense }
	assert.deepEqual(observed, [[1, lifeBefore, distanceBefore]])
	assert.equal(offense.length, 1, "planAct received the counter: the enemy in a firing zone notified the tracker")
})

test("active turn hands the enemy positions to the stagnation counter just before observing (a moving enemy keeps the rule out of play)", async () => {
	globalThis.Color = { rgb: () => 0 }
	const { turn, stagnation } = await import("../dist/Main/Kassbi_Class.js")
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()] })
	Object.assign(w.enemies[0], {
		tp: 4, strength: 0, weapon: item("enemy gun", 2, 20, { maxRange: 8 }),
		weapons: [], chips: [], effects: [], launchedEffects: []
	})
	const calls = []
	const observe = stagnation.observe, note = stagnation.noteEnemyPositions
	stagnation.noteEnemyPositions = function (key) { calls.push(["positions", key]); return note.call(this, key) }
	stagnation.observe = function (...args) { calls.push(["observe"]); return observe.apply(this, args) }
	try {
		initLeekLogging(new LogConfig().setAll(false))
		turn()
	} finally { delete stagnation.observe; delete stagnation.noteEnemyPositions }
	assert.deepEqual(calls.map(([name]) => name), ["positions", "observe"], "positions first, then the observation of the same turn")
	assert.ok(calls[0][1].includes(`${w.enemies[0].cell.x},${w.enemies[0].cell.y}`), `key ${calls[0][1]}`)
})

test("killing the last enemy cancels its danger: finish it rather than shield and leave it alive", () => {
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 60), chips: [shield(2, 160)], danger: () => 200 })
	const { plan } = w.evaluate()
	assert.equal(plan.weaponShots, 2) // 120 dégâts moyens ≥ 100 PV × marge 1,1
	assert.equal(plan.protection.length, 0)
	assert.equal(plan.usefulDamage, 100)
	assert.equal(plan.danger, 200) // danger brut conservé dans le plan
})

test("killing one of two enemies does not waive the danger", () => {
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 60), chips: [shield(2, 160)],
		positions: [[3, 0], [3, 1]], danger: () => 200 })
	const { plan } = w.evaluate()
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.weaponShots, 1)
})

test("a kill needs a margin over the mean damage", () => {
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 52), chips: [shield(2, 160)], danger: () => 200 })
	const { plan } = w.evaluate() // 104 < 100 × 1,1 : pas de meurtre crédité
	assert.equal(plan.protection.length, 1)
})

test("a plan whose danger reaches my life loses to a survivable one, even with less damage", () => {
	const w = world({ tp: 6, mp: 0, gun: item("gun", 2, 30), chips: [shield(2, 25)], danger: () => 120 })
	const { plan } = w.evaluate()
	// 3 tirs (90) à danger 120 ≥ 100 PV : létal ; bouclier + 2 tirs (60) à danger 95 : on survit.
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.weaponShots, 2)
})

test("a plan is lethal only once the planned heal no longer covers the danger", () => {
	const w = world({ tp: 6, mp: 0, gun: item("gun", 2, 30), life: 40,
		chips: [chip("cure", 2, 0, { minRange: 0, features: [{ type: Effect.HEAL, minValue: 60, maxValue: 60 }] })],
		danger: () => 80 })
	const { plan } = w.evaluate()
	// (voir aussi le test de seuil ci-dessous : le soin doit compter dans la létalité, pas seulement dans le score)
	// Sans soin : 80 ≥ 40 PV. Avec le soin : 100 PV > 80, on joue le soin même si cela coûte un tir.
	assert.equal(plan.protection.length, 1)
})

test("lethality threshold: danger == my life is lethal, one point less is not (shield costs a shot)", () => {
	const setup = (danger) => world({ tp: 6, mp: 0, gun: item("gun", 2, 30), chips: [shield(2, 25)], danger: () => danger })
	// 3 tirs (90) sans bouclier ; bouclier + 2 tirs (60), danger réduit de 25.
	let { plan } = setup(100).evaluate() // 100 ≥ 100 PV : létal sans bouclier (90 − 100 − 1000) ; bouclier : 60 − 75
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.weaponShots, 2)
	;({ plan } = setup(99).evaluate()) // 99 < 100 PV : non létal, 90 − 99 = −9 bat 60 − 74 = −14
	assert.equal(plan.protection.length, 0)
	assert.equal(plan.weaponShots, 3)
})

test("the planned heal counts in the lethality threshold, not only in the score", () => {
	// PV 50, soin 20 (70 PV), danger 60, tir 30/2 PT, soin 2 PT. Sans soin : létal (60 ≥ 50), 3 tirs.
	// Avec soin : 60 < 70, non létal. Sans la pénalité létale, 3 tirs (90 − 60 = 30) battrait le soin (60 − 60 + 20 = 20).
	const w = world({ tp: 6, mp: 0, gun: item("gun", 2, 30), life: 50,
		chips: [chip("cure", 2, 0, { minRange: 0, features: [{ type: Effect.HEAL, minValue: 20, maxValue: 20 }] })],
		danger: () => 60 })
	const { plan } = w.evaluate()
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.weaponShots, 2)
})
