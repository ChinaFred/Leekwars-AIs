import assert from "node:assert/strict"
import test from "node:test"
import { TACTICAL_LIMITS } from "../dist/Classes/Plannification/TacticalTypes.js"
import { riskWeight, RETREAT_RISK_FACTOR } from "../dist/Classes/Plannification/TacticalScore.js"
import { evaluateTacticalPlans, selfHitRadius } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { executeTacticalPlan } from "../dist/Classes/Plannification/TacticalExecution.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { EnemyMemory } from "../dist/Classes/Context/EnemyMemory.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { StagnationTracker } from "../dist/Classes/Context/StagnationTracker.js"
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
// Le bouclier n'est candidat qu'au seuil du rôle (`shouldShield`) : blessé (voir `shouldShield`, `TacticalScore.ts`)
// et à portée de menace de l'ennemi (ses PM + portée de son arme). Sans effet sur le poids du risque (pas de repli).
const shieldable = { maxLife: 300, enemyWeapon: { maxRange: 5 } }
const xyKey = (cell) => cell.x * 4096 + cell.y
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

function world({ tp = 6, mp = 0, gun = item("gun", 2, 10), weapons, chips = [],
	positions = [[3, 0]], danger = () => 0, obstacles = [], lineOfSight = () => true,
	life = 100, maxLife = 100, enemyWeapon = null, cells: coordinates, aggression = 50 } = {}) {
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
		id: 1, name: "me", cell: cell(0), life, maxLife, strength: 0, wisdom: 0,
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
		weapon: enemyWeapon, absoluteShield: 0, relativeShield: 0
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
	const profile = new LeekProfile(aggression)
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

// Combat 54965081, tours 3 et 4 : un seul spark (3 PT) lancé sur 10 PT alors que la puce n'a pas de cooldown.
test("fight 54965081: a chip without base cooldown is planned and cast as often as TP and maxUses allow, others once", () => {
	const cases = [
		["no cooldown, 10 TP / 3 TP", { cooldown: 0 }, 3],
		["no cooldown, maxUses 2", { cooldown: 0, maxUses: 2 }, 2],
		["cooldown 1", { cooldown: 1 }, 1],
		["unknown base cooldown", { cooldown: undefined }, 1]
	]
	for (const [name, options, casts] of cases) {
		const w = world({ tp: 10, gun: null, chips: [chip("spark", 3, 8, options)] })
		const { plan } = w.evaluate()
		assert.deepEqual(plan.chips.map((c) => c.name), Array(casts).fill("spark"), name)
		assert.deepEqual([plan.tpUsed, plan.usefulDamage], [3 * casts, 8 * casts], name)
		executeTacticalPlan(w.me, plan)
		assert.deepEqual(w.events, Array(casts).fill("chip:spark:2"), name)
		assert.equal(w.me.tp, 10 - 3 * casts, name)
	}
	// Chaque lancer revérifie la permission native : un refus après le premier lancer arrête les suivants.
	const w = world({ tp: 10, gun: null, chips: [chip("spark", 3, 8, { cooldown: 0 })] })
	const { plan } = w.evaluate()
	const useChip = w.me.useChip
	w.me.useChip = function (...args) { const result = useChip.apply(this, args); this.denyChips = true; return result }
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:spark:2"])
	// Retour natif ≤ 0 de `useChip` (sans que `canUseChip` change) : les lancers restants de cette puce ne sont pas tentés.
	const refused = world({ tp: 10, gun: null, chips: [chip("spark", 3, 8, { cooldown: 0 })] })
	const refusedPlan = refused.evaluate().plan
	let calls = 0
	refused.me.useChip = () => { calls++; return 0 }
	executeTacticalPlan(refused.me, refusedPlan)
	assert.equal(calls, 1)
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
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => 40, ...shieldable })
	const plan = w.evaluate().plan
	assert.equal(plan.weaponShots, 1)
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.danger, 40, "raw danger is retained")
	assert.equal(plan.score, 15 + 1.25 * 0.75 * 30) // + N : 2 tirs (30) possibles au tour suivant depuis cette case
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:shield:1", "shoot:2"])
	const forbidden = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => 40, ...shieldable })
	forbidden.profile.allowShielding = false
	assert.equal(forbidden.evaluate().plan.protection.length, 0)
})

