import test from "node:test"
import assert from "node:assert/strict"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { executeTacticalPlan } from "../dist/Classes/Plannification/TacticalExecution.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"

test("equal-danger retreat prefers a reachable position nearer a native firing cell", () => {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const cells = new Map(Array.from({ length: 9 }, (_, i) => {
		const x = i - 4
		return [x, { x, y: 0, id: i, entity: null, obstacle: false }]
	}))
	const cell = x => cells.get(x) ?? null
	const gun = { name: "gun", cost: 2, minRange: 1, maxRange: 3, maxUses: -1,
		features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const enemy = { id: 2, cell: cell(-3), life: 100, maxLife: 100, absoluteShield: 0, relativeShield: 0 }
	const me = { id: 1, cell: cell(0), life: 100, maxLife: 100, strength: 0, wisdom: 0,
		tp: 2, mp: 1, weapon: gun, weapons: [gun], chips: [],
		canUseWeapon: target => Math.abs(me.cell.x - target.cell.x) <= 3,
		canUseChip: () => false,
		useWeapon() { me.tp -= 2; return 1 },
		moveToward(destination, cost) {
			me.cell.entity = null; me.cell = destination; destination.entity = me; me.mp -= cost
			return cost
		} }
	me.cell.entity = me; enemy.cell.entity = enemy
	globalThis.Field = { cellFromXY: (x, y) => y === 0 ? cell(x) : null }
	let calls = 0
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy],
		weaponCells: () => { calls++; return [cell(-2), cell(-1), cell(0)] } }
	const reachable = computeReachableCells(me, me.mp)
	const entries = new Map([...reachable.entries()].map(({ cell: c, cost }) =>
		[c.x * 4096 + c.y, { cell: c, mpCost: cost, danger: c.x === 0 ? 10 : 0, breakdown: [] }]))
	const threat = new ThreatMap(me.id, 1, entries, { candidateCells: reachable.size,
		truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const { plan } = evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat })
	assert.equal(calls, 1, "no additional native firing-cell query")
	assert.equal(plan.weaponShots, 1)
	assert.equal(plan.destination.x, -1, "not the equally dangerous +1 dead-end for firing")
	assert.equal(plan.firingDistance, 0)
	executeTacticalPlan(me, plan)
	assert.equal(me.cell.x, -1)
})

test("relative and absolute shields are applied to each damage feature before choosing a weapon", () => {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const feature = value => ({ type: 1, minValue: value, maxValue: value })
	const multi = { name: "multi", cost: 2, minRange: 1, maxRange: 3, maxUses: 1,
		features: [feature(20), feature(20), feature(20)] }
	const single = { ...multi, name: "single", features: [feature(40)] }
	const origin = { id: 1, x: 0, y: 0, obstacle: false, entity: null }
	const targetCell = { id: 2, x: 1, y: 0, obstacle: false, entity: null }
	const enemy = { id: 2, cell: targetCell, life: 100, maxLife: 100, absoluteShield: 10, relativeShield: 50 }
	const me = { id: 1, cell: origin, life: 100, maxLife: 100, strength: 0, wisdom: 0,
		tp: 3, mp: 0, weapon: multi, weapons: [multi, single], chips: [],
		canUseWeapon: () => true, canUseChip: () => false }
	origin.entity = me; targetCell.entity = enemy
	globalThis.Field = { cellFromXY: (x, y) => x === 0 && y === 0 ? origin : null }
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy], weaponCells: () => [origin] }
	const reachable = computeReachableCells(me, 0)
	const threat = new ThreatMap(me.id, 1, new Map([[0, {
		cell: origin, mpCost: 0, danger: 0, breakdown: []
	}]]), { candidateCells: 1, truncated: false, inputsTruncated: false,
		enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const { plan } = evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat })
	assert.equal(plan.weapon, single)
	assert.equal(plan.usefulDamage, 10)
})

test("future firing distance is unknown with multiple enemies or no native firing seed", () => {
	const evaluate = (positions, nativeCells) => {
		delete globalThis.System
		globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
		const cells = new Map(Array.from({ length: 9 }, (_, i) => {
			const x = i - 4
			return [x, { x, y: 0, id: i, entity: null, obstacle: false }]
		}))
		const cell = x => cells.get(x) ?? null
		const gun = { name: "gun", cost: 2, minRange: 1, maxRange: 3, maxUses: -1,
			features: [{ type: 1, minValue: 20, maxValue: 20 }] }
		const enemies = positions.map(([x], i) => ({
			id: i + 2, cell: cell(x), life: 100, maxLife: 100, absoluteShield: 0, relativeShield: 0
		}))
		const me = { id: 1, cell: cell(0), life: 100, maxLife: 100, strength: 0, wisdom: 0,
			tp: 2, mp: 1, weapon: gun, weapons: [gun], chips: [],
			canUseWeapon: () => true, canUseChip: () => false }
		me.cell.entity = me
		for (const enemy of enemies) enemy.cell.entity = enemy
		globalThis.Field = { cellFromXY: (x, y) => y === 0 ? cell(x) : null }
		globalThis.Fight = { turn: 1, me, getAliveEnemies: () => enemies,
			weaponCells: target => nativeCells(target).map(cell) }
		const reachable = computeReachableCells(me, me.mp)
		const entries = new Map([...reachable.entries()].map(({ cell: c, cost }) =>
			[c.x * 4096 + c.y, { cell: c, mpCost: cost, danger: c.x === 0 ? 10 : 0, breakdown: [] }]))
		const threat = new ThreatMap(me.id, 1, entries, { candidateCells: reachable.size,
			truncated: false, inputsTruncated: false, enemyCount: enemies.length,
			pairsEvaluated: 0, lineOfSightCalls: 0 })
		return evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat }).plan
	}

	const withoutSeed = evaluate([[-3, 0]], () => [])
	assert.ok(withoutSeed)
	assert.equal(withoutSeed.firingDistance, undefined)

	const multipleTargets = evaluate([[-3, 0], [3, 0]], target =>
		target.id === 2 ? [-2, -1, 0] : [0, 1, 2])
	assert.ok(multipleTargets)
	assert.equal(multipleTargets.firingDistance, undefined)
})
