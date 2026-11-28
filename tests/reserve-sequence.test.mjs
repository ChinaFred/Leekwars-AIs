import test from "node:test"
import assert from "node:assert/strict"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { executeReservePlan } from "../dist/Classes/Plannification/ReservePlan.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { getLogConfig, initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

const PREFIX = "[Reserve] plan before execution "

// Grille/BFS, dépenses et compteurs dynamiques. Frais synthétiques, PAS mesures moteur.
function arena({ distance = 7, life = 45, initialOps = 100000, providerJump = 610000,
	danger = c => c.x === -2 ? 0 : 100, extras = [] } = {}) {
	const grid = new Map(), trace = [], stats = { providers: 0, danger: 0 }
	let ops = initialOps
	for (let x = -17; x <= 17; x++) for (let y = -17; y <= 17; y++) {
		if (Math.abs(x) + Math.abs(y) <= 17) {
			grid.set(`${x},${y}`, { id: grid.size, x, y, obstacle: false, entity: null })
		}
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const gun = { name: "gun", minRange: 1, maxRange: 6, cost: 4, maxUses: -1,
		features: [{ type: 1, minValue: 30, maxValue: 30 }] }
	const heal = { name: "bandage", minRange: 0, maxRange: 6, cost: 2, maxUses: 1,
		currentCooldown: 0, features: [{ type: 2, minValue: 30, maxValue: 30 }] }
	const shield = { ...heal, name: "shield", cost: 6,
		features: [{ type: 3, minValue: 20, maxValue: 20 }] }
	const hit = (from, target, weapon) => {
		const d = dist(from, target.cell)
		return d >= weapon.minRange && d <= weapon.maxRange
	}
	const enemies = [[distance, 0], ...extras].map(([x, y], i) =>
		({ id: i + 2, cell: cell(x, y), life: 153, maxLife: 243, mp: 3, weapon: gun }))
	const record = (name, data = {}) => trace.push({ name, ops, tp: me.tp, mp: me.mp, dangerReads: stats.danger, ...data })
	const me = { id: 1, cell: cell(0), life, maxLife: 100, tp: 10, mp: 4,
		weapon: gun, weapons: [gun], chips: [heal], strength: 0, wisdom: 0,
		distance: target => dist(me.cell, target.cell),
		canUseWeapon(target, weapon = me.weapon) {
			ops += 100
			return target.life > 0 && weapon && hit(me.cell, target, weapon) && !me.deny
		},
		canUseChip(chip, target) {
			ops += 50
			if (me.chipError) throw new Error("native support error")
			return target === me && chip.currentCooldown === 0 && !me.denyChip
		},
		chipCells: () => [],
		setWeapon(weapon) { record("equip"); ops += 3000; if (me.failEquip) return false; me.weapon = weapon; me.tp--; return true },
		useWeapon(target) {
			record("shoot"); ops += 3000
			if (me.shotError) throw new Error("native shot error")
			if (me.refuse) return -1
			assert.ok(me.canUseWeapon(target) && me.tp >= gun.cost)
			me.tp -= gun.cost; target.life -= 30; me.afterShot?.()
			return 1
		},
		useChip(chip, target) {
			assert.ok(me.canUseChip(chip, target) && me.tp >= chip.cost)
			record("support", { chip: chip.name }); ops += 3000
			me.tp -= chip.cost; chip.currentCooldown = 1
			if (chip === heal) me.life = Math.min(me.maxLife, me.life + 30)
			return 1
		},
		moveToward(target, limit = me.mp) {
			const to = target.cell ?? target
			record("move", { to: { x: to.x, y: to.y }, limit }); ops += 3000
			if (me.failMove) return 0
			const cost = computeReachableCells(me, Math.min(me.mp, limit)).costTo(to)
			assert.notEqual(cost, null)
			me.cell.entity = null; me.cell = to; to.entity = me; me.mp -= cost
			return cost
		},
		moveAwayFrom(target, limit) { record("geometric", { target: target.id, limit }); ops += 3000; me.mp -= limit; return limit }
	}
	me.cell.entity = me
	for (const enemy of enemies) enemy.cell.entity = enemy
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	globalThis.Chip = { bandage: heal }
	globalThis.Field = { cellFromXY(x, y) { ops += 10; return cell(x, y) }, lineOfSight: () => true }
	globalThis.Fight = { turn: 6, me,
		getNearestEnemy: () => enemies.find(e => e.life > 0) ?? null,
		getAliveEnemies: () => enemies.filter(e => e.life > 0),
		weaponCells(target, weapon) {
			stats.providers++
			ops += providerJump // Par défaut > plafond relatif 60 % : force l'interruption de la recherche principale, avant dépense.
			return [...grid.values()].filter(c => hit(c, target, weapon))
		}
	}
	globalThis.System = { get operations() { return ++ops }, maxOperations: 1000000 }
	const profile = new LeekProfile()
	const reachable = computeReachableCells(me, me.mp)
	const threat = new ThreatMap(me.id, 6, new Map([...reachable.entries()].map(e =>
		[e.cell.x * 4096 + e.cell.y, { ...e, danger: danger(e.cell), breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false,
		enemyCount: enemies.length, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const nativeDanger = threat.dangerAt.bind(threat)
	threat.dangerAt = c => { stats.danger++; ops += 100; return nativeDanger(c) }
	const context = { reachable, threat }
	const run = ({ direct = false, ctx = context, contextless = false, enabled = true, onLog } = {}) => {
		const begin = trace.length
		const saved = getLogConfig(), oldLog = console.log, oldDebug = globalThis.Debug, oldColor = globalThis.Color
		initLeekLogging(new LogConfig().setAll(false).setEnabled(LOG_CONTEXT.PLANNING, enabled).setEnabled(LOG_CONTEXT.ERROR, true))
		console.log = text => { trace.push({ text, ops }); ops += text.length; onLog?.(text) }
		globalThis.Debug = { log: text => trace.push({ error: text }) }
		globalThis.Color = { rgb: () => 0 }
		try {
			if (direct) executeReservePlan(me, profile, contextless ? undefined : ctx)
			else planAct(me, profile, contextless ? undefined : ctx)
		} finally {
			console.log = oldLog; initLeekLogging(saved); globalThis.Debug = oldDebug; globalThis.Color = oldColor
			delete globalThis.System
		}
		const turnTrace = trace.slice(begin)
		const previewIndex = turnTrace.findIndex(e => e.text?.startsWith(PREFIX))
		return { trace: turnTrace, actions: turnTrace.filter(e => e.name), previewIndex,
			plan: previewIndex < 0 ? null : JSON.parse(turnTrace[previewIndex].text.slice(PREFIX.length)), ops }
	}
	return { me, enemies, cell, profile, context, stats, heal, shield, run,
		bumpOps(value) { ops += value },
		resetOps(value) {
			ops = value
			globalThis.System = { get operations() { return ++ops }, maxOperations: 1000000 }
		} }
}

function assertPlanBeforeActions(result) {
	assert.ok(result.previewIndex >= 0 && result.previewIndex < result.trace.findIndex(e => e.name))
	for (const action of result.actions) {
		assert.match(result.trace[result.trace.indexOf(action) - 1].text, /phase before action|before action;/)
	}
}

test("turn6 fallback: actual sequence, support, final path and PT/MP are decided before first action", () => {
	const w = arena(), r = w.run()
	assertPlanBeforeActions(r)
	assert.ok(r.trace.some(e => e.text?.includes("fallback: operations reserve")))
	assert.deepEqual(r.plan.approach, { to: { x: 1, y: 0 }, mpCost: 1, mpRemainingIfReached: 3 })
	assert.equal(r.plan.attack.weaponShotsAtMost, 2)
	assert.deepEqual(r.plan.protection, [{ chip: "bandage", target: 1, tpCost: 2, tpBefore: 2, tpAfter: 0 }])
	assert.deepEqual(r.plan.destination, { x: -2, y: 0 })
	assert.equal(r.plan.retreat.mpCost, 3)
	assert.deepEqual(r.plan.resources, { tpInitial: 10, equipment: 0, attack: 8, boost: 0, support: 2,
		tpRemainingIfExecuted: 0, mpInitial: 4, approachOrProgress: 1, retreat: 3, mpRemainingIfExecuted: 0 })
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "shoot", "support", "move"])
	assert.deepEqual(r.actions.at(-1).to, r.plan.destination)
	assert.equal(w.stats.providers, 1)
	assert.equal(w.stats.danger, r.actions[0].dangerReads, "no danger rescanning after action")
	assert.equal(w.me.tp, 0); assert.equal(w.me.mp, 0)
})

for (const life of [50, 25]) test(`contact turn8/9 life${life}: support/cover forecast and actual two shots past70%`, () => {
	const w = arena({ distance: 1, life, initialOps: 665000, providerJump: 160000,
		danger: c => c.x <= -2 ? 60.3 : 100 })
	// Réserve directe : le principal a déjà refusé ; simuler un résultat natif tardif.
	const r = w.run({ direct: true })
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.destination, { x: -2, y: 0 })
	assert.equal(r.plan.retreat.mpCost, 2)
	assert.equal(r.plan.protection[0].chip, "bandage")
	assert.equal(r.actions.filter(e => e.name === "shoot").length, 2)
	assert.ok(r.actions.every(e => e.ops > 700000))
	assert.ok(r.ops < 1000000)
})

test("equipment and its PT are explicit; failed equipment activates only planned support/retreat", () => {
	const w = arena(); w.me.weapon = null; w.me.failEquip = true
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.equal(r.plan.attack.equipTp, 1)
	assert.equal(r.plan.resources.equipment, 1)
	assert.deepEqual(r.actions.map(e => e.name), ["move", "equip", "support", "move"])
	assert.equal(r.plan.protection.length, 0)
	assert.equal(r.plan.support.alternatives[0].chip, "bandage")
	assert.equal(w.me.tp, 8)
})

test("refused attack enables a support alternative explicitly listed before action, no extra shots", () => {
	const w = arena({ life: 30 }); w.me.chips = [w.shield]; w.me.refuse = true
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.equal(r.plan.protection.length, 0)
	assert.deepEqual(r.plan.support.alternatives, [{ chip: "shield", tpCost: 6, when: "earlier actions spend less PT" }])
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "support", "move"])
	assert.equal(w.me.tp, 4)
})

test("refused attack: the first heal changes life and cancels the later listed support", () => {
	const w = arena()
	const backup = { ...w.heal, name: "backup" }
	w.me.chips = [w.heal, backup]; w.me.refuse = true
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.protection.map(s => s.chip), ["bandage"])
	assert.deepEqual(r.plan.support.alternatives.map(s => s.chip), ["backup"])
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "support", "move"])
	assert.equal(r.actions.find(e => e.name === "support").chip, "bandage")
	assert.equal(w.me.life, 75)
	assert.equal(w.me.tp, 8)
})

