import assert from "node:assert/strict"
import test from "node:test"
import { Budget, TACTICAL_LIMITS, Unavailable } from "../dist/Classes/Plannification/TacticalTypes.js"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { stagnationEscape } from "../dist/Classes/Plannification/TacticalStagnation.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Bornes de volume : une ligne rouge `SEARCH CUT [origine] cause=<quoi> bound (<valeur> > <borne>) ops=… repli=…` quand une
// borne écarte la recherche, avec la valeur observée et la borne ; rien sous la borne. Le message de l'exception reste le même.

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }

/** Lignes `SEARCH CUT` émises par `run` (contexte ERROR seul, sortie `console.log`). */
function capture(run) {
	const lines = [], original = console.log
	const config = new LogConfig(); config.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true)
	console.log = (text) => lines.push(String(text))
	try { initLeekLogging(config); run() } finally {
		console.log = original
		const off = new LogConfig(); off.setAll(false); initLeekLogging(off)
	}
	return lines.filter((text) => text.includes("SEARCH CUT"))
}

const item = (name, cost, damage, options = {}) => ({
	name, cost, minRange: 1, maxRange: 5, maxUses: -1, needsLos: false,
	features: [{ type: Effect.DAMAGE, minValue: damage, maxValue: damage }], ...options
})
const chip = (name, cost, damage, options = {}) => item(name, cost, damage, { currentCooldown: 0, cooldown: 1, ...options })
const heal = (name) => chip(name, 1, 0, { minRange: 0, features: [{ type: Effect.HEAL, minValue: 5, maxValue: 5 }] })
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

/** Terrain ouvert `size` x `size` centré sur moi (0,0) ; ennemis aux `positions`. */
function world({ size = 11, tp = 6, mp = 0, weapons, chips = [], positions = [[3, 0]], life = 100, truncated = false } = {}) {
	delete globalThis.System
	const grid = new Map()
	const half = Math.floor(size / 2)
	for (let x = -half; x <= half; x++) for (let y = -half; y <= half; y++) grid.set(`${x},${y}`, { id: grid.size, x, y, entity: null, obstacle: false, empty: true })
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	const gun = item("gun", 2, 10)
	const hit = (from, to, thing) => distance(from, to) >= thing.minRange && distance(from, to) <= thing.maxRange
	const me = {
		id: 1, name: "me", cell: cell(0), life, maxLife: 100, strength: 0, wisdom: 0, absoluteShield: 0, relativeShield: 0,
		tp, mp, weapon: weapons?.[0] ?? gun, weapons: weapons ?? [gun], chips, say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) { return target.life > 0 && hit(this.cell, target.cell, this.weapon) },
		canUseChip(thing, target) { return thing.currentCooldown === 0 && target.life > 0 && (target === this || hit(this.cell, target.cell, thing)) },
		chipCells(thing, target) { return [...grid.values()].filter((from) => hit(from, target.cell, thing)) }
	}
	const enemies = positions.map(([x, y], i) => ({ id: i + 2, name: `enemy${i}`, cell: cell(x, y), life: 100, maxLife: 100, mp: 0, weapon: null, absoluteShield: 0, relativeShield: 0 }))
	me.cell.entity = me
	for (const enemy of enemies) enemy.cell.entity = enemy
	globalThis.Fight = {
		turn: 1, me, getNearestEnemy: () => enemies[0], getAliveEnemies: () => enemies, getAllies: () => [me], getEnemies: () => enemies,
		weaponCells: (target, thing) => [...grid.values()].filter((from) => hit(from, target.cell, thing))
	}
	globalThis.Field = { cellFromXY: cell, lineOfSight: () => true, distance, getObstacles: () => [] }
	const reachable = computeReachableCells(me, mp, 1)
	const entries = new Map([...reachable.entries()].map((entry) => [entry.cell.x * 4096 + entry.cell.y, { cell: entry.cell, mpCost: entry.cost, danger: 0, breakdown: [] }]))
	const threat = new ThreatMap(me.id, 1, entries, {
		candidateCells: reachable.size, truncated, inputsTruncated: false, pairsEvaluated: 0, lineOfSightCalls: 0, enemyCount: enemies.length
	})
	return { me, grid, reachable, evaluate: () => evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat }) }
}

