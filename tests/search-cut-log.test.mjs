import assert from "node:assert/strict"
import test from "node:test"
import { Budget, TACTICAL_LIMITS, Unavailable } from "../dist/Classes/Plannification/TacticalTypes.js"
import { stagnationEscape } from "../dist/Classes/Plannification/TacticalStagnation.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Journal de coupure : UNE ligne rouge `SEARCH CUT [origine] cause=… ops=…` par recherche coupée par un plafond, au point
// où la coupure est décidée. Les messages existants (`operations reserve`, `search bound`) restent ceux des exceptions.

function capture(run) {
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true); initLeekLogging(errors)
	try { run() } finally {
		delete globalThis.System
		globalThis.Debug = oldDebug; globalThis.Color = oldColor
		const off = new LogConfig(); off.setAll(false); initLeekLogging(off)
	}
	return lines.filter((text) => text.includes("SEARCH CUT"))
}

const reason = (action) => { try { action() } catch (error) { assert.ok(error instanceof Unavailable); return error.message } return null }

test("search cut: Budget emits one line per cut, however many times the cut is caught again; no cut, no line", () => {
	const cuts = capture(() => {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const quiet = new Budget()
		System.operations = 500
		assert.equal(reason(() => quiet.check()), null, "500/1000 is under 60 % and 80 %")

		System.operations = 0
		const fraction = new Budget()
		System.operations = 650
		assert.equal(reason(() => fraction.check()), "operations reserve")
		assert.equal(reason(() => fraction.check()), "operations reserve", "a re-thrown cut stays silent")
		assert.equal(reason(() => fraction.tick()), "operations reserve")
	})
	assert.deepEqual(cuts, [`SEARCH CUT [tactique] cause=operations reserve (search fraction) ops=650/1000 ticks=0/${TACTICAL_LIMITS.work}`])
})

test("search cut: global cap, volume bound of the search and boost origin keep their exception message", () => {
	const global = capture(() => {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const budget = new Budget(); System.operations = 850
		assert.equal(reason(() => budget.check()), "operations reserve")
	})
	assert.deepEqual(global, [`SEARCH CUT [tactique] cause=operations reserve (global cap) ops=850/1000 ticks=0/${TACTICAL_LIMITS.work}`])

	const bound = capture(() => {
		const budget = new Budget()
		let message = null
		for (let i = 0; i <= TACTICAL_LIMITS.work && message === null; i++) message = reason(() => budget.tick())
		assert.equal(message, "search bound")
		assert.equal(reason(() => budget.tick()), "search bound")
	})
	assert.deepEqual(bound, [`SEARCH CUT [tactique] cause=search bound ops=?/? ticks=${TACTICAL_LIMITS.work + 1}/${TACTICAL_LIMITS.work}`])

	const boost = capture(() => {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const budget = new Budget(undefined, "boost PM"); System.operations = 650
		assert.equal(reason(() => budget.check()), "operations reserve")
	})
	assert.equal(boost.length, 1)
	assert.match(boost[0], /^SEARCH CUT \[boost PM\] cause=operations reserve \(search fraction\) ops=650\/1000 /)

	const nextTurn = capture(() => {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const budget = new Budget(0.05, "tour suivant", "N = 0"); System.operations = 100
		assert.equal(reason(() => budget.check()), "operations reserve", "the exception message is unchanged")
	})
	assert.equal(nextTurn.length, 1)
	assert.match(nextTurn[0], /^SEARCH CUT \[tour suivant\] cause=operations reserve \(search fraction\) ops=100\/1000 /)
})

// Couloir 40 x 3, zone de tir à 26 cases de marche (même monde que stagnation-route-allowance) : le BFS lit `System.operations`
// à chaque case ; `step` opérations par lecture.
const grid = new Map()
for (let x = 0; x < 40; x++) for (let y = 0; y < 3; y++) grid.set(`${x},${y}`, { id: x * 3 + y, x, y, obstacle: false, entity: null })
const at = (x, y) => grid.get(`${x},${y}`) ?? null

function escape(step) {
	let operations = 0
	globalThis.System = { maxOperations: 2_000_000, get operations() { operations += step; return operations } }
	globalThis.Field = { cellFromXY: at }
	for (const cell of grid.values()) cell.entity = null
	const me = { id: 1, cell: at(1, 1), life: 384, strength: 10 }
	me.cell.entity = me
	const chip = { name: "zone" }
	const entries = []
	for (let x = 0; x <= 6; x++) entries.push({ cell: at(x, 1), cost: Math.abs(x - 1) })
	return stagnationEscape({
		me, target: { id: 2, cell: at(39, 1) }, turns: 2, weapons: [], attackChips: [chip],
		chipZones: new Map([[chip, [...grid.values()].filter((cell) => cell.x >= 27 && cell.x <= 34)]]), entries,
		dangers: new Map([...grid.values()].map((cell) => [cell.x * 4096 + cell.y, 0])),
		preparation: { weaponCells: new Map() }, skipped: { refused: 0, noProgress: null }, budget: new Budget(),
		visited: () => false, riskFree: false
	})
}

test("search cut: the stagnation route emits one line when its allowance stops the BFS; none when it completes", () => {
	const done = capture(() => assert.equal(escape(500)?.progressModel, "stagnation walk route"))
	assert.deepEqual(done, [], "no cut, no line")
	const cut = capture(() => assert.equal(escape(100_000)?.progressModel, "stagnation approach"))
	assert.equal(cut.length, 1)
	assert.match(cut[0], /^SEARCH CUT \[stagnation\] cause=walking route allowance ops=\d+\/2000000 limite=\d+ cases=\d+$/)
})
