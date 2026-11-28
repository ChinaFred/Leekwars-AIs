import test from "node:test"
import assert from "node:assert/strict"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { executeReservePlan } from "../dist/Classes/Plannification/ReservePlan.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, getLogConfig, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Coûts synthétiques par primitive réellement appelée, PAS des mesures moteur.
// Les déplacements utilisent le vrai BFS local : pas de téléportation ni de portée fictive.
function combat({ currentCheckCost = 21000, dangerReadCost = 500, planningActionLogCost = 0,
	nativeMoveCost = 1000, danger = () => 0, enemyCount = 1 } = {}) {
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const grid = new Map(), trace = [], turns = []
	for (let x = -30; x <= 50; x++) for (let y = 0; y <= 2; y++) {
		grid.set(`${x},${y}`, { id: grid.size, x, y, obstacle: y === 2 && x % 5 === 0, entity: null, empty: true })
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	let ops = 0, stats, reserveStart, fieldCallsAtFallback, dangerReadsAtFallback
	const gun = { name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, maxUses: -1,
		needsLos: true, features: [{ type: 1, minValue: 40, maxValue: 40 }] }
	const enemies = Array.from({ length: enemyCount }, (_, i) =>
		({ id: 2 + i, cell: cell(i === 0 ? 26 : -26), life: 249, maxLife: 249, mp: 3, weapon: gun }))
	const hits = (from, target) => {
		const d = Math.abs(from.x - target.cell.x) + Math.abs(from.y - target.cell.y)
		return d >= 1 && d <= 6 && Field.lineOfSight(from, target.cell)
	}
	const me = { id: 1, cell: cell(0), life: 333, maxLife: 333, tp: 9, mp: 4,
		weapon: gun, weapons: [gun], chips: [], strength: 0, wisdom: 0,
		distance: target => Math.abs(me.cell.x - target.cell.x) + Math.abs(me.cell.y - target.cell.y),
		canUseWeapon(target) {
			ops += currentCheckCost; stats.currentChecks++; me.afterCurrentCheck?.()
			return hits(me.cell, target)
		},
		canUseChip: () => true,
		useWeapon() { throw new Error("no simulated target can be shot from this position") },
		useChip(chip) { record("support"); ops += 1000; me.tp -= chip.cost; return 1 },
		moveToward(destination, limit) {
			record("move", { destination: { x: destination.x, y: destination.y }, limit,
				fieldCallsBeforeNative: stats.fieldCalls })
			if (me.failMove) { ops += 100; return 0 }
			// Pathfinding du contrôle natif simulé, avec les mêmes obstacles/occupants/PM.
			const fresh = computeReachableCells(me, Math.min(me.mp, limit), Fight.turn)
			const cost = fresh.costTo(destination)
			if (cost === null) return 0
			assert.ok(cost > 0 && cost <= me.mp && cost <= limit)
			me.cell.entity = null; me.cell = destination; destination.entity = me; me.mp -= cost
			ops += nativeMoveCost
			return cost
		}
	}
	function record(name, details = {}) {
		trace.push({ kind: "action", name, ops, relative: ops - reserveStart, tp: me.tp, mp: me.mp, ...details })
	}
	me.cell.entity = me
	for (const enemy of enemies) enemy.cell.entity = enemy
	globalThis.Field = {
		cellFromXY(x, y) { ops += 30; stats.fieldCalls++; return cell(x, y) },
		lineOfSight() { ops += 100; stats.los++; return true }
	}
	globalThis.Fight = {
		turn: 1, me, getNearestEnemy: () => enemies[0], getAliveEnemies: () => enemies,
		weaponCells(target, weapon) {
			stats.providers++
			// Fournisseur complet : examine réellement toutes les cases de la grille.
			const result = []
			for (const c of grid.values()) {
				ops += 700
				const d = Math.abs(c.x - target.cell.x) + Math.abs(c.y - target.cell.y)
				if (d >= weapon.minRange && d <= weapon.maxRange && Field.lineOfSight(c, target.cell)) result.push(c)
			}
			return result
		}
	}
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const profile = new LeekProfile()
	function turn({ invalid = false, initialOps = 200000, reserve = false } = {}) {
		ops = initialOps; me.mp = 4; me.tp = 9
		stats = { fieldCalls: 0, los: 0, providers: 0, currentChecks: 0, dangerReads: 0, dangerCells: [] }
		const origin = me.cell, traceStart = trace.length
		const reachable = computeReachableCells(me, me.mp)
		assert.equal(reachable.size, 20, "vraie zone atteignable de 20 cases, sans troncature")
		const threat = new ThreatMap(me.id, Fight.turn, new Map([...reachable.entries()].map(e =>
			[e.cell.x * 4096 + e.cell.y, { cell: e.cell, mpCost: e.cost, danger: danger(e.cell, origin), breakdown: [] }])),
		{ candidateCells: 20, truncated: invalid, inputsTruncated: false,
			enemyCount: enemies.length, pairsEvaluated: 500, lineOfSightCalls: 0 })
		const getDanger = threat.dangerAt.bind(threat)
		threat.dangerAt = c => {
			ops += dangerReadCost; stats.dangerReads++; stats.dangerCells.push({ x: c.x, y: c.y })
			return getDanger(c)
		}
		const oldLog = console.log, config = getLogConfig()
		initLeekLogging(new LogConfig().setAll(false).setEnabled(LOG_CONTEXT.PLANNING, true))
		reserveStart = ops; fieldCallsAtFallback = stats.fieldCalls; dangerReadsAtFallback = stats.dangerReads
		console.log = text => {
			if (text.includes("[Tactical] fallback:")) {
				reserveStart = ops; fieldCallsAtFallback = stats.fieldCalls; dangerReadsAtFallback = stats.dangerReads
			}
			trace.push({ kind: "log", text })
			if (text.includes("[Reserve] phase before action")) ops += planningActionLogCost
		}
		try {
			if (reserve) executeReservePlan(me, profile, { reachable, threat })
			else planAct(me, profile, { reachable, threat })
		} finally {
			console.log = oldLog; initLeekLogging(config)
		}
		const result = { origin: { x: origin.x, y: origin.y }, end: { x: me.cell.x, y: me.cell.y },
			ops, relative: ops - reserveStart, stats: { ...stats }, fieldCallsAtFallback, dangerReadsAtFallback,
			trace: trace.slice(traceStart), tp: me.tp, mp: me.mp }
		turns.push(result); Fight.turn++
		return result
	}
	return { me, enemies, turns, turn, cell, profile }
}

test("whole planAct, several turns: 20 valid cells, distance 26, main plan actually progresses", () => {
	const w = combat()
	try {
		for (let i = 0; i < 3; i++) {
			const t = w.turn(), moves = t.trace.filter(e => e.kind === "action")
			assert.ok(t.trace.some(e => e.text?.includes("[Tactical] plan before execution")))
			assert.equal(moves.length, 1)
			assert.equal(moves[0].name, "move")
			assert.ok(t.ops < 700000)
			assert.equal(t.stats.providers, 0, "far-range progress needs no firing-cell provider")
			assert.ok(t.end.x > t.origin.x, "actual progress, not just a log or reserved PM")
			assert.ok(t.mp >= 0 && t.mp < 4)
			assert.equal(t.tp, 9, "no PT fictitiously reserved for unreachable shots")
			const actionIndex = t.trace.findIndex(e => e.kind === "action")
			assert.ok(t.trace.slice(0, actionIndex).some(e => e.text?.includes("plan before execution")))
			assert.ok(t.trace[actionIndex - 1].text.includes("phase before action"))
		}
		assert.ok(w.turns.every((t, i) => i === 0 || t.origin.x === w.turns[i - 1].end.x),
			"successive real positions retained, no turn reset or oscillation")
	} finally { delete globalThis.System }
})

test("3% reached during danger validation: use an already validated safe-progress candidate within 5%", () => {
	const w = combat({ dangerReadCost: 1600 })
	try {
		const t = w.turn({ reserve: true }), moves = t.trace.filter(e => e.kind === "action")
		const validated = t.stats.dangerCells.slice(t.dangerReadsAtFallback)
		assert.ok(t.trace.some(e => e.text?.includes("[Reserve] plan before execution")))
		assert.ok(t.relative >= 30000 && t.relative < 50000 && t.ops < 700000)
		assert.ok(validated.length < 20, "danger scan is genuinely interrupted")
		assert.ok(validated.some(c => c.x === t.origin.x && c.y === t.origin.y),
			"origin danger was actually read")
		assert.ok(validated.some(c => c.x === 4 && c.y === 0),
			"the already reachable progress candidate was actually read as zero danger")
		assert.equal(moves.length, 1, "available action margin must not be discarded")
		assert.equal(moves[0].name, "move")
		assert.ok(validated.some(c => c.x === t.end.x && c.y === t.end.y),
			"never treat an unvalidated destination as safe")
		assert.ok(t.end.x > t.origin.x)
		assert.ok(t.mp >= 0 && t.mp < 4)
		assert.equal(t.tp, 9)
		assert.ok(!t.trace.some(e => e.text?.includes("modeled (all enemies)")),
			"an interrupted scan is not a completely validated map")
		assert.ok(t.trace.findIndex(e => e.text?.includes("plan before execution")) <
			t.trace.findIndex(e => e.kind === "action"))
	} finally { delete globalThis.System }
})

test("3% reached during danger validation: high validated danger never becomes safe progress", () => {
	const w = combat({ dangerReadCost: 1600,
		danger: (c, origin) => c.x === origin.x && c.y === origin.y ? 0 : 200 })
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.relative >= 30000 && t.relative < 50000 && t.ops < 700000)
		assert.deepEqual(t.origin, t.end)
		assert.equal(t.trace.some(e => e.kind === "action"), false)
	} finally { delete globalThis.System }
})