/** Une ligne exactement, de cette cause, sur l'origine « tactique », avec le repli. */
function assertOneCut(lines, cause, reason, run) {
	assert.equal(lines.length, 1, lines.join("\n"))
	assert.match(lines[0], new RegExp(`^SEARCH CUT \\[tactique\\] cause=${cause.replace(/[()>.]/g, "\\$&")} ops=\\?/\\? repli=plan B$`))
	assert.equal(run.reason, reason)
}

test("bound: cells over TACTICAL_LIMITS.cells", () => {
	let result
	const w = world({ size: 21, mp: 9 })
	assert.ok(w.reachable.size > TACTICAL_LIMITS.cells)
	assertOneCut(capture(() => { result = w.evaluate() }), `cells bound (${w.reachable.size} > ${TACTICAL_LIMITS.cells})`, "cells/PT bound", result)
	const under = world({ mp: 3 })
	assert.ok(under.reachable.size <= TACTICAL_LIMITS.cells)
	assert.deepEqual(capture(() => { result = under.evaluate() }), [])
	assert.equal(result.reason, "complete search")
})

test("bound: TP over TACTICAL_LIMITS.tp", () => {
	let result
	const w = world({ tp: TACTICAL_LIMITS.tp + 1 })
	assertOneCut(capture(() => { result = w.evaluate() }), `PT bound (${TACTICAL_LIMITS.tp + 1} > ${TACTICAL_LIMITS.tp})`, "cells/PT bound", result)
	assert.deepEqual(capture(() => { result = world({ tp: TACTICAL_LIMITS.tp }).evaluate() }), [])
})

test("bound: enemies, weapons and offensive chips over their limits; at the limit, no line", () => {
	let result
	const positions = (n) => Array.from({ length: n }, (_, i) => [3, i - 2])
	assertOneCut(capture(() => { result = world({ positions: positions(5) }).evaluate() }),
		`enemies bound (5 > ${TACTICAL_LIMITS.enemies})`, "items/targets bound", result)
	assert.deepEqual(capture(() => { result = world({ positions: positions(4) }).evaluate() }), [])

	const guns = (n) => Array.from({ length: n }, (_, i) => item(`gun${i}`, 2, 10))
	assertOneCut(capture(() => { result = world({ weapons: guns(5) }).evaluate() }),
		`weapons bound (5 > ${TACTICAL_LIMITS.weapons})`, "items/targets bound", result)
	assert.deepEqual(capture(() => { result = world({ weapons: guns(4) }).evaluate() }), [])

	const sparks = (n) => Array.from({ length: n }, (_, i) => chip(`spark${i}`, 1, 5))
	assertOneCut(capture(() => { result = world({ chips: sparks(9) }).evaluate() }),
		`attack chips bound (9 > ${TACTICAL_LIMITS.attackChips})`, "items/targets bound", result)
	assert.deepEqual(capture(() => { result = world({ chips: sparks(8) }).evaluate() }), [])
})

test("bound: protection chips over TACTICAL_LIMITS.protectionChips", () => {
	let result
	const heals = (n) => Array.from({ length: n }, (_, i) => heal(`heal${i}`))
	assertOneCut(capture(() => { result = world({ life: 10, chips: heals(4) }).evaluate() }),
		`protections bound (4 > ${TACTICAL_LIMITS.protectionChips})`, "protection bound", result)
	assert.deepEqual(capture(() => { result = world({ life: 10, chips: heals(3) }).evaluate() }), [])
})

test("bound: truncated data (danger map) falls back to plan B with one line; complete data: none", () => {
	let result
	const lines = capture(() => { result = world({ truncated: true }).evaluate() })
	assert.equal(lines.length, 1, lines.join("\n"))
	assert.match(lines[0], /^SEARCH CUT \[tactique\] cause=truncated data \(carte de danger\) ops=\?\/\? repli=plan B$/)
	assert.equal(result.reason, "truncated data")
	assert.deepEqual(capture(() => { result = world().evaluate() }), [])
})

