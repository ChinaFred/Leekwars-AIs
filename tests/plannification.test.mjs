import assert from "node:assert/strict"
import test from "node:test"

import { planAct } from "../dist/Brain/PlanActScenario.js"

test("planAct does nothing when there is no enemy", () => {
	globalThis.Fight = {
		me: {},
		getNearestEnemy: () => null,
		getEnemies: () => [],
		getAliveEnemies: () => [],
		getAllies: () => []
	}

	assert.equal(planAct({}), undefined)
})
