import assert from "node:assert/strict"
import test from "node:test"
import { stagnationEscape, stagnationRouteFraction } from "../dist/Classes/Plannification/TacticalStagnation.js"
import { Budget } from "../dist/Classes/Plannification/TacticalTypes.js"
import { OPS_BUDGET } from "../dist/Toolbox/Budgets.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Combat 54994953 : Kassbi immobile 63 tours contre un ennemi immobile à distance 25. La recherche de route de la
// sortie de stagnation s'arrêtait à 2 % des opérations à CHAQUE tour (« holding, safety first » : 61 fois), le plan
// restait nul (0 PM utilisé). Monde synthétique : couloir 40 x 3, zone de tir à 26 cases de marche. Le coût en
// opérations d'une itération du BFS est un MODÈLE (compteur qui avance à chaque lecture de `System.operations`), pas une mesure.

const MAX_OPS = 2_000_000
const grid = new Map()
for (let x = 0; x < 40; x++) for (let y = 0; y < 3; y++) grid.set(`${x},${y}`, { id: x * 3 + y, x, y, obstacle: false, entity: null })
const at = (x, y) => grid.get(`${x},${y}`) ?? null
const key = (cell) => cell.x * 4096 + cell.y

/** Chaque lecture de `System.operations` coûte `step` opérations (le BFS en lit une par case dépilée). */
function meter(step, start = 0) {
	let operations = start
	globalThis.System = { maxOperations: MAX_OPS, get operations() { operations += step; return operations } }
}

function scenario({ turns, step, mp = 5, danger = () => 0, enemyX = 39, startOps = 0 }) {
	meter(step, startOps)
	globalThis.Field = { cellFromXY: at }
	const config = new LogConfig(); config.setAll(false); config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	for (const cell of grid.values()) cell.entity = null
	const me = { id: 1, cell: at(1, 1), life: 384, strength: 10 }
	const target = { id: 2, cell: at(enemyX, 1) }
	me.cell.entity = me
	const chip = { name: "zone" }
	const zone = [...grid.values()].filter((cell) => cell.x >= 27 && cell.x <= 34)
	const entries = []
	for (let x = 0; x <= 1 + mp; x++) entries.push({ cell: at(x, 1), cost: Math.abs(x - 1) })
	const dangers = new Map([...grid.values()].map((cell) => [key(cell), danger(cell)]))
	const skipped = { refused: 0, noProgress: null }
	const messages = []
	const original = console.log
	let plan
	try {
		console.log = (message) => messages.push(String(message))
		plan = stagnationEscape({
			me, target, turns, weapons: [], attackChips: [chip], chipZones: new Map([[chip, zone]]), entries, dangers,
			preparation: { weaponCells: new Map() }, skipped, budget: new Budget(), visited: () => false, riskFree: false
		})
	} finally { console.log = original }
	return { plan, skipped, messages }
}

test("allowance: base 4 % per blocked turn, multiplied by the blocked turns, capped at 30 %", () => {
	assert.equal(OPS_BUDGET.STAGNATION_ROUTE, 0.04)
	assert.equal(stagnationRouteFraction(2), 0.04, "first turn where the escape acts: x1")
	assert.equal(stagnationRouteFraction(3), 0.08)
	assert.equal(stagnationRouteFraction(5), 0.04 * 4)
	assert.equal(stagnationRouteFraction(500), OPS_BUDGET.STAGNATION_ROUTE_MAX)
	assert.ok(OPS_BUDGET.STAGNATION_ROUTE_MAX <= OPS_BUDGET.TACTICAL_SEARCH && OPS_BUDGET.STAGNATION_ROUTE_MAX < OPS_BUDGET.SEARCH_GLOBAL)
})

test("fight 54994953: a firing zone 26 walking cells away under a realistic allowance gives a move (afterMp > 0), not a hold", () => {
	// ~50 000 opérations de BFS : l'ancien plafond de 2 % (40 000) l'arrêtait, 4 % (80 000) le laisse finir.
	const { plan, skipped, messages } = scenario({ turns: 2, step: 500 })
	assert.ok(plan, `a plan is expected, got hold: ${skipped.noProgress}`)
	assert.equal(plan.progressModel, "stagnation walk route")
	assert.ok(plan.afterMp > 0 && plan.afterMp <= 5)
	assert.equal(plan.destination.x, 6, "walks toward the zone along the corridor")
	assert.ok(plan.stagnation.walkAfter < plan.stagnation.walkBefore)
	assert.equal(plan.stagnation.walkBefore, 26)
	assert.ok(!messages.some((m) => m.includes("holding")))
})

test("progressive allowance: a search too costly for x1 is retried with the blocked turns multiplier", () => {
	// ~150 000 opérations de BFS : 4 % (80 000) insuffisant, 12 % (3 tours bloqués) suffisant.
	const first = scenario({ turns: 2, step: 1500 })
	assert.ok(first.plan, "no hold: the fallback advances")
	assert.equal(first.plan.progressModel, "stagnation approach", "route search stopped by its allowance")
	assert.ok(first.plan.afterMp > 0)
	assert.ok(first.messages.some((m) => m.includes("operations allowance") && m.includes("advancing to")))
	const third = scenario({ turns: 4, step: 1500 })
	assert.equal(third.plan?.progressModel, "stagnation walk route")
	assert.equal(third.plan.stagnation.walkBefore, 26)
})

test("allowance exhausted and no danger: advances to the nearest reachable cell, never a bare hold", () => {
	const { plan, skipped, messages } = scenario({ turns: 2, step: 100_000 })
	assert.ok(plan, `no hold without danger: ${skipped.noProgress}`)
	assert.equal(plan.progressModel, "stagnation approach")
	assert.equal(plan.destination.x, 6, "closest reachable cell to the target")
	assert.equal(plan.afterMp, 5)
	assert.equal(plan.danger, 0)
	assert.ok(!messages.some((m) => m.includes("safety first")))
})

test("allowance exhausted with a danger: holds and only then says 'safety first'", () => {
	const { plan, skipped, messages } = scenario({ turns: 2, step: 100_000, danger: (cell) => cell.x > 1 ? 100 : 0 })
	assert.equal(plan, null)
	assert.match(skipped.noProgress, /^stagnation: walking route search stopped by its operations allowance/)
	assert.ok(messages.some((m) => m.includes("holding, safety first")))
})

test("allowance exhausted, no closer cell and no danger: holds without claiming safety", () => {
	const { plan, messages } = scenario({ turns: 2, step: 100_000, enemyX: 1 })
	assert.equal(plan, null)
	assert.ok(messages.some((m) => m.includes("holding")) && !messages.some((m) => m.includes("safety first")))
})

test("global ceiling: the allowance never extends the search past 80 % of the turn (30 % cap reached)", () => {
	const { plan, messages } = scenario({ turns: 500, step: 1000, startOps: MAX_OPS * 0.785 })
	assert.equal(plan?.progressModel, "stagnation approach")
	assert.ok(messages.some((m) => m.includes("operations allowance")))
})