test("bound: a native cell list over 613 cells is refused with one line; at 613, none", () => {
	let result
	const run = (count) => {
		const w = world({ size: 31, mp: 1 })
		const all = [...w.grid.values()]
		const native = Fight.weaponCells
		Fight.weaponCells = (target, thing) => count > 0 ? all.slice(0, count) : native(target, thing)
		return capture(() => { result = w.evaluate() })
	}
	const lines = run(614)
	assert.equal(lines.length, 1, lines.join("\n"))
	assert.match(lines[0], /^SEARCH CUT \[tactique\] cause=native cells bound \(614 > 613\) ops=\?\/\? repli=plan en cours, sinon plan B$/)
	assert.equal(result.reason, "native cells bound")
	assert.deepEqual(run(613), [])
})

test("Budget.bound: one line per budget however often it is caught; origin and fallback are those of the budget", () => {
	const lines = capture(() => {
		const budget = new Budget(undefined, "boost PM", "plan sans boost")
		for (let i = 0; i < 3; i++) {
			assert.throws(() => budget.bound("cells", 143, 113, "cells/PT bound"), (error) => error instanceof Unavailable && error.message === "cells/PT bound")
		}
	})
	assert.deepEqual(lines, ["SEARCH CUT [boost PM] cause=cells bound (143 > 113) ops=?/? repli=plan sans boost"])
})

test("next-turn value: its budget cut is a red line with its own origin", () => {
	const lines = capture(() => {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const budget = new Budget(0.05, "tour suivant", "N = 0")
		System.operations = 100
		assert.throws(() => budget.check(), Unavailable)
		delete globalThis.System
	})
	assert.deepEqual(lines, [`SEARCH CUT [tour suivant] cause=operations reserve (search fraction) ops=100/1000 ticks=0/${TACTICAL_LIMITS.work}`])
})

// Couloir de `width` x 20 cases, zone de tir à l'extrémité x >= `zoneX` ; moi à x = 1. Sans `System` : pas d'allocation de temps.
function stagnationRoute(zoneX, zoneCells) {
	delete globalThis.System
	const grid = new Map()
	for (let x = 0; x < 40; x++) for (let y = 0; y < 20; y++) grid.set(`${x},${y}`, { id: x * 20 + y, x, y, obstacle: false, entity: null })
	const at = (x, y) => grid.get(`${x},${y}`) ?? null
	globalThis.Field = { cellFromXY: at }
	const me = { id: 1, cell: at(1, 10), life: 384, strength: 10 }
	me.cell.entity = me
	const spell = { name: "zone" }
	const entries = [{ cell: at(1, 10), cost: 0 }, { cell: at(2, 10), cost: 1 }]
	return stagnationEscape({
		me, target: { id: 2, cell: at(39, 10) }, turns: 2, weapons: [], attackChips: [spell],
		chipZones: new Map([[spell, zoneCells ?? [...grid.values()].filter((cell) => cell.x >= zoneX && cell.x <= zoneX + 1)]]), entries,
		dangers: new Map([...grid.values()].map((cell) => [cell.x * 4096 + cell.y, 0])),
		preparation: { weaponCells: new Map() }, skipped: { refused: 0, noProgress: null }, budget: new Budget(),
		visited: () => false, riskFree: false
	})
}

test("bound: the stagnation walking-route BFS stops at 613 cells with one line; a reachable zone gives none", () => {
	const far = capture(() => stagnationRoute(38))
	assert.equal(far.length, 1, far.join("\n"))
	assert.match(far[0], /^SEARCH CUT \[stagnation\] cause=walking route cells bound \(\d+ >= 613\) ops=\?\/\? cases_sans_route=\d+$/)
	assert.deepEqual(capture(() => assert.equal(stagnationRoute(10)?.progressModel, "stagnation walk route")), [])
})

test("bound: a native firing zone over 613 cells in the stagnation exit is refused with one line", () => {
	const lines = capture(() => assert.throws(() => stagnationRoute(0, Array.from({ length: 614 }, (_, i) => ({ id: i, x: i % 40, y: Math.floor(i / 40), obstacle: false, entity: null }))), Unavailable))
	assert.deepEqual(lines, ["SEARCH CUT [tactique] cause=native cells bound (614 > 613) ops=?/? repli=plan en cours, sinon plan B"])
})