test("support listed in the plan is cancelled if cooldown changes after shooting", () => {
	const w = arena()
	w.me.afterShot = () => { w.heal.currentCooldown = 1 }
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.protection.map(s => s.chip), ["bandage"])
	assert.equal(r.actions.some(e => e.name === "support"), false)
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "shoot", "move"])
	assert.equal(w.me.tp, 2)
})

test("healing and shielding opt-outs are explicit in the plan and never execute", () => {
	const w = arena(); w.me.chips = [w.heal, w.shield]
	w.profile.allowHealing = false; w.profile.allowShielding = false
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.protection, [])
	assert.deepEqual(r.plan.support.omitted.map(s => [s.chip, s.reason]), [
		["bandage", "profile forbids support"], ["shield", "profile forbids support"]
	])
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "shoot", "move"])
	assert.equal(w.me.tp, 2)
})

for (const minimumRange of [6]) {
	test(`shield forecast uses distance from the planned shot cell across threat range`, () => {
		for (const [range, expected] of [[minimumRange - 1, false], [minimumRange, true], [minimumRange + 1, true]]) {
			const w = arena({ life: 30 })
			w.shield.cost = 2; w.me.chips = [w.shield]
			w.enemies[0].mp = 0
			w.enemies[0].weapon = { ...w.enemies[0].weapon, maxRange: range }
			const r = w.run()
			assertPlanBeforeActions(r)
			assert.deepEqual(r.plan.approach.to, { x: 1, y: 0 })
			assert.equal(r.plan.protection.some(s => s.chip === "shield"), expected, `range=${range}`)
			assert.equal(r.actions.some(e => e.name === "support" && e.chip === "shield"), expected)
			assert.equal(w.me.tp, expected ? 0 : 2)
		}
	})
}