test("healing competes with damage and is capped at actual missing life", () => {
	const heal = chip("heal", 2, 0, { minRange: 0,
		features: [{ type: Effect.HEAL, minValue: 30, maxValue: 30 }] })
	const w = world({ tp: 4, life: 45, gun: item("gun", 2, 10), chips: [heal], danger: () => 20 })
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
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => 40, ...shieldable })
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
		{ start: 1000, max: 10000, after: 7000, retained: true },
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

test("a target restriction is rejected in range; out of range it is only caught on arrival, after the move", () => {
	const restricted = chip("enemy-forbidden", 2, 60, { maxRange: 2 })
	// À portée (ma case est dans la liste native) : le refus n'est pas géométrique, la puce est écartée sans rien dépenser.
	const near = world({ tp: 2, mp: 1, gun: null, chips: [restricted], positions: [[2, 0]] })
	near.me.denyChips = true
	const refused = near.evaluate()
	assert.deepEqual([refused.plan, refused.reason], [null, "offensive chip refused at current cell"])
	// Hors de portée : rien ne distingue cette restriction de la géométrie. Le plan se déplace, puis le contrôle natif
	// de l'exécution refuse la puce : aucun PT dépensé, refus journalisé.
	const w = world({ tp: 2, mp: 1, gun: null, chips: [restricted] })
	w.me.denyChips = true
	assert.equal(w.me.canUseChip(restricted, w.enemies[0]), false)
	const plan = w.evaluate().plan
	assert.deepEqual([plan.shotCell.x, plan.chips], [1, [restricted]])
	const messages = [], original = console.log
	try { console.log = (message) => messages.push(String(message)); executeTacticalPlan(w.me, plan) } finally { console.log = original }
	assert.deepEqual(w.events, ["move:1,0:1"])
	assert.equal(w.me.tp, 2)
	assert.ok(messages.some((m) => m.includes("[Tactical] execution: chip unavailable: enemy-forbidden")))
})

// Éclair (données officielles) : lancer en ligne (launchType 1), portée 2-5, 4 PT. Ennemi en (3,1) : ma case (0,0) n'est
// pas alignée ; (0,1) l'est, à 1 PM. Ce test échoue si une puce n'est créditée que depuis la case actuelle.
const lightning = (options = {}) => chip("lightning", 4, 40, { launchType: 1, minRange: 2, maxRange: 5, ...options })
test("line chip: not castable from my cell, an aligned cell is reachable -> move, then cast", () => {
	const w = world({ tp: 4, mp: 2, gun: null, chips: [lightning()], positions: [[3, 1]] })
	assert.equal(w.me.canUseChip(w.me.chips[0], w.enemies[0]), false, "not aligned")
	const plan = w.evaluate().plan
	assert.deepEqual([plan.shotCell.x, plan.shotCell.y, plan.beforeMp, plan.chips.map((c) => c.name)], [0, 1, 1, ["lightning"]])
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events.slice(0, 2), ["move:0,1:1", "chip:lightning:2"])
	assert.equal(w.enemies[0].life, 60)
})

test("line weapon: not usable from my cell, an aligned cell is reachable -> move, then shoot", () => {
	const laser = item("laser", 3, 20, { launchType: 1, minRange: 2, maxRange: 5 })
	const w = world({ tp: 6, mp: 2, gun: laser, positions: [[3, 1]] })
	assert.equal(w.me.canUseWeapon(w.enemies[0]), false, "not aligned")
	const plan = w.evaluate().plan
	assert.deepEqual([plan.shotCell.x, plan.shotCell.y, plan.beforeMp, plan.weaponShots], [0, 1, 1, 2])
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events.slice(0, 3), ["move:0,1:1", "shoot:2", "shoot:2"])
})

test("line chip refused on arrival: logged, the planned weapon shot and the final move still run", () => {
	const laser = item("laser", 3, 20, { launchType: 1, minRange: 2, maxRange: 5 })
	const w = world({ tp: 7, mp: 2, gun: laser, chips: [lightning()], positions: [[3, 1]],
		danger: (cell) => cell.x === 0 && cell.y === 0 ? 0 : 5 })
	const plan = w.evaluate().plan
	assert.deepEqual([plan.shotCell.y, plan.destination.y, plan.weaponShots, plan.chips.map((c) => c.name)], [1, 0, 1, ["lightning"]])
	w.me.afterMove = () => { w.me.denyChips = true }
	const messages = [], original = console.log
	try { console.log = (message) => messages.push(String(message)); executeTacticalPlan(w.me, plan) } finally { console.log = original }
	assert.deepEqual(w.events, ["move:0,1:1", "shoot:2", "move:0,0:1"])
	assert.equal(w.me.tp, 4, "the 4 PT of the refused chip are not spent, and not re-planned")
	assert.ok(messages.some((m) => m.includes("[Tactical] execution: chip unavailable: lightning")))
})

