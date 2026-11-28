import test from "node:test"
import assert from "node:assert/strict"
import { ExecutionBudget, SEARCH_GLOBAL_FRACTION, hasExecutionRoom } from "../dist/Classes/Plannification/ExecutionBudget.js"

// Coûts synthétiques : aucune calibration du moteur n'est revendiquée.
function counter(start, run) {
	let ops = start
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	try { run(n => { ops += n }) } finally { delete globalThis.System }
}

test("the search ceiling shared by the tactical search and the plan B is 80 % of the total", () => {
	assert.equal(SEARCH_GLOBAL_FRACTION, 0.80)
})

test("execution starts beyond the 80% search ceiling, but keeps the explicit 3% tail", () => {
	counter(801002, spend => {
		assert.ok(801002 > 1000000 * SEARCH_GLOBAL_FRACTION)
		const budget = new ExecutionBudget()
		assert.ok(hasExecutionRoom())
		assert.ok(budget.available())
		spend(168997)
		assert.equal(hasExecutionRoom(), true)
		spend(1)
		assert.equal(hasExecutionRoom(), false)
		assert.equal(budget.available(), false)
	})
})

test("execution observes phase costs and stops early without forgetting the high watermark", () => {
	counter(711002, spend => {
		const budget = new ExecutionBudget()
		assert.ok(budget.available())
		spend(40000)
		assert.ok(budget.available(), "remaining248998 > tail30000 + 2*40000")
		spend(80000)
		assert.equal(budget.available(), false, "remaining168998 < tail30000 + 2*80000")
		assert.equal(budget.available(), false, "cheap repeated checks must not reset the largest cost")
		assert.ok(System.operations < System.maxOperations)
	})
})

test("strict adaptive boundary uses 3% plus twice the largest observed segment", () => {
	for (const [increment, expected] of [[24999, true], [25000, false], [25001, false]]) {
		counter(800000, spend => {
			const budget = new ExecutionBudget()
			assert.ok(budget.available())
			spend(40000)
			assert.ok(budget.available())
			spend(25000)
			assert.ok(budget.available())
			spend(increment)
			assert.equal(hasExecutionRoom(), true, "more than the 3% tail remains")
			assert.equal(budget.available(), expected, `remaining ${1000000 - System.operations}`)
			assert.equal(budget.available(), expected, "small checks do not erase the 40k peak")
		})
	}
})

test("execution does not charge previous research to the phase high watermark", () => {
	counter(400000, spend => {
		spend(311002) // Recherche passée ; le plan est maintenant choisi.
		const budget = new ExecutionBudget()
		assert.ok(budget.available())
		spend(5000)
		assert.ok(budget.available())
	})
})

test("execution cannot start at the genuine engine limit", () => {
	counter(1000000, () => {
		assert.equal(hasExecutionRoom(), false)
		assert.equal(new ExecutionBudget().available(), false)
	})
})

test("the book may open its 3rd turn while it has spent less than 30 % of the total (0.08 never opened it: level 2 alone costs 400-540 k ops)", async () => {
	const { BookBudget, BOOK_DEEPEN_FRACTION } = await import("../dist/Classes/Plannification/BookBudget.js")
	assert.equal(BOOK_DEEPEN_FRACTION, 0.30)
	let ops = 100000
	globalThis.System = { get operations() { return ops }, maxOperations: 2000000 }
	try {
		const budget = new BookBudget()
		ops += 300000 // 15 % du total consommé par le livre
		assert.equal(budget.deepenOk(), true)
		ops += 400000 // 35 %
		assert.equal(budget.deepenOk(), false)
	} finally { delete globalThis.System }
})