{
	test(`progress on both sides of the 3% validation boundary with hard reserve available`, () => {
		for (const dangerReadCost of [1499.95, 1500.05]) {
			const w = combat({ dangerReadCost, currentCheckCost: 0 })
			try {
				const t = w.turn({ reserve: true }), moves = t.trace.filter(e => e.kind === "action")
				assert.equal(t.stats.dangerReads - t.dangerReadsAtFallback, 20)
				const entry = t.trace.find(e => e.text?.includes("[Reserve] plan before execution "))
				const preview = JSON.parse(entry.text.split("plan before execution ")[1])
				assert.match(preview.dangerStatus, dangerReadCost < 1500 ? /modeled/ : /partial/)
				assert.ok(t.relative < 50000 && t.ops < 700000)
				assert.equal(moves.length, 1, `danger read cost ${dangerReadCost}`)
				assert.equal(moves[0].name, "move")
				assert.ok(t.end.x > t.origin.x)
				assert.ok(t.mp >= 0 && t.mp < 4)
				assert.equal(t.tp, 9)
			} finally { delete globalThis.System }
		}
	})
}

test("relative 5% crossed by a native check: validated movement remains possible with engine room", () => {
	const w = combat({ currentCheckCost: 60000 })
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.relative >= 50000 && t.ops < 700000)
		assert.deepEqual(t.trace.filter(e => e.kind === "action").map(e => e.name), ["move"])
		assert.ok(t.end.x > t.origin.x)
	} finally { delete globalThis.System }
})