test("area chips: no shot cell inside the effect zone unless every effect excludes the caster", () => {
	const feature = (targets) => [{ type: Effect.DAMAGE, minValue: 40, maxValue: 40, targets }]
	assert.equal(selfHitRadius({ area: 4, features: feature(27) }), 0, "Lightning: circle 2, caster excluded (no bit 4)")
	assert.equal(selfHitRadius({ area: 4, features: feature(31) }), 2)
	assert.equal(selfHitRadius({ area: 4, features: feature(undefined) }), 2, "unreadable targets: caster assumed hit")
	assert.deepEqual([1, 2, 3, 5, 13, undefined].map((area) => selfHitRadius({ area, features: feature(31) })), [0, 0, 1, 3, 0, 0])
	// Ennemi à 2 cases : ma case est dans le cercle de rayon 2. (-1,0) est à 3 : recul d'une case, puis tir.
	const blast = (targets) => world({ tp: 4, mp: 1, gun: null, positions: [[2, 0]],
		chips: [chip("blast", 4, 40, { minRange: 2, maxRange: 5, area: 4, features: feature(targets) })] })
	const far = blast(31)
	const plan = far.evaluate().plan
	assert.deepEqual([plan.shotCell.x, plan.chips.map((c) => c.name)], [-1, ["blast"]])
	const safe = blast(27).evaluate().plan
	assert.deepEqual([safe.shotCell.x, safe.beforeMp, safe.chips.map((c) => c.name)], [0, 0, ["blast"]])
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
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => 40, ...shieldable })
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

test("profile aggression weights explicitly trade immediate damage against potential danger", () => {
	// Facteur de `w` 0,5 x (1,5 - agressivité/100) ; `N` porte le poids d'approche `a` = 1,25 x (0,5 + agressivité/100),
	// borné à [0,5 ; 1/0,75] (poids effectif de N <= 1).
	for (const [aggression, weight, approach] of [[0, 0.75, 0.625], [50, 0.5, 1.25], [100, 0.25, 1 / 0.75]]) {
		const w = world({ tp: 2, gun: item("gun", 2, 30), danger: () => 10, aggression })
		const { plan } = w.evaluate()
		assert.equal(plan.nextTurn, approach * 0.75 * 30, `${aggression}: N`) // le même tir au tour suivant
		assert.ok(plan.nextTurn <= 30, "deferred damage never outweighs the same damage this turn")
		assert.equal(plan.score, 30 - weight * 10 + approach * 0.75 * 30, `${aggression}`)
	}
})

// With aggression 50, a shot is worth 15 and the shield absorbs up to 40 danger (at the weight 0.5, a 30 shield is never
// worth more than the 15 shot it costs).
test("the plan switches between two shots and protection at the score crossover", () => {
	const crossover = 30 // 15 / w, w = 0,5
	for (const [danger, expected] of [
		[crossover - 0.1, ["shoot:2", "shoot:2"]],
		[crossover + 0.1, ["chip:shield:1", "shoot:2"]]
	]) {
		// Le comportement ne se protège que sous 0,375 de vie : 100/300 PV (au-dessus de son seuil de repli, 0,25).
		const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => danger, ...shieldable, maxLife: 300 })
		planAct(w.me, w.profile, w.context())
		assert.deepEqual(w.events, expected, `danger ${danger}`)
	}
})

test("search boundaries retain a complete incumbent where permitted", () => {
	for (const [start, max, below, boundary] of [
		[600, 1000, 849, 850], [1000, 10000, 6999, 7000]
	]) {
		const cases = [[below, true], [boundary, true], [boundary + 1, true]]
		if (max === 1000) cases.push([969, true], [970, false], [971, false])
		for (const [after, shouldPlan] of cases) {
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
	const { turn, leekProfile } = await import("./helpers/joint-turn.mjs")
	const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield()], maxLife: 120 })
	Object.assign(w.enemies[0], {
		tp: 4, strength: 0, weapon: item("enemy gun", 2, 20, { maxRange: 8 }),
		weapons: [], chips: [], effects: [], launchedEffects: []
	})
	initLeekLogging(new LogConfig().setAll(false))
	// Le bouclier à 36/120 PV prouve que la carte de danger arrive au plan (seuil de bouclier à agressivité 100 : 0,30).
	w.me.life = 36
	turn()
	assert.deepEqual(w.events, ["chip:shield:1", "shoot:2"])
})

