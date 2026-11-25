import test from "node:test"
import assert from "node:assert/strict"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { executeReservePlan } from "../dist/Classes/Plannification/ReservePlan.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { getLogConfig, initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Scénarios synthétiques aux distances/PV du log Domingo, PAS sa grille inconnue.
// Vraie grille losange (613 cases), BFS, obstacles, LOS, PT/PM et contrôles natifs.
// Coûts par primitive et par sortie : dynamiques, jamais mesures moteur.
function arena({ turn = 6, distance = 5, life = 333, initialOps = 422000,
	providerCost = 50, actionCost = 3000, logCost = 1, equipped = false,
	blockOriginLos = false, danger = c => c.x <= 0 ? 0 : 100 } = {}) {
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const grid = new Map(), trace = [], stats = { providers: new Map(), danger: 0, field: 0 }
	for (let x = -17; x <= 17; x++) for (let y = -17; y <= 17; y++) {
		if (Math.abs(x) + Math.abs(y) <= 17) {
			grid.set(`${x},${y}`, { id: grid.size, x, y, obstacle: false, entity: null, empty: true })
		}
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	let ops = initialOps
	const pistol = { name: "pistol", cost: 3, minRange: 1, maxRange: 7, maxUses: -1,
		needsLos: true, features: [{ type: 1, minValue: 8, maxValue: 8 }] }
	const machine = { ...pistol, name: "machine_gun", cost: 4, maxRange: 6,
		features: [{ type: 1, minValue: 48, maxValue: 48 }] }
	const heal = { name: "bandage", cost: 2, minRange: 0, maxRange: 6,
		currentCooldown: 0, maxUses: 1, features: [{ type: 2, minValue: 30, maxValue: 30 }] }
	const shield = { ...heal, name: "shield", currentCooldown: 1,
		features: [{ type: 3, minValue: 12, maxValue: 12 }] }
	const spark = { ...heal, name: "spark", currentCooldown: 0, minRange: 1,
		features: [{ type: 1, minValue: 8, maxValue: 8 }] }
	const enemy = { id: 2, cell: cell(distance), life: 249, maxLife: 249,
		mp: 3, weapon: machine, absoluteShield: 0, relativeShield: 0 }
	const enemies = [enemy]
	const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const los = (from, to) => !blockOriginLos || from.x >= (blockOriginLos === true ? 1 : blockOriginLos)
	const hit = (from, target, item) => {
		const d = dist(from, target.cell)
		return d >= item.minRange && d <= item.maxRange &&
			(!item.needsLos || Field.lineOfSight(from, target.cell))
	}
	const record = (name, data = {}) => trace.push({ kind: "action", name, ops, tp: me.tp, mp: me.mp, ...data })
	const travel = (destination, limit) => {
		const cost = computeReachableCells(me, Math.min(me.mp, limit)).costTo(destination)
		if (cost === null || me.failMove) return 0
		assert.ok(cost >= 0 && cost <= me.mp && cost <= limit)
		me.cell.entity = null; me.cell = destination; destination.entity = me; me.mp -= cost
		ops += actionCost
		return cost
	}
	const me = { id: 1, name: "Kassbi", cell: cell(0), life, maxLife: 333,
		tp: 10, mp: 4, strength: 0, wisdom: 0, weapon: equipped ? machine : pistol,
		weapons: [pistol, machine], chips: [heal, shield, spark],
		distance: target => dist(me.cell, target.cell),
		canUseWeapon(target, weapon = me.weapon) {
			ops += 1200
			return target.life > 0 && weapon && hit(me.cell, target, weapon) && !me.deny
		},
		canUseChip(chip, target) {
			ops += 150
			return target.life > 0 && chip.currentCooldown === 0 &&
				(chip.features[0].type === 1 ? target !== me && hit(me.cell, target, chip) : target === me)
		},
		chipCells(chip, target) {
			return [...grid.values()].filter(c => {
				ops += providerCost
				return hit(c, target, chip)
			})
		},
		moveToward(destination, limit) { record("move", { to: { x: destination.x, y: destination.y }, limit }); return travel(destination, limit) },
		moveAwayFrom(target, limit) {
			record("unknown retreat", { limit })
			const reachable = computeReachableCells(me, Math.min(me.mp, limit))
			let best = me.cell
			for (const { cell: c } of reachable.entries()) if (dist(c, target.cell) > dist(best, target.cell)) best = c
			return travel(best, limit)
		},
		setWeapon(weapon) {
			record("equip", { weapon: weapon.name }); ops += actionCost
			if (me.failEquip) return false
			assert.ok(me.weapons.includes(weapon) && me.tp >= 1)
			me.weapon = weapon; me.tp--; return true
		},
		useWeapon(target) {
			assert.ok(me.tp >= me.weapon.cost && me.canUseWeapon(target))
			record("shot"); ops += actionCost
			if (me.refuse) return 0
			me.tp -= me.weapon.cost; target.life -= me.weapon.features[0].minValue
			me.afterShot?.()
			return 1
		},
		useChip(chip, target) {
			assert.ok(me.tp >= chip.cost && me.canUseChip(chip, target))
			record(chip.features[0].type === 1 ? "offensive chip" : "protection")
			ops += actionCost; me.tp -= chip.cost; chip.currentCooldown = 1
			if (chip.features[0].type === 2) me.life = Math.min(me.maxLife, me.life + 30)
			else target.life -= chip.features[0].minValue
			return 1
		}
	}
	me.cell.entity = me; enemy.cell.entity = enemy
	globalThis.Field = {
		cellFromXY(x, y) { ops += 30; stats.field++; return cell(x, y) },
		lineOfSight(from, to) { ops += 30; return los(from, to) }
	}
	globalThis.Fight = { turn, me,
		getNearestEnemy: () => enemies.find(e => e.life > 0) ?? null,
		getAliveEnemies: () => enemies.filter(e => e.life > 0),
		weaponCells(target, weapon) {
			const id = `${target.id}:${weapon.name}`
			stats.providers.set(id, (stats.providers.get(id) ?? 0) + 1)
			return [...grid.values()].filter(c => {
				ops += providerCost
				return !c.obstacle && hit(c, target, weapon)
			})
		}
	}
	globalThis.System = { get operations() { return ++ops }, maxOperations: 1000000 }
	const profile = new LeekProfile()
	const run = ({ truncated = false, contextless = false, logging = true, onLog, reserve = false } = {}) => {
		const reachable = computeReachableCells(me, me.mp)
		const threat = new ThreatMap(me.id, Fight.turn, new Map([...reachable.entries()].map(e =>
			[e.cell.x * 4096 + e.cell.y, { ...e, danger: danger(e.cell), breakdown: [] }])),
		{ candidateCells: reachable.size, truncated, inputsTruncated: false,
			enemyCount: enemies.length, pairsEvaluated: reachable.size * 25, lineOfSightCalls: 0 })
		const nativeDanger = threat.dangerAt.bind(threat)
		threat.dangerAt = c => { ops += 550; stats.danger++; return nativeDanger(c) }
		const oldLog = console.log, config = getLogConfig(), begin = trace.length, start = ops
		initLeekLogging(new LogConfig().setAll(false).setEnabled(LOG_CONTEXT.PLANNING, logging))
		console.log = text => {
			trace.push({ kind: "log", text, ops })
			ops += text.length * logCost
			onLog?.(text)
		}
		try {
			if (reserve) executeReservePlan(me, profile, contextless ? undefined : { reachable, threat })
			else planAct(me, profile, contextless ? undefined : { reachable, threat })
		}
		finally { console.log = oldLog; initLeekLogging(config) }
		return { trace: trace.slice(begin), start, ops, reachable }
	}
	return { me, enemy, enemies, cell, profile, stats, run, setOps: n => { ops = n } }
}

for (const scenario of [
	{ turn: 4, distance: 11, initialOps: 335000, danger: c => c.x <= 2 ? 0 : 60.3 },
	{ turn: 5, distance: 8, initialOps: 430000 },
	{ turn: 6, distance: 5, initialOps: 422000, blockOriginLos: true },
	{ turn: 8, distance: 1, life: 170, initialOps: 462000, danger: c => c.x <= -2 ? 60.3 : 100 },
	{ turn: 9, distance: 1, life: 82, initialOps: 462000, equipped: true, danger: c => c.x <= -2 ? 60.3 : 100 }
]) test(`Domingo-inspired turn ${scenario.turn}: complete main plan before actual actions, dynamic ops`, () => {
	const w = arena(scenario)
	try {
		const t = w.run(), actions = t.trace.filter(e => e.kind === "action")
		const index = t.trace.findIndex(e => e.text?.startsWith("[Tactical] plan before execution "))
		assert.ok(index >= 0 && index < t.trace.findIndex(e => e.kind === "action"))
		const plan = JSON.parse(t.trace[index].text.split("plan before execution ")[1])
		assert.equal(plan.searchStatus, "complete search")
		assert.ok(!t.trace.some(e => e.text?.includes("[Tactical] fallback:")))
		assert.ok(actions.length > 0)
		assert.ok(t.ops < 700000)
		assert.equal(w.stats.danger, t.reachable.size, "one danger validation, no repeated provider reads")
		assert.ok([...w.stats.providers.values()].every(n => n === 1), "native item cells never recomputed")
		assert.ok(plan.mp.before + plan.mp.after <= 4 && plan.tp.planned <= 10)
		assert.ok(w.me.mp >= 0 && w.me.tp >= 0)
		for (const action of actions) {
			const i = t.trace.indexOf(action)
			assert.match(t.trace[i - 1].text, /phase before action/)
			assert.ok(action.ops < 700000)
		}
		if (scenario.turn === 4) {
			assert.equal(actions.some(e => e.name === "shot"), false)
			assert.ok(w.me.cell.x > 0)
			assert.equal(w.me.tp, 10)
		} else {
			assert.equal(actions.filter(e => e.name === "shot").length, 2)
			assert.equal(plan.weapon.name, "machine_gun")
			assert.deepEqual({ x: w.me.cell.x, y: w.me.cell.y }, plan.destination)
			if (scenario.turn === 5 || scenario.turn === 6) {
				assert.ok(plan.mp.before > 0 && plan.mp.after > 0, "approach AND reachable retreat")
				assert.ok(actions.findIndex(e => e.name === "shot") > actions.findIndex(e => e.name === "move"))
			}
			if (scenario.turn === 9) assert.ok(actions.some(e => e.name === "protection"), "heal with real PT")
		}
	} finally { delete globalThis.System }
})

test("turn 7: fallback reaches 711002/1M but remaining engine budget allows two shots and support", () => {
	const w = arena({ turn: 7, distance: 1, life: 170, equipped: true,
		initialOps: 665000, providerCost: 0, danger: c => c.x <= -2 ? 60.3 : 100 })
	let injected = false
	try {
		const t = w.run({ reserve: true, onLog: text => {
			if (!injected && text.includes("[Reserve] phase before action")) {
				injected = true
				w.setOps(711002)
			}
		} }), actions = t.trace.filter(e => e.kind === "action")
		assert.ok(t.start >= 665000 && t.start < 700000)
		assert.ok(injected)
		const preview = t.trace.find(e => e.text?.includes("[Reserve] plan before execution "))
		assert.ok(preview)
		const intent = JSON.parse(preview.text.split("plan before execution ")[1])
		assert.equal(intent.attack.weapon, "machine_gun")
		assert.equal(intent.attack.weaponShotsAtMost, 2)
		const phase = t.trace.find(e => e.text?.includes("[Reserve] phase before action"))
		assert.ok(phase)
		assert.match(phase.text, /weapon shot/)
		assert.ok(phase.ops < 700000 && t.ops >= 711002)
		assert.equal(actions.filter(e => e.name === "shot").length, 2)
		assert.ok(actions.some(e => e.name === "protection"))
		assert.ok(actions.every(e => e.ops >= 711002))
		assert.ok(actions.every((e, i) => i === 0 || e.ops > actions[i - 1].ops))
		assert.ok(t.ops < 1000000)
		assert.equal(w.me.tp, 0)
	} finally { delete globalThis.System }
})

test("main interrupted before its first complete firing candidate: fallback reuses cells/danger, fires twice and retreats", () => {
	// Aucun tir actuel ni progrès court à danger favorable : le premier fournisseur
	// dépasse la recherche (plafond relatif 30 % : 613 cases × 480 ≈ 294 000 ops, plus la validation des dangers),
	// mais renvoie bien les cellules de l'arme non équipée.
	const w = arena({ distance: 8, initialOps: 200000, providerCost: 480 })
	w.me.chips = []; w.me.weapons = [w.me.weapons[1]]; w.me.weapon = null
	try {
		const t = w.run(), actions = t.trace.filter(e => e.kind === "action")
		assert.ok(t.trace.some(e => e.text?.includes("fallback: operations reserve")))
		assert.ok(t.trace.some(e => e.text?.includes("reuse current evaluation")))
		assert.ok(t.trace.some(e => e.text?.includes("[Reserve] plan before execution")))
		assert.equal(w.stats.danger, t.reachable.size)
		assert.deepEqual([...w.stats.providers.values()], [1], "the late native provider is not called again")
		assert.equal(actions.filter(e => e.name === "shot").length, 2)
		assert.equal(w.me.weapon.name, "machine_gun")
		assert.ok(actions.filter(e => e.name === "move").length === 2)
		assert.ok(t.ops < 700000 && w.me.mp >= 0 && w.me.tp >= 0)
	} finally { delete globalThis.System }
})

test("main keeps a complete ready option if later search consumes its relative allowance", () => {
	const w = arena({ distance: 1, initialOps: 200000, providerCost: 240 })
	w.me.chips = []
	try {
		const t = w.run()
		const preview = t.trace.find(e => e.text?.includes("[Tactical] plan before execution"))
		assert.ok(preview)
		assert.match(preview.text, /complete incumbent/)
		assert.ok(!t.trace.some(e => e.text?.includes("[Tactical] fallback:")))
		assert.ok(t.trace.some(e => e.name === "shot"))
		assert.ok(t.ops < 700000)
	} finally { delete globalThis.System }
})

test("fallback: search allowance never cuts off equipment, second shot, support or real retreat", () => {
	const w = arena({ turn: 9, distance: 1, life: 82, equipped: true,
		initialOps: 430000, actionCost: 20000, danger: c => c.x <= -2 ? 60.3 : 100 })
	try {
		const t = w.run({ truncated: true }), actions = t.trace.filter(e => e.kind === "action")
		assert.ok(t.trace.some(e => e.text?.includes("fallback: truncated data")))
		assert.equal(actions.filter(e => e.name === "shot").length, 2)
		assert.ok(actions.some(e => e.name === "protection"))
		assert.ok(actions.some(e => e.name === "unknown retreat"))
		assert.equal(w.me.tp, 0)
		assert.ok(t.ops - t.start > 50000 && t.ops < 700000)
		const preview = t.trace.find(e => e.text?.includes("[Reserve] plan before execution"))
		const p = JSON.parse(preview.text.split("plan before execution ")[1])
		assert.match(p.mode, /bounded sequence with explicit conditional branches/)
		assert.equal(p.dangerStatus, "unknown")
		assert.equal(p.destination, null)
		assert.equal(p.retreat.mode, "geometric")
		assert.equal(p.retreat.danger, null)
		assert.equal(p.attack.weaponShotsAtMost, 2)
		assert.deepEqual(p.protection.map(s => s.chip), ["bandage"])
	} finally { delete globalThis.System }
})

test("several actual turns: far target requires no shooting-cell provider; full plans progress", () => {
	const w = arena({ distance: 16, initialOps: 200000, danger: () => 0 })
	w.me.chips = []
	try {
		for (let i = 0; i < 3; i++) {
			const x = w.me.cell.x
			w.me.mp = 4; w.me.tp = 10; w.setOps(200000)
			const t = w.run()
			assert.ok(t.trace.some(e => e.text?.includes("[Tactical] plan before execution")))
			assert.ok(!t.trace.some(e => e.text?.includes("[Tactical] fallback:")))
			assert.ok(w.me.cell.x >= x && t.trace.some(e => e.kind === "action"))
			assert.ok(t.ops < 700000)
			if (i < 2) assert.equal(w.stats.providers.size, 0)
			Fight.turn++
		}
	} finally { delete globalThis.System }
})

for (const path of ["main", "reserve"]) {
	test(`${path}: globally exhausted budget forbids all actions/providers`, () => {
		const w = arena({ initialOps: 1000000 })
		try {
			const t = w.run({ truncated: path === "reserve" })
			assert.equal(t.trace.some(e => e.kind === "action"), false)
			assert.equal(w.stats.providers.size, 0)
		} finally { delete globalThis.System }
	})
	test(`${path}: a phase log crossing the global guard prevents the following native action`, () => {
		const w = arena({ initialOps: 400000, distance: 1, equipped: true })
		try {
			const t = w.run({ truncated: path === "reserve", onLog: text => {
				if (text.includes("phase before action")) w.setOps(1000000)
			} })
			assert.ok(t.trace.some(e => e.text?.includes("phase before action")))
			assert.equal(t.trace.some(e => e.kind === "action"), false)
		} finally { delete globalThis.System }
	})
	test(`${path}: PLANNING disabled is silent and actions still run`, () => {
		const w = arena({ distance: 1, equipped: true })
		try {
			const t = w.run({ truncated: path === "reserve", logging: false })
			assert.equal(t.trace.some(e => e.kind === "log"), false)
			assert.ok(t.trace.some(e => e.name === "shot"))
		} finally { delete globalThis.System }
	})
}

test("main: opt-outs are honored, native refusal is not retried and no second planner executes", () => {
	const w = arena({ distance: 1, life: 82, equipped: true })
	w.me.chips = []
	w.profile.setSupportOptions(false, false, false)
	w.me.refuse = true
	try {
		const t = w.run()
		const p = JSON.parse(t.trace.find(e => e.text?.includes("[Tactical] plan before execution")).text.split("plan before execution ")[1])
		assert.deepEqual(p.protection, [])
		assert.equal(p.mp.after, 0)
		assert.equal(t.trace.filter(e => e.name === "shot").length, 1)
		assert.equal(w.me.tp, 10)
		assert.ok(t.trace.some(e => e.text?.includes("weapon refused: result 0")))
		assert.ok(!t.trace.some(e => e.text?.includes("[Reserve]")))
	} finally { delete globalThis.System }
})

test("main: an unavailable native approach never becomes shots or a second sequence", () => {
	const w = arena({ blockOriginLos: true })
	w.me.failMove = true
	try {
		const t = w.run()
		assert.deepEqual(t.trace.filter(e => e.kind === "action").map(e => e.name), ["move"])
		assert.equal(w.me.tp, 10)
		assert.equal(w.me.mp, 4)
		assert.ok(!t.trace.some(e => e.text?.includes("[Reserve]")))
	} finally { delete globalThis.System }
})

test("main: aggregate danger survives modeled and actual kills, cover accounts for every enemy", () => {
	const w = arena({ distance: 1, equipped: true, danger: c => c.y >= 1 ? 60.3 : c.x < 0 ? 180 : 100 })
	w.me.chips = []; w.me.weapons = [w.me.weapon]
	w.enemy.life = 50
	const other = { ...w.enemy, id: 3, cell: w.cell(-6, 2), life: 50 }
	w.enemies.push(other); other.cell.entity = other
	try {
		const t = w.run()
		const p = JSON.parse(t.trace.find(e => e.text?.includes("[Tactical] plan before execution")).text.split("plan before execution ")[1])
		assert.equal(p.danger, 60.3, "no expected-kill subtraction from the map")
		assert.ok(p.destination.y >= 1, "do not flee into the second enemy's modeled danger")
		assert.ok(w.enemy.life <= 0)
		assert.ok(w.me.cell.y >= 1, "actual destination reached after the kill")
	} finally { delete globalThis.System }
})

for (const path of ["main", "reserve"]) test(`${path}: no later action starts once an atomic action exhausts the engine budget`, () => {
	const w = arena({ initialOps: 500000, distance: 1, equipped: true, actionCost: 600000 })
	w.me.chips = []
	try {
		const t = w.run({ truncated: path === "reserve" }), actions = t.trace.filter(e => e.kind === "action")
		assert.ok(actions.some(e => e.name === "shot"))
		assert.ok(t.ops >= 1000000)
		assert.ok(actions.every(e => e.ops < 1000000))
		assert.equal(actions.some(e => e.name.includes("move") || e.name.includes("retreat")), false)
	} finally { delete globalThis.System }
})

for (const path of ["main", "reserve"]) test(`${path}: observed costly shot protects the next action while engine room remains`, () => {
	const w = arena({ initialOps: path === "reserve" ? 665000 : 645000,
		distance: 1, equipped: true, actionCost: 100000, providerCost: 0 })
	w.me.chips = []
	try {
		const t = w.run({ truncated: path === "reserve" }), actions = t.trace.filter(e => e.kind === "action")
		assert.deepEqual(actions.map(e => e.name), ["shot"])
		assert.ok(actions[0].ops > 700000 || t.ops > 700000)
		assert.ok(t.ops < 970000, "stop is adaptive, not an exhausted 3% tail")
		assert.ok(t.ops - actions[0].ops >= 100000)
		assert.ok(t.trace.some(e => e.text?.includes("operations reserve; stop")))
		assert.equal(w.me.tp, 6)
		assert.ok(!t.trace.some(e => e.text?.includes("historical compatibility")))
	} finally { delete globalThis.System }
})

for (const path of ["main", "reserve"]) test(`${path}: preview reports the actual adaptive execution policy`, () => {
	const w = arena({ distance: 1, equipped: true })
	try {
		const t = w.run({ truncated: path === "reserve" })
		const label = path === "main" ? "[Tactical]" : "[Reserve]"
		const entry = t.trace.find(e => e.text?.includes(`${label} plan before execution `))
		assert.ok(entry)
		const preview = JSON.parse(entry.text.split("plan before execution ")[1])
		const policy = path === "main" ? preview.executionBudget : preview.ops.executionMargin
		assert.match(policy, /3% total \+ 2 \* largest observed execution segment/)
		assert.match(policy, /opaque costs not guaranteed/)
		assert.ok(t.trace.some(e => e.name === "shot"))
	} finally { delete globalThis.System }
})

test("enemy displacement during preparation invalidates the plan AND cached danger", () => {
	const w = arena({ distance: 1, equipped: true })
	const native = Fight.weaponCells
	let changed = false
	Fight.weaponCells = (...args) => {
		if (!changed) {
			changed = true
			w.enemy.cell.entity = null; w.enemy.cell = w.cell(2); w.enemy.cell.entity = w.enemy
		}
		return native(...args)
	}
	try {
		const t = w.run()
		assert.ok(t.trace.some(e => e.text?.includes("fallback: state changed during search")))
		const p = JSON.parse(t.trace.find(e => e.text?.includes("[Reserve] plan before execution")).text.split("plan before execution ")[1])
		assert.equal(p.dangerStatus, "unknown")
		assert.equal(p.dangerAtShot, null)
		assert.ok(!t.trace.some(e => e.text?.includes("reuse current evaluation")))
	} finally { delete globalThis.System }
})

test("enemy displacement after shots cancels stale modeled cover rather than claiming safety", () => {
	const w = arena({ distance: 1, equipped: true, danger: c => c.x <= -2 ? 60.3 : 100 })
	w.me.chips = []
	w.me.afterShot = () => {
		w.enemy.cell.entity = null; w.enemy.cell = w.cell(3); w.enemy.cell.entity = w.enemy
	}
	try {
		const t = w.run()
		assert.equal(t.trace.some(e => e.name === "move"), false)
		assert.ok(t.trace.some(e => e.text?.includes("danger stale after actions; final move cancelled")))
		assert.ok(!t.trace.some(e => e.text?.includes("[Reserve]")))
	} finally { delete globalThis.System }
})

for (const path of ["main", "reserve"]) test(`${path}: an enemy moving during preview invalidates the attack before execution`, () => {
	const w = arena({ distance: 1, equipped: true })
	w.me.chips = []
	let changed = false
	try {
		const t = w.run({ truncated: path === "reserve", onLog: text => {
			if (!changed && text.includes("plan before execution")) {
				changed = true
				w.enemy.cell.entity = null; w.enemy.cell = w.cell(3); w.enemy.cell.entity = w.enemy
			}
		} })
		assert.ok(changed)
		assert.equal(t.trace.some(e => e.name === "shot"), false)
		assert.equal(t.trace.some(e => e.name === "move"), false)
		assert.equal(w.me.tp, 10)
		if (t.trace.some(e => e.name === "unknown retreat")) {
			assert.ok(t.trace.some(e => e.text?.includes("danger unknown; geometric only, no safety claim")))
		}
	} finally { delete globalThis.System }
})

test("entry without context remains effective and never invents known danger", () => {
	const w = arena({ distance: 1, equipped: true })
	w.me.chips = []
	try {
		const t = w.run({ contextless: true })
		assert.equal(t.trace.filter(e => e.name === "shot").length, 2)
		const p = JSON.parse(t.trace.find(e => e.text?.includes("[Reserve] plan before execution")).text.split("plan before execution ")[1])
		assert.equal(p.dangerStatus, "unknown")
		assert.equal(p.dangerAtShot, null)
		assert.equal(p.destination, null, "geometric retreat cannot be promised as cover")
	} finally { delete globalThis.System }
})

test("historical compatibility is explicitly conditional and its phase log cannot bypass the global guard", () => {
	const w = arena({ distance: 1, equipped: true, initialOps: 200000 })
	w.me.chips = []; w.me.weapons = [w.me.weapon]
	delete w.me.canUseChip
	try {
		const t = w.run({ contextless: true, onLog: text => {
			if (text.includes("; before action;")) w.setOps(701000)
		} })
		assert.ok(t.trace.some(e => e.text?.includes("historical compatibility queue only")))
		assert.ok(t.trace.some(e => e.text?.includes("historical queue; intent")))
		assert.ok(t.trace.some(e => e.text?.includes("global operations reserve after phase log")))
		assert.equal(t.trace.some(e => e.kind === "action"), false)
	} finally { delete globalThis.System }
})

test("historical compatibility continues at 711002 with small observed execution segments", () => {
	const w = arena({ distance: 1, equipped: true, initialOps: 711002 })
	w.me.chips = []; w.me.weapons = [w.me.weapon]
	delete w.me.canUseChip
	try {
		const t = w.run({ contextless: true }), actions = t.trace.filter(e => e.kind === "action")
		assert.ok(t.trace.some(e => e.text?.includes("historical compatibility queue only")))
		const entry = t.trace.find(e => e.text?.includes("plan before execution "))
		const preview = JSON.parse(entry.text.split("plan before execution ")[1])
		assert.match(preview.executionBudget, /3% total \+ 2 \* largest observed execution segment/)
		assert.ok(actions.some(e => e.name === "shot"))
		assert.ok(actions.every(e => e.ops > 711002 && e.ops < 970000))
	} finally { delete globalThis.System }
})

test("complete main incumbent survives research80% and executes shots plus retreat beyond it", () => {
	const w = arena({ turn: 7, distance: 1, life: 170, equipped: true,
		initialOps: 750000, danger: c => c.x <= -2 ? 60.3 : 100 })
	try {
		const t = w.run(), actions = t.trace.filter(e => e.kind === "action")
		const index = t.trace.findIndex(e => e.text?.startsWith("[Tactical] plan before execution "))
		assert.ok(index >= 0 && index < t.trace.findIndex(e => e.kind === "action"))
		const plan = JSON.parse(t.trace[index].text.split("plan before execution ")[1])
		assert.match(plan.searchStatus, /bounded search.*complete incumbent/)
		assert.equal(actions.filter(e => e.name === "shot").length, 2)
		assert.ok(actions.some(e => e.name === "move"), "reachable modeled retreat must still execute")
		assert.ok(actions.every(e => e.ops > 800000 && e.ops < 1000000))
		assert.deepEqual({ x: w.me.cell.x, y: w.me.cell.y }, plan.destination)
		assert.ok(!t.trace.some(e => e.text?.includes("[Reserve]")), "never launch a second sequence")
		assert.equal(w.stats.providers.size, 1, "no new native provider after research stops")
		assert.ok([...w.stats.providers.values()].every(n => n === 1))
		assert.ok(t.ops < 1000000)
	} finally { delete globalThis.System }
})
