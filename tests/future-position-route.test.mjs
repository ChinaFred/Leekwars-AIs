import test from "node:test"
import assert from "node:assert/strict"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { computeReachableCells, ReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"

function corridor({ tp = 4, danger = () => 0, missing = false, routeLength = null } = {}) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const points = routeLength === null
		? [[0, 0], [1, 0], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]]
		: Array.from({ length: routeLength + 3 }, (_, x) => [x, 0])
	const cells = new Map(points.map(([x, y], id) => [`${x},${y}`, {
		id, x, y, entity: null, obstacle: false
	}]))
	const cell = (x, y) => cells.get(`${x},${y}`) ?? null
	let fields = 0, providers = 0
	globalThis.Field = { cellFromXY(x, y) { fields++; return cell(x, y) }, lineOfSight: () => true }
	const weapon = { name: "gun", cost: 4, minRange: 1, maxRange: 2, needsLos: false, maxUses: -1,
		features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const enemy = { id: 2, cell: routeLength === null ? cell(6, 2) : cell(routeLength + 2, 0),
		life: 100, maxLife: 100, absoluteShield: 0, relativeShield: 0 }
	const me = { id: 1, cell: cell(0, 0), life: 100, maxLife: 100, strength: 0, wisdom: 0,
		tp, mp: 1, weapon, weapons: [weapon], chips: [], canUseWeapon: () => false, canUseChip: () => false }
	me.cell.entity = me; enemy.cell.entity = enemy
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy],
		weaponCells() { providers++; return [] } }
	const reachable = computeReachableCells(me, me.mp)
	const entries = new Map([...reachable.entries()].filter(({ cell: c }) => !missing || c.x !== 1)
		.map(({ cell: c, cost }) => [c.x * 4096 + c.y, {
			cell: c, mpCost: cost, danger: danger(c), breakdown: []
		}]))
	const threat = new ThreatMap(me.id, 1, entries, { candidateCells: reachable.size,
		truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	fields = 0
	return { me, enemy, reachable, threat, stats: () => ({ fields, providers }) }
}

for (const tp of [4, 0]) {
	test(`multi-turn route avoids a geometric dead end without a current shot (PT=${tp})`, () => {
		const w = corridor({ tp })
		const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
		assert.ok(plan)
		assert.deepEqual([plan.destination.x, plan.destination.y], [0, 1])
		assert.equal(plan.weaponShots, 0)
		assert.equal(plan.progressModel, "future firing route")
		assert.equal(w.stats().providers, 0)
	})
}

test("future route length is accepted through 8 steps and falls back beyond the bound", () => {
	for (const routeLength of [7, 8]) {
		const w = corridor({ tp: 0, routeLength })
		const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
		assert.ok(plan)
		assert.equal(plan.progressModel, "future firing route", `${routeLength} steps`)
	}

	const beyond = corridor({ tp: 0, routeLength: 9 })
	const { plan } = evaluateTacticalPlans(beyond.me, new LeekProfile(), beyond)
	assert.ok(plan)
	assert.notEqual(plan.progressModel, "future firing route")
})

test("known danger still outweighs progress towards a hypothetical firing position", () => {
	const w = corridor({ tp: 0, danger: c => c.y === 1 ? 50 : 0 })
	const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
	assert.ok(!plan || plan.destination.y !== 1)
})

test("incomplete danger data rejects the joint plan before future exploration", () => {
	const w = corridor({ tp: 0, missing: true })
	const result = evaluateTacticalPlans(w.me, new LeekProfile(), w)
	assert.equal(result.plan, null)
	assert.match(result.reason, /missing\/invalid danger/)
	assert.deepEqual(w.stats(), { fields: 0, providers: 0 })
})

test("a blocked line of sight is not treated as a future firing position", () => {
	const w = corridor({ tp: 0 })
	w.me.weapon.needsLos = true
	let checks = 0
	Field.lineOfSight = () => { checks++; return false }
	const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
	assert.ok(checks > 0 && checks <= 8)
	assert.notEqual(plan?.progressModel, "future firing route")
	assert.equal(w.stats().providers, 0)
})

test("optional route exploration stops at its synthetic ops allowance", () => {
	const w = corridor({ tp: 0 })
	let ops = 100000
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const lookup = Field.cellFromXY
	Field.cellFromXY = (x, y) => { ops += 3000; return lookup(x, y) }
	try {
		const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
		assert.ok(plan)
		assert.notEqual(plan.progressModel, "future firing route")
		assert.ok(w.stats().fields <= 7)
		assert.equal(w.stats().providers, 0)
	} finally { delete globalThis.System }
})

test("future route accepts the seventh and eighth LOS, but never asks for a ninth", () => {
	for (const visibleAt of [7, 8, 9]) {
		const w = corridor({ tp: 0 })
		w.me.weapon.needsLos = true
		w.me.weapon.maxRange = 100
		let calls = 0
		Field.lineOfSight = () => ++calls === visibleAt
		const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
		assert.ok(plan, `visible at LOS ${visibleAt}`)
		assert.equal(calls, Math.min(visibleAt, 8))
		assert.equal(plan.progressModel === "future firing route", visibleAt <= 8)
		assert.equal(w.stats().providers, 0)
	}
})

test("future route continues below 2% synthetic ops and falls back at and above 2%", () => {
	for (const spent of [19999, 20000, 20001]) {
		const w = corridor({ tp: 0 })
		let ops = 100000
		let charged = false
		globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
		const lookup = Field.cellFromXY
		Field.cellFromXY = (x, y) => {
			if (!charged) { charged = true; ops += spent }
			return lookup(x, y)
		}
		try {
			const { plan } = evaluateTacticalPlans(w.me, new LeekProfile(), w)
			assert.ok(charged)
			assert.ok(plan, `synthetic cost ${spent}`)
			assert.equal(plan.progressModel === "future firing route", spent < 20000)
			assert.equal(w.stats().providers, 0)
		} finally { delete globalThis.System }
	}
})

test("synthetic reachable input exercises the 160-cell exploration cap", () => {
	// Deliberately nonphysical seeds expose the defensive cap: a real BFS with
	// a radius of eight has at most 145 cells, and the planner accepts at most
	// 85 initially reachable cells. These seeds do not represent a combat map.
	for (const available of [79, 80, 81]) {
		delete globalThis.System
		globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
		const origin = { id: 0, x: 0, y: 0, entity: null, obstacle: false }
		const seeds = [origin, ...Array.from({ length: 79 }, (_, i) =>
			({ id: i + 1, x: 200 + 10 * i, y: 200, entity: null, obstacle: false }))]
		const cellKey = c => c.x * 4096 + c.y
		const entries = new Map(seeds.map((cell, i) => [cellKey(cell), { cell, cost: i === 0 ? 0 : 1 }]))
		const reachable = new ReachableCells(1, origin, 1, 1, entries, false)
		const neighbors = seeds.slice(1).flatMap(cell => [[1, 0], [-1, 0], [0, 1], [0, -1]]
			.map(([dx, dy]) => ({ x: cell.x + dx, y: cell.y + dy, entity: null, obstacle: false })))
			.slice(0, available)
		const map = new Map(neighbors.map((cell, i) => [cellKey(cell), { ...cell, id: 1000 + i }]))
		const returned = []
		globalThis.Field = {
			cellFromXY(x, y) {
				const cell = map.get(x * 4096 + y) ?? null
				if (cell) returned.push(cellKey(cell))
				return cell
			}
		}
		const weapon = { cost: 4, minRange: 1, maxRange: 1, needsLos: false, maxUses: -1,
			features: [{ type: 1, minValue: 20, maxValue: 20 }] }
		const enemy = { id: 2, cell: { x: -1000, y: -1000 }, life: 100, maxLife: 100 }
		const me = { id: 1, cell: origin, life: 100, maxLife: 100, strength: 0, wisdom: 0,
			tp: 0, mp: 1, weapon, weapons: [weapon], chips: [], canUseWeapon: () => false, canUseChip: () => false }
		origin.entity = me
		globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy], weaponCells: () => {
			assert.fail("unaffordable weapon must not query native firing cells")
		} }
		const threat = new ThreatMap(me.id, 1, new Map(seeds.map(cell =>
			[cellKey(cell), { cell, mpCost: cell === origin ? 0 : 1, danger: 0, breakdown: [] }])),
		{ candidateCells: seeds.length, truncated: false, inputsTruncated: false,
			enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
		const result = evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat })
		assert.notEqual(result.reason, "evaluation API unavailable")
		assert.equal(returned.length, Math.min(available, 80), `${available} available cells`)
		assert.equal(new Set(returned).size, returned.length)
		assert.notEqual(result.plan?.progressModel, "future firing route")
	}
})