test("expensive planning log crosses 5% but not the engine limit: validated movement remains possible", () => {
	const w = combat({ planningActionLogCost: 50000 })
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.relative >= 50000 && t.ops < 700000)
		assert.ok(t.trace.some(e => e.text?.includes("phase before action")))
		assert.deepEqual(t.trace.filter(e => e.kind === "action").map(e => e.name), ["move"])
		assert.ok(t.end.x > t.origin.x)
		assert.ok(t.mp >= 0 && t.mp < 4)
	} finally { delete globalThis.System }
})

test("movement crossing the old relative limit can be followed by support while budget remains", () => {
	const w = combat({ nativeMoveCost: 30000 }); w.me.life = 100
	w.me.chips = [{ name: "bandage", cost: 2, minRange: 0, maxRange: 6, currentCooldown: 0,
		features: [{ type: 2, minValue: 20, maxValue: 20 }] }]
	try {
		const t = w.turn({ reserve: true }), actions = t.trace.filter(e => e.kind === "action")
		assert.deepEqual(actions.map(e => e.name), ["move", "support"])
		assert.ok(actions[0].relative < 50000)
		assert.ok(t.relative >= 50000)
		assert.ok(t.end.x > t.origin.x)
		assert.equal(t.tp, 7)
		assert.ok(t.ops < 700000)
	} finally { delete globalThis.System }
})