test("successive reserve turns replan from real positions and current cooldowns", () => {
	const w = arena({ distance: 15, life: 30, danger: () => 0 })
	const origins = [], destinations = [], turns = []
	for (let i = 0; i < 3; i++) {
		if (i > 0) { Fight.turn++; w.me.tp = 10; w.me.mp = 4 }
		w.resetOps(200000)
		const reachable = computeReachableCells(w.me, w.me.mp)
		const threat = new ThreatMap(w.me.id, Fight.turn, new Map([...reachable.entries()].map(e =>
			[e.cell.x * 4096 + e.cell.y, { ...e, danger: 0, breakdown: [] }])),
		{ candidateCells: reachable.size, truncated: false, inputsTruncated: false,
			enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
		const r = w.run({ direct: true, ctx: { reachable, threat } })
		assertPlanBeforeActions(r)
		origins.push(r.plan.origin)
		destinations.push({ x: w.me.cell.x, y: w.me.cell.y })
		turns.push(r)
		assert.deepEqual(r.plan.origin, i === 0 ? { x: 0, y: 0 } : destinations[i - 1])
		assert.ok(w.me.mp >= 0 && w.me.tp >= 0)
	}
	assert.deepEqual(origins.slice(0, 2), [{ x: 0, y: 0 }, { x: 4, y: 0 }])
	assert.deepEqual(destinations.slice(0, 2), [{ x: 4, y: 0 }, { x: 8, y: 0 }])
	assert.equal(turns[0].actions.filter(e => e.name === "support").length, 1)
	assert.ok(turns[1].plan.support.omitted.some(s => s.chip === "bandage" && /cooldown/.test(s.reason)))
	assert.equal(turns[1].actions.some(e => e.name === "support"), false)
	assert.ok(turns[2].actions.some(e => e.name === "shoot"), "progress eventually reaches an executable attack")
})

for (const invalid of ["absent", "truncated", "stale"]) test(`${invalid} map: planned geometric branch, explicit unknown destination`, () => {
	const w = arena()
	if (invalid === "truncated") w.context.threat.inputsTruncated = true
	if (invalid === "stale") w.context.threat.turn--
	const r = w.run({ direct: true, contextless: invalid === "absent" })
	assertPlanBeforeActions(r)
	assert.equal(r.plan.destination, null)
	assert.equal(r.plan.retreat.mode, "geometric")
	assert.equal(r.plan.retreat.awayFrom, 2)
	assert.equal(r.plan.retreat.mpLimit, 3)
	assert.equal(r.plan.retreat.mpCost, null)
	assert.equal(r.plan.resources.retreat, null)
	assert.equal(r.plan.resources.mpRemainingIfExecuted, null)
	assert.equal(r.plan.retreat.danger, null)
	assert.match(r.plan.retreat.status, /no safety claim/)
	assert.equal(r.actions.at(-1).name, "geometric")
})

test("no shot: progression, support and absence of post-attack retreat are all explicit", () => {
	const w = arena({ distance: 15, life: 30, danger: () => 0 })
	const r = w.run({ direct: true })
	assertPlanBeforeActions(r)
	assert.equal(r.plan.attack, null)
	assert.deepEqual(r.plan.destination, { x: 4, y: 0 })
	assert.equal(r.plan.resources.attack, 0)
	assert.equal(r.plan.protection[0].chip, "bandage")
	assert.match(r.plan.retreat.status, /no attack selected/)
	assert.deepEqual(r.actions.map(e => e.name), ["move", "support"])
	assert.equal(w.stats.providers, 0)
})

test("multi-enemy danger picks the announced aggregate cover, not nearest-target distance", () => {
	const w = arena({ extras: [[-4, 0]], danger: c => c.y === 1 ? 10 : c.x < 0 ? 200 : 100 })
	const r = w.run({ direct: true })
	assertPlanBeforeActions(r)
	assert.equal(r.plan.destination.y, 1)
	assert.equal(r.plan.retreat.danger, 10)
	assert.deepEqual(r.actions.at(-1).to, r.plan.destination)
})

test("hiding opt-out gives a concrete final hold with its reason", () => {
	const w = arena(); w.profile.allowHiding = false
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.equal(r.plan.retreat.mode, "hold")
	assert.match(r.plan.retreat.status, /profile forbids/)
	assert.deepEqual(r.plan.destination, { x: 1, y: 0 })
	assert.equal(r.actions.filter(e => e.name === "move").length, 1)
})

test("failed approach cancels the entire announced sequence", () => {
	const w = arena(); w.me.failMove = true
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.equal(r.plan.retreat.alternatives.failedApproach, "stop entire sequence")
	assert.deepEqual(r.actions.map(e => e.name), ["move"])
	assert.equal(w.me.tp, 10)
})

test("a newly blocked retreat is cancelled, not replaced by an unannounced second plan", () => {
	const w = arena(); w.me.afterShot = () => { w.cell(0).obstacle = true; w.cell(1, 1).obstacle = true; w.cell(1, -1).obstacle = true }
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.destination, { x: -2, y: 0 })
	assert.match(r.plan.retreat.alternatives.blockedDestination, /hold/)
	assert.equal(r.actions.filter(e => e.name === "move").length, 1)
	assert.equal(r.trace.filter(e => e.text?.startsWith(PREFIX)).length, 1)
})

test("native action exception is reported after preview and never starts another sequence", () => {
	const w = arena(); w.me.shotError = true
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot"])
	assert.ok(r.trace.some(e => e.error?.includes("native shot error")))
	assert.match(r.plan.retreat.alternatives.apiFailure, /no second sequence/)
})

test("forced displacement uses the announced local branch, never another offensive sequence", () => {
	const w = arena()
	w.me.afterShot = () => {
		w.me.cell.entity = null; w.me.cell = w.cell(0, 1); w.me.cell.entity = w.me
	}
	const r = w.run()
	assertPlanBeforeActions(r)
	assert.deepEqual(r.plan.destination, { x: -2, y: 0 })
	assert.match(r.plan.retreat.alternatives.displacedOrReducedMP, /one bounded local path check/)
	assert.deepEqual(r.actions.at(-1).to, { x: -2, y: 1 })
	assert.equal(r.actions.filter(e => e.name === "shoot").length, 1)
	assert.ok(r.trace.some(e => e.text?.includes("retreat branch: changed position/MP")))
	assert.equal(r.trace.filter(e => e.text?.startsWith(PREFIX)).length, 1)
})

test("zero MP: current shots/support are explicit, no provider or invented retreat", () => {
	const w = arena({ distance: 1 }); w.me.mp = 0
	const r = w.run({ direct: true })
	assertPlanBeforeActions(r)
	assert.equal(r.plan.retreat.mode, "hold")
	assert.match(r.plan.retreat.status, /no remaining MP/)
	assert.deepEqual(r.plan.destination, { x: 0, y: 0 })
	assert.deepEqual(r.actions.map(e => e.name), ["shoot", "shoot", "support"])
	assert.equal(w.stats.providers, 0)
})

test("native preparation error reports the unavailable plan and performs no action", () => {
	const w = arena()
	Fight.weaponCells = () => { throw new Error("native preparation error") }
	const r = w.run({ direct: true })
	assert.equal(r.plan, null)
	assert.deepEqual(r.actions, [])
	assert.ok(r.trace.some(e => e.error?.includes("native preparation error")))
	assert.ok(r.trace.some(e => e.text?.includes("API failure; stop (movement attempted=false)")))
})

test("old host without Fight.weaponCells: planAct says the reserve API is unavailable and does nothing", () => {
	const w = arena({ distance: 3 }); w.me.chips = []
	delete Fight.weaponCells
	const r = w.run({ contextless: true })
	assert.equal(r.plan, null)
	assert.ok(r.trace.some(e => e.text?.includes("reserve API unavailable; no action")))
	assert.deepEqual(r.actions, [])
})

test("PLANNING disabled produces no previews but executes the same preselected sequence", () => {
	const w = arena(), r = w.run({ enabled: false })
	assert.equal(r.trace.some(e => e.text), false)
	assert.deepEqual(r.actions.map(e => e.name), ["move", "shoot", "shoot", "support", "move"])
})

for (const enabled of [true, false]) test(`expensive final path completion stops safely with PLANNING=${enabled}`, () => {
	const w = arena({ initialOps: 200000, providerJump: 160000 })
	const entries = w.context.reachable.entries.bind(w.context.reachable)
	let scans = 0
	w.context.reachable.entries = () => {
		if (++scans === 3) w.bumpOps(500000)
		return entries()
	}
	const r = w.run({ direct: true, enabled })
	assert.equal(scans, 3, "the synthetic cost is applied during final path preparation")
	assert.deepEqual(r.actions, [])
	assert.ok(r.ops < 1000000)
	assert.equal(w.me.tp, 10); assert.equal(w.me.mp, 4)
	if (enabled) {
		assert.ok(r.plan)
		assert.equal(r.plan.retreat.complete, false)
		assert.match(r.plan.retreat.status, /completion margin/)
		assert.ok(r.trace.some(e => e.text?.includes("hard operations reserve; no action")))
	} else assert.equal(r.plan, null)
})