test("active turn feeds the stagnation counter: observed once at the start of the turn and handed to the planner", async () => {
	globalThis.Color = { rgb: () => 0 }
	const { turn } = await import("./helpers/joint-turn.mjs")
	const { stagnation } = await import("../dist/Brain/TurnObservation.js")
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
	// Tour précédent dans l'historique partagé : une de mes actions a retiré 20 PV à sa cible.
	const { actionHistory } = await import("../dist/Classes/Context/StagnationTracker.js")
	const hit = { id: -1, life: 50 }
	try {
		initLeekLogging(new LogConfig().setAll(false))
		actionHistory.begin(0, w.me, 0, 0)
		actionHistory.track(w.me, "shot", hit, () => { hit.life -= 20 })
		actionHistory.end()
		turn()
	} finally { delete stagnation.observe; delete stagnation.noteOffense }
	// Depuis l'historique des actions : `observe` reçoit aussi les dégâts de mon tour précédent et le nombre d'ennemis.
	assert.deepEqual(observed, [[1, lifeBefore, distanceBefore, 20, 1]])
	assert.equal(offense.length, 1, "planAct received the counter: the enemy in a firing zone notified the tracker")
})

test("active turn hands the enemy positions to the stagnation counter just before observing (a moving enemy keeps the rule out of play)", async () => {
	globalThis.Color = { rgb: () => 0 }
	const { turn } = await import("./helpers/joint-turn.mjs")
	const { stagnation } = await import("../dist/Brain/TurnObservation.js")
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
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 60), chips: [shield(2, 160)], danger: () => 200, ...shieldable })
	const { plan } = w.evaluate()
	assert.equal(plan.weaponShots, 2) // 120 dégâts moyens ≥ 100 PV × marge 1,1
	assert.equal(plan.protection.length, 0)
	assert.equal(plan.usefulDamage, 100)
	assert.equal(plan.danger, 200) // danger brut conservé dans le plan
})

test("killing one of two enemies does not waive the danger", () => {
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 60), chips: [shield(2, 160)],
		positions: [[3, 0], [3, 1]], danger: () => 200, ...shieldable })
	const { plan } = w.evaluate()
	assert.equal(plan.protection.length, 1)
	assert.equal(plan.weaponShots, 1)
})

test("a kill needs a margin over the mean damage", () => {
	const w = world({ tp: 8, mp: 0, gun: item("gun", 4, 52), chips: [shield(2, 160)], danger: () => 200, ...shieldable })
	const { plan } = w.evaluate() // 104 < 100 × 1,1 : pas de meurtre crédité
	assert.equal(plan.protection.length, 1)
})