for (const [label, costs] of [["exhausted search margin", {}], ["interrupted danger validation", { dangerReadCost: 1600 }]]) {
	test(`near firing range with ${label}: never spend all PM on a blind approach`, () => {
		const w = combat(costs)
		w.enemies[0].cell.entity = null
		w.enemies[0].cell = w.cell(7); w.enemies[0].cell.entity = w.enemies[0]
		try {
			const t = w.turn({ reserve: true })
			assert.ok(t.relative >= 30000 && t.relative < 50000)
			const moves = t.trace.filter(e => e.kind === "action")
			assert.ok(moves.length <= 1)
			assert.ok(moves.every(e => e.name === "move" && e.limit <= 1))
			assert.ok(t.mp >= 3)
		} finally { delete globalThis.System }
	})
}

test("engine budget exhausted: no native provider or action starts", () => {
	const w = combat()
	try {
		const t = w.turn({ initialOps: 1000000 })
		assert.equal(t.stats.providers, 0)
		assert.equal(t.trace.some(e => e.kind === "action"), false)
	} finally { delete globalThis.System }
})

test("known danger beats geometric advance: no cached dangerous progress is forced", () => {
	const w = combat({ danger: (c, origin) => c.x === origin.x && c.y === origin.y ? 0 : 200 })
	try {
		const t = w.turn()
		assert.equal(t.trace.some(e => e.kind === "action"), false)
		assert.deepEqual(t.origin, t.end)
	} finally { delete globalThis.System }
})

test("invalid map: geometric cached progression remains explicitly unknown, never modeled safety", () => {
	const w = combat()
	try {
		const t = w.turn({ invalid: true })
		assert.ok(t.end.x > t.origin.x)
		const phase = t.trace.find(e => e.text?.includes("phase before action"))
		assert.equal(JSON.parse(phase.text.split("phase before action ")[1]).destinationDanger, null)
		assert.ok(t.trace.some(e => e.text?.includes("danger unknown")))
		assert.ok(!t.trace.some(e => e.text?.includes("danger modeled")))
	} finally { delete globalThis.System }
})

test("native movement failure: cached intention does not imply progress or trigger a second sequence", () => {
	const w = combat(); w.me.failMove = true
	try {
		const t = w.turn({ reserve: true })
		assert.deepEqual(t.origin, t.end)
		assert.equal(t.trace.filter(e => e.kind === "action").length, 1)
		assert.ok(t.trace.some(e => e.text?.includes("not reached; stop")))
	} finally { delete globalThis.System }
})

test("path blocked after caching: native obstacles/path-cost checks prevent a fictitious movement", () => {
	const w = combat()
	w.me.afterCurrentCheck = () => {
		for (const c of [w.cell(1), w.cell(-1), w.cell(0, 1)]) c.obstacle = true
	}
	try {
		const t = w.turn({ reserve: true })
		assert.deepEqual(t.origin, t.end)
		assert.equal(t.mp, 4)
		assert.equal(t.trace.filter(e => e.kind === "action").length, 1)
		assert.ok(t.trace.some(e => e.text?.includes("not reached; stop")))
	} finally { delete globalThis.System }
})

test("multiple enemies and support: aggregate danger preserved, no extra native search after margin", () => {
	const w = combat({ enemyCount: 2 })
	w.me.life = 100
	w.me.chips = [{ name: "bandage", cost: 2, minRange: 0, maxRange: 6, currentCooldown: 0,
		features: [{ type: 2, minValue: 20, maxValue: 20 }] }]
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.end.x > t.origin.x)
		assert.equal(t.stats.currentChecks, 1, "second enemy not queried after internal search margin")
		assert.deepEqual(t.trace.filter(e => e.kind === "action").map(e => e.name), ["move", "support"])
		assert.equal(t.tp, 7)
		assert.ok(t.relative < 50000)
	} finally { delete globalThis.System }
})

