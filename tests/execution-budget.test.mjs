import test from "node:test"
import assert from "node:assert/strict"
import { ExecutionBudget, hasExecutionRoom } from "../dist/Classes/Plannification/ExecutionBudget.js"

// Coûts synthétiques : aucune calibration du moteur n'est revendiquée.
function counter(start, run) {
	let ops = start
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	try { run(n => { ops += n }) } finally { delete globalThis.System }
}

test("execution starts beyond research70%, but keeps the explicit 3% tail", () => {
	counter(711002, spend => {
		const budget = new ExecutionBudget()
		assert.ok(hasExecutionRoom())
		assert.ok(budget.available())
		spend(258997)
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