test("a plan whose danger reaches my life loses to a survivable one, even with less damage", () => {
	const w = world({ tp: 6, mp: 0, gun: item("gun", 2, 30), chips: [shield(2, 25)], danger: () => 120, ...shieldable })
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
	const setup = (danger) => world({ tp: 6, mp: 0, gun: item("gun", 2, 30), chips: [shield(2, 25)], danger: () => danger, ...shieldable })
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

// --- N (valeur de la case finale au tour suivant) ne décote jamais les dégâts de ce tour ---------------------------

test("N never defers a kill of the last enemy for a small heal", () => {
	const w = world({ tp: 6, gun: item("gun", 2, 30), life: 100, maxLife: 300,
		chips: [chip("cure", 2, 0, { minRange: 0, features: [{ type: Effect.HEAL, minValue: 10, maxValue: 10 }] })] })
	w.enemies[0].life = 80
	const { plan } = w.evaluate()
	assert.deepEqual([plan.weaponShots, plan.protection.length], [3, 0])
	assert.equal(plan.nextTurn, 0, "a kill is possible this turn: N is 0 for every plan")
})

test("N is the same for two plans ending on the same cell: a shield still costs the full shot it replaces", () => {
	// 6 PT, 0 PM, danger 60 (w = 0,5), bouclier 15 pour 2 PT : 3 tirs (3d − 30) contre bouclier + 2 tirs (2d − 22,5), seuil d = 7,5
	// comme sans N. Avec un N plafonné par les PV restants après CE plan, le bouclier gagnait jusqu'à d = 45.
	for (const [damage, shots, protection] of [[7, 2, 1], [8, 3, 0]]) {
		const { plan } = world({ tp: 6, mp: 0, gun: item("gun", 2, damage), chips: [shield(2, 15)], danger: () => 60, ...shieldable }).evaluate()
		assert.deepEqual([plan.weaponShots, plan.protection.length], [shots, protection], `damage ${damage}`)
		assert.ok(plan.nextTurn > 0, "N is credited, identically for both plans")
	}
})

test("N never makes a plan abstain from a shot that takes all the target's life: same danger threshold as without N", () => {
	// Tir de 40 sur une cible à 40 PV (pas la marge de coup fatal), possible seulement depuis x = 1 (danger D), AGGRESSIVE
	// (w = 0,5 depuis la posture du rôle ; avant 0,75 et seuil 53/54) : tirer tant que 40 − 0,5 D > 0, soit D ≤ 79. Avec
	// l'ancien N, l'abstention commençait à D = 14.
	for (const [danger, shots] of [[79, 1], [81, 0]]) {
		const w = world({ tp: 2, mp: 1, gun: item("gun", 2, 40, { maxRange: 1 }), positions: [[2, 0]],
			cells: Array.from({ length: 6 }, (_, i) => [i - 3, 0]), danger: (c) => c.x === 1 ? danger : 0 })
		w.enemies[0].life = 40
		assert.equal(w.evaluate().plan?.weaponShots ?? 0, shots, `danger ${danger}`)
	}
})

// --- le comportement configuré décide du soin, du bouclier et du repli dans le plan conjoint -----------------------

test("healing is a candidate only at the behavior threshold (aggression 50: life <= 0.325, or <= 0.50 under threat)", () => {
	const heal = () => chip("heal", 2, 0, { minRange: 0, features: [{ type: Effect.HEAL, minValue: 30, maxValue: 30 }] })
	const protection = (options = {}) => {
		const w = world({ tp: 4, life: 82, gun: item("gun", 2, 10), chips: [heal()], danger: () => 20, ...options })
		if (options.forbid) w.profile.allowHealing = false
		return w.evaluate().plan.protection.map((c) => c.name)
	}
	assert.deepEqual(protection(), []) // 0,82 : au-dessus de 0,325 comme de 0,50
	assert.deepEqual(protection({ life: 70 }), [])
	assert.deepEqual(protection({ life: 50 }), ["heal"]) // ennemi à 3 cases (≤ 10), vie ≤ 0,50
	assert.deepEqual(protection({ life: 50, forbid: true }), []) // le profil garde la main
})

test("shielding is a candidate only at the behavior threshold and inside the enemy threat range", () => {
	const protection = (options = {}) => {
		// Bouclier de 40 (30 avant la posture : à w = 0,5 il ne valait plus que le tir de 15 qu'il coûte, à égalité).
		const w = world({ tp: 4, gun: item("gun", 2, 15), chips: [shield(2, 40)], danger: () => 40, ...shieldable, maxLife: 120, ...options })
		return w.evaluate().plan.protection.map((c) => c.name)
	}
	// 100/120 PV = 0,83 : au-dessus du seuil (0,375 à agressivité 50).
	assert.deepEqual(protection(), [])
	assert.deepEqual(protection({ maxLife: 300 }), ["shield"]) // 0,33 ≤ 0,375
	assert.deepEqual(protection({ maxLife: 100 }), []) // pleine vie
	// Portée de menace = PM de l'ennemi (0) + portée de son arme : à 3 cases, une arme de portée 2 ne menace pas.
	assert.deepEqual(protection({ maxLife: 300, enemyWeapon: { maxRange: 2 } }), [])
	assert.deepEqual(protection({ maxLife: 300, enemyWeapon: null }), []) // sans arme connue : portée 1
})

test("riskWeight: 0.5 x (1.5 - aggression/100), doubled under the retreat threshold when hiding is allowed", () => {
	assert.equal(RETREAT_RISK_FACTOR, 2)
	const weight = (life, range, change = () => {}) => {
		const profile = new LeekProfile()
		change(profile)
		return riskWeight(profile, life, range)
	}
	assert.equal(weight(1, 5), 0.5)
	assert.equal(weight(0.40, 5), 0.5) // ne se replie qu'à d ≤ 1 ou vie ≤ 0,25
	assert.equal(weight(0.25, 5), 0.5 * RETREAT_RISK_FACTOR)
	assert.equal(weight(0.25, 11), 0.5) // panique : d ≤ 10 seulement
	assert.equal(weight(0.25, 5, (profile) => { profile.allowHiding = false }), 0.5)
	// Au contact (d ≤ 1) : vie ≤ 0,50.
	assert.equal(weight(0.50, 1), 0.5 * RETREAT_RISK_FACTOR)
	assert.equal(weight(0.51, 1), 0.5)
	// « Trop près » : d < MIN_SAFE_DISTANCE (2), blessé (vie ≤ 0,225 à agressivité 50).
	assert.equal(weight(0.22, 2), 0.5 * RETREAT_RISK_FACTOR) // panique à d ≤ 10 aussi
	assert.equal(weight(0.40, 2), 0.5)
})

test("under the retreat threshold the danger weighs twice: the same shot is taken when healthy, declined when wounded", () => {
	// Tir possible seulement depuis x = 1 (1 PM, plus de PM pour repartir), où le danger vaut 45 ; ailleurs 0.
	const setup = (maxLife) => world({ tp: 2, mp: 1, life: 100, maxLife, gun: item("gun", 2, 30, { maxRange: 1 }), positions: [[2, 0]],
		cells: Array.from({ length: 6 }, (_, i) => [i - 3, 0]), danger: (c) => c.x === 1 ? 45 : 0 })
	const healthy = setup(100).evaluate().plan
	assert.equal(healthy.weaponShots, 1)
	assert.equal(healthy.score, 30 - 0.5 * 45 + 1.25 * 0.75 * 30) // w = 0,5 ; + N : le même tir au tour suivant depuis x = 1
	const wounded = setup(400).evaluate().plan // vie 0,25 (panique), ennemi à 2 cases : w = 1, 30 − 45 < 0
	assert.equal(wounded?.weaponShots ?? 0, 0)
	const forbidden = setup(400)
	forbidden.profile.allowHiding = false // sans repli autorisé, le poids n'est pas doublé
	assert.equal(forbidden.evaluate().plan.weaponShots, 1)
})

// --- posture du rôle : mêmes tactiques, pilotées par le profil (`posture`, TacticalScore.ts) -----------------------

test("posture, approach weight: on the corridor the profile advances 2 cells without a shot", () => {
	// Ennemi à 12 cases, arme de portée 1 (aucun tir, aucun N, pas de trajet futur à 8 pas), 2 PM ; danger 0,6 en x = 1 et
	// 1,8 en x = 2. Score d'une avance de x : a x G - w x danger, a = 1,25, w = 0,5 : 0,95 puis 1,6.
	const w = world({ tp: 2, mp: 2, gun: item("gun", 2, 10, { maxRange: 1 }), positions: [[12, 0]],
		cells: Array.from({ length: 16 }, (_, i) => [i - 3, 0]), danger: (c) => c.x === 1 ? 0.6 : c.x === 2 ? 1.8 : 0 })
	const { plan } = w.evaluate()
	assert.deepEqual([plan.destination.x, plan.progress, plan.weaponShots, Number(plan.score.toFixed(4))], [2, 2, 0, 1.6]) // `progress` journalisé : distance brute, pas pondérée
})

test("posture, passivity floor: at the 4th passive turn the danger no longer weighs", () => {
	// Tir de 30 (tous les PV de la cible, sans la marge de coup fatal : N = 0) possible seulement depuis x = 1, danger 50
	// (< 0,75 x 100 PV). Passivité p = 0 : le tir est pris (30 - 0). À poids plein (w = 0,5) : 30 - 25 > 0, déjà pris.
	const shots = (passive) => {
		const w = world({ tp: 2, mp: 1, gun: item("gun", 2, 30, { maxRange: 1 }), positions: [[2, 0]],
			cells: Array.from({ length: 6 }, (_, i) => [i - 3, 0]), danger: (c) => c.x === 1 ? 50 : 0 })
		w.enemies[0].life = 30
		const stagnation = new StagnationTracker()
		stagnation.passive = passive
		return w.evaluate({ ...w.context(), stagnation }).plan?.weaponShots ?? 0
	}
	assert.equal(shots(4), 1)
	assert.equal(shots(0), 1)
})

test("posture, future route weapon: walks towards the weapon with the best damage over a turn", () => {
	// Ennemi à 9 cases, 1 PM, aucune arme à portée ce tour. pistol (en main, portée 2, 10 / 2 PT), cannon (portée 4, 40 /
	// 3 PT), rifle (portée 6, 12 / 2 PT). `futureRouteDistance` après 1 pas : 9 - portée - 1.
	const route = (tp) => {
		const weapons = [item("pistol", 2, 10, { maxRange: 2 }), item("cannon", 3, 40, { maxRange: 4 }), item("rifle", 2, 12, { maxRange: 6 })]
		const w = world({ tp, mp: 1, gun: weapons[0], weapons, positions: [[9, 0]], cells: Array.from({ length: 13 }, (_, i) => [i - 2, 0]) })
		const { plan } = w.evaluate()
		return [plan.destination.x, plan.futureRouteDistance]
	}
	assert.deepEqual(route(6), [1, 4]) // cannon : 1 PT d'équipement, 1 tir de 40 > pistol 3 x 10 > rifle 2 x 12
	// 3 PT : cannon inabordable après l'équipement (0 tir), rifle 1 x 12 > pistol 1 x 10.
	assert.deepEqual(route(3), [1, 2])
})

// --- boost : composante du plan conjoint --------------------------------------------------------------------------

const boost = (name, cost, type, value, turns) => chip(name, cost, 0, { minRange: 0, maxRange: 0,
	features: [{ type, minValue: value, maxValue: value, turns }] })

test("joint plan: the boost is a scored component, chosen when it brings more than the shot it costs, with the real chips", () => {
	// 6 PT, gun 3 PT / 10, bolt 3 PT / 30, protein 3 PT : +100 force pendant 2 tours.
	const setup = (options = {}) => world({ tp: 6, gun: item("gun", 3, 10), chips: [chip("bolt", 3, 30),
		boost("protein", 3, 38, 100, 2)], ...options })
	let w = setup()
	let plan = w.evaluate().plan
	// Sans boost : bolt + 1 tir = 40. Avec : bolt à force 100 = 60, plus 0,75 × 2 tirs × 10 au tour suivant = 15.
	assert.deepEqual(plan.boost, { chips: [w.me.chips[1]], tpGain: 0 })
	assert.deepEqual(plan.chips.map((c) => c.name), ["bolt"])
	assert.equal(plan.weaponShots, 0)
	assert.equal(plan.usefulDamage, 60)
	// + N : bolt + 1 tir sans boost au tour suivant (40), plafonné par les PV restants après le meilleur tour (100 − 60).
	assert.equal(plan.score, 75 + 1.25 * 0.75 * 40)
	assert.equal(plan.tpUsed, 6)
	assert.deepEqual(w.events, [], "evaluation spends nothing")
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:protein:1", "chip:bolt:2"]) // boost avant les puces offensives
	// Coup fatal : 6 PT, gun 3 PT / 10, protein 3 PT (+50 force, 2 tours). Ennemi à 20 PV : 2 tirs le tuent (20) ; boost +
	// 1 tir = 15, et les 5 PV restants ne valent que 0,75 × 5 plus tard. Ennemi à 100 PV : 15 + 7,5 bat 20.
	const fatal = (enemyLife) => {
		const duel = world({ tp: 6, gun: item("gun", 3, 10), chips: [boost("protein", 3, 38, 50, 2)] })
		duel.enemies[0].life = enemyLife
		return duel.evaluate().plan
	}
	plan = fatal(20)
	assert.equal(plan.boost, undefined)
	assert.deepEqual([plan.weaponShots, plan.usefulDamage], [2, 20])
	plan = fatal(100)
	assert.deepEqual(plan.boost.chips.map((c) => c.name), ["protein"])
	assert.deepEqual([plan.weaponShots, plan.usefulDamage, plan.score], [1, 15, 22.5 + 1.25 * 0.75 * 20]) // + N : 2 tirs de base
	// Sous 50 % de PV, un plan qui tire ne booste pas (MIN_LIFE_RATIO_FOR_BOOST).
	assert.equal(setup({ life: 49 }).evaluate().plan.boost, undefined)
	assert.notEqual(setup({ life: 50 }).evaluate().plan.boost, undefined)
	// Effet déjà actif ou puce en délai : aucune variante.
	w = setup()
	w.me.effects = [{ type: 38, turns: 1 }]
	assert.equal(w.evaluate().plan.boost, undefined)
	w = setup()
	w.me.chips[1].currentCooldown = 2
	assert.equal(w.evaluate().plan.boost, undefined)
})

test("joint plan: a TP boost pays for an extra shot this turn; both boosts are ordered TP first", () => {
	// 6 PT, gun 3 PT / 10. motivation : 2 PT, +3 PT pendant 3 tours -> 7 PT : toujours 2 tirs ce tour, 3 les suivants.
	let w = world({ tp: 6, gun: item("gun", 3, 10), chips: [boost("motivation", 2, 32, 3, 3)] })
	let plan = w.evaluate().plan
	assert.deepEqual(plan.boost, { chips: [w.me.chips[0]], tpGain: 3 })
	assert.equal(plan.weaponShots, 2)
	assert.equal(plan.tpUsed, 8) // 2 + 6 : PT dépensés, les 3 PT gagnés ne sont pas déduits
	// 2 tours suivants à 9 PT (3 tirs) au lieu de 6 (2 tirs) ; + N : les 2 tirs de base du tour suivant (0,75 × 20).
	assert.equal(plan.score, 20 + 0.75 * 2 * 10 + 1.25 * 0.75 * 20)
	// motivation : 1 PT, +4 PT -> 9 PT ce tour : un 3e tir tout de suite.
	w = world({ tp: 6, gun: item("gun", 3, 10), chips: [boost("motivation", 1, 32, 4, 1)] })
	plan = w.evaluate().plan
	assert.equal(plan.weaponShots, 3)
	assert.equal(plan.usefulDamage, 30)
	w.me.useChip = function (c) { this.tp += 4 - c.cost; w.events.push(`chip:${c.name}`); return 1 }
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["chip:motivation", "shoot:2", "shoot:2", "shoot:2"])
	assert.equal(w.me.tp, 0)
	// Les deux : PT d'abord, quel que soit l'ordre de l'inventaire.
	w = world({ tp: 10, gun: item("gun", 3, 10), chips: [boost("protein", 2, 38, 100, 3), boost("motivation", 2, 32, 3, 3)] })
	plan = w.evaluate().plan
	assert.deepEqual(plan.boost.chips.map((c) => c.name), ["motivation", "protein"])
})

test("joint plan without a shot: boost only if it lasts and the enemy can come into range; no boost ready costs nothing", () => {
	// Ennemi à 6 cases, 1 PM. Portée utile d'un boost sans tir = portée de l'arme + 2 × mes PM + PM adverses (0).
	const setup = (options = {}) => world({ tp: 6, mp: 1, gun: item("gun", 3, 10), positions: [[6, 0]],
		cells: Array.from({ length: 11 }, (_, i) => [i - 4, 0]), chips: [boost("protein", 3, 38, 100, 2)], ...options })
	let plan = setup().evaluate().plan // portée 5 + 1 PM : le tir est possible, le boost vient avec lui
	assert.ok(plan.boost && plan.weaponShots > 0, "in range after the approach: the boost comes with the shot")
	const far = setup({ gun: item("gun", 3, 10, { maxRange: 2 }) }) // portée utile 2 + 2 + 0 = 4 < 6
	plan = far.evaluate().plan
	assert.equal(plan.weaponShots, 0)
	assert.equal(plan.boost, undefined)
	const reachable = setup({ gun: item("gun", 3, 10, { maxRange: 4 }) }) // tir impossible (6 > 4 + 1) ; portée utile 6
	plan = reachable.evaluate().plan
	assert.equal(plan.weaponShots, 0)
	assert.deepEqual(plan.boost?.chips.map((c) => c.name), ["protein"])
	assert.equal(plan.tpUsed, 3)
	executeTacticalPlan(reachable.me, plan)
	assert.deepEqual(reachable.events, ["chip:protein:1", "move:1,0:1"]) // boost avant le déplacement final
	const brief = setup({ gun: item("gun", 3, 10, { maxRange: 4 }), chips: [boost("protein", 3, 38, 100, 1)] })
	assert.equal(brief.evaluate().plan.boost, undefined)
})
