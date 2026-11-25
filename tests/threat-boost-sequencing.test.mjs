import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }
globalThis.Field = { cellFromXY: () => null, lineOfSight: () => true }

const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { buildThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")

test("three boosts: fixed random cases equal exhaustive cast-order enumeration", () => {
	let state = 0x918bad42
	const int = (min, max) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return min + state % (max - min + 1)
	}
	const me = { id: 1, cell: { id: 1, x: 2, y: 0 } }
	const foe = { id: 2, cell: { id: 2, x: 0, y: 0 } }
	const myReach = computeReachableCells(me, 0, 1)
	const enemyReach = computeReachableCells(foe, 0, 1)
	const weapon = {
		id: 10, cost: 1, minRange: 1, maxRange: 4, needsLos: false,
		features: [{ type: 1, minValue: 10, maxValue: 10 }]
	}
	let financed = 0
	let initiallyImpossible = 0
	for (let scenario = 0; scenario < 1000; scenario++) {
		const tp = int(2, 9)
		const boosts = Array.from({ length: 3 }, (_, i) => {
			const cost = int(1, 13)
			const tpGain = int(0, 15)
			const strength = int(0, 30) * 10
			return {
				id: 100 + i, cost, tpGain, strength,
				features: [
					{ type: 32, minValue: tpGain, maxValue: tpGain },
					{ type: 6, minValue: strength, maxValue: strength }
				]
			}
		})
		let best = 0
		let bestCost = 0
		const visit = (budget, strength, used, cost) => {
			const damage = budget * 10 * (1 + strength / 100)
			if (damage > best) {
				best = damage
				bestCost = cost
			}
			for (let i = 0; i < boosts.length; i++) {
				const boost = boosts[i]
				if (!(used & (1 << i)) && boost.cost <= budget) {
					visit(budget - boost.cost + boost.tpGain, strength + boost.strength, used | (1 << i), cost + boost.cost)
				}
			}
		}
		visit(tp, 0, 0, 0)
		if (bestCost > tp) financed++
		if (boosts.some((boost) => boost.cost > tp)) initiallyImpossible++
		const map = buildThreatMap(me, myReach, [{
			id: 2, name: "enemy", strength: 0, tp, weapon, chips: [], boosts, reachable: enemyReach
		}], 1)
		assert.ok(Math.abs(map.dangerAt(me.cell) - best) < 1e-8, `scenario ${scenario}`)
	}
	assert.ok(financed > 100, `financed ${financed}`)
	assert.ok(initiallyImpossible > 100, `initially impossible ${initiallyImpossible}`)
})
