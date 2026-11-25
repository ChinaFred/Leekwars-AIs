import test from "node:test"
import assert from "node:assert/strict"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { executeTacticalPlan } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { executeReservePlan } from "../dist/Classes/Plannification/ReservePlan.js"
import { Plannification } from "../dist/Classes/Plannification/Plannification.js"
import { Action } from "../dist/Classes/Plannification/Action.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, getLogConfig, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

const TACTICAL = "[Tactical] plan before execution "
const RESERVE = "[Reserve] plan before execution "
const LEGACY = "[Plannification] Execute: plan before execution "
const position = cell => ({ x: cell.x, y: cell.y })

function world({ distance = 7, range = 6, danger = c => c.x === -2 ? 0 : 100 } = {}) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const cells = new Map()
	for (let x = -4; x <= 9; x++) cells.set(x, { id: x + 4, x, y: 0, obstacle: false, entity: null, empty: true })
	const cell = x => cells.get(x)
	const trace = []
	const record = name => trace.push({ kind: "action", name, tp: me.tp, mp: me.mp, from: position(me.cell) })
	const gun = { name: "gun", cost: 4, minRange: 1, maxRange: range, maxUses: -1,
		features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const heal = { name: "bandage", cost: 2, minRange: 0, maxRange: 6, currentCooldown: 0,
		features: [{ type: 2, minValue: 20, maxValue: 20 }] }
	const shield = { ...heal, name: "shield", cost: 1, features: [{ type: 3, minValue: 20, maxValue: 20 }] }
	const bolt = { ...heal, name: "bolt", cost: 1, features: [{ type: 1, minValue: 10, maxValue: 10 }] }
	const hits = (from, target, item) => {
		const d = Math.abs(from.x - target.cell.x)
		return d >= item.minRange && d <= item.maxRange
	}
	const enemy = { id: 2, cell: cell(distance), life: 153, maxLife: 243, mp: 3, weapon: gun }
	const me = { id: 1, cell: cell(0), life: 70, maxLife: 100, tp: 10, mp: 4,
		strength: 0, wisdom: 0, weapon: gun, weapons: [gun], chips: [],
		distance: target => Math.abs(me.cell.x - target.cell.x),
		canUseWeapon: (target, item = me.weapon) => !!item && target.life > 0 && !me.deny &&
			hits(me.cell, target, item),
		canUseChip: (chip, target) => target.life > 0 && chip.currentCooldown === 0 && hits(me.cell, target, chip),
		chipCells: (chip, target) => [...cells.values()].filter(c => hits(c, target, chip)),
		setWeapon(item) { record("equipment"); if (me.failEquip) return false; me.weapon = item; me.tp--; return true },
		moveToward(target, limit = me.mp) {
			record("move")
			if (me.failMove) return 0
			const destination = target.cell ?? target
			const cost = computeReachableCells(me, Math.min(me.mp, limit)).costTo(destination)
			assert.notEqual(cost, null)
			me.cell.entity = null; me.cell = destination; destination.entity = me; me.mp -= cost
			return cost
		},
		moveAwayFrom(target, limit = me.mp) { record("away"); me.mp -= limit; return limit },
		useWeapon(target) {
			record("weapon shot")
			if (me.refuse) return -1
			assert.ok(me.tp >= me.weapon.cost && me.canUseWeapon(target))
			me.tp -= me.weapon.cost; target.life -= 20; me.afterShot?.()
			return 1
		},
		useChip(chip, target) {
			record(chip.name)
			assert.ok(me.tp >= chip.cost && me.canUseChip(chip, target))
			me.tp -= chip.cost; chip.currentCooldown = 1
			return 1
		}
	}
	me.cell.entity = me; enemy.cell.entity = enemy
	globalThis.Fight = { turn: 6, me, getNearestEnemy: () => enemy,
		getAliveEnemies: () => enemy.life > 0 ? [enemy] : [],
		weaponCells: (target, item) => [...cells.values()].filter(c => hits(c, target, item)) }
	globalThis.Field = { cellFromXY: (x, y) => y === 0 ? cell(x) ?? null : null }
	globalThis.Chip = { bandage: heal }
	const reachable = computeReachableCells(me, me.mp)
	const threat = new ThreatMap(me.id, 6, new Map([...reachable.entries()].map(e =>
		[e.cell.x * 4096 + e.cell.y, { cell: e.cell, danger: danger(e.cell), mpCost: e.cost, breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false,
		enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const profile = new LeekProfile()
	const complete = () => ({
		target: enemy, shotCell: cell(1), destination: cell(-2), beforeMp: 1, afterMp: 3,
		weapon: gun, weaponShots: 2, chips: [bolt], protection: [shield],
		tpUsed: 11, usefulDamage: 50, danger: 0, score: 50
	})
	return { me, enemy, cell, trace, gun, heal, shield, bolt, profile,
		context: { reachable, threat }, complete }
}

function capture(w, fn, enabled = true, otherContexts = false) {
	const oldLog = console.log, config = getLogConfig()
	initLeekLogging(new LogConfig().setAll(otherContexts).setEnabled(LOG_CONTEXT.PLANNING, enabled))
	console.log = text => w.trace.push({ kind: "log", text })
	try { fn() } finally { console.log = oldLog; initLeekLogging(config) }
	return w.trace
}

function preview(trace, prefix) {
	const index = trace.findIndex(e => e.kind === "log" && e.text.startsWith(prefix))
	assert.ok(index >= 0, `missing ${prefix}`)
	assert.ok(index < trace.findIndex(e => e.kind === "action"), "preview precedes every native action")
	return JSON.parse(trace[index].text.slice(prefix.length))
}

function actions(trace) { return trace.filter(e => e.kind === "action") }
function phases(trace) {
	return trace.filter(e => e.kind === "log" && e.text.includes("phase before action "))
		.map(e => JSON.parse(e.text.split("phase before action ")[1]))
}
function assertBeforeEveryAction(trace, names) {
	const actual = []
	for (let i = 0; i < trace.length; i++) {
		if (trace[i].kind !== "action") continue
		const preceding = trace[i - 1]
		assert.equal(preceding.kind, "log")
		assert.ok(preceding.text.includes("phase before action "))
		const phase = JSON.parse(preceding.text.split("phase before action ")[1])
		actual.push(phase.phase)
		assert.equal(phase.tp, trace[i].tp)
		assert.equal(phase.mp, trace[i].mp)
		assert.deepEqual(phase.from, trace[i].from)
	}
	assert.deepEqual(actual, names)
}

test("complete plan: exact preview and real protection/equipment/chip/shots/movement order before spending", () => {
	const w = world(), plan = w.complete()
	w.me.tp = 12; w.me.weapon = { ...w.gun, name: "old" }; w.me.chips = [w.shield, w.bolt]
	const trace = capture(w, () => executeTacticalPlan(w.me, plan))
	const p = preview(trace, TACTICAL)
	assert.deepEqual(p.order, ["approach", "protection", "equipment if needed", "offensive chips", "weapon shots", "final move"])
	assert.deepEqual(p.target, { id: 2, position: { x: 7, y: 0 } })
	assert.deepEqual([p.origin, p.shotCell, p.destination], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }])
	assert.deepEqual(p.tp, { available: 12, planned: 11, remainingIfExecuted: 1 })
	assert.deepEqual(p.mp, { available: 4, before: 1, after: 3 })
	assert.deepEqual(p.weapon, { name: "gun", cost: 4, equipTp: 1, shots: 2 })
	assert.deepEqual(p.chips, [{ name: "bolt", cost: 1 }])
	assert.deepEqual(p.protection, [{ name: "shield", cost: 1 }])
	assert.equal(p.danger, 0); assert.equal(p.score, 50)
	assert.match(p.mode, /native checks may cancel/)
	assertBeforeEveryAction(trace, ["approach", "protection", "equipment", "offensive chip", "weapon shot", "weapon shot", "final move"])
	assert.equal(w.me.tp, 1); assert.equal(w.me.mp, 0)
})

test("planAct complete path prints selected plan before any action", () => {
	const w = world()
	const trace = capture(w, () => planAct(w.me, w.profile, w.context))
	const p = preview(trace, TACTICAL)
	assert.equal(p.target.id, 2)
	assert.equal(p.weapon.shots, 2)
	assert.ok(!trace.some(e => e.text?.startsWith(RESERVE)))
	assertBeforeEveryAction(trace, ["approach", "weapon shot", "weapon shot", "final move"])
})

test("complete plan failure: announced intent does not become a fictitious shot after failed approach", () => {
	const w = world(); w.me.failMove = true
	const trace = capture(w, () => executeTacticalPlan(w.me, w.complete()))
	assert.equal(preview(trace, TACTICAL).weapon.shots, 2)
	assert.deepEqual(actions(trace).map(e => e.name), ["move"])
	assert.deepEqual(phases(trace).map(e => e.phase), ["approach"])
	assert.ok(trace.some(e => e.text?.includes("shot cell not reached")))
	assert.equal(w.me.tp, 10)
})

test("complete refused shot: phase is an attempt, refusal is explicit and not retried", () => {
	const w = world(), plan = { ...w.complete(), chips: [], protection: [] }; w.me.refuse = true
	const trace = capture(w, () => executeTacticalPlan(w.me, plan))
	preview(trace, TACTICAL)
	assertBeforeEveryAction(trace, ["approach", "weapon shot", "final move"])
	assert.ok(trace.some(e => e.text?.includes("weapon refused: result -1")))
	assert.equal(w.me.tp, 10)
})

test("reserve after operations reserve: full conditional sequence precedes approach, attack and retreat", () => {
	const w = world()
	let ops = 200000
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const native = Fight.weaponCells
	Fight.weaponCells = (...args) => { ops = 510000; return native(...args) }
	try {
		const trace = capture(w, () => planAct(w.me, w.profile, w.context))
		assert.ok(trace.some(e => e.text?.includes("fallback: operations reserve")))
		const p = preview(trace, RESERVE)
		assert.match(p.mode, /bounded sequence with explicit conditional branches/)
		assert.deepEqual(p.approach, { to: { x: 1, y: 0 }, mpCost: 1, mpRemainingIfReached: 3 })
		assert.equal(p.attack.weaponShotsAtMost, 2)
		assert.equal(p.attack.weaponTpAtMost, 8)
		assert.match(p.attack.condition, /recheck real position/)
		assert.deepEqual(p.protection, [])
		assert.deepEqual(p.destination, { x: -2, y: 0 }); assert.equal(p.score, null)
		assert.equal(p.retreat.mode, "modeled")
		assert.equal(p.retreat.mpCost, 3)
		assert.equal(p.resources.mpRemainingIfExecuted, 0)
		assert.match(p.retreat.alternatives.blockedDestination, /hold/)
		assertBeforeEveryAction(trace, ["approach", "weapon shot", "weapon shot", "retreat"])
		const retreat = phases(trace).at(-1)
		assert.deepEqual(retreat.to, { x: -2, y: 0 }); assert.equal(retreat.mpCost, 3); assert.equal(retreat.mp, 3)
	} finally { delete globalThis.System }
})

test("reserve support: projected before actions and checked against real PT after shots", () => {
	const w = world(); w.me.chips = [w.heal]
	const trace = capture(w, () => executeReservePlan(w.me, w.profile, w.context))
	const p = preview(trace, RESERVE)
	assert.deepEqual(p.protection, [{ chip: "bandage", target: 1, tpCost: 2, tpBefore: 2, tpAfter: 0 }])
	assert.equal(p.resources.attack, 8)
	assert.equal(p.resources.support, 2)
	assert.equal(p.resources.tpRemainingIfExecuted, 0)
	assertBeforeEveryAction(trace, ["approach", "weapon shot", "weapon shot", "support", "retreat"])
	const support = phases(trace).find(p => p.phase === "support")
	assert.equal(support.tp, 2); assert.equal(support.details.chip, "bandage")
})

test("reserve unknown map: no invented destination or safety in preview or geometric retreat phase", () => {
	const w = world()
	const trace = capture(w, () => executeReservePlan(w.me, w.profile))
	const p = preview(trace, RESERVE)
	assert.equal(p.destination, null); assert.equal(p.dangerAtShot, null); assert.equal(p.dangerStatus, "unknown")
	assertBeforeEveryAction(trace, ["approach", "weapon shot", "weapon shot", "geometric retreat"])
	const retreat = phases(trace).at(-1).details
	assert.equal(retreat.destination, null); assert.equal(retreat.danger, null)
	assert.equal(retreat.mpLimit, 3); assert.equal(retreat.awayFrom, 2)
})

test("reserve no shot: progression destination is announced before movement", () => {
	const w = world({ range: 1, danger: () => 0 })
	const trace = capture(w, () => executeReservePlan(w.me, w.profile, w.context))
	const p = preview(trace, RESERVE)
	assert.equal(p.attack, null); assert.equal(p.approach, null)
	assert.deepEqual(p.destination, { x: 4, y: 0 })
	assert.equal(p.retreat.mode, "hold")
	assert.match(p.retreat.status, /no attack selected/)
	assert.deepEqual(p.progressSelection.to, p.destination)
	assert.deepEqual(p.emergencyProgress.to, { x: 4, y: 0 })
	assertBeforeEveryAction(trace, ["cached progress"])
	assert.deepEqual(phases(trace)[0].to, { x: 4, y: 0 })
	assert.equal(w.me.tp, 10)
})

for (const failure of ["move", "weapon"]) {
	test(`reserve ${failure} failure: conditional preview, no second sequence or fake success`, () => {
		const w = world(); w.me.failMove = failure === "move"; w.me.refuse = failure === "weapon"
		const trace = capture(w, () => executeReservePlan(w.me, w.profile, w.context))
		assert.equal(preview(trace, RESERVE).attack.weaponShotsAtMost, 2)
		assertBeforeEveryAction(trace, failure === "move" ? ["approach"] : ["approach", "weapon shot", "retreat"])
		assert.ok(trace.some(e => e.text?.includes(failure === "move" ? "not reached; stop" : "weapon refused: result -1")))
		assert.equal(w.me.tp, 10)
		assert.equal(trace.filter(e => e.text?.startsWith(RESERVE)).length, 1)
	})
}

test("historical planAct: whole queued order and provisional budgets precede execution", () => {
	const w = world({ distance: 3 }); w.me.chips = [w.heal]
	delete Fight.weaponCells // chemin de compatibilité réel, pas une imitation du planificateur
	const trace = capture(w, () => planAct(w.me, w.profile))
	const p = preview(trace, LEGACY)
	assert.deepEqual(p.actions.map(a => a.name), ["shoot", "shoot", "heal"])
	assert.deepEqual(p.tp, { available: 10, remainingPlanned: 0 })
	assert.deepEqual(p.mp, { available: 4, remainingPlanned: 4 })
	assert.equal(p.destination, null); assert.equal(p.danger, null); assert.equal(p.score, null)
	for (let i = 0; i < trace.length; i++) if (trace[i].kind === "action") {
		assert.match(trace[i - 1].text, /^\[Plannification\]   → .*before action/)
	}
	assert.equal(w.me.tp, 0)
})

test("historical queue exhaustion is not logged as guaranteed action success", () => {
	const w = world({ distance: 3 }), plan = new Plannification(w.me, w.enemy, w.profile)
	w.me.refuse = true
	plan.actions.push(new Action("shoot", () => w.me.useWeapon(w.enemy), "gun"))
	const trace = capture(w, () => plan.execute())
	preview(trace, LEGACY)
	assert.equal(w.me.tp, 10)
	assert.ok(trace.some(e => e.text?.includes("queue completed, success not inferred")))
})

for (const mode of ["complete", "reserve", "historical"]) {
	test(`${mode}: PLANNING off emits nothing even with other contexts enabled; formatting stays lazy`, () => {
		const w = world({ distance: mode === "historical" ? 3 : 7 }), p = w.complete()
		let reads = 0
		let run
		if (mode === "complete") {
			Object.defineProperty(p, "score", { get() { reads++; return 50 } })
			run = () => executeTacticalPlan(w.me, p)
		} else if (mode === "reserve") {
			Object.defineProperty(w.gun, "name", { get() { reads++; return "gun" } })
			run = () => executeReservePlan(w.me, w.profile, w.context)
		} else {
			const plan = new Plannification(w.me, w.enemy, w.profile)
			const action = new Action("shoot", () => w.me.useWeapon(w.enemy))
			Object.defineProperty(action, "desc", { get() { reads++; return "gun" } })
			plan.actions.push(action)
			run = () => plan.execute()
		}
		const trace = capture(w, run, false, true)
		assert.ok(actions(trace).length > 0)
		assert.equal(trace.filter(e => e.kind === "log").length, 0)
		assert.equal(reads, 0)
	})
}

test("reserve and complete decisions/native action order are unchanged by PLANNING activation", () => {
	for (const mode of ["complete", "reserve"]) {
		const runs = []
		for (const enabled of [false, true]) {
			const w = world()
			const trace = capture(w, () => mode === "complete"
				? executeTacticalPlan(w.me, w.complete()) : executeReservePlan(w.me, w.profile, w.context), enabled)
			runs.push(actions(trace))
		}
		assert.deepEqual(runs[0], runs[1], mode)
	}
})

test("preview/phase formatting errors are swallowed without changing native action order", () => {
	const baseline = world()
	capture(baseline, () => executeReservePlan(baseline.me, baseline.profile, baseline.context))
	const w = world(), stringify = JSON.stringify
	try {
		JSON.stringify = () => { throw new Error("formatting fixture failure") }
		capture(w, () => executeReservePlan(w.me, w.profile, w.context))
	} finally { JSON.stringify = stringify }
	assert.deepEqual(actions(w.trace), actions(baseline.trace))
})