test("partial validation previews only evaluated endpoint dangers before the cached movement", () => {
	const w = combat({ dangerReadCost: 1600,
		danger: (c, origin) => c.x === origin.x && c.y === origin.y ? 3 : 1 })
	try {
		const t = w.turn({ reserve: true }), actionIndex = t.trace.findIndex(e => e.kind === "action")
		assert.ok(actionIndex > 0)
		const previewIndex = t.trace.findIndex(e => e.text?.includes("[Reserve] plan before execution "))
		assert.ok(previewIndex >= 0 && previewIndex < actionIndex)
		const preview = JSON.parse(t.trace[previewIndex].text.split("plan before execution ")[1])
		assert.match(preview.dangerStatus, /partial/)
		assert.match(preview.emergencyProgress.scope, /map incomplete/)
		assert.equal(preview.emergencyProgress.originDanger, 3)
		assert.equal(preview.emergencyProgress.danger, 1)
		assert.deepEqual(preview.emergencyProgress.to, t.end)
		assert.equal(preview.attack, null)
		assert.deepEqual(preview.destination, t.end, "the only announced destination is validated progress")
		assert.deepEqual(preview.progressSelection.to, t.end)
		assert.equal(preview.retreat.mode, "hold", "no invented post-attack retreat")
		assert.equal(preview.retreat.danger, null, "partial danger is not presented as a complete map")
		const phase = JSON.parse(t.trace[actionIndex - 1].text.split("phase before action ")[1])
		assert.equal(phase.originDanger, 3)
		assert.equal(phase.destinationDanger, 1)
		assert.match(phase.dangerScope, /map incomplete/)
		const evaluated = t.stats.dangerCells.slice(t.dangerReadsAtFallback)
		assert.ok(evaluated.length < 20)
		for (const point of [t.origin, phase.to]) {
			assert.ok(evaluated.some(c => c.x === point.x && c.y === point.y))
		}
		assert.equal(t.trace[actionIndex].fieldCallsBeforeNative, t.fieldCallsAtFallback,
			"partial endpoint rescue launches no extra AI path search")
		assert.equal(t.trace.filter(e => e.kind === "action").length, 1)
	} finally { delete globalThis.System }
})

test("partial validation with only the origin read cannot credit an unevaluated geometric destination", () => {
	const w = combat({ dangerReadCost: 31000 })
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.relative >= 30000 && t.relative < 50000 && t.ops < 700000)
		assert.deepEqual(t.stats.dangerCells.slice(t.dangerReadsAtFallback), [t.origin])
		const entry = t.trace.find(e => e.text?.includes("[Reserve] plan before execution "))
		const preview = JSON.parse(entry.text.split("plan before execution ")[1])
		assert.match(preview.dangerStatus, /partial/)
		assert.equal(preview.emergencyProgress, null)
		assert.equal(t.trace.some(e => e.kind === "action"), false)
		assert.deepEqual(t.end, t.origin)
		assert.equal(t.mp, 4)
	} finally { delete globalThis.System }
})

test("expensive danger validation cannot credit an unevaluated destination as safe", () => {
	const w = combat({ dangerReadCost: 60000 })
	try {
		const t = w.turn({ reserve: true })
		assert.ok(t.relative >= 50000 && t.ops < 700000)
		assert.equal(t.trace.some(e => e.kind === "action"), false)
		assert.deepEqual(t.end, t.origin)
		assert.ok(t.trace.some(e => e.text?.includes("partial scan")))
	} finally { delete globalThis.System }
})

for (const [name, costs] of [
	["phase log", { planningActionLogCost: 50000 }],
	["native move", { nativeMoveCost: 30000 }]
]) {
	test(`partial danger validation: ${name} crossing old 5% limit permits safe remaining actions`, () => {
		const w = combat({ dangerReadCost: 1600, ...costs })
		w.me.life = 100
		w.me.chips = [{ name: "bandage", cost: 2, minRange: 0, maxRange: 6, currentCooldown: 0,
			features: [{ type: 2, minValue: 20, maxValue: 20 }] }]
		try {
			const t = w.turn({ reserve: true }), actions = t.trace.filter(e => e.kind === "action")
			assert.ok(t.trace.some(e => e.text?.includes("partial scan")))
			assert.ok(t.relative >= 50000 && t.ops < 700000)
			assert.deepEqual(actions.map(e => e.name), ["move", "support"])
			assert.equal(t.tp, 7)
			for (const action of actions) {
				assert.ok(action.ops < 700000)
			}
		} finally { delete globalThis.System }
	})
}
